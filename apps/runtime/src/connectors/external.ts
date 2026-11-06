import {
  type ActionKindChoice,
  CONNECTION_ACTION_KINDS,
  type ConnectorActionView,
  type ConnectorView,
  type DescribedSignIn,
  type ImportRequest,
  type RegistryHit,
  type RegistryService,
  type SignInChoice,
  type SourcePreview,
} from "@engenty/wizards-shared/connectors";
import { note } from "@engenty/wizards-shared/run";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { logRuleChange } from "../broker/log.js";
import { db, schema } from "../db/client.js";
import {
  buildImportedConnector,
  mcpHeaders,
} from "../engenty/connections-external/build-connector.js";
import { ImportValidationError } from "../engenty/connections-external/errors.js";
import {
  assembleRecord,
  connectorIdFromSlug,
  prepareSource,
  resolveRequiredHeaders,
  surfaceRequiresAuth,
  toolPrefixFromSlug,
} from "../engenty/connections-external/import-service.js";
import {
  groupIn,
  groupOf,
  recipientFieldIn,
} from "../engenty/connections-external/importer/classify.js";
import {
  mapAuth,
  mapAuthFromRegistry,
  mapAuthFromSecuritySchemes,
} from "../engenty/connections-external/importer/map-auth.js";
import { isUnauthorizedMcpError } from "../engenty/connections-external/invoke/mcp-client.js";
import { createGuardedFetch } from "../engenty/connections-external/net/guarded-fetch.js";
import {
  discoverImportableSources,
  discoverOAuthFacts,
  type RegistryOAuthFacts,
  registryDiscover,
  registrySearch,
  resolveMcpTransport,
} from "../engenty/connections-external/registry-client.js";
import { resolveRegistrySource } from "../engenty/connections-external/registry-source.js";
import type {
  ActionKindSet,
  ImportedConnectorRecord,
  NormalizedAction,
  StoredAuthConfig,
  StoredRequiredHeader,
} from "../engenty/connections-external/types.js";
import type { ConnectorDefinition } from "../engenty/connections-sdk/types.js";
import { encryptToken } from "../engenty/shims/connections-sdk.js";
import { assertPublicHttpHost } from "../engenty/shims/web-ingest.js";
import { env } from "../env.js";
import { managed } from "../manage.js";
import { requireAdmin, requireWritableSpace } from "../services/access.js";
import { ServiceError } from "../services/errors.js";
import { BUILTIN_CONNECTORS, builtinConnector, missingSetup, usable } from "./builtin.js";

/**
 * Imported connectors: any service becomes a connector from its OpenAPI spec or MCP server,
 * found through the integrations registry or pasted as a URL. Searching, normalising, auth
 * mapping and invoking are engenty's (`apps/runtime/src/engenty/connections-external`); kept here is what
 * engenty leaves to its host — where the records live and who may import.
 *
 * A pasted address (docs/plans/capabilities-next.md, piece 1) is one the registry lists nothing
 * at. Its sign-in is what the source describes itself or what the admin chooses, its id comes
 * from its host, an admin says what each action does, and on a computer of one's own it may be a
 * private address. The studio marks such a connector „nicht geprüft“.
 */

// engenty's dynamic client registration reads the redirect from this variable.
process.env.CONNECTIONS_REDIRECT_URI ??=
  env.connectRedirectUrl || `${env.appUrl}/api/connect/callback`;

const where = (spaceId: string, id: string) =>
  and(eq(schema.spaceConnector.spaceId, spaceId), eq(schema.spaceConnector.id, id));

async function loadRow(spaceId: string, id: string) {
  return (await db.query.spaceConnector.findFirst({ where: where(spaceId, id) })) ?? null;
}

async function load(spaceId: string, id: string): Promise<ImportedConnectorRecord | null> {
  return (await loadRow(spaceId, id))?.record ?? null;
}

/** Keeps a record. `bundleId` is given once, when a plugin brings the connector (`bundles/`). */
async function save(spaceId: string, record: ImportedConnectorRecord, bundleId?: string) {
  await db
    .insert(schema.spaceConnector)
    .values({ spaceId, id: record.id, record, ...(bundleId ? { bundleId } : {}) })
    .onConflictDoUpdate({
      target: [schema.spaceConnector.spaceId, schema.spaceConnector.id],
      set: { record, updatedAt: new Date() },
    });
}

/** What a connector came with: the record of a plugin taken into the space, by its name. */
type BundleRef = { id: string; name: string } | null;

async function bundleRef(bundleId: string | null): Promise<BundleRef> {
  if (!bundleId) {
    return null;
  }
  const row = await db.query.spaceBundle.findFirst({
    where: eq(schema.spaceBundle.id, bundleId),
    columns: { id: true, name: true },
  });
  return row ?? null;
}

/** The properties a JSON schema of an object names. */
const propertiesOf = (schema: unknown): string[] => {
  const properties = (schema as { properties?: unknown } | null)?.properties;
  return properties && typeof properties === "object" ? Object.keys(properties) : [];
};

