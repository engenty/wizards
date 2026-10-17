import { isLang, type Lang } from "@engenty-wizards/shared/definition";
import { note, type RunNote } from "@engenty-wizards/shared/run";
import type {
  ConnectionDef,
  ConnectionKind,
  ConnectionView,
  ConnectorOption,
} from "@engenty-wizards/shared/store";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import {
  buildAuthorizationUrl,
  createOAuth2Pkce,
  exchangeAuthorizationCode,
  refreshAccessToken,
} from "../engenty/connections-sdk/oauth2.js";
import {
  type ConnectorActionContext,
  type ConnectorDefinition,
  scopesForGroups,
} from "../engenty/connections-sdk/types.js";
import { env } from "../env.js";
import { NotedError } from "../model-errors.js";
import { seal, unseal } from "../secrets/crypto.js";
import { deleteSecret, getSecret, putSecret, type StoreScope } from "../store/index.js";
import { type ServerKey, serverText } from "../texts.js";
import { connectorFetch, MAIL_CONNECTORS, resolveEnv, usable, viaAccount } from "./builtin.js";
import { resolveConnector } from "./external.js";
import {
  AccountConnectError,
  redeemTicket,
  refreshThroughAccount,
  startThroughAccount,
} from "./via-account.js";

/** The connectors a person can pick for each kind of connection. */
const CONNECTORS: Record<ConnectionKind, ConnectorDefinition[]> = { mail: MAIL_CONNECTORS };

const HINTS: Record<string, ServerKey> = { imap: "imapHint" };

type FieldWords = Record<string, Record<string, { label?: string; placeholder?: string }>>;

/** The built-in connectors' fields in each language; their definitions say them in English. */
const FIELD_WORDS: { [L in Exclude<Lang, "en">]?: FieldWords } = {
  de: {
    imap: {
      email: { label: "E-Mail-Adresse", placeholder: "name@firma.at" },
      password: { label: "Passwort oder App-Passwort" },
      host: { label: "IMAP-Server", placeholder: "leer lassen bei Gmail, GMX, iCloud …" },
    },
  },
};

/**
 * What a connection asks the provider for: what reading needs, plus what each action the wizard
 * may use needs. A wizard that only reads never asks for the right to send or delete.
 */
function scopesFor(connection: ConnectionDef, connector: ConnectorDefinition): string[] {
  const scopes = new Set(scopesForGroups(connector, new Set(["read"] as const)));
  for (const action of connector.actions) {
    if (connection.actions?.includes(action.id)) {
      for (const scope of action.providerScopes ?? []) {
        scopes.add(scope);
      }
    }
  }
  return [...scopes];
}

/** Where the provider sends the person back; must be registered with the OAuth client. */
export function connectRedirectUri(): string {
  return env.connectRedirectUrl || `${env.appUrl}/api/connect/callback`;
}

const slot = (connectionId: string) => `connection:${connectionId}`;

/** What is stored for a connected account. `accessToken` is the credentials JSON for `api_key`. */
interface StoredConnection {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  scopes: string[];
  /** Connected through the account's Manage-App, which also refreshes the token. */
  via?: "account";
}

/** A connector that needs no credential: there is nothing for the person to connect. */
const open = (connector: ConnectorDefinition) =>
  connector.auth.kind === "api_key" && connector.auth.apiKey.fields.length === 0;

/** The connectors behind a connection: the built-in ones of its kind, or the one it names. */
async function candidates(connection: ConnectionDef, projectId: string) {
  if (connection.connector) {
    const found = await resolveConnector(projectId, connection.connector);
    return found ? [found.connector] : [];
  }
  return connection.kind ? CONNECTORS[connection.kind] : [];
}

export async function connectorOptions(
  connection: ConnectionDef,
  projectId: string,
  lang: Lang = "en",
): Promise<ConnectorOption[]> {
  const out: ConnectorOption[] = [];
  for (const c of await candidates(connection, projectId)) {
    if (!(await usable(c))) {
      continue;
    }
    out.push(
      c.auth.kind === "api_key"
        ? {
            id: c.id,
            name: c.name,
            auth: "api_key",
            fields: c.auth.apiKey.fields.map((f) => ({
              ...f,
              ...(lang === "en" ? undefined : FIELD_WORDS[lang]?.[c.id]?.[f.key]),
            })),
            hint: HINTS[c.id] && serverText(lang, HINTS[c.id]),
          }
        : { id: c.id, name: c.name, auth: "oauth2" },
    );
  }
  return out;
}

