import {
  CONNECTION_ACTION_KINDS,
  CONNECTION_AUDIENCES,
  CONNECTION_LIMITS,
  CONNECTION_OUTCOMES,
  CONNECTION_SIGN_INS,
  type ConnectionRules,
  DEFAULT_CONNECTION_RULES,
  type MailboxView,
  type SpaceConnectionView,
} from "@engenty/wizards-shared/connectors";
import type { Lang } from "@engenty/wizards-shared/definition";
import { featureOn } from "@engenty/wizards-shared/features";
import { note } from "@engenty/wizards-shared/run";
import { and, asc, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { GuideSpaceConnection } from "../authoring/guide.js";
import { callsToday, inAudience, logRuleChange, type Who } from "../broker/index.js";
import { db, schema } from "../db/client.js";
import {
  buildAuthorizationUrl,
  createOAuth2Pkce,
  exchangeAuthorizationCode,
  type OAuth2Tokens,
} from "../engenty/connections-sdk/oauth2.js";
import type { ConnectorDefinition } from "../engenty/connections-sdk/types.js";
import { currentFeatures } from "../features.js";
import { managed, type Role, tenantInfo } from "../manage.js";
import { loadedPlugin } from "../plugins/registry.js";
import { sealAccount } from "../secrets/accounts.js";
import { seal, unseal } from "../secrets/crypto.js";
import { isAdminRole, requireAdmin, requireWritableSpace } from "../services/access.js";
import { notFound, ServiceError } from "../services/errors.js";
import { ownedSpace } from "../services/spaces.js";
import { currentTenant } from "../tenants/tenant.js";
import { connectorFetch, resolveEnv, signInFetch, viaAccount } from "./builtin.js";
import { resolveConnector } from "./external.js";
import { connectRedirectUri as redirectUri } from "./index.js";
import { standInUrl } from "./stand-ins.js";
import { AccountConnectError, redeemTicket, startThroughAccount } from "./via-account.js";

/*
 * The connections of a space (docs/plans/capabilities.md, "Connections"): admins set one up,
 * choose how it signs in (as the space, or each person themselves), who may use it and what each
 * kind of action may do. The rows are `space_connection`; a person's own sign-in is a row of
 * `space_connection_sign_in`. Secrets are sealed here and unsealed by the broker alone
 * (`broker/account.ts`). Plugins reach the same table through `server.connections`
 * (`plugin-connections.ts`).
 *
 * Each person signing in is the plan's to include (the switch `personSignIn`): without it a
 * connection is set up as the space and none is changed to each person. One that already has
 * each person sign in keeps working, and its admins may change it to the space.
 */

export type SpaceConnectionRow = typeof schema.spaceConnection.$inferSelect;

/** What is sealed in `secret`: tokens, or the keys of an `api_key` connector as JSON in `accessToken`. */
export interface StoredTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  scopes: string[];
  /** Signed in through the account's Manage-App, which also refreshes the token. */
  via?: "account";
}

export const rulesSchema = z.object(
  Object.fromEntries(
    CONNECTION_ACTION_KINDS.map((k) => [k, z.enum(CONNECTION_OUTCOMES)]),
  ) as Record<
    (typeof CONNECTION_ACTION_KINDS)[number],
    z.ZodEnum<{ allow: "allow"; ask: "ask"; deny: "deny" }>
  >,
);

export const newConnectionSchema = z.object({
  connectorId: z.string().min(1).max(200),
  name: z.string().trim().min(1).max(CONNECTION_LIMITS.name),
  signIn: z.enum(CONNECTION_SIGN_INS),
  /** Left out: the members, and the admins on a connector that came from a pasted address. */
  audience: z.enum(CONNECTION_AUDIENCES).optional(),
  rules: rulesSchema.default(DEFAULT_CONNECTION_RULES),
  /** The connector's actions it is for; left out: every action. */
  actions: z.array(z.string().max(200)).max(200).default([]),
});

/** A limit on a connection's calls: a whole number from 1, or null for none. */
const callLimit = z.number().int().min(1).max(CONNECTION_LIMITS.calls).nullable();