/** An action's input fields: the top-level ones, and those of an HTTP body as `body.<name>`. */
function fieldsOf(action: NormalizedAction): string[] {
  const top = propertiesOf(action.input_json_schema);
  if (action.invoke.kind !== "http") {
    return top.slice(0, 60);
  }
  const body = propertiesOf(
    (action.input_json_schema.properties as Record<string, unknown> | undefined)?.body,
  );
  return [
    ...top.filter((name) => name !== "body" || !body.length),
    ...body.map((name) => `body.${name}`),
  ].slice(0, 60);
}

/** An action as the studio lists it: what it does (an admin's word before the guess), its fields. */
const actionView = (
  record: Pick<ImportedConnectorRecord, "action_kinds">,
  a: NormalizedAction,
): ConnectorActionView => {
  const recipientField = recipientFieldIn(record, a);
  return {
    id: a.id,
    summary: (a.summary || a.description).slice(0, 160),
    group: groupIn(record, a),
    ...(recipientField ? { recipientField } : {}),
    fields: fieldsOf(a),
  };
};

/** Imported from a pasted address: the registry lists no surface behind it. */
const fromAddress = (record: Pick<ImportedConnectorRecord, "registry_surface_slug">) =>
  !record.registry_surface_slug;

/**
 * Whether requests for a source may reach this computer and its private networks: a source from
 * a pasted address, on a runtime that is a computer of one's own. It is asked at every request
 * and kept nowhere, so the same record on a managed runtime stays behind the guard.
 */
const reachesPrivate = (pasted: boolean) => pasted && !managed;

const hostOf = (sourceUrl: string) => new URL(sourceUrl).host;

/** Whether the guard refuses an address as one outside the public internet. */
async function isPrivateAddress(sourceUrl: string): Promise<boolean> {
  try {
    await assertPublicHttpHost(sourceUrl);
    return false;
  } catch (err) {
    return /not allowed for fetch|blocked IP/.test(err instanceof Error ? err.message : "");
  }
}

/**
 * The fetch a source's requests go through, and whether its address is a private one. A pasted
 * private address is taken on a computer of one's own and refused in words on a managed runtime;
 * everything else goes through the guard as it always did.
 */
async function reachOf(
  sourceUrl: string,
  pasted: boolean,
): Promise<{ fetchImpl: typeof fetch; privateAddress: boolean }> {
  const privateAddress = pasted && (await isPrivateAddress(sourceUrl));
  if (privateAddress && managed) {
    throw new ServiceError("invalid", note("connectorPrivateAddress", { host: hostOf(sourceUrl) }));
  }
  return {
    fetchImpl: createGuardedFetch(reachesPrivate(pasted) ? { allowPrivate: true } : {}),
    privateAddress,
  };
}

function view(record: ImportedConnectorRecord, bundle: BundleRef = null): ConnectorView {
  const auth = record.auth_config;
  const needsOAuthClient =
    auth.kind === "oauth2" && !record.client_id_enc && !(auth.dcr && auth.registration_endpoint);
  return {
    usable: !needsOAuthClient,
    missingSetup: null,
    id: record.id,
    name: record.name,
    domain: record.domain,
    sourceKind: record.source_kind,
    sourceUrl: record.source_url,
    toolPrefix: record.tool_prefix,
    auth: auth.kind,
    needsOAuthClient,
    toolsPending: record.source_kind === "mcp" && record.actions.length === 0,
    fromAddress: fromAddress(record),
    bundle,
    actions: record.actions.map((a) => actionView(record, a)),
    importedAt: record.imported_at,
    refreshedAt: record.refreshed_at,
  };
}

/** What the admin can fix is told as it is; anything else is the registry or the source failing. */
function importFailure(err: unknown): ServiceError {
  const message = err instanceof Error ? err.message : String(err);
  return new ServiceError(err instanceof ImportValidationError ? "invalid" : "refused", message);
}

/** Headers a key never goes in: the request's own, and the MCP session's. */
const RESERVED_HEADERS = new Set([
  "host",
  "content-length",
  "content-type",
  "connection",
  "transfer-encoding",
  "accept",
  "mcp-session-id",
  "mcp-protocol-version",
]);

/** An admin's choice for the sign-in of a pasted address (shared `SignInChoice`). */
export const signInChoiceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("described") }),
  z.object({
    kind: z.literal("header"),
    name: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/)
      .refine((name) => !RESERVED_HEADERS.has(name.toLowerCase())),
    /** What stands before the key: `Bearer`, `Token`. */
    scheme: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9-]{0,19}$/)
      .optional(),
    /** The key, to list an MCP server's tools now; it is kept nowhere. */
    value: z
      .string()
      .min(1)
      .max(2000)
      .regex(/^[^\r\n]+$/)
      .optional(),
  }),
  z.object({ kind: z.literal("none") }),
]);

export const actionKindSchema = z.object({
  kind: z.enum(CONNECTION_ACTION_KINDS),
  recipientField: z.string().min(1).max(200).optional(),
});

/** What the studio sends to read an address: `sourceKind` left out, the runtime finds it. */
export const connectorPreviewSchema = z.object({
  domain: z.string().min(1).max(253).optional(),
  sourceKind: z.enum(["openapi", "mcp"]).optional(),
  sourceUrl: z.string().url(),
  signIn: signInChoiceSchema.optional(),
});

