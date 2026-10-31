/** Imported connectors as the studio shows them: a service of a space, with its actions. */

/** What a connector action does; `send` is a mail, a message or a post to other people. */
export type ActionGroup = "read" | "write" | "send" | "destructive";

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

// --- connections of a space (docs/plans/capabilities.md, "Connections") ---------------------
// A connection belongs to the space: its admins set it up and choose how it signs in. The runtime
// decides calls by these words in apps/runtime/src/broker/call.ts; the studio will draw them.

/** How a connection signs in: once as the space (a key, an app token, a team login), or each person themselves. */
export const CONNECTION_SIGN_INS = ["space", "person"] as const;
export type ConnectionSignIn = (typeof CONNECTION_SIGN_INS)[number];

/** Who may use a connection: the space's admins, its members, or everyone, guests at a wizard's link too. */
export const CONNECTION_AUDIENCES = ["admins", "members", "all"] as const;
export type ConnectionAudience = (typeof CONNECTION_AUDIENCES)[number];

/** What the broker's admins hear of (docs/plans/broker.md, "Notifications"); decided in the runtime's broker/log.ts. */
export const CRITICAL_KINDS = [
  "refused_write",
  "outside_audience",
  "host_not_in_grant",
  "limit_reached",
  "sign_in_failed",
  "first_use",
  "rule_changed",
] as const;
export type CriticalKind = (typeof CRITICAL_KINDS)[number];

/**
 * Why the broker did not run a call (the runtime's broker/call.ts `Refusal`), as the log's
 * `result` and „Was darf …?“ name it. The Protokoll page has words for each one.
 */
export const BROKER_REFUSALS = [
  "not_connected",
  "no_action",
  "not_in_grant",
  "denied",
  "declined",
  "nobody",
  "needs_approval",
  "ai_step_writes",
  "not_allowed_recipient",
  "run_limit",
  "day_limit",
] as const;
export type BrokerRefusal = (typeof BROKER_REFUSALS)[number];

/** A person of the organization, as Fähigkeiten › Protokoll names them and „Was darf …?“ offers them. */
export interface ProtocolPerson {
  id: string;
  name: string;
  role: "owner" | "admin" | "member" | "client";
}

/** An action of a connection, as „Was darf …?“ offers it. */
export interface BrokerActionChoice {
  id: string;
  name: string;
  kind: ConnectionActionKind;
}

/** What „Was darf …?“ picks from (`GET /api/studio/spaces/:id/broker/choices`). */
export interface ProtocolChoices {
  people: ProtocolPerson[];
  connections: {
    id: string;
    name: string;
    connector: { id: string; name: string } | null;
    audience: "admins" | "members" | "all";
    signIn: "space" | "person";
    actions: BrokerActionChoice[];
  }[];
}

/** One line of the broker's log as the Protokoll page reads it (`GET …/broker/log`). */
export interface ProtocolLine {
  id: string;
  at: string;
  durationMs: number;
  who: {
    kind: string;
    id: string | null;
    /** A person, an admin, or the person Goose works for, by name. */
    name: string | null;
    /** A fixed step: whom its run is held for. */
    for?: { kind: string; id: string | null; name: string | null };
  };
  runId: string | null;
  stepId: string | null;
  chatId: string | null;
  wizardId: string | null;
  connectionId: string;
  actionId: string;
  kind: string;
  input: { fields?: Record<string, number>; sample?: string | null; size?: number } | null;
  outcome: string;
  rule: string | null;
  reason: string | null;
  result: string | null;
  resultSize: number | null;
  critical: boolean;
  criticalKind: string | null;
  connectionName: string | null;
  connectorName: string | null;
  actionName: string | null;
  wizardName: string | null;
  runMode: string | null;
  chatTitle: string | null;
}

/** A page of the log; `next` loads the one after it. */
export interface ProtocolPage {
  lines: ProtocolLine[];
  next: string | null;
}

/** One line with what its run was allowed (`GET …/broker/log/:line`). */
export interface ProtocolLineDetail {
  line: ProtocolLine;
  run: {
    id: string;
    wizardId: string;
    mode: string;
    status: string;
    /** Null: a run from before grants were kept. */
    grant: { actions: string[] | null; hosts: string[] } | null;
  } | null;
}

