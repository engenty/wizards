/** Imported connectors as the studio shows them: a service of a space, with its actions. */

export type ActionGroup = "read" | "write" | "destructive";

export interface ConnectorActionView {
  id: string;
  summary: string;
  group: ActionGroup;
}

export interface ConnectorView {
  id: string;
  name: string;
  domain: string;
  /** Where it comes from: shipped with the product, or imported from a spec or an MCP server. */
  sourceKind: "builtin" | "openapi" | "mcp";
  sourceUrl: string;
  toolPrefix: string;
  /** Whether a person can connect an account right now. */
  usable: boolean;
  /** Built-in OAuth connectors that are not usable: the settings the server still needs. */
  missingSetup: string | null;
  /** How a person connects their account. */
  auth: "none" | "oauth2" | "api_key";
  /** OAuth without client credentials and without self-registration: connecting cannot work yet. */
  needsOAuthClient: boolean;
  /** An MCP server that lists its tools only to a signed-in account: none are known yet. */
  toolsPending: boolean;
  actions: ConnectorActionView[];
  importedAt: string;
  refreshedAt: string | null;
}

export interface RegistryHit {
  domain: string;
  name: string;
  description: string;
  kinds: string[];
}

/** One way a registry service can be imported: an OpenAPI spec or an MCP server. */
export interface RegistrySource {
  sourceKind: "openapi" | "mcp";
  sourceUrl: string;
  name: string | null;
  /** Why this source cannot be imported; null = it can. */
  blocked: string | null;
  auth: string;
  suggestedId: string;
  suggestedToolPrefix: string;
}

export interface RegistryService {
  domain: string;
  summary: string | null;
  sources: RegistrySource[];
  /** How to get a credential, in the provider's words. */
  credentials: { label: string; setup: string | null; url: string | null }[];
}

export interface SourcePreview {
  title: string | null;
  actions: ConnectorActionView[];
  blockers: string[];
  /** Actions beyond the per-connector cap. */
  dropped: number;
  toolsPending: boolean;
}

export interface ImportRequest {
  domain: string;
  sourceKind: "openapi" | "mcp";
  sourceUrl: string;
  id: string;
  toolPrefix: string;
  name?: string;
  /** Only these actions; default all. */
  actions?: string[];
  oauthClientId?: string;
  oauthClientSecret?: string;
}
