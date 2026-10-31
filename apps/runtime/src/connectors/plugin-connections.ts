import type {
  PluginConnection,
  PluginConnections,
  PluginConnectorOffer,
} from "@engenty/wizards/plugin";
import type { Lang } from "@engenty/wizards-shared/definition";
import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { brokerCall, currentCaller, reachesOutside } from "../broker/index.js";
import { db, schema } from "../db/client.js";
import {
  buildAuthorizationUrl,
  createOAuth2Pkce,
  exchangeAuthorizationCode,
  type OAuth2Tokens,
} from "../engenty/connections-sdk/oauth2.js";
import type { ConnectorDefinition } from "../engenty/connections-sdk/types.js";
import { seal, unseal } from "../secrets/crypto.js";
import { currentTenant } from "../tenants/tenant.js";
import { builtinConnector, connectorFetch, resolveEnv, usable, viaAccount } from "./builtin.js";
import { connectRedirectUri as redirectUri } from "./index.js";
import { AccountConnectError, redeemTicket, startThroughAccount } from "./via-account.js";

/*
 * Accounts a plugin connects for a space (`server.connections`, docs/content/dev/plugins): the
 * runtime's built-in OAuth connectors, signed in through the same callback as a wizard's
 * connections, kept in `plugin_connection` rather than in a wizard's store.
 */

/** Carried through the provider as `state`, sealed. `plugin` tells it from a wizard's state. */
interface PluginOAuthState {
  plugin: string;
  tenantId: string;
  spaceId: string;
  connectorId: string;
  actions: string[];
  verifier: string;
  exp: number;
  /** The language the person picked: the page the provider sends them back to speaks it. */
  lang?: Lang;
}

/** What is sealed in `data`; the broker's reader (`broker/account.ts`) alone unseals it. */
export interface StoredTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  scopes: string[];
  via?: "account";
}

export type PluginConnectionRow = typeof schema.pluginConnection.$inferSelect;
type Row = PluginConnectionRow;

function oauthConnector(id: string): ConnectorDefinition {
  const connector = builtinConnector(id);
  if (connector?.auth.kind !== "oauth2") {
    throw new Error(`"${id}" is not a built-in connector that signs in.`);
  }
  return connector;
}

/** A built-in connector a plugin may connect: signed in, or with keys. */
function connectorOf(id: string): ConnectorDefinition {
  const connector = builtinConnector(id);
  if (!connector || connector.auth.kind === "browser") {
    throw new Error(`"${id}" is not a built-in connector a plugin can connect.`);
  }
  return connector;
}

/** The actions a connection is made for exist on the connector. */
function knownActions(connector: ConnectorDefinition, actions: string[]): string[] {
  for (const id of actions) {
    if (!connector.actions.some((a) => a.id === id)) {
      throw new Error(`${connector.name} has no action "${id}".`);
    }
  }
  return [...new Set(actions)];
}

async function spaceExists(space: string) {
  const row = await db.query.space.findFirst({
    where: eq(schema.space.id, space),
    columns: { id: true },
  });
  if (!row) {
    throw new Error(`There’s no space “${space}”.`);
  }
}

/** Keeps a connection: the same account for the same space again replaces the first one. */
async function keep(input: {
  plugin: string;
  spaceId: string;
  connector: string;
  label: string;
  actions: string[];
  stored: StoredTokens;
}): Promise<Row> {
  const same = await db.query.pluginConnection.findFirst({
    where: and(
      eq(schema.pluginConnection.plugin, input.plugin),
      eq(schema.pluginConnection.spaceId, input.spaceId),
      eq(schema.pluginConnection.connector, input.connector),
      eq(schema.pluginConnection.label, input.label),
    ),
  });
  if (same) {
    const [row] = await db
      .update(schema.pluginConnection)
      .set({ actions: input.actions, data: seal(input.stored), updatedAt: new Date() })
      .where(eq(schema.pluginConnection.id, same.id))
      .returning();
    return row;
  }
  const [row] = await db
    .insert(schema.pluginConnection)
    .values({
      id: nanoid(14),
      plugin: input.plugin,
      spaceId: input.spaceId,
      connector: input.connector,
      label: input.label,
      actions: input.actions,
      data: seal(input.stored),
    })
    .returning();
  return row;
}

