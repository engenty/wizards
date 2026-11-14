import type { ConnectionDef } from "@engenty/wizards-shared/store";
import { and, eq } from "drizzle-orm";
import { connectorFetch, resolveEnv, signInFetch } from "../connectors/builtin.js";
import { candidates, open, type StoredConnection } from "../connectors/index.js";
import { connectionsFor, remember, runConnectionsOn } from "../connectors/person-connections.js";
import { sameService } from "../connectors/same-service.js";
import {
  listSpaceConnections,
  type SpaceConnectionRow,
  type StoredTokens,
} from "../connectors/space-connections.js";
import { refreshThroughAccount } from "../connectors/via-account.js";
import { db, schema } from "../db/client.js";
import { refreshAccessToken } from "../engenty/connections-sdk/oauth2.js";
import type {
  ConnectorActionContext,
  ConnectorDefinition,
} from "../engenty/connections-sdk/types.js";
import { seal, unseal } from "../secrets/crypto.js";
import { getSecret, type StoredSecret, type StoreScope } from "../store/index.js";
import { currentTenant } from "../tenants/tenant.js";
import { type BrokerConnection, type SpaceRules, spaceRulesOf, type Who } from "./call.js";

/*
 * The one reader of a connection's secret (docs/plans/broker.md, "One reader"). Nothing outside
 * `broker/` imports this module: `call.ts` reads an account here, decides, runs the action and
 * logs it. A test walks the source tree and fails on another importer.
 */

/** A connected account as an action runs with it: the connector, its context with a fresh token, the label. */
export interface Account {
  connector: ConnectorDefinition;
  ctx: ConnectorActionContext;
  label: string;
  /** A person's own account (`person_connection`): the space's rules for its service count. */
  person?: true;
}

/**
 * The account a wizard's connection (or a share target's) uses in this run: the person's own
 * connection the lookup finds (`connectionsFor`). The only candidate is remembered once used.
 * `null` when there is none to use. A connection of the space is resolved before
 * (`heldConnection`), so that its rules count.
 */
export async function wizardAccount(
  scope: StoreScope,
  connection: ConnectionDef,
  spaceId: string,
): Promise<Account | null> {
  const found = await connectionsFor(scope, spaceId, connection);
  const chosen = found.chosen?.kind === "person" ? found.chosen : null;
  if (!chosen) {
    const only = connection.connector ? (await candidates(connection, spaceId))[0] : undefined;
    return !found.chosen && only && open(only)
      ? { connector: only, label: only.name, ctx: actionContext(scope, connection, only, "{}", []) }
      : null;
  }
  const row = await db.query.personConnection.findFirst({
    where: eq(schema.personConnection.id, chosen.row.id),
  });
  let data = row ? unseal<StoredConnection>(row.secret) : null;
  if (!data) {
    throw new Error("The connection's keys cannot be read here. Connect it again.");
  }
  if (found.by === "only") {
    await remember(scope.wizardId, connection.id, scope.holder, chosen);
  }
  const { connector } = chosen;
  const fresh = await refreshed(connector, data);
  if (fresh) {
    data = fresh;
    await db
      .update(schema.personConnection)
      .set({ secret: seal(data), updatedAt: new Date() })
      .where(eq(schema.personConnection.id, chosen.row.id));
  }
  return {
    connector,
    label: chosen.row.label,
    ctx: actionContext(scope, connection, connector, data.accessToken, data.scopes, chosen.row),
    person: true,
  };
}

/**
 * The space's rules for a person's own account of this connector used in a run of the space
 * (behind `runConnections`): those of the space's connections of the same connector or the same
 * service, read on every call so that a pause or a changed rule binds at once. Null where the
 * space has none, or the switch is off: the wizard's `policy` counts then.
 */
export async function spaceRulesFor(
  spaceId: string,
  connectorId: string,
): Promise<SpaceRules | null> {
  if (!(await runConnectionsOn())) {
    return null;
  }
  const service = sameService(connectorId);
  const rows = await listSpaceConnections(spaceId);
  return spaceRulesOf(rows.filter((row) => service.includes(row.connectorId)));
}

/**
 * A wizard's connection as the broker holds it: where the run uses a connection of the space for
 * the need (behind `runConnections`), that connection, under the space's rules.
 */
export async function heldConnection(connection: BrokerConnection): Promise<BrokerConnection> {
  if (connection.kind !== "store_secret" || !(await runConnectionsOn())) {
    return connection;
  }
  const found = await connectionsFor(connection.scope, connection.spaceId, connection.def);
  if (found.chosen?.kind !== "space") {
    return connection;
  }
  if (found.by === "only") {
    await remember(
      connection.scope.wizardId,
      connection.def.id,
      connection.scope.holder,
      found.chosen,
    );
  }
  return {
    kind: "space_connection",
    row: found.chosen.row,
    connector: found.chosen.connector,
    need: connection.def,
  };
}

function actionContext(
  scope: StoreScope,
  connection: ConnectionDef,
  connector: ConnectorDefinition,
  accessToken: string,
  scopes: string[],
  stored?: { label: string; createdAt: Date },
): ConnectorActionContext {
  return {
    accessToken,
    fetchImpl: connectorFetch,
    log: () => undefined,
    connection: {
      id: connection.id,
      connector_id: connector.id,
      auth_kind: connector.auth.kind,
      autonomous_mode: "read_only",
      connected_by: null,
      created_at: (stored?.createdAt ?? new Date()).toISOString(),
      display_name: stored?.label ?? connector.name,
      error_message: null,
      external_account: stored?.label ?? null,
      granted_scopes: scopes,
      owner_user_id: null,
      space_id: null,
      status: "active",
      tenant_id: scope.wizardId,
    },
  };
}