async function connectorFor(
  connection: ConnectionDef,
  connectorId: string,
  projectId: string,
): Promise<ConnectorDefinition> {
  const connector = (await candidates(connection, projectId)).find((c) => c.id === connectorId);
  if (!connector) {
    throw new Error(`Unknown connector "${connectorId}".`);
  }
  return connector;
}

export async function connectionViews(
  connections: ConnectionDef[],
  scope: StoreScope,
  projectId: string,
  /** The language the person reads the connectors' fields in. */
  lang: Lang = "en",
): Promise<ConnectionView[]> {
  return Promise.all(
    connections.map(async (c) => {
      const stored = await getSecret<StoredConnection>(scope, slot(c.id));
      const only = c.connector ? (await candidates(c, projectId))[0] : undefined;
      return {
        id: c.id,
        kind: c.kind ?? null,
        connector: c.connector ?? null,
        title: c.title ?? only?.name ?? null,
        description: c.description ?? null,
        account: stored
          ? {
              connector: stored.provider,
              label: stored.label,
              connectedAt: stored.createdAt.toISOString(),
            }
          : only && open(only)
            ? { connector: only.id, label: only.name, connectedAt: new Date(0).toISOString() }
            : null,
        connectors: await connectorOptions(c, projectId, lang),
      };
    }),
  );
}

// --- connecting ----------------------------------------------------------------

/** Carried through the provider as `state`: sealed, so the PKCE verifier stays with us. */
interface OAuthState {
  scope: StoreScope;
  projectId: string;
  runId: string;
  connectionId: string;
  connectorId: string;
  verifier: string;
  exp: number;
  /** The language the person picked: the page the provider sends them back to speaks it. */
  lang?: Lang;
}

export async function startOAuth(
  scope: StoreScope,
  projectId: string,
  runId: string,
  connection: ConnectionDef,
  connectorId: string,
  lang?: Lang,
): Promise<string> {
  const connector = await connectorFor(connection, connectorId, projectId);
  if (connector.auth.kind !== "oauth2") {
    throw new Error(`${connector.name} is not connected by signing in.`);
  }
  if (await viaAccount(connector)) {
    // The Manage-App keeps the PKCE verifier; ours stays empty.
    const state: OAuthState = {
      scope,
      projectId,
      runId,
      connectionId: connection.id,
      connectorId,
      verifier: "",
      exp: Date.now() + 15 * 60_000,
      lang,
    };
    try {
      return await startThroughAccount(
        scopesFor(connection, connector),
        seal(state),
        connectRedirectUri(),
      );
    } catch (err) {
      throw err instanceof AccountConnectError ? new ConnectError(err.message) : err;
    }
  }
  // Servers that hand out OAuth clients on request (most MCP servers): get one on first use.
  await connector.auth.oauth2.registerClient?.();
  const pkce = createOAuth2Pkce();
  const state: OAuthState = {
    scope,
    projectId,
    runId,
    connectionId: connection.id,
    connectorId,
    verifier: pkce.codeVerifier,
    exp: Date.now() + 15 * 60_000,
    lang,
  };
  return buildAuthorizationUrl({
    connector,
    pkce,
    redirectUri: connectRedirectUri(),
    scopes: scopesFor(connection, connector),
    state: seal(state),
    resolveEnv,
  });
}

/** The language a sign-in was started in, a wizard's or a plugin's; null where it names none. */
export function oauthStateLang(rawState: string): Lang | null {
  const lang = unseal<{ lang?: unknown }>(rawState)?.lang;
  return isLang(lang) ? lang : null;
}

/** The run an OAuth callback belongs to; its tenant is looked up before the state is used. */
export function oauthStateRun(rawState: string): string | null {
  return unseal<OAuthState>(rawState)?.runId ?? null;
}

/**
 * Google came back: with a code, or — connected through the account's Manage-App — with a
 * ticket that holds the tokens.
 */