/** The provider rights the named actions need, and the connector's own base rights. */
function scopesOf(connector: ConnectorDefinition, actions: string[]): string[] {
  const scopes = new Set(connector.auth.kind === "oauth2" ? connector.auth.oauth2.baseScopes : []);
  for (const id of actions) {
    const action = connector.actions.find((a) => a.id === id);
    if (!action) {
      throw new Error(`${connector.name} has no action "${id}".`);
    }
    for (const scope of action.providerScopes ?? []) {
      scopes.add(scope);
    }
  }
  return [...scopes];
}

const view = (row: Row): PluginConnection => ({
  id: row.id,
  space: row.spaceId,
  connector: row.connector,
  label: row.label,
  actions: row.actions,
  createdAt: row.createdAt.toISOString(),
});

/** A state the callback can tell is a plugin's: the tenant to finish it in, or null. */
export function pluginStateTenant(rawState: string): string | null {
  const state = unseal<PluginOAuthState>(rawState);
  return state && typeof state.plugin === "string" ? state.tenantId : null;
}

/**
 * The provider came back for a plugin's sign-in: keeps the account. A second sign-in to the
 * same account for the same space replaces the first one's tokens.
 */
export async function finishPluginOAuth(
  answer: { code: string } | { ticket: string },
  rawState: string,
): Promise<{ plugin: string; spaceId: string }> {
  const state = unseal<PluginOAuthState>(rawState);
  if (!state?.plugin || state.exp < Date.now()) {
    throw new Error("The sign-in has expired. Connect again.");
  }
  const connector = oauthConnector(state.connectorId);
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
  await keep({
    plugin: state.plugin,
    spaceId: state.spaceId,
    connector: connector.id,
    label: account.label,
    actions: state.actions,
    stored,
  });
  return { plugin: state.plugin, spaceId: state.spaceId };
}