/** „Was darf …?“'s answer (`GET …/broker/ask`). */
export interface BrokerAnswer {
  who: { kind: string; for?: { kind: string }; admin?: boolean };
  connection: { id: string; name: string; connector: string };
  action: { id: string; kind: ConnectionActionKind; known: boolean };
  outcome: ConnectionOutcome;
  rule: string;
  reason: string;
  refused?: BrokerRefusal;
  admins?: true;
}

/** What an action does, as the rules see it. */
export const CONNECTION_ACTION_KINDS = ["read", "write", "destructive", "send"] as const;
export type ConnectionActionKind = (typeof CONNECTION_ACTION_KINDS)[number];

/** A rule's outcome: Erlaubt, Mit Freigabe, Nie. */
export const CONNECTION_OUTCOMES = ["allow", "ask", "deny"] as const;
export type ConnectionOutcome = (typeof CONNECTION_OUTCOMES)[number];

export type ConnectionRules = Record<ConnectionActionKind, ConnectionOutcome>;

/** What a connection starts with: reading runs, a change or a mail waits for approval, deleting never. */
export const DEFAULT_CONNECTION_RULES: ConnectionRules = {
  read: "allow",
  write: "ask",
  destructive: "deny",
  send: "ask",
};

export const CONNECTION_LIMITS = {
  /** Characters of a connection's name. */
  name: 80,
  /** Connections one space may hold. */
  perSpace: 200,
};

/** A connection of a space as the studio lists it; never a secret. */
export interface SpaceConnectionView {
  id: string;
  spaceId: string;
  connectorId: string;
  /** The connector behind it, where this runtime knows it. */
  connector: {
    id: string;
    name: string;
    auth: "oauth2" | "api_key" | "browser";
    /** What the connector is for, in its own words. */
    description?: string;
    /** An `api_key` connector: what is typed to sign in (as the space, or each person). */
    fields?: ConnectorKeyField[];
  } | null;
  name: string;
  signIn: ConnectionSignIn;
  audience: ConnectionAudience;
  rules: ConnectionRules;
  /** The connector's actions it is made for; empty: every action. */
  actions: string[];
  /** The plugin that set it up, where one did. */
  plugin: string | null;
  /** A `space` sign-in: the account as the provider names it; null until an admin signed in. */
  account: { label: string; signedInAt: string } | null;
  /** A `person` sign-in: the asking person's own; null until they signed in. */
  mySignIn: { label: string; signedInAt: string } | null;
  setUpBy: string | null;
  /** Who set it up, by name where the organization still knows them. */
  setUpByName?: string | null;
  setUpAt: string;
  lastUsedAt: string | null;
  /** A `person` sign-in: how many people signed in; never who. */
  signedIn: number;
}

/** A field an `api_key` connector asks for when someone signs in. */
export interface ConnectorKeyField {
  key: string;
  label: string;
  placeholder?: string;
  required?: boolean;
  secret?: boolean;
}

/**
 * A connection as a person's menu › „Verbindungen“ lists it: in a space of theirs, within their
 * audience. Their own sign-in only, never anyone else's, never a secret.
 */
export interface PersonConnectionView {
  id: string;
  name: string;
  connectorId: string;
  connector: {
    id: string;
    name: string;
    auth: "oauth2" | "api_key" | "browser";
    /** An `api_key` connector: what the person types to sign in. */
    fields?: ConnectorKeyField[];
  } | null;
  signIn: ConnectionSignIn;
  audience: ConnectionAudience;
  /** A `person` sign-in: this person's own; null until they signed in. */
  mySignIn: { label: string; signedInAt: string } | null;
  /** A `space` sign-in: the account the admins signed in with; null until they did. */
  account: { label: string; signedInAt: string } | null;
  /** Who set it up, by name where the organization still knows them. */
  setUpBy: string | null;
  setUpAt: string;
}

/** The person's menu › „Verbindungen“: per space they belong to, the connections they may use. */
export interface PersonSignIns {
  spaces: { id: string; name: string; connections: PersonConnectionView[] }[];
}