export const connectionPatchSchema = z.object({
  name: z.string().trim().min(1).max(CONNECTION_LIMITS.name).optional(),
  /** How it signs in: a change forgets the sign-ins of the way it leaves. */
  signIn: z.enum(CONNECTION_SIGN_INS).optional(),
  audience: z.enum(CONNECTION_AUDIENCES).optional(),
  rules: rulesSchema.optional(),
  actions: z.array(z.string().max(200)).max(200).optional(),
  /** The calls one run makes through it at most, and the calls it takes per day; null: no limit. */
  callsPerRun: callLimit.optional(),
  callsPerDay: callLimit.optional(),
  /** `read_only`: an admin agrees that its mailbox is read while a run waits for mail. */
  autonomousMode: z.enum(["off", "read_only"]).optional(),
});

export type NewConnection = z.infer<typeof newConnectionSchema>;

/** A sign-in's answer: who the provider says the account is. */
export interface SignedIn {
  label: string;
}

// --- reading ---------------------------------------------------------------------------------

/** A connection by id, in this tenant; not found where the id is another tenant's or nobody's. */
export async function spaceConnectionById(id: string): Promise<SpaceConnectionRow> {
  const row = await db.query.spaceConnection.findFirst({
    where: eq(schema.spaceConnection.id, id),
  });
  if (!row) {
    throw notFound();
  }
  // The space check says whether the row is this tenant's.
  await ownedSpace("", row.spaceId);
  return row;
}

/** A connection of this space by id, or null. */
export async function spaceConnectionOf(
  spaceId: string,
  id: string,
): Promise<SpaceConnectionRow | null> {
  const row = await db.query.spaceConnection.findFirst({
    where: and(eq(schema.spaceConnection.id, id), eq(schema.spaceConnection.spaceId, spaceId)),
  });
  return row ?? null;
}

export async function listSpaceConnections(spaceId: string): Promise<SpaceConnectionRow[]> {
  return db.query.spaceConnection.findMany({
    where: eq(schema.spaceConnection.spaceId, spaceId),
    orderBy: [asc(schema.spaceConnection.setUpAt)],
  });
}

/** The connector behind a connection: a built-in one, or one the space imported. */
export async function connectorOfRow(row: SpaceConnectionRow): Promise<ConnectorDefinition> {
  const found = await resolveConnector(row.spaceId, row.connectorId);
  if (!found) {
    throw new ServiceError("not_found", note("connectorGone", { id: row.connectorId }));
  }
  return found.connector;
}

/** The space's connections as the authoring guide lists them: id, name, connector, sign-in, actions. */
export async function guideSpaceConnections(spaceId: string): Promise<GuideSpaceConnection[]> {
  const rows = await listSpaceConnections(spaceId);
  const listed: GuideSpaceConnection[] = [];
  for (const row of rows) {
    const connector = (await resolveConnector(spaceId, row.connectorId))?.connector;
    if (!connector) {
      continue;
    }
    const actions = row.actions.length
      ? connector.actions.filter((a) => row.actions.includes(a.id))
      : connector.actions;
    listed.push({
      id: row.id,
      name: row.name,
      connector: connector.name,
      signIn: row.signIn,
      actions: actions.map((a) => ({ id: a.id, group: a.group })),
    });
  }
  return listed;
}