/** `server.connections` of one plugin; every call runs inside the current tenant. */
export function pluginConnections(plugin: string): PluginConnections {
  const own = (id: string) =>
    db.query.pluginConnection.findFirst({
      where: and(eq(schema.pluginConnection.id, id), eq(schema.pluginConnection.plugin, plugin)),
    });

  return {
    async available(ids) {
      const out: PluginConnectorOffer[] = [];
      for (const id of ids) {
        const connector = builtinConnector(id);
        if (!connector || connector.auth.kind === "browser" || !(await usable(connector))) {
          continue;
        }
        out.push(
          connector.auth.kind === "api_key"
            ? {
                id,
                name: connector.name,
                auth: "api_key",
                fields: connector.auth.apiKey.fields.map((f) => ({
                  key: f.key,
                  label: f.label,
                  ...(f.placeholder ? { placeholder: f.placeholder } : {}),
                  ...(f.required === false ? { required: false } : {}),
                  ...(f.secret ? { secret: true } : {}),
                })),
              }
            : { id, name: connector.name, auth: "oauth2" },
        );
      }
      return out;
    },

    async start({ space, connector: connectorId, actions, lang }) {
      const connector = oauthConnector(connectorId);
      if (connector.auth.kind !== "oauth2") {
        throw new Error("not an oauth connector");
      }
      await spaceExists(space);
      const scopes = scopesOf(connector, actions);
      const base = {
        plugin,
        tenantId: currentTenant(),
        spaceId: space,
        connectorId,
        actions: [...new Set(actions)],
        exp: Date.now() + 15 * 60_000,
        lang,
      };
      if (await viaAccount(connector)) {
        // The Manage-App keeps the PKCE verifier; ours stays empty.
        try {
          const url = await startThroughAccount(
            scopes,
            seal({ ...base, verifier: "" } satisfies PluginOAuthState),
            redirectUri(),
          );
          return { url };
        } catch (err) {
          throw err instanceof AccountConnectError
            ? Object.assign(new Error(err.message), { status: 409, code: "account" })
            : err;
        }
      }
      await connector.auth.oauth2.registerClient?.();
      const pkce = createOAuth2Pkce();
      const url = await buildAuthorizationUrl({
        connector,
        pkce,
        redirectUri: redirectUri(),
        scopes,
        state: seal({ ...base, verifier: pkce.codeVerifier } satisfies PluginOAuthState),
        resolveEnv,
      });
      return { url };
    },

    async connect({ space, connector: connectorId, actions, credentials }) {
      const connector = connectorOf(connectorId);
      if (connector.auth.kind !== "api_key") {
        throw new Error(`${connector.name} is connected by signing in: use start.`);
      }
      await spaceExists(space);
      const wanted = knownActions(connector, actions);
      const keys: Record<string, string> = {};
      for (const field of connector.auth.apiKey.fields) {
        const value = String(credentials[field.key] ?? "").trim();
        if (!value && field.required !== false) {
          throw Object.assign(new Error(`"${field.label}" is missing.`), {
            status: 400,
            code: "credentials",
          });
        }
        if (value) {
          keys[field.key] = value.slice(0, 500);
        }
      }
      let account: { label: string };
      try {
        account = await connector.auth.apiKey.verify(keys, connectorFetch);
      } catch (err) {
        throw Object.assign(new Error(String((err as Error)?.message ?? err).slice(0, 300)), {
          status: 400,
          code: "credentials",
        });
      }
      const row = await keep({
        plugin,
        spaceId: space,
        connector: connector.id,
        label: account.label,
        actions: wanted,
        stored: {
          accessToken: JSON.stringify(keys),
          refreshToken: null,
          expiresAt: null,
          scopes: [],
        },
      });
      return view(row);
    },

    async list(space) {
      const rows = await db.query.pluginConnection.findMany({
        where: and(
          eq(schema.pluginConnection.plugin, plugin),
          eq(schema.pluginConnection.spaceId, space),
        ),
        orderBy: [desc(schema.pluginConnection.createdAt)],
      });
      return rows.map(view);
    },

    async get(id) {
      const row = await own(id);
      return row ? view(row) : null;
    },

    async call(id, actionId, input) {
      const row = await own(id);
      if (!row) {
        throw new Error(`There is no connection "${id}".`);
      }
      if (!row.actions.includes(actionId)) {
        throw new Error(`The connection was not made for "${actionId}". Connect it again.`);
      }
      const connector = connectorOf(row.connector);
      const action = connector.actions.find((a) => a.id === actionId);
      if (!action) {
        throw new Error(`${connector.name} has no action "${actionId}".`);
      }
      // The run or chat the plugin's code runs in, where the runtime set it; else the plugin itself.
      const caller = currentCaller() ?? {
        who: { kind: "plugin" as const, id: plugin },
        where: { spaceId: row.spaceId },
      };
      reachesOutside(`plugin:${plugin}`, {
        connection: row.connector,
        action: actionId,
        kind: action.group === "destructive" ? "destructive" : action.group,
      });
      const out = await brokerCall({
        who: caller.who,
        where: { ...caller.where, spaceId: caller.where.spaceId ?? row.spaceId },
        connection: { kind: "plugin_connection", row, connector },
        action: { id: actionId },
        input: action.inputSchema.parse(input),
      });
      if (!out.ok) {
        throw new Error(out.reason);
      }
      return out.result as never;
    },

    async remove(id) {
      await db
        .delete(schema.pluginConnection)
        .where(and(eq(schema.pluginConnection.id, id), eq(schema.pluginConnection.plugin, plugin)));
    },
  };
}
