import {
  CONNECTION_ACTION_KINDS,
  CONNECTION_AUDIENCES,
  CONNECTION_LIMITS,
  CONNECTION_OUTCOMES,
  CONNECTION_SIGN_INS,
  DEFAULT_CONNECTION_RULES,
  type SpaceConnectionView,
} from "@engenty/wizards-shared/connectors";
import type { Lang } from "@engenty/wizards-shared/definition";
import { note } from "@engenty/wizards-shared/run";
import { and, asc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { GuideSpaceConnection } from "../authoring/guide.js";
import { inAudience, type Who } from "../broker/index.js";
import { db, schema } from "../db/client.js";
import {
  buildAuthorizationUrl,
  createOAuth2Pkce,
  exchangeAuthorizationCode,
  type OAuth2Tokens,
} from "../engenty/connections-sdk/oauth2.js";
import type { ConnectorDefinition } from "../engenty/connections-sdk/types.js";
import type { Role } from "../manage.js";
import { seal, unseal } from "../secrets/crypto.js";
import { isAdminRole, requireAdmin, requireWritableSpace } from "../services/access.js";
import { notFound, ServiceError } from "../services/errors.js";
import { ownedSpace } from "../services/spaces.js";
import { currentTenant } from "../tenants/tenant.js";
import { connectorFetch, resolveEnv, viaAccount } from "./builtin.js";
import { resolveConnector } from "./external.js";
import { connectRedirectUri as redirectUri } from "./index.js";
import { AccountConnectError, redeemTicket, startThroughAccount } from "./via-account.js";

/*
 * The connections of a space (docs/plans/capabilities.md, "Connections"): admins set one up,
 * choose how it signs in (as the space, or each person themselves), who may use it and what each
 * kind of action may do. The rows are `space_connection`; a person's own sign-in is a row of
 * `space_connection_sign_in`. Secrets are sealed here and unsealed by the broker alone
 * (`broker/account.ts`). Plugins reach the same table through `server.connections`
 * (`plugin-connections.ts`).
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
  audience: z.enum(CONNECTION_AUDIENCES).default("members"),
  rules: rulesSchema.default(DEFAULT_CONNECTION_RULES),
  /** The connector's actions it is for; left out: every action. */
  actions: z.array(z.string().max(200)).max(200).default([]),
});

export const connectionPatchSchema = z.object({
  name: z.string().trim().min(1).max(CONNECTION_LIMITS.name).optional(),
  audience: z.enum(CONNECTION_AUDIENCES).optional(),
  rules: rulesSchema.optional(),
  actions: z.array(z.string().max(200)).max(200).optional(),
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
): Promise<SpaceConnectionView[]> {
  const rows = await listSpaceConnections(spaceId);
  const own = rows.length
    ? await db.query.spaceConnectionSignIn.findMany({
        where: eq(schema.spaceConnectionSignIn.userId, userId),
      })
    : [];
  return Promise.all(
    rows.map(async (row) => {
      const connector = (await resolveConnector(spaceId, row.connectorId))?.connector ?? null;
      const mine = own.find((s) => s.connectionId === row.id);
      return {
        id: row.id,
        spaceId: row.spaceId,
        connectorId: row.connectorId,
        connector: connector
          ? { id: connector.id, name: connector.name, auth: connector.auth.kind }
          : null,
        name: row.name,
        signIn: row.signIn,
        audience: row.audience,
        rules: row.rules,
        actions: row.actions,
        plugin: row.plugin,
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
      };
    }),
  );
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
      name: input.name,
      signIn: input.signIn,
      audience: input.audience,
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
  const actions =
    patch.actions !== undefined
      ? knownActions(await connectorOfRow(row), patch.actions)
      : undefined;
  const [updated] = await db
    .update(schema.spaceConnection)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.audience !== undefined ? { audience: patch.audience } : {}),
      ...(patch.rules !== undefined ? { rules: patch.rules } : {}),
      ...(actions !== undefined ? { actions } : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.spaceConnection.id, row.id))
    .returning();
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
    await db
      .update(schema.spaceConnection)
      .set({ secret: seal(stored), label, updatedAt: new Date() })
      .where(eq(schema.spaceConnection.id, row.id));
    return;
  }
  await db
    .insert(schema.spaceConnectionSignIn)
    .values({ connectionId: row.id, userId: as.userId, label, secret: seal(stored) })
    .onConflictDoUpdate({
      target: [schema.spaceConnectionSignIn.connectionId, schema.spaceConnectionSignIn.userId],
      set: { label, secret: seal(stored), signedInAt: new Date(), updatedAt: new Date() },
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
  return buildAuthorizationUrl({
    connector,
    pkce,
    redirectUri: redirectUri(),
    scopes,
    state: seal({ ...base, verifier: pkce.codeVerifier } satisfies SpaceConnectionOAuthState),
    resolveEnv,
  });
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
          redirectUri: redirectUri(),
          resolveEnv,
        });
  // A provider that will not name the account still connected it.
  const account = (await connector.auth.oauth2
    .resolveAccount?.(tokens.accessToken, fetch)
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
      .set({ secret: null, label: null, updatedAt: new Date() })
      .where(eq(schema.spaceConnection.id, row.id));
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