/** What the studio shows: never a secret. `userId` tells whose own sign-in to look up. */
export async function spaceConnectionViews(
  spaceId: string,
  userId: string,
): Promise<(SpaceConnectionView & { pausedBy: string | null })[]> {
  const rows = await listSpaceConnections(spaceId);
  const people = rows.some((row) => row.signIn === "person");
  const signIns = people
    ? await db
        .select({
          connectionId: schema.spaceConnectionSignIn.connectionId,
          userId: schema.spaceConnectionSignIn.userId,
          label: schema.spaceConnectionSignIn.label,
          signedInAt: schema.spaceConnectionSignIn.signedInAt,
        })
        .from(schema.spaceConnectionSignIn)
        .where(
          inArray(
            schema.spaceConnectionSignIn.connectionId,
            rows.map((row) => row.id),
          ),
        )
    : [];
  const today = await callsToday(rows.map((row) => row.id));
  return Promise.all(
    rows.map(async (row) => {
      const found = await resolveConnector(spaceId, row.connectorId);
      const connector = found?.connector ?? null;
      const theirs =
        row.signIn === "person" ? signIns.filter((s) => s.connectionId === row.id) : [];
      const mine = theirs.find((s) => s.userId === userId);
      return {
        id: row.id,
        spaceId: row.spaceId,
        connectorId: row.connectorId,
        connector: connector
          ? {
              id: connector.id,
              name: connector.name,
              auth: connector.auth.kind,
              description: connector.description,
              ...(connector.auth.kind === "api_key"
                ? { fields: connector.auth.apiKey.fields }
                : {}),
              ...(found?.fromAddress ? { fromAddress: true } : {}),
            }
          : null,
        name: row.name,
        signIn: row.signIn,
        audience: row.audience,
        rules: row.rules,
        actions: row.actions,
        plugin: row.plugin,
        pluginName: row.plugin
          ? (loadedPlugin(row.plugin)?.source.manifest.name ?? row.plugin)
          : null,
        bundleId: row.bundleId,
        account:
          row.signIn === "space" && row.secret
            ? {
                label: row.label ?? connector?.name ?? row.name,
                signedInAt: row.setUpAt.toISOString(),
              }
            : null,
        mySignIn:
          row.signIn === "person" && mine
            ? { label: mine.label, signedInAt: mine.signedInAt.toISOString() }
            : null,
        setUpBy: row.setUpBy,
        setUpAt: row.setUpAt.toISOString(),
        lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
        signedIn: theirs.length,
        pausedAt: row.pausedAt?.toISOString() ?? null,
        pausedBy: row.pausedBy,
        callsPerRun: row.callsPerRun,
        callsPerDay: row.callsPerDay,
        callsToday: today.get(row.id) ?? 0,
      };
    }),
  );
}

/**
 * The mailboxes of the space whose mail can wake a run: connections that sign in as the space, to
 * a connector with a stream of messages. A member sees those within their audience.
 */
export async function mailboxesOf(spaceId: string, who: Who): Promise<MailboxView[]> {
  const rows = await listSpaceConnections(spaceId);
  const views: MailboxView[] = [];
  for (const row of rows) {
    const connector = (await resolveConnector(spaceId, row.connectorId))?.connector;
    if (
      row.signIn !== "space" ||
      !row.secret ||
      !connector?.stream ||
      !inAudience(row.audience, who)
    ) {
      continue;
    }
    const cursor = await db.query.mailCursor.findFirst({
      where: eq(schema.mailCursor.connectionId, row.id),
    });
    views.push({
      id: row.id,
      name: row.name,
      account: row.label ?? connector.name,
      on: row.autonomousMode !== "off",
      readAt: cursor?.readAt?.toISOString() ?? null,
      error: cursor?.error ?? null,
    });
  }
  return views;
}

// --- setting up, admins only -----------------------------------------------------------------

/** The actions named exist on the connector. */
function knownActions(connector: ConnectorDefinition, actions: string[]): string[] {
  for (const id of actions) {
    if (!connector.actions.some((a) => a.id === id)) {
      throw new ServiceError("invalid", note("connectorNoAction", { name: connector.name, id }));
    }
  }
  return [...new Set(actions)];
}

/** Whether a connection here may have each person sign in. A computer of one's own has no plan. */
export async function personSignInAllowed(): Promise<boolean> {
  return !managed || featureOn(await currentFeatures(), "personSignIn");
}

/** Refuses each person signing in where the organization's plan leaves it out, naming the plan. */
async function requirePersonSignIn(): Promise<void> {
  if (await personSignInAllowed()) {
    return;
  }
  const plan = (await tenantInfo(currentTenant()).catch(() => null))?.plan?.name;
  throw new ServiceError(
    "plan",
    plan ? note("personSignInNotInPlan", { plan }) : note("personSignInNotInOrganizationPlan"),
  );
}

