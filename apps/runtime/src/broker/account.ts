import type { ConnectionDef } from "@engenty/wizards-shared/store";
import { and, eq } from "drizzle-orm";
import { connectorFetch, resolveEnv } from "../connectors/builtin.js";
import {
  candidates,
  connectorFor,
  open,
  type StoredConnection,
  slot,
} from "../connectors/index.js";
import type { SpaceConnectionRow, StoredTokens } from "../connectors/space-connections.js";
import { refreshThroughAccount } from "../connectors/via-account.js";
import { db, schema } from "../db/client.js";
import { refreshAccessToken } from "../engenty/connections-sdk/oauth2.js";
import type {
  ConnectorActionContext,
  ConnectorDefinition,
} from "../engenty/connections-sdk/types.js";
import { seal, unseal } from "../secrets/crypto.js";
import { getSecret, putSecret, type StoredSecret, type StoreScope } from "../store/index.js";
import { currentTenant } from "../tenants/tenant.js";
import type { Who } from "./call.js";

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
}

/**
 * The account a wizard's connection (or a share target's) holds for this store: the person who
 * runs the wizard connected it. `null` when nothing is connected.
 */
export async function wizardAccount(
  scope: StoreScope,
  connection: ConnectionDef,
  spaceId: string,
): Promise<Account | null> {
  const stored = await getSecret<StoredConnection>(scope, slot(connection.id));
  if (!stored) {
    const only = connection.connector ? (await candidates(connection, spaceId))[0] : undefined;
    return only && open(only)
      ? { connector: only, label: only.name, ctx: actionContext(scope, connection, only, "{}", []) }
      : null;
  }
  const connector = await connectorFor(connection, stored.provider, spaceId);
  let data = stored.data;
  const fresh = await refreshed(connector, data);
  if (fresh) {
    data = fresh;
    await putSecret(scope, slot(connection.id), connector.id, stored.label, data);
  }
  return {
    connector,
    label: stored.label,
    ctx: actionContext(scope, connection, connector, data.accessToken, data.scopes, stored),
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

/** Whose sign-in a `person` connection opens for: a person, an admin, or Goose for its person. */
const signsInThemselves = (who: Who): who is Who & { id: string } =>
  (who.kind === "person" || who.kind === "admin" || who.kind === "goose") && Boolean(who.id);

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
    if (!signsInThemselves(who)) {
      return null;
    }
    const own = await db.query.spaceConnectionSignIn.findFirst({
      where: and(
        eq(schema.spaceConnectionSignIn.connectionId, row.id),
        eq(schema.spaceConnectionSignIn.userId, who.id),
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
      autonomous_mode: "read_only",
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

/** „Letzte Nutzung“: the connection was just used. */
/** The rights the provider granted a connection of the space at its sign-in; none for keys. */
export function grantedScopes(row: SpaceConnectionRow): string[] {
  const data = row.secret ? unseal<StoredTokens>(row.secret) : null;
  return data?.scopes ?? [];
}

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
