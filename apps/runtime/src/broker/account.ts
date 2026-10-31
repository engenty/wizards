import type { ConnectionDef } from "@engenty/wizards-shared/store";
import { eq } from "drizzle-orm";
import { connectorFetch, resolveEnv } from "../connectors/builtin.js";
import {
  candidates,
  connectorFor,
  open,
  type StoredConnection,
  slot,
} from "../connectors/index.js";
import type { PluginConnectionRow, StoredTokens } from "../connectors/plugin-connections.js";
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
  const expires = data.expiresAt ? Date.parse(data.expiresAt) : null;
  if (
    connector.auth.kind === "oauth2" &&
    data.refreshToken &&
    expires !== null &&
    expires - Date.now() < 5 * 60_000
  ) {
    const tokens =
      data.via === "account"
        ? await refreshThroughAccount(data.refreshToken)
        : await refreshAccessToken({
            config: connector.auth.oauth2,
            refreshToken: data.refreshToken,
            resolveEnv,
          });
    data = {
      ...(data.via ? { via: data.via } : {}),
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? data.refreshToken,
      expiresAt: tokens.expiresAt?.toISOString() ?? null,
      scopes: tokens.grantedScopes.length ? tokens.grantedScopes : data.scopes,
    };
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

/**
 * The account a plugin connected for a space (`plugin_connection`), its tokens refreshed when
 * they run out within five minutes.
 */
export async function pluginAccount(
  row: PluginConnectionRow,
  connector: ConnectorDefinition,
): Promise<Account> {
  let data = unseal<StoredTokens>(row.data);
  if (!data) {
    throw new Error("The connection's keys cannot be read here. Connect the account again.");
  }
  const expires = data.expiresAt ? Date.parse(data.expiresAt) : null;
  if (
    connector.auth.kind === "oauth2" &&
    data.refreshToken &&
    expires !== null &&
    expires - Date.now() < 5 * 60_000
  ) {
    const tokens =
      data.via === "account"
        ? await refreshThroughAccount(data.refreshToken)
        : await refreshAccessToken({
            config: connector.auth.oauth2,
            refreshToken: data.refreshToken,
            resolveEnv,
          });
    data = {
      ...(data.via ? { via: data.via } : {}),
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? data.refreshToken,
      expiresAt: tokens.expiresAt?.toISOString() ?? null,
      scopes: tokens.grantedScopes.length ? tokens.grantedScopes : data.scopes,
    };
    await db
      .update(schema.pluginConnection)
      .set({ data: seal(data), updatedAt: new Date() })
      .where(eq(schema.pluginConnection.id, row.id));
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
      connected_by: row.createdBy,
      created_at: row.createdAt.toISOString(),
      display_name: row.label,
      error_message: null,
      external_account: row.label,
      granted_scopes: data.scopes,
      owner_user_id: null,
      space_id: row.spaceId,
      status: "active",
      tenant_id: currentTenant(),
    },
  };
  return { connector, ctx, label: row.label };
}

/** A secret of a store that is no connection: the browser's kept sign-ins. */
export function keptSecret<T>(scope: StoreScope, slot: string): Promise<StoredSecret<T> | null> {
  return getSecret<T>(scope, slot);
}