export async function createSpaceConnection(
  userId: string | null,
  spaceId: string,
  input: NewConnection,
  /** The plugin that sets it up through `server.connections`, where one does. */
  plugin: string | null = null,
): Promise<SpaceConnectionRow> {
  await ownedSpace(userId ?? "", spaceId);
  await requireWritableSpace(spaceId);
  await requireAdmin();
  if (input.signIn === "person") {
    await requirePersonSignIn();
  }
  const found = await resolveConnector(spaceId, input.connectorId);
  if (!found || found.connector.auth.kind === "browser") {
    throw new ServiceError("invalid", note("connectorGone", { id: input.connectorId }));
  }
  const count = await db.$count(
    schema.spaceConnection,
    eq(schema.spaceConnection.spaceId, spaceId),
  );
  if (count >= CONNECTION_LIMITS.perSpace) {
    throw new ServiceError("refused", note("tooManyConnections"));
  }
  const [row] = await db
    .insert(schema.spaceConnection)
    .values({
      id: nanoid(14),
      spaceId,
      connectorId: found.connector.id,
      plugin,
      // Its connector came with a plugin for Claude Code or Cursor: it goes with that, too.
      bundleId: found.bundleId,
      name: input.name,
      signIn: input.signIn,
      // A server nobody checked reaches the AI with its own texts: the admins use it first.
      audience: input.audience ?? (found.fromAddress ? "admins" : "members"),
      rules: input.rules,
      actions: knownActions(found.connector, input.actions),
      setUpBy: userId,
    })
    .returning();
  return row;
}

export async function updateSpaceConnection(
  userId: string,
  id: string,
  patch: z.infer<typeof connectionPatchSchema>,
): Promise<SpaceConnectionRow> {
  const row = await spaceConnectionById(id);
  await ownedSpace(userId, row.spaceId);
  await requireWritableSpace(row.spaceId);
  await requireAdmin();
  const signInChanged = patch.signIn !== undefined && patch.signIn !== row.signIn;
  if (signInChanged && patch.signIn === "person") {
    // A plugin calls with no person: its connection stays the space's.
    if (row.plugin) {
      throw new ServiceError("invalid", note("pluginConnectionSignsInAsSpace"));
    }
    await requirePersonSignIn();
  }
  const actions =
    patch.actions !== undefined
      ? knownActions(await connectorOfRow(row), patch.actions)
      : undefined;
  const switched =
    patch.autonomousMode !== undefined && patch.autonomousMode !== row.autonomousMode;
  if (switched && !(row.signIn === "space" && (await connectorOfRow(row)).stream)) {
    throw new ServiceError("invalid", note("connectionNoMailbox"));
  }
  const [updated] = await db
    .update(schema.spaceConnection)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      // The space's own sign-in goes with the way it leaves; a person's has none on the row.
      ...(signInChanged ? { signIn: patch.signIn, secret: null, label: null } : {}),
      ...(patch.audience !== undefined ? { audience: patch.audience } : {}),
      ...(patch.rules !== undefined ? { rules: patch.rules } : {}),
      ...(actions !== undefined ? { actions } : {}),
      ...(patch.callsPerRun !== undefined ? { callsPerRun: patch.callsPerRun } : {}),
      ...(patch.callsPerDay !== undefined ? { callsPerDay: patch.callsPerDay } : {}),
      ...(patch.autonomousMode !== undefined ? { autonomousMode: patch.autonomousMode } : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.spaceConnection.id, row.id))
    .returning();
  if (signInChanged && updated.signIn === "space") {
    await db
      .delete(schema.spaceConnectionSignIn)
      .where(eq(schema.spaceConnectionSignIn.connectionId, row.id));
  }
  if (switched) {
    // Agreed from now on: what came before, or while it was off, stays unread.
    await forgetMailCursor(row.id);
    if (updated.autonomousMode !== "off") {
      await db.insert(schema.mailCursor).values({ connectionId: row.id, since: new Date() });
    }
  }
  // How it signs in, who may use it, what each kind of action may do and how many calls it takes:
  // a change there is heard of.
  const rulesChanged =
    patch.rules !== undefined && JSON.stringify(patch.rules) !== JSON.stringify(row.rules);
  const audienceChanged = patch.audience !== undefined && patch.audience !== row.audience;
  const limits = changedLimits(row, updated);
  if (rulesChanged || audienceChanged || signInChanged || limits || switched) {
    await logRuleChange({
      userId,
      spaceId: row.spaceId,
      connectionId: row.id,
      summary: {
        ...(signInChanged ? { signIn: `${row.signIn} → ${updated.signIn}` } : {}),
        ...(audienceChanged ? { audience: `${row.audience} → ${updated.audience}` } : {}),
        ...(rulesChanged ? { rules: changedRules(row.rules, updated.rules) } : {}),
        ...(limits ? { limits } : {}),
        ...(switched
          ? { autonomousMode: `${row.autonomousMode} → ${updated.autonomousMode}` }
          : {}),
      },
      reason: [
        signInChanged
          ? updated.signIn === "space"
            ? "It now signs in as the space."
            : "Each person now signs in."
          : "",
        audienceChanged ? `The audience is now ${updated.audience}.` : "",
        rulesChanged ? `The rules changed: ${changedRules(row.rules, updated.rules)}.` : "",
        limits ? `The limits changed: ${limits}.` : "",
        switched
          ? updated.autonomousMode === "off"
            ? "Its mailbox is no longer read on its own."
            : "Its mailbox is read while a run waits for mail."
          : "",
      ]
        .filter(Boolean)
        .join(" "),
    });
  }
  return updated;
}