/** What the studio, the architect and MCP clients send to import a connector. */
export const connectorImportSchema = z.object({
  domain: z.string().min(1).max(253).optional(),
  sourceKind: z.enum(["openapi", "mcp"]),
  sourceUrl: z.string().url(),
  id: z.string().min(2).max(60).optional(),
  toolPrefix: z.string().min(2).max(31).optional(),
  name: z.string().min(1).max(120).optional(),
  actions: z.array(z.string()).max(500).optional(),
  oauthClientId: z.string().max(500).optional(),
  oauthClientSecret: z.string().max(500).optional(),
  signIn: signInChoiceSchema.optional(),
  actionKinds: z.record(z.string().max(200), actionKindSchema).optional(),
});

/** What an admin says single actions do; `null` takes an action back to what the importer read. */
export const actionKindsPatchSchema = z.object({
  actions: z.record(z.string().max(200), actionKindSchema.nullable()),
});

// --- the registry ----------------------------------------------------------------

export async function searchRegistry(query: string): Promise<RegistryHit[]> {
  const results = await registrySearch({ query, limit: 12 });
  return results.map((r) => ({
    domain: r.domain,
    name: r.name,
    description: r.description,
    kinds: r.kinds.filter((k) => k === "openapi" || k === "mcp"),
  }));
}

export async function registryService(domain: string): Promise<RegistryService> {
  const { parsed } = await registryDiscover(domain).catch((err) => {
    throw importFailure(err);
  });
  return {
    domain: parsed.domain,
    summary: parsed.summary ?? parsed.description ?? null,
    sources: discoverImportableSources(parsed).map((s) => ({
      sourceKind: s.source_kind,
      sourceUrl: s.source_url,
      name: s.surface.name,
      blocked: s.blocked_reason,
      auth: s.surface.auth.status,
      suggestedId: connectorIdFromSlug(s.surface.slug),
      suggestedToolPrefix: toolPrefixFromSlug(s.surface.slug),
    })),
    credentials: Object.values(parsed.credentials).map((c) => ({
      label: c.label ?? c.type,
      setup: c.setup ?? null,
      url: c.generateUrl ?? null,
    })),
  };
}

/**
 * OAuth facts straight from an MCP server. The registry says "OAuth, see the server's well-known
 * document" for most MCP servers but probes only the service's main domain, so its own document
 * carries no endpoints for them, and of a pasted address it knows nothing. The server publishes
 * them itself: its protected-resource document (RFC 9728) names the authorization server, whose
 * metadata (RFC 8414, or OpenID Connect's) names the endpoints.
 */