export async function finishOAuth(
  answer: { code: string } | { ticket: string },
  rawState: string,
): Promise<OAuthState> {
  const state = unseal<OAuthState>(rawState);
  if (!state || state.exp < Date.now()) {
    throw new Error("The sign-in has expired. Connect again.");
  }
  const run = await db.query.run.findFirst({ where: eq(schema.run.id, state.runId) });
  const connection = run?.definition.connections?.find((c) => c.id === state.connectionId);
  if (!connection) {
    throw new Error("The run this sign-in belongs to is gone.");
  }
  const connector = await connectorFor(connection, state.connectorId, state.projectId);
  if (connector.auth.kind !== "oauth2") {
    throw new Error("not an oauth connector");
  }
  const tokens =
    "ticket" in answer
      ? await redeemTicket(answer.ticket)
      : await exchangeAuthorizationCode({
          code: answer.code,
          codeVerifier: state.verifier,
          config: connector.auth.oauth2,
          redirectUri: connectRedirectUri(),
          resolveEnv,
        });
  // A provider that will not name the account still connected it.
  const account = (await connector.auth.oauth2
    .resolveAccount?.(tokens.accessToken, fetch)
    .catch(() => null)) ?? { label: connector.name };
  const stored: StoredConnection = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt?.toISOString() ?? null,
    scopes: tokens.grantedScopes,
    ...("ticket" in answer ? { via: "account" as const } : {}),
  };
  await putSecret(state.scope, slot(connection.id), connector.id, account.label, stored);
  return state;
}

/** Connects an `api_key` connector with what the person typed; the connector checks it first. */
export async function connectWithCredentials(
  scope: StoreScope,
  projectId: string,
  connection: ConnectionDef,
  connectorId: string,
  values: Record<string, string>,
): Promise<string> {
  const connector = await connectorFor(connection, connectorId, projectId);
  if (connector.auth.kind !== "api_key") {
    throw new Error(`${connector.name} is connected by signing in.`);
  }
  const credentials: Record<string, string> = {};
  for (const field of connector.auth.apiKey.fields) {
    const value = String(values[field.key] ?? "").trim();
    if (!value && field.required !== false) {
      throw new ConnectError(note("fieldMissing", { label: field.label }));
    }
    if (value) {
      credentials[field.key] = value.slice(0, 500);
    }
  }
  let account: { label: string };
  try {
    account = await connector.auth.apiKey.verify(credentials, connectorFetch);
  } catch (err) {
    throw new ConnectError(connectFailure(err));
  }
  const stored: StoredConnection = {
    accessToken: JSON.stringify(credentials),
    refreshToken: null,
    expiresAt: null,
    scopes: [],
  };
  await putSecret(scope, slot(connection.id), connector.id, account.label, stored);
  return account.label;
}

/** A connect attempt the person can fix (wrong password, unknown server). */
export class ConnectError extends NotedError {}

function connectFailure(err: unknown): RunNote {
  const e = err as {
    authenticationFailed?: boolean;
    code?: string;
    message?: string;
    responseText?: string;
    imapHost?: string;
  };
  const host = e.imapHost ? ` (${e.imapHost})` : "";
  if (e.authenticationFailed) {
    const answer = e.responseText?.slice(0, 160);
    return note("signInRefused", { host, answer: answer ? note("serverSaid", { answer }) : "" });
  }
  if (e.code === "ENOTFOUND") {
    return note("mailServerNotExist", { host });
  }
  if (e.code === "ETIMEDOUT" || e.code === "ETIMEOUT" || e.code === "ECONNREFUSED") {
    return note("mailServerNotResponding", { host });
  }
  const detail = String(e.message ?? err).slice(0, 200);
  return note("connectingNotWork", { host, detail });
}

export function disconnect(scope: StoreScope, connectionId: string) {
  return deleteSecret(scope, slot(connectionId));
}

// --- using ---------------------------------------------------------------------

/**
 * The connector and the context its actions run with, for a connection the person has
 * connected — with a fresh access token. `null` when nothing is connected.
 */
export async function connectionContext(
  scope: StoreScope,
  connection: ConnectionDef,
  projectId: string,
): Promise<{ connector: ConnectorDefinition; ctx: ConnectorActionContext; label: string } | null> {
  const stored = await getSecret<StoredConnection>(scope, slot(connection.id));
  if (!stored) {
    const only = connection.connector ? (await candidates(connection, projectId))[0] : undefined;
    return only && open(only)
      ? { connector: only, label: only.name, ctx: actionContext(scope, connection, only, "{}", []) }
      : null;
  }
  const connector = await connectorFor(connection, stored.provider, projectId);
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