const forgetMailCursor = (connectionId: string) =>
  db.delete(schema.mailCursor).where(eq(schema.mailCursor.connectionId, connectionId));

/** "write: ask → allow, send: ask → deny" */
function changedRules(before: ConnectionRules, after: ConnectionRules): string {
  return (Object.keys(after) as (keyof ConnectionRules)[])
    .filter((k) => before[k] !== after[k])
    .map((k) => `${k}: ${before[k]} → ${after[k]}`)
    .join(", ");
}

/** "calls per run: none → 20, calls per day: 500 → none"; empty where no limit changed. */
function changedLimits(
  before: Pick<SpaceConnectionRow, "callsPerRun" | "callsPerDay">,
  after: Pick<SpaceConnectionRow, "callsPerRun" | "callsPerDay">,
): string {
  const said = (limit: number | null) => (limit === null ? "none" : String(limit));
  return (
    [
      ["calls per run", before.callsPerRun, after.callsPerRun],
      ["calls per day", before.callsPerDay, after.callsPerDay],
    ] as const
  )
    .filter(([, was, is]) => was !== is)
    .map(([name, was, is]) => `${name}: ${said(was)} → ${said(is)}`)
    .join(", ");
}

/**
 * Pauses a connection, or resumes it (docs/plans/capabilities-next.md, 2a): while it pauses the
 * broker refuses every call through it, whoever calls, at the call (broker/call.ts reads the
 * pause each time). Nothing is lost: its sign-ins, rules and audience stay. Heard of as a changed
 * rule, with who did it. Pausing what pauses, or resuming what does not, changes nothing.
 */
export async function pauseSpaceConnection(
  userId: string,
  id: string,
  paused: boolean,
): Promise<SpaceConnectionRow> {
  const row = await spaceConnectionById(id);
  await ownedSpace(userId, row.spaceId);
  await requireWritableSpace(row.spaceId);
  await requireAdmin();
  if (Boolean(row.pausedAt) === paused) {
    return row;
  }
  const [updated] = await db
    .update(schema.spaceConnection)
    .set({
      pausedAt: paused ? new Date() : null,
      pausedBy: paused ? userId : null,
      updatedAt: new Date(),
    })
    .where(eq(schema.spaceConnection.id, row.id))
    .returning();
  await logRuleChange({
    userId,
    spaceId: row.spaceId,
    connectionId: row.id,
    summary: { paused: paused ? "yes" : "no" },
    reason: paused ? "The connection is paused: nobody reaches it." : "The connection is resumed.",
  });
  return updated;
}

export async function removeSpaceConnection(userId: string, id: string): Promise<void> {
  const row = await spaceConnectionById(id);
  await ownedSpace(userId, row.spaceId);
  await requireWritableSpace(row.spaceId);
  await requireAdmin();
  await db.delete(schema.spaceConnection).where(eq(schema.spaceConnection.id, row.id));
}

// --- signing in ------------------------------------------------------------------------------

/** As whom a sign-in is kept: the space's own, or one person's. */
export type SignInAs = { as: "space" } | { as: "person"; userId: string; role: Role };

/** The admins sign in as the space; a member signs in to a connection in which each person does, if it is for them. */
async function allowSignIn(row: SpaceConnectionRow, as: SignInAs): Promise<void> {
  if (as.as === "space") {
    if (row.signIn !== "space") {
      throw new ServiceError("invalid", note("connectionEachPersonSignsIn"));
    }
    await requireAdmin();
    return;
  }
  if (row.signIn !== "person") {
    throw new ServiceError("invalid", note("connectionSignsInAsSpace"));
  }
  const who: Who = { kind: isAdminRole(as.role) ? "admin" : "person", id: as.userId };
  if (!inAudience(row.audience, who)) {
    throw new ServiceError("forbidden", note("connectionNotForYou"));
  }
}

