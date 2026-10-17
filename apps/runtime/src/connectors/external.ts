import type {
  ConnectorActionView,
  ConnectorView,
  ImportRequest,
  RegistryHit,
  RegistryService,
  SourcePreview,
} from "@engenty-wizards/shared/connectors";
import { note } from "@engenty-wizards/shared/run";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
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
  ImportedConnectorRecord,
  NormalizedAction,
} from "../engenty/connections-external/types.js";
import type { ConnectorDefinition } from "../engenty/connections-sdk/types.js";
import { encryptToken } from "../engenty/shims/connections-sdk.js";
import { env } from "../env.js";
import { requireAdmin, requireWritableProject } from "../services/access.js";
import { ServiceError } from "../services/errors.js";
import { BUILTIN_CONNECTORS, builtinConnector, missingSetup, usable } from "./builtin.js";

/**
 * Imported connectors: any service becomes a connector from its OpenAPI spec or MCP server,
 * found through the integrations registry or pasted as a URL. Searching, normalising, auth
 * mapping and invoking are engenty's (`apps/runtime/src/engenty/connections-external`); kept here is what
 * engenty leaves to its host — where the records live and who may import.
 */

// engenty's dynamic client registration reads the redirect from this variable.
process.env.CONNECTIONS_REDIRECT_URI ??=
  env.connectRedirectUrl || `${env.appUrl}/api/connect/callback`;

const where = (projectId: string, id: string) =>
  and(eq(schema.projectConnector.projectId, projectId), eq(schema.projectConnector.id, id));

async function load(projectId: string, id: string): Promise<ImportedConnectorRecord | null> {
  const row = await db.query.projectConnector.findFirst({ where: where(projectId, id) });
  return row?.record ?? null;
}

async function save(projectId: string, record: ImportedConnectorRecord) {
  await db
    .insert(schema.projectConnector)
    .values({ projectId, id: record.id, record })
    .onConflictDoUpdate({
      target: [schema.projectConnector.projectId, schema.projectConnector.id],
      set: { record, updatedAt: new Date() },
    });
}

const actionView = (a: NormalizedAction): ConnectorActionView => ({
  id: a.id,
  summary: (a.summary || a.description).slice(0, 160),
  group: a.classification,
});

function view(record: ImportedConnectorRecord): ConnectorView {
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
    actions: record.actions.map(actionView),
    importedAt: record.imported_at,
    refreshedAt: record.refreshed_at,
  };
}

/** What the admin can fix is told as it is; anything else is the registry or the source failing. */
function importFailure(err: unknown): ServiceError {
  const message = err instanceof Error ? err.message : String(err);
  return new ServiceError(err instanceof ImportValidationError ? "invalid" : "refused", message);
}