async function probeOAuth(
  sourceUrl: string,
  guarded: typeof fetch = createGuardedFetch(),
): Promise<RegistryOAuthFacts | null> {
  const json = async (url: string) => {
    const res = await guarded(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    return res?.ok
      ? ((await res.json().catch(() => null)) as Record<string, unknown> | null)
      : null;
  };
  const first = async (urls: string[]) => {
    for (const url of [...new Set(urls)]) {
      const found = await json(url);
      if (found) {
        return found;
      }
    }
    return null;
  };
  const text = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  const { origin, pathname } = new URL(sourceUrl);
  const path = pathname.replace(/\/+$/, "");
  const resource = await first([
    `${origin}/.well-known/oauth-protected-resource${path}`,
    `${origin}/.well-known/oauth-protected-resource`,
  ]);
  const issuer = (text(list(resource?.authorization_servers)[0]) ?? origin).replace(/\/+$/, "");
  let issuerUrl: URL;
  try {
    issuerUrl = new URL(issuer);
  } catch {
    return null;
  }
  const issuerPath = issuerUrl.pathname.replace(/\/+$/, "");
  const server = await first([
    `${issuer}/.well-known/oauth-authorization-server`,
    `${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerPath}`,
    `${issuer}/.well-known/openid-configuration`,
    `${origin}/.well-known/oauth-authorization-server`,
  ]);
  const authorizationEndpoint = text(server?.authorization_endpoint);
  const tokenEndpoint = text(server?.token_endpoint);
  if (!(authorizationEndpoint && tokenEndpoint)) {
    return null;
  }
  const registrationEndpoint = text(server?.registration_endpoint);
  const scopes = list(server?.scopes_supported);
  return {
    authorizationEndpoint,
    tokenEndpoint,
    grantTypes: list(server?.grant_types_supported),
    // A long list is a catalogue, not what one client should ask for.
    scopes: scopes.length <= 8 ? scopes : [],
    ...(registrationEndpoint ? { registrationEndpoint, dcr: true } : {}),
  };
}

/** OAuth facts a server published as the sign-in the connector keeps; null where they are no authorization-code flow. */
function oauthSignIn(oauth: RegistryOAuthFacts): StoredAuthConfig | null {
  if (
    !(oauth.authorizationEndpoint && oauth.tokenEndpoint) ||
    (oauth.grantTypes.length > 0 && !oauth.grantTypes.includes("authorization_code"))
  ) {
    return null;
  }
  const registration = oauth.dcr === true ? oauth.registrationEndpoint?.trim() : undefined;
  return {
    kind: "oauth2",
    auth_url: oauth.authorizationEndpoint,
    token_url: oauth.tokenEndpoint,
    scopes: oauth.scopes,
    ...(registration ? { dcr: true, registration_endpoint: registration } : {}),
  };
}

/** A key or token in a header, as an admin chose it: the connection asks for the key. */
function headerSignIn(choice: Extract<SignInChoice, { kind: "header" }>): StoredAuthConfig {
  const scheme = choice.scheme?.trim();
  return {
    kind: "api_key",
    fields: [{ key: "api_key", label: "API key", required: true, secret: true }],
    placement: {
      in: "header",
      name: choice.name,
      value_template: scheme ? `${scheme} {{api_key}}` : "{{api_key}}",
    },
  };
}

/**
 * The sign-in a connector from a pasted address keeps: the admin's choice of a header or none
 * first, what the source describes else. A source that asks for a sign-in and describes none
 * needs the choice, and says so.
 */
function signInFor(
  sourceUrl: string,
  described: StoredAuthConfig | null,
  choice: SignInChoice | undefined,
): StoredAuthConfig {
  if (choice?.kind === "none") {
    return { kind: "none" };
  }
  if (choice?.kind === "header") {
    return headerSignIn(choice);
  }
  if (!described) {
    throw new ServiceError("invalid", note("connectorSignInUnknown", { host: hostOf(sourceUrl) }));
  }
  return described;
}

function describedView(auth: StoredAuthConfig | null): DescribedSignIn {
  return {
    described: auth?.kind ?? null,
    needsOAuthClient: auth?.kind === "oauth2" && !(auth.dcr && auth.registration_endpoint),
    keyIn: auth?.kind === "api_key" ? auth.placement.name : null,
  };
}

interface SourceInput {
  domain?: string;
  sourceKind: "openapi" | "mcp";
  sourceUrl: string;
  signIn?: SignInChoice;
  /** Headers with a fixed value a plugin sets on every request to its server (`bundles/`). */
  headers?: StoredRequiredHeader[];
}

/** What a plugin gives with a server it brings: the record it belongs to, and its fixed headers. */
export interface FromBundle {
  bundleId: string;
  headers: StoredRequiredHeader[];
}

/**
 * Fetch and normalise a source. One the registry lists comes with the registry's facts. A pasted
 * address has none: an MCP server is asked for its tools without a sign-in, and where it wants
 * one, for its own OAuth documents; an OpenAPI description says it in its security schemes.
 */
async function prepare(input: SourceInput) {
  const resolved = input.domain
    ? await resolveRegistrySource({ domain: input.domain, sourceUrl: input.sourceUrl })
    : { discover: null, surface: null };
  const { surface } = resolved;
  const pasted = !surface;
  const { fetchImpl, privateAddress } = await reachOf(input.sourceUrl, pasted);
  if (
    input.sourceKind === "mcp" &&
    surface &&
    resolved.discover &&
    surfaceRequiresAuth(surface) &&
    !discoverOAuthFacts(resolved.discover.parsed)
  ) {
    const oauth = await probeOAuth(input.sourceUrl, fetchImpl);
    if (oauth) {
      const parsed = resolved.discover.parsed;
      resolved.discover.parsed = {
        ...parsed,
        detect: { ...parsed.detect, auth: { ...parsed.detect?.auth, oauth } },
      };
    }
  }
  const blockers: string[] = [];
  if (surface) {
    try {
      resolveRequiredHeaders(surface);
    } catch (err) {
      blockers.push((err as Error).message);
    }
    if (surface.variables.length) {
      blockers.push(
        `this source needs ${surface.variables.map((v) => v.name).join(", ")} in its address — paste the resolved URL instead`,
      );
    }
    if (input.sourceKind === "mcp" && !resolveMcpTransport(surface)) {
      blockers.push(`unsupported MCP transport (${surface.transports.join(", ")})`);
    }
  }
  const source = {
    fetchImpl,
    requiredHeaders:
      !blockers.length && surface ? resolveRequiredHeaders(surface) : (input.headers ?? []),
    sourceKind: input.sourceKind,
    sourceUrl: input.sourceUrl,
    specOverrides: surface?.spec_overrides ?? [],
    transport: surface ? resolveMcpTransport(surface) : null,
  };
  let prepared = await prepareSource({
    ...source,
    deferMcpTools: input.sourceKind === "mcp" && surfaceRequiresAuth(surface),
  }).catch(async (err) => {
    // A server that answers 401 to streamable HTTP and does not speak SSE fails on the second
    // try, and the 401 is lost. Its own OAuth documents say what it was: it wants a sign-in,
    // and its tools come once an account is connected.
    if (pasted && input.sourceKind === "mcp" && (await probeOAuth(input.sourceUrl, fetchImpl))) {
      return prepareSource({ ...source, deferMcpTools: true });
    }
    throw err;
  });
  if (surface) {
    const mapped = mapAuth({
      discover: resolved.discover?.parsed ?? null,
      securitySchemes: prepared.normalized.security_schemes as Record<string, never> | null,
      sourceKind: input.sourceKind,
      surface,
    });
    return {
      ...resolved,
      prepared,
      blockers,
      pasted,
      privateAddress,
      described: mapped.ok ? mapped.auth : null,
    };
  }
  let described: StoredAuthConfig | null;
  if (input.sourceKind === "openapi") {
    const schemes = prepared.normalized.security_schemes;
    described =
      schemes && Object.keys(schemes).length
        ? mapAuthFromSecuritySchemes(schemes as Record<string, never>)
        : { kind: "none" };
  } else if (prepared.deferred_mcp_tools) {
    // It wants a sign-in: what it describes itself, then what the registry knows of its domain.
    const oauth = await probeOAuth(input.sourceUrl, fetchImpl);
    described =
      (oauth ? oauthSignIn(oauth) : null) ??
      (resolved.discover ? mapAuthFromRegistry(resolved.discover.parsed) : null);
    const { signIn } = input;
    if (signIn?.kind === "header" && signIn.value) {
      // The key the admin typed lists the tools now. A key the server refuses is said in words.
      const value = signIn.scheme ? `${signIn.scheme.trim()} ${signIn.value}` : signIn.value;
      prepared = await prepareSource({
        ...source,
        deferOnUnauthorized: false,
        mcpHeaders: { [signIn.name]: value },
      }).catch((err) => {
        throw isUnauthorizedMcpError(err)
          ? new ServiceError(
              "invalid",
              note("connectorKeyRefused", { host: hostOf(input.sourceUrl) }),
            )
          : err;
      });
    }
  } else {
    // Its tools list answered without a sign-in: it needs none.
    described = { kind: "none" };
  }
  return { ...resolved, prepared, blockers, pasted, privateAddress, described };
}

/** A two-letter country ending's second level: `co.uk`, `com.au`, `or.at`. */
const SECOND_LEVELS = new Set(["co", "com", "org", "net", "ac", "gv", "or", "gov", "edu"]);

/**
 * The id and tool prefix a pasted address suggests: its host without `www`, `mcp` or `api` in
 * front and without its ending (`crm.example.at` → `crm-example`, `mcp.linear.app` → `linear`).
 * A bare address or a name that is no id gets `server` in front.
 */
export function namesFromHost(host: string): { id: string; toolPrefix: string } {
  // `[::1]:9000` is an IPv6 address with a port; everything else ends in its port.
  const v6 = /^\[(.+)\]/.exec(host);
  const name = (v6 ? v6[1] : host.replace(/:\d+$/, "")).toLowerCase();
  let labels = name.split(".").filter(Boolean);
  const address = name.includes(":") || labels.every((l) => /^\d+$/.test(l));
  if (!address) {
    if (labels.length > 2 && ["www", "mcp", "api"].includes(labels[0])) {
      labels = labels.slice(1);
    }
    if (labels.length > 1) {
      const end = labels.at(-1) as string;
      const second = labels.at(-2) as string;
      labels = labels.slice(
        0,
        labels.length > 2 && end.length === 2 && SECOND_LEVELS.has(second) ? -2 : -1,
      );
    }
  }
  const slug = connectorIdFromSlug(address ? `server-${name}` : labels.join("-"));
  const id = /^[a-z][a-z0-9-]{1,59}$/.test(slug)
    ? slug
    : connectorIdFromSlug(`server-${slug}`) || "server";
  return { id, toolPrefix: toolPrefixFromSlug(id) };
}

/** A suggested id and tool prefix no connector of the space has yet: `crm`, then `crm-2`. */
export async function freeNames(
  spaceId: string,
  suggested: { id: string; toolPrefix: string },
): Promise<{ id: string; toolPrefix: string }> {
  const taken = await listConnectors(spaceId);
  for (let n = 1; n < 50; n++) {
    const tail = n === 1 ? "" : `${n}`;
    const id = tail ? `${suggested.id.slice(0, 57)}-${tail}` : suggested.id;
    const toolPrefix = tail ? `${suggested.toolPrefix.slice(0, 27)}_${tail}` : suggested.toolPrefix;
    if (!taken.some((c) => c.id === id || c.toolPrefix === toolPrefix)) {
      return { id, toolPrefix };
    }
  }
  return suggested;
}

/** Which kind an address is tried as first: a file that names itself a description, else an MCP server. */
const kindsToTry = (sourceUrl: string): ("openapi" | "mcp")[] =>
  /\.(json|ya?ml)$|openapi|swagger/i.test(new URL(sourceUrl).pathname)
    ? ["openapi", "mcp"]
    : ["mcp", "openapi"];

/**
 * Reads an address before anything is imported: what answers there (an MCP server or an OpenAPI
 * description), its actions with what each was read as, how it signs in, and the names its host
 * suggests. For admins of a space that can be changed here.
 */
export async function previewSource(
  spaceId: string,
  input: Omit<SourceInput, "sourceKind"> & { sourceKind?: "openapi" | "mcp" },
): Promise<SourcePreview> {
  await requireWritableSpace(spaceId);
  await requireAdmin();
  let failed: unknown;
  for (const sourceKind of input.sourceKind ? [input.sourceKind] : kindsToTry(input.sourceUrl)) {
    let found: Awaited<ReturnType<typeof prepare>>;
    try {
      found = await prepare({ ...input, sourceKind });
    } catch (err) {
      // What is the same for either kind: a private address in the cloud, a key refused.
      if (err instanceof ServiceError) {
        throw err;
      }
      failed ??= err;
      continue;
    }
    const { prepared, surface } = found;
    const host = hostOf(input.sourceUrl);
    const names = await freeNames(
      spaceId,
      surface
        ? { id: connectorIdFromSlug(surface.slug), toolPrefix: toolPrefixFromSlug(surface.slug) }
        : namesFromHost(host),
    );
    return {
      sourceKind,
      host,
      suggestedId: names.id,
      suggestedToolPrefix: names.toolPrefix,
      title: prepared.normalized.title ?? surface?.name ?? null,
      actions: prepared.normalized.actions.map((a) => actionView({}, a)),
      blockers: found.blockers,
      dropped: prepared.normalized.dropped_count,
      toolsPending: prepared.deferred_mcp_tools === true,
      signIn: describedView(found.described),
      fromAddress: found.pasted,
      privateAddress: found.privateAddress,
    };
  }
  if (input.sourceKind) {
    throw importFailure(failed);
  }
  throw new ServiceError(
    "invalid",
    note("connectorAddressNotRead", {
      host: hostOf(input.sourceUrl),
      detail: (failed instanceof Error ? failed.message : String(failed)).slice(0, 300),
    }),
  );
}

/**
 * What an admin says single actions do, checked against the actions: an action that is not
 * there is an error (`strict`) or left out, a recipient's field must be one of the action's.
 */
function checkedKinds(
  record: Pick<ImportedConnectorRecord, "actions" | "name">,
  choices: Record<string, ActionKindChoice>,
  strict: boolean,
): Record<string, ActionKindSet> {
  const kinds: Record<string, ActionKindSet> = {};
  for (const [id, choice] of Object.entries(choices)) {
    const action = record.actions.find((a) => a.id === id);
    if (!action) {
      if (strict) {
        throw new ServiceError("invalid", note("connectorNoAction", { name: record.name, id }));
      }
      continue;
    }
    const field = choice.kind === "send" ? choice.recipientField?.trim() : undefined;
    const fields = fieldsOf(action);
    if (field && fields.length && !fields.some((f) => field === f || field.startsWith(`${f}.`))) {
      throw new ServiceError("invalid", note("connectorNoRecipientField", { id, field }));
    }
    // What the importer read anyway is not kept: a better guess later still applies.
    if (field || choice.kind !== groupOf(action)) {
      kinds[id] = { kind: choice.kind, ...(field ? { recipient_field: field } : {}) };
    }
  }
  return kinds;
}

// --- a space's connectors --------------------------------------------------------

async function builtinView(connector: ConnectorDefinition): Promise<ConnectorView> {
  const ready = await usable(connector);
  return {
    id: connector.id,
    name: connector.name,
    domain: "",
    sourceKind: "builtin",
    sourceUrl: "",
    toolPrefix: connector.toolPrefix,
    auth: connector.auth.kind === "oauth2" ? "oauth2" : "api_key",
    usable: ready,
    missingSetup: ready ? null : missingSetup(connector),
    needsOAuthClient: false,
    toolsPending: false,
    fromAddress: false,
    bundle: null,
    actions: connector.actions.map((a) => ({
      id: a.id,
      summary: a.summary.slice(0, 160),
      group: a.group,
    })),
    importedAt: "",
    refreshedAt: null,
  };
}

/** Every connector a wizard of the space can name: the built-in ones, then its imports. */
export async function listConnectors(spaceId: string): Promise<ConnectorView[]> {
  const rows = await db.query.spaceConnector.findMany({
    where: eq(schema.spaceConnector.spaceId, spaceId),
    orderBy: [asc(schema.spaceConnector.createdAt)],
  });
  const bundleIds = [...new Set(rows.flatMap((r) => (r.bundleId ? [r.bundleId] : [])))];
  const bundles = bundleIds.length
    ? await db
        .select({ id: schema.spaceBundle.id, name: schema.spaceBundle.name })
        .from(schema.spaceBundle)
        .where(inArray(schema.spaceBundle.id, bundleIds))
    : [];
  return [
    ...(await Promise.all(BUILTIN_CONNECTORS.map(builtinView))),
    ...rows.map((r) => view(r.record, bundles.find((b) => b.id === r.bundleId) ?? null)),
  ];
}

/**
 * A connector by id, ready to run, with the JSON schema of each action's input: a built-in one,
 * or one the space imported.
 */
export async function resolveConnector(
  spaceId: string,
  id: string,
): Promise<{
  connector: ConnectorDefinition;
  inputSchema(actionId: string): Record<string, unknown>;
  imported: boolean;
  /** Imported from a pasted address: a new connection on it starts for the admins. */
  fromAddress: boolean;
  /** The record of the plugin that brought it, where one did: a connection on it carries it too. */
  bundleId: string | null;
} | null> {
  const builtin = builtinConnector(id);
  if (builtin) {
    return {
      connector: builtin,
      imported: false,
      fromAddress: false,
      bundleId: null,
      inputSchema: (actionId) => {
        const action = builtin.actions.find((a) => a.id === actionId);
        try {
          return action ? (z.toJSONSchema(action.inputSchema) as Record<string, unknown>) : {};
        } catch {
          return {};
        }
      },
    };
  }
  const found = await importedConnector(spaceId, id);
  return found
    ? {
        connector: found.connector,
        imported: true,
        fromAddress: fromAddress(found.record),
        bundleId: found.bundleId,
        inputSchema: (actionId) =>
          found.record.actions.find((a) => a.id === actionId)?.input_json_schema ?? {},
      }
    : null;
}

export async function importConnector(
  userId: string,
  spaceId: string,
  input: ImportRequest,
  /** A plugin brings it (`bundles/`): the record it belongs to, and the headers it sets. */
  from?: FromBundle,
): Promise<{ connector: ConnectorView; warnings: string[] }> {
  await requireWritableSpace(spaceId);
  await requireAdmin();
  // A pasted address names itself: its host is the domain and suggests the id and the prefix.
  const host = hostOf(input.sourceUrl);
  const suggested = namesFromHost(host);
  const id = input.id ?? suggested.id;
  const toolPrefix = input.toolPrefix ?? suggested.toolPrefix;
  if (await load(spaceId, id)) {
    throw new ServiceError("invalid", note("connectorAlreadyExistsSpace", { id }));
  }
  try {
    const { discover, surface, prepared, pasted, described } = await prepare({
      ...input,
      ...(from ? { headers: from.headers } : {}),
    });
    const name = input.name ?? null;
    const { record: assembled, warnings } = assembleRecord({
      actionFilter: input.actions ?? null,
      actionKinds: input.actionKinds
        ? checkedKinds(
            { actions: prepared.normalized.actions, name: name ?? host },
            input.actionKinds,
            false,
          )
        : null,
      // The registry knows nothing of a pasted address: its sign-in is what it describes itself
      // or what the admin chose.
      auth: pasted ? signInFor(input.sourceUrl, described, input.signIn) : null,
      discover: discover?.parsed ?? null,
      domain: input.domain ?? new URL(input.sourceUrl).hostname,
      id,
      importedBy: userId,
      name,
      oauthClient:
        input.oauthClientId && input.oauthClientSecret
          ? { clientId: input.oauthClientId, clientSecret: input.oauthClientSecret }
          : null,
      prepared,
      // The registry's own document is not kept: the record holds what was made of it.
      rawDiscover: null,
      sourceKind: input.sourceKind,
      sourceUrl: input.sourceUrl,
      surface,
      tenantId: spaceId,
      toolPrefix,
    });
    // The registry's headers come with its surface; a plugin's own are kept the same way.
    const record: ImportedConnectorRecord =
      pasted && from?.headers.length ? { ...assembled, required_headers: from.headers } : assembled;
    const { skippedActions } = buildImportedConnector(record);
    if (skippedActions.length) {
      warnings.push(`${skippedActions.length} action(s) have an input the tools cannot express`);
    }
    await save(spaceId, record, from?.bundleId);
    return { connector: view(record, await bundleRef(from?.bundleId ?? null)), warnings };
  } catch (err) {
    throw err instanceof ServiceError ? err : importFailure(err);
  }
}

/**
 * Imports a registry service by its domain, for callers that do not pick a source by hand (the
 * architect, MCP clients): the first importable source of the wanted kind, MCP before OpenAPI —
 * an MCP server is the service's own, curated set of actions.
 */
export async function importFromRegistry(
  userId: string,
  spaceId: string,
  input: { domain: string; kind?: "mcp" | "openapi" },
): Promise<{ connector: ConnectorView; warnings: string[] }> {
  await requireWritableSpace(spaceId);
  await requireAdmin();
  const service = await registryService(input.domain);
  const order = input.kind ? [input.kind] : (["mcp", "openapi"] as const);
  const source = order
    .flatMap((kind) => service.sources.filter((s) => s.sourceKind === kind))
    .find((s) => !s.blocked);
  if (!source) {
    const why = service.sources.map((s) => `${s.sourceKind}: ${s.blocked}`).join("; ");
    throw new ServiceError(
      "invalid",
      `${input.domain} has nothing that can be imported${why ? ` (${why})` : ""}.`,
    );
  }
  const taken = (await listConnectors(spaceId)).find((c) => c.id === source.suggestedId);
  if (taken) {
    return { connector: taken, warnings: ["already imported"] };
  }
  return importConnector(userId, spaceId, {
    domain: service.domain,
    sourceKind: source.sourceKind,
    sourceUrl: source.sourceUrl,
    id: source.suggestedId,
    toolPrefix: source.suggestedToolPrefix,
    ...(source.name ? { name: source.name } : {}),
  });
}

export async function removeConnector(spaceId: string, id: string) {
  await requireWritableSpace(spaceId);
  await requireAdmin();
  await db.delete(schema.spaceConnector).where(where(spaceId, id));
}

/**
 * Re-reads the source and replaces the connector's actions; what an admin said single actions do
 * stays. An MCP server that only lists its tools to a signed-in account needs that account's
 * token: a run passes the one it calls with, the studio's „Aktionen neu laden“ the one of a
 * signed-in connection (`reload.ts`, which asks for an admin).
 */
export async function refreshConnector(
  spaceId: string,
  id: string,
  accessToken: string | null,
): Promise<ConnectorView> {
  await requireWritableSpace(spaceId);
  const record = await load(spaceId, id);
  if (!record) {
    throw new ServiceError("not_found", note("connectorNotExist"));
  }
  try {
    const { surface } = record.registry_surface_slug
      ? await resolveRegistrySource({ domain: record.domain, sourceUrl: record.source_url })
      : { surface: null };
    const { fetchImpl } = await reachOf(record.source_url, fromAddress(record));
    const requiredHeaders = surface ? resolveRequiredHeaders(surface) : record.required_headers;
    const transport =
      record.source_kind === "mcp"
        ? ((surface ? resolveMcpTransport(surface) : null) ??
          record.mcp_transport ??
          "streamable-http")
        : null;
    const prepared = await prepareSource({
      deferOnUnauthorized: false,
      fetchImpl,
      mcpHeaders: accessToken ? mcpHeaders(record, accessToken) : undefined,
      requiredHeaders,
      sourceKind: record.source_kind,
      sourceUrl: record.source_url,
      specOverrides: surface?.spec_overrides ?? [],
      transport,
    });
    const updated: ImportedConnectorRecord = {
      ...record,
      actions: prepared.normalized.actions,
      base_url: record.base_url ?? prepared.normalized.base_url,
      mcp_transport: transport,
      refreshed_at: new Date().toISOString(),
      required_headers: requiredHeaders,
      spec_hash: prepared.spec_hash,
    };
    await save(spaceId, updated);
    return (await importedView(spaceId, id)) ?? view(updated);
  } catch (err) {
    throw err instanceof ServiceError ? err : importFailure(err);
  }
}

/** A connector the space imported, as the studio shows it; null where there is none. */
export async function importedView(spaceId: string, id: string): Promise<ConnectorView | null> {
  const row = await loadRow(spaceId, id);
  return row ? view(row.record, await bundleRef(row.bundleId)) : null;
}

/**
 * An admin says what single actions of an imported connector do: read, write, delete or send,
 * and for a send the input field that holds the recipient. The broker decides by it from the
 * next call on, so every connection on the connector hears of a changed kind like a changed rule.
 */
export async function setActionKinds(
  userId: string,
  spaceId: string,
  id: string,
  choices: Record<string, ActionKindChoice | null>,
): Promise<ConnectorView> {
  await requireWritableSpace(spaceId);
  await requireAdmin();
  const record = await load(spaceId, id);
  if (!record) {
    throw new ServiceError("not_found", note("connectorNotExist"));
  }
  const set = Object.fromEntries(
    Object.entries(choices).filter((entry): entry is [string, ActionKindChoice] => !!entry[1]),
  );
  const said = checkedKinds(record, set, true);
  const kinds = { ...record.action_kinds };
  for (const actionId of Object.keys(choices)) {
    if (said[actionId]) {
      kinds[actionId] = said[actionId];
    } else {
      // Taken back, or said as the importer read it anyway: the guess applies again.
      delete kinds[actionId];
    }
  }
  const updated: ImportedConnectorRecord = { ...record, action_kinds: kinds };
  const changed = record.actions
    .filter((a) => groupIn(record, a) !== groupIn(updated, a))
    .map((a) => `${a.id}: ${groupIn(record, a)} → ${groupIn(updated, a)}`);
  await save(spaceId, updated);
  if (changed.length) {
    const connections = await db.query.spaceConnection.findMany({
      where: and(
        eq(schema.spaceConnection.spaceId, spaceId),
        eq(schema.spaceConnection.connectorId, id),
      ),
      columns: { id: true },
    });
    for (const connection of connections) {
      await logRuleChange({
        userId,
        spaceId,
        connectionId: connection.id,
        summary: { kinds: changed.join(", ") },
        reason: `What ${record.name}'s actions do was changed: ${changed.join(", ")}.`,
      });
    }
  }
  return (await importedView(spaceId, id)) ?? view(updated);
}

/** The connector as engenty's framework runs it: actions with handlers, auth with its flows. */
export async function importedConnector(
  spaceId: string,
  id: string,
): Promise<{
  connector: ConnectorDefinition;
  record: ImportedConnectorRecord;
  bundleId: string | null;
} | null> {
  const row = await loadRow(spaceId, id);
  if (!row) {
    return null;
  }
  const { record } = row;
  // The record is read at call time, so a client registered a moment ago is the one used.
  let current = record;
  const { connector } = buildImportedConnector(
    record,
    () => current,
    async (client) => {
      current = {
        ...current,
        client_id_enc: encryptToken(client.clientId),
        client_secret_enc: client.clientSecret ? encryptToken(client.clientSecret) : null,
      };
      await save(spaceId, current);
    },
    { allowPrivate: reachesPrivate(fromAddress(record)) },
  );
  return { connector, record, bundleId: row.bundleId };
}