/** Keeps a sign-in: the space's in its row, a person's in theirs. */
async function keepSignIn(
  row: SpaceConnectionRow,
  as: SignInAs,
  label: string,
  stored: StoredTokens,
): Promise<void> {
  if (as.as === "space") {
    // An admin agreed to reading that account: another one is not agreed to, nor its cursor valid.
    const another = label !== row.label;
    await db
      .update(schema.spaceConnection)
      .set({
        secret: sealAccount(stored),
        grantedScopes: stored.scopes,
        label,
        updatedAt: new Date(),
        ...(another ? { autonomousMode: "off" as const } : {}),
      })
      .where(eq(schema.spaceConnection.id, row.id));
    if (another) {
      await forgetMailCursor(row.id);
    }
    return;
  }
  await db
    .insert(schema.spaceConnectionSignIn)
    .values({ connectionId: row.id, userId: as.userId, label, secret: sealAccount(stored) })
    .onConflictDoUpdate({
      target: [schema.spaceConnectionSignIn.connectionId, schema.spaceConnectionSignIn.userId],
      set: { label, secret: sealAccount(stored), signedInAt: new Date(), updatedAt: new Date() },
    });
}

/** Signs in with what the person typed: the connector tries the keys once, then they are kept sealed. */
export async function signInWithCredentials(
  id: string,
  as: SignInAs,
  values: Record<string, string>,
): Promise<SignedIn> {
  const row = await spaceConnectionById(id);
  await allowSignIn(row, as);
  const connector = await connectorOfRow(row);
  if (connector.auth.kind !== "api_key") {
    throw new ServiceError("invalid", note("connectorSignsIn", { name: connector.name }));
  }
  const credentials: Record<string, string> = {};
  for (const field of connector.auth.apiKey.fields) {
    const value = String(values[field.key] ?? "").trim();
    if (!value && field.required !== false) {
      throw new ServiceError("invalid", note("fieldMissing", { label: field.label }));
    }
    if (value) {
      credentials[field.key] = value.slice(0, 500);
    }
  }
  let account: { label: string };
  try {
    account = await connector.auth.apiKey.verify(credentials, connectorFetch);
  } catch (err) {
    throw new ServiceError(
      "refused",
      note("connectingNotWork", {
        host: "",
        detail: String((err as Error)?.message ?? err).slice(0, 200),
      }),
    );
  }
  await keepSignIn(row, as, account.label, {
    accessToken: JSON.stringify(credentials),
    refreshToken: null,
    expiresAt: null,
    scopes: [],
  });
  return { label: account.label };
}

/** Carried through the provider as `state`, sealed. `spaceConnection` tells it from a wizard's or a plugin's. */
interface SpaceConnectionOAuthState {
  spaceConnection: string;
  tenantId: string;
  /** Who signs in: null for the space itself. */
  userId: string | null;
  verifier: string;
  exp: number;
  lang?: Lang;
}

/** The provider rights the connection's actions need, and the connector's base rights. */
function scopesOf(connector: ConnectorDefinition, actions: string[]): string[] {
  const scopes = new Set(connector.auth.kind === "oauth2" ? connector.auth.oauth2.baseScopes : []);
  const wanted = actions.length
    ? connector.actions.filter((a) => actions.includes(a.id))
    : connector.actions;
  for (const action of wanted) {
    for (const scope of action.providerScopes ?? []) {
      scopes.add(scope);
    }
  }
  return [...scopes];
}

/** The provider's sign-in page for a connection; the callback (`/api/connect/callback`) finishes it. */
export async function startSpaceConnectionOAuth(
  id: string,
  as: SignInAs,
  lang?: Lang,
): Promise<string> {
  const row = await spaceConnectionById(id);
  await allowSignIn(row, as);
  const connector = await connectorOfRow(row);
  if (connector.auth.kind !== "oauth2") {
    throw new ServiceError("invalid", note("connectorTakesKeys", { name: connector.name }));
  }
  const scopes = scopesOf(connector, row.actions);
  const base = {
    spaceConnection: row.id,
    tenantId: currentTenant(),
    userId: as.as === "person" ? as.userId : null,
    exp: Date.now() + 15 * 60_000,
    lang,
  };
  if (await viaAccount(connector)) {
    // The Manage-App keeps the PKCE verifier; ours stays empty.
    try {
      return await startThroughAccount(
        scopes,
        seal({ ...base, verifier: "" } satisfies SpaceConnectionOAuthState),
        redirectUri(),
      );
    } catch (err) {
      throw err instanceof AccountConnectError ? new ServiceError("refused", err.message) : err;
    }
  }
  await connector.auth.oauth2.registerClient?.();
  const pkce = createOAuth2Pkce();
  return standInUrl(
    await buildAuthorizationUrl({
      connector,
      pkce,
      redirectUri: redirectUri(),
      scopes,
      state: seal({ ...base, verifier: pkce.codeVerifier } satisfies SpaceConnectionOAuthState),
      resolveEnv,
    }),
  );
}

