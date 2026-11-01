import type {
  PluginConnection,
  PluginConnections,
  PluginConnectorOffer,
} from "@engenty/wizards/plugin";
import { DEFAULT_CONNECTION_RULES } from "@engenty/wizards-shared/connectors";
import type { Lang } from "@engenty/wizards-shared/definition";
import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  brokerCall,
  currentCaller,
  grantedScopes,
  kindOf,
  reachesOutside,
} from "../broker/index.js";
import { db, schema } from "../db/client.js";
import {
  buildAuthorizationUrl,
  createOAuth2Pkce,
  exchangeAuthorizationCode,
  type OAuth2Tokens,
} from "../engenty/connections-sdk/oauth2.js";
import type { ConnectorDefinition } from "../engenty/connections-sdk/types.js";
import { managed } from "../manage.js";
import { seal, unseal } from "../secrets/crypto.js";
import { currentTenant } from "../tenants/tenant.js";
import { builtinConnector, connectorFetch, resolveEnv, usable, viaAccount } from "./builtin.js";
import { connectRedirectUri as redirectUri } from "./index.js";
import {
  keepSpaceSignIn,
  type SpaceConnectionRow,
  type StoredTokens,
} from "./space-connections.js";
import { AccountConnectError, redeemTicket, startThroughAccount } from "./via-account.js";

/*
 * Accounts a plugin connects for a space (`server.connections`, docs/content/dev/plugins): the
 * runtime's built-in connectors, signed in through the same callback as a wizard's connections.
 * They are connections of the space (`space_connection`, docs/plans/capabilities.md) that sign
 * in as the space, open to everyone, with the default rules; the plugin that set one up is
 * noted on the row and sees only its own.
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

type Row = SpaceConnectionRow;

/** The broker's name for a plugin's own request through a connection (`connections.request`). */
const REQUEST = "request";

/**
 * What a plugin's connection reaches: the public internet in the cloud; on a local install the
 * local network too, where a person's own bucket (a NAS, a MinIO) is. A wizard's connections stay
 * on the public internet everywhere (`connectorFetch`).
 */
const pluginFetch: typeof fetch = managed ? connectorFetch : (input, init) => fetch(input, init);

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
  const same = await db.query.spaceConnection.findFirst({
    where: and(
      eq(schema.spaceConnection.plugin, input.plugin),
      eq(schema.spaceConnection.spaceId, input.spaceId),
      eq(schema.spaceConnection.connectorId, input.connector),
      eq(schema.spaceConnection.label, input.label),
    ),
  });
  if (same) {
    await db
      .update(schema.spaceConnection)
      .set({ actions: input.actions, updatedAt: new Date() })
      .where(eq(schema.spaceConnection.id, same.id));
    await keepSpaceSignIn(same, input.label, input.stored);
    return (await db.query.spaceConnection.findFirst({
      where: eq(schema.spaceConnection.id, same.id),
    })) as Row;
  }
  const [row] = await db
    .insert(schema.spaceConnection)
    .values({
      id: nanoid(14),
      spaceId: input.spaceId,
      connectorId: input.connector,
      plugin: input.plugin,
      name: input.label,
      label: input.label,
      signIn: "space",
      audience: "all",
      rules: DEFAULT_CONNECTION_RULES,
      actions: input.actions,
      secret: seal(input.stored),
      setUpBy: null,
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
  connector: row.connectorId,
  label: row.label ?? row.name,
  actions: row.actions,
  createdAt: row.setUpAt.toISOString(),
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
    db.query.spaceConnection.findFirst({
      where: and(eq(schema.spaceConnection.id, id), eq(schema.spaceConnection.plugin, plugin)),
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

    async start({ space, connector: connectorId, actions, scopes: more, lang }) {
      const connector = oauthConnector(connectorId);
      if (connector.auth.kind !== "oauth2") {
        throw new Error("not an oauth connector");
      }
      await spaceExists(space);
      const scopes = [...new Set([...scopesOf(connector, actions), ...(more ?? [])])];
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
        account = await connector.auth.apiKey.verify(keys, pluginFetch);
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
      const rows = await db.query.spaceConnection.findMany({
        where: and(
          eq(schema.spaceConnection.plugin, plugin),
          eq(schema.spaceConnection.spaceId, space),
        ),
        orderBy: [desc(schema.spaceConnection.setUpAt)],
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
      if (row.actions.length && !row.actions.includes(actionId)) {
        throw new Error(`The connection was not made for "${actionId}". Connect it again.`);
      }
      const connector = connectorOf(row.connectorId);
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
        connection: row.connectorId,
        action: actionId,
        kind: kindOf(action.group),
      });
      const out = await brokerCall({
        who: caller.who,
        where: { ...caller.where, spaceId: caller.where.spaceId ?? row.spaceId },
        connection: { kind: "space_connection", row, connector },
        action: { id: actionId },
        input: action.inputSchema.parse(input),
      });
      if (!out.ok) {
        throw new Error(out.reason);
      }
      return out.result as never;
    },

    async request(id, request) {
      const row = await own(id);
      if (!row) {
        throw new Error(`There is no connection "${id}".`);
      }
      const connector = connectorOf(row.connectorId);
      const capability = connector.request;
      if (!capability) {
        throw new Error(`${connector.name} takes no requests of a plugin.`);
      }
      const kind = request.kind ?? "read";
      const caller = currentCaller() ?? {
        who: { kind: "plugin" as const, id: plugin },
        where: { spaceId: row.spaceId },
      };
      reachesOutside(`plugin:${plugin}`, { connection: row.connectorId, action: REQUEST, kind });
      const out = await brokerCall<Response>({
        who: caller.who,
        where: { ...caller.where, spaceId: caller.where.spaceId ?? row.spaceId },
        connection: { kind: "space_connection", row, connector },
        action: { id: REQUEST, kind },
        input: { method: request.method ?? "GET", url: request.url.split("?")[0] },
        handler: async (account) => {
          const url = new URL(request.url);
          if (!capability.origins(account.ctx).includes(url.origin)) {
            throw new Error(`${connector.name} takes no requests to ${url.origin}.`);
          }
          const body = request.body as BodyInit | undefined;
          const unsigned = new Request(url, {
            method: request.method ?? "GET",
            headers: request.headers,
            body,
          });
          if (!capability.sign) {
            unsigned.headers.set("authorization", `Bearer ${account.ctx.accessToken}`);
          }
          const signed = capability.sign ? await capability.sign(account.ctx, unsigned) : unsigned;
          const res = await pluginFetch(signed.url, {
            method: signed.method,
            headers: signed.headers,
            body,
            signal: request.signal,
          });
          // The service turned the sign-in down: the broker hears of it, as of an action's.
          if (res.status === 401) {
            throw Object.assign(new Error(`${connector.name} refused the sign-in (401).`), {
              status: 401,
            });
          }
          return res;
        },
      });
      if (!out.ok) {
        throw new Error(out.reason);
      }
      return out.result;
    },

    async scopes(id) {
      const row = await own(id);
      return row ? grantedScopes(row) : [];
    },

    async remove(id) {
      await db
        .delete(schema.spaceConnection)
        .where(and(eq(schema.spaceConnection.id, id), eq(schema.spaceConnection.plugin, plugin)));
    },
  };
}