/** Fresh tokens where the ones kept run out within five minutes; the same ones else. */
async function refreshed(
  connector: ConnectorDefinition,
  data: StoredTokens,
): Promise<StoredTokens | null> {
  const expires = data.expiresAt ? Date.parse(data.expiresAt) : null;
  if (
    connector.auth.kind !== "oauth2" ||
    !data.refreshToken ||
    expires === null ||
    expires - Date.now() >= 5 * 60_000
  ) {
    return null;
  }
  const tokens =
    data.via === "account"
      ? await refreshThroughAccount(data.refreshToken)
      : await refreshAccessToken({
          config: connector.auth.oauth2,
          fetchImpl: connector.auth.oauth2.fetchImpl ?? signInFetch,
          refreshToken: data.refreshToken,
          resolveEnv,
        });
  return {
    ...(data.via ? { via: data.via } : {}),
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken ?? data.refreshToken,
    expiresAt: tokens.expiresAt?.toISOString() ?? null,
    scopes: tokens.grantedScopes.length ? tokens.grantedScopes : data.scopes,
  };
}

/**
 * Whose sign-in a `person` connection opens for: a person, an admin, Goose for its person, or a
 * fixed step for the person its run is held for. A guest, or a step nobody's run, has none.
 */
function signedInAs(who: Who): string | null {
  const asked = who.kind === "step" ? who.for : who;
  return asked &&
    (asked.kind === "person" || asked.kind === "admin" || asked.kind === "goose") &&
    asked.id
    ? asked.id
    : null;
}

/**
 * The account a connection of the space holds for this caller: the space's own sign-in, or the
 * caller's where each person signs in. `null` when nobody has signed in yet. Tokens that run out
 * within five minutes are refreshed and written back.
 */
export async function spaceAccount(
  row: SpaceConnectionRow,
  connector: ConnectorDefinition,
  who: Who,
): Promise<Account | null> {
  let sealed: string | null;
  let label: string;
  let signedInAt: Date;
  let write: (secret: string) => Promise<unknown>;
  if (row.signIn === "space") {
    sealed = row.secret;
    label = row.label ?? connector.name;
    signedInAt = row.setUpAt;
    write = (secret) =>
      db
        .update(schema.spaceConnection)
        .set({ secret, updatedAt: new Date() })
        .where(eq(schema.spaceConnection.id, row.id));
  } else {
    const userId = signedInAs(who);
    if (!userId) {
      return null;
    }
    const own = await db.query.spaceConnectionSignIn.findFirst({
      where: and(
        eq(schema.spaceConnectionSignIn.connectionId, row.id),
        eq(schema.spaceConnectionSignIn.userId, userId),
      ),
    });
    if (!own) {
      return null;
    }
    sealed = own.secret;
    label = own.label;
    signedInAt = own.signedInAt;
    write = (secret) =>
      db
        .update(schema.spaceConnectionSignIn)
        .set({ secret, updatedAt: new Date() })
        .where(
          and(
            eq(schema.spaceConnectionSignIn.connectionId, row.id),
            eq(schema.spaceConnectionSignIn.userId, own.userId),
          ),
        );
  }
  if (!sealed) {
    return null;
  }
  let data = unseal<StoredTokens>(sealed);
  if (!data) {
    throw new Error("The connection's keys cannot be read here. Sign in again.");
  }
  const fresh = await refreshed(connector, data);
  if (fresh) {
    data = fresh;
    await write(seal(data));
  }
  const ctx: ConnectorActionContext = {
    accessToken: data.accessToken,
    fetchImpl: connectorFetch,
    log: () => undefined,
    connection: {
      id: row.id,
      connector_id: connector.id,
      auth_kind: connector.auth.kind,
      autonomous_mode: row.autonomousMode,
      connected_by: row.setUpBy,
      created_at: signedInAt.toISOString(),
      display_name: row.name,
      error_message: null,
      external_account: label,
      granted_scopes: data.scopes,
      owner_user_id: null,
      space_id: row.spaceId,
      status: "active",
      tenant_id: currentTenant(),
    },
  };
  return { connector, ctx, label };
}

/**
 * What a connection of the space says of a call now: whether it pauses, its limits, and whether
 * it was used before. Read on every call, so a pause or a limit binds a step or a chat turn that
 * read the row before it, and only the first call of all is a first use. Null where the
 * connection is gone.
 */
export async function stateOf(
  id: string,
): Promise<Pick<
  SpaceConnectionRow,
  "pausedAt" | "pausedBy" | "callsPerRun" | "callsPerDay" | "lastUsedAt"
> | null> {
  const row = await db.query.spaceConnection.findFirst({
    where: eq(schema.spaceConnection.id, id),
    columns: {
      pausedAt: true,
      pausedBy: true,
      callsPerRun: true,
      callsPerDay: true,
      lastUsedAt: true,
    },
  });
  return row ?? null;
}

/** The rights the provider granted a connection of the space at its sign-in; none for keys. */
export function grantedScopes(row: SpaceConnectionRow): string[] {
  const data = row.secret ? unseal<StoredTokens>(row.secret) : null;
  return data?.scopes ?? [];
}

/** „Letzte Nutzung“: the connection was just used. */
export async function markUsed(row: SpaceConnectionRow): Promise<void> {
  await db
    .update(schema.spaceConnection)
    .set({ lastUsedAt: new Date() })
    .where(eq(schema.spaceConnection.id, row.id));
}

/** A secret of a store that is no connection: the browser's kept sign-ins. */
export function keptSecret<T>(scope: StoreScope, slot: string): Promise<StoredSecret<T> | null> {
  return getSecret<T>(scope, slot);
}