/** A state the callback can tell is a space connection's: the tenant to finish it in, or null. */
export function spaceConnectionStateTenant(rawState: string): string | null {
  const state = unseal<SpaceConnectionOAuthState>(rawState);
  return state && typeof state.spaceConnection === "string" ? state.tenantId : null;
}

/** The provider came back for a connection of the space: keeps the sign-in it started. */
export async function finishSpaceConnectionOAuth(
  answer: { code: string } | { ticket: string },
  rawState: string,
): Promise<{ connectionId: string }> {
  const state = unseal<SpaceConnectionOAuthState>(rawState);
  if (!state?.spaceConnection || state.exp < Date.now()) {
    throw new Error("The sign-in has expired. Sign in again.");
  }
  const row = await db.query.spaceConnection.findFirst({
    where: eq(schema.spaceConnection.id, state.spaceConnection),
  });
  if (!row) {
    throw new Error("The connection this sign-in belongs to is gone.");
  }
  const connector = await connectorOfRow(row);
  if (connector.auth.kind !== "oauth2") {
    throw new Error("not an oauth connector");
  }
  const tokens: OAuth2Tokens =
    "ticket" in answer
      ? await redeemTicket(answer.ticket)
      : await exchangeAuthorizationCode({
          code: answer.code,
          codeVerifier: state.verifier,
          config: connector.auth.oauth2,
          fetchImpl: connector.auth.oauth2.fetchImpl ?? signInFetch,
          redirectUri: redirectUri(),
          resolveEnv,
        });
  // A provider that will not name the account still connected it.
  const account = (await connector.auth.oauth2
    .resolveAccount?.(tokens.accessToken, signInFetch)
    .catch(() => null)) ?? { label: connector.name };
  const stored: StoredTokens = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt?.toISOString() ?? null,
    scopes: tokens.grantedScopes,
    ...("ticket" in answer ? { via: "account" as const } : {}),
  };
  // The person's role was checked when the sign-in started; the state is ours, sealed.
  const as: SignInAs =
    state.userId === null
      ? { as: "space" }
      : { as: "person", userId: state.userId, role: "member" };
  if (as.as === "space" && row.signIn !== "space") {
    throw new Error("The connection no longer signs in as the space.");
  }
  if (as.as === "person" && row.signIn !== "person") {
    throw new Error("The connection no longer signs in per person.");
  }
  await keepSignIn(row, as, account.label, stored);
  return { connectionId: row.id };
}

/** Forgets a sign-in: the space's (admins) or the person's own. */
export async function removeSignIn(id: string, as: SignInAs): Promise<void> {
  const row = await spaceConnectionById(id);
  if (as.as === "space") {
    await requireAdmin();
    await db
      .update(schema.spaceConnection)
      .set({ secret: null, label: null, autonomousMode: "off", updatedAt: new Date() })
      .where(eq(schema.spaceConnection.id, row.id));
    await forgetMailCursor(row.id);
    return;
  }
  await db
    .delete(schema.spaceConnectionSignIn)
    .where(
      and(
        eq(schema.spaceConnectionSignIn.connectionId, row.id),
        eq(schema.spaceConnectionSignIn.userId, as.userId),
      ),
    );
}

/**
 * Keeps a sign-in as the space that a plugin or a command already made (`server.connections`
 * after the provider came back): the same account for the same space again replaces the first.
 */
export async function keepSpaceSignIn(
  row: SpaceConnectionRow,
  label: string,
  stored: StoredTokens,
): Promise<void> {
  await keepSignIn(row, { as: "space" }, label, stored);
}