/** What the studio, the architect and MCP clients send to import a connector. */
export const connectorImportSchema = z.object({
  domain: z.string().min(1).max(253),
  sourceKind: z.enum(["openapi", "mcp"]),
  sourceUrl: z.string().url(),
  id: z.string().min(2).max(60),
  toolPrefix: z.string().min(2).max(31),
  name: z.string().min(1).max(120).optional(),
  actions: z.array(z.string()).max(500).optional(),
  oauthClientId: z.string().max(500).optional(),
  oauthClientSecret: z.string().max(500).optional(),
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
 * carries no endpoints for them. The server publishes them itself (RFC 9728, RFC 8414).
 */
async function probeOAuth(sourceUrl: string): Promise<RegistryOAuthFacts | null> {
  const guarded = createGuardedFetch();
  const json = async (url: string) => {
    const res = await guarded(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    return res?.ok
      ? ((await res.json().catch(() => null)) as Record<string, unknown> | null)
      : null;
  };
  const origin = new URL(sourceUrl).origin;
  const resource = await json(`${origin}/.well-known/oauth-protected-resource`);
  const issuer = (resource?.authorization_servers as string[] | undefined)?.[0] ?? origin;
  const server =
    (await json(`${issuer.replace(/\/+$/, "")}/.well-known/oauth-authorization-server`)) ??
    (await json(`${origin}/.well-known/oauth-authorization-server`));
  const text = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
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

/** Fetch and normalise a source with the facts the registry holds about it. */
async function prepare(input: {
  domain?: string;
  sourceKind: "openapi" | "mcp";
  sourceUrl: string;
}) {
  const resolved = input.domain
    ? await resolveRegistrySource({ domain: input.domain, sourceUrl: input.sourceUrl })
    : { discover: null, surface: null };
  const { surface } = resolved;
  if (
    input.sourceKind === "mcp" &&
    resolved.discover &&
    surfaceRequiresAuth(surface) &&
    !discoverOAuthFacts(resolved.discover.parsed)
  ) {
    const oauth = await probeOAuth(input.sourceUrl);
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
  const prepared = await prepareSource({
    deferMcpTools: input.sourceKind === "mcp" && surfaceRequiresAuth(surface),
    requiredHeaders: !blockers.length && surface ? resolveRequiredHeaders(surface) : [],
    sourceKind: input.sourceKind,
    sourceUrl: input.sourceUrl,
    specOverrides: surface?.spec_overrides ?? [],
    transport: surface ? resolveMcpTransport(surface) : null,
  });
  return { ...resolved, prepared, blockers };
}

export async function previewSource(input: {
  domain?: string;
  sourceKind: "openapi" | "mcp";
  sourceUrl: string;
}): Promise<SourcePreview> {
  const { prepared, blockers } = await prepare(input).catch((err) => {
    throw importFailure(err);
  });
  return {
    title: prepared.normalized.title,
    actions: prepared.normalized.actions.map(actionView),
    blockers,
    dropped: prepared.normalized.dropped_count,
    toolsPending: prepared.deferred_mcp_tools === true,
  };
}

// --- a project's connectors --------------------------------------------------------

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
    actions: connector.actions.map((a) => ({
      id: a.id,
      summary: a.summary.slice(0, 160),
      group: a.group,
    })),
    importedAt: "",
    refreshedAt: null,
  };
}

/** Every connector a wizard of the project can name: the built-in ones, then its imports. */
export async function listConnectors(projectId: string): Promise<ConnectorView[]> {
  const rows = await db.query.projectConnector.findMany({
    where: eq(schema.projectConnector.projectId, projectId),
    orderBy: [asc(schema.projectConnector.createdAt)],
  });
  return [
    ...(await Promise.all(BUILTIN_CONNECTORS.map(builtinView))),
    ...rows.map((r) => view(r.record)),
  ];
}

/**
 * A connector by id, ready to run, with the JSON schema of each action's input: a built-in one,
 * or one the project imported.
 */
export async function resolveConnector(
  projectId: string,
  id: string,
): Promise<{
  connector: ConnectorDefinition;
  inputSchema(actionId: string): Record<string, unknown>;
  imported: boolean;
} | null> {
  const builtin = builtinConnector(id);
  if (builtin) {
    return {
      connector: builtin,
      imported: false,
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
  const found = await importedConnector(projectId, id);
  return found
    ? {
        connector: found.connector,
        imported: true,
        inputSchema: (actionId) =>
          found.record.actions.find((a) => a.id === actionId)?.input_json_schema ?? {},
      }
    : null;
}

export async function importConnector(
  userId: string,
  projectId: string,
  input: ImportRequest,
): Promise<{ connector: ConnectorView; warnings: string[] }> {
  await requireWritableProject(projectId);
  await requireAdmin();
  if (await load(projectId, input.id)) {
    throw new ServiceError("invalid", note("connectorAlreadyExistsSpace", { id: input.id }));
  }
  try {
    const { discover, surface, prepared } = await prepare(input);
    const { record, warnings } = assembleRecord({
      actionFilter: input.actions ?? null,
      discover: discover?.parsed ?? null,
      domain: input.domain,
      id: input.id,
      importedBy: userId,
      name: input.name ?? null,
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
      tenantId: projectId,
      toolPrefix: input.toolPrefix,
    });
    const { skippedActions } = buildImportedConnector(record);
    if (skippedActions.length) {
      warnings.push(`${skippedActions.length} action(s) have an input the tools cannot express`);
    }
    await save(projectId, record);
    return { connector: view(record), warnings };
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
  projectId: string,
  input: { domain: string; kind?: "mcp" | "openapi" },
): Promise<{ connector: ConnectorView; warnings: string[] }> {
  await requireWritableProject(projectId);
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
  const taken = (await listConnectors(projectId)).find((c) => c.id === source.suggestedId);
  if (taken) {
    return { connector: taken, warnings: ["already imported"] };
  }
  return importConnector(userId, projectId, {
    domain: service.domain,
    sourceKind: source.sourceKind,
    sourceUrl: source.sourceUrl,
    id: source.suggestedId,
    toolPrefix: source.suggestedToolPrefix,
    ...(source.name ? { name: source.name } : {}),
  });
}

export async function removeConnector(projectId: string, id: string) {
  await requireWritableProject(projectId);
  await requireAdmin();
  await db.delete(schema.projectConnector).where(where(projectId, id));
}

/**
 * Re-reads the source and replaces the connector's actions. An MCP server that only lists its
 * tools to a signed-in account needs that account's token.
 */
export async function refreshConnector(
  projectId: string,
  id: string,
  accessToken: string | null,
): Promise<ConnectorView> {
  await requireWritableProject(projectId);
  const record = await load(projectId, id);
  if (!record) {
    throw new ServiceError("not_found", note("connectorNotExist"));
  }
  try {
    const { surface } = record.registry_surface_slug
      ? await resolveRegistrySource({ domain: record.domain, sourceUrl: record.source_url })
      : { surface: null };
    const requiredHeaders = surface ? resolveRequiredHeaders(surface) : record.required_headers;
    const transport =
      record.source_kind === "mcp"
        ? ((surface ? resolveMcpTransport(surface) : null) ??
          record.mcp_transport ??
          "streamable-http")
        : null;
    const prepared = await prepareSource({
      deferOnUnauthorized: false,
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
    await save(projectId, updated);
    return view(updated);
  } catch (err) {
    throw importFailure(err);
  }
}

/** The connector as engenty's framework runs it: actions with handlers, auth with its flows. */
export async function importedConnector(
  projectId: string,
  id: string,
): Promise<{ connector: ConnectorDefinition; record: ImportedConnectorRecord } | null> {
  const record = await load(projectId, id);
  if (!record) {
    return null;
  }
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
      await save(projectId, current);
    },
  );
  return { connector, record };
}
