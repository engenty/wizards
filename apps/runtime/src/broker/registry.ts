import type { ToolId } from "@engenty/wizards-shared/definition";
import type { ActionKind } from "./call.js";

/*
 * Every tool and share target that reaches outside says so here: which connection, which action,
 * what kind. The walk test (`test/broker-walk.test.ts`) fails on a file that reaches outside
 * without going through `brokerCall` and registering what it reaches.
 */

export interface OutsideReach {
  /** The connection's id, or what kind of connection: "mail", "share:slack", a wizard's connection. */
  connection: string;
  action: string;
  kind: ActionKind;
}

const reaches = new Map<string, OutsideReach[]>();

/** A tool or target (by its id) reaches outside through these actions. Registering twice is fine. */
export function reachesOutside(id: string, list: OutsideReach | OutsideReach[]): void {
  reaches.set(id, Array.isArray(list) ? list : [list]);
}

/** What is registered, for tests and the Protokoll page later. */
export function outsideReaches(): ReadonlyMap<string, OutsideReach[]> {
  return reaches;
}

/*
 * Every tool of a step and of the catalogue has a descriptor: what it is about (the resource),
 * what it does there (the action) and its kind. The kind is the broker's own (`ActionKind`), the
 * one its log and the Protokoll page show: `read` only looks; `write` and `destructive` change
 * the tenant's own data or the run's files; `send` reaches past the tenant (a host, a page in the
 * browser, a person). The plan's three words map onto it: read is `read`, write is `write` or
 * `destructive`, act is `send`. Where a call's kind depends on its input, the descriptor names
 * the most a call can do. `test/tool-descriptors.test.ts` fails on a tool without one.
 */

export interface ToolDescriptor {
  /** What a call is about: `web`, `browser`, `pages`, `lists`, `files`, `data`, `knowledge` … */
  resource: string;
  /** What it does there, the log's action. */
  action: string;
  kind: ActionKind;
  /** The step's tool (its `tools`) that brings it; left out: it comes without one. */
  tool?: ToolId;
  /**
   * The calls whose line another path writes in a step: `brokerCall`, `brokerHost`, the
   * catalogue's gate (elements/gate.ts). True: every call.
   */
  logged?: true | ((input: unknown) => boolean);
}

const read = (resource: string, action: string, tool?: ToolId): ToolDescriptor => ({
  resource,
  action,
  kind: "read",
  ...(tool ? { tool } : {}),
});

/** By a path, `page_read` reads a page of Knowledge, whose gate writes the line. */
const byPath = (input: unknown) =>
  Boolean((input as { path?: unknown } | null)?.path?.toString().trim());

const DESCRIPTORS: Record<string, ToolDescriptor> = {
  web_search: read("web", "search", "web_search"),
  web_fetch: read("web", "fetch", "web_fetch"),
  http_request: { resource: "host", action: "request", kind: "send", tool: "http", logged: true },
  generate_image: { resource: "images", action: "generate", kind: "write", tool: "image" },

  // The run's one page: going somewhere or doing something on it is a request to its host.
  browser_open: { resource: "browser", action: "open", kind: "send", tool: "browser" },
  browser_read: read("browser", "read", "browser"),
  browser_click: { resource: "browser", action: "click", kind: "send", tool: "browser" },
  browser_type: { resource: "browser", action: "type", kind: "send", tool: "browser" },
  browser_select: { resource: "browser", action: "select", kind: "send", tool: "browser" },
  browser_scroll: read("browser", "scroll", "browser"),
  browser_press: { resource: "browser", action: "press", kind: "send", tool: "browser" },
  browser_back: { resource: "browser", action: "back", kind: "send", tool: "browser" },
  browser_wait: read("browser", "wait", "browser"),
  browser_screenshot: { resource: "browser", action: "screenshot", kind: "write", tool: "browser" },
  browser_request_credentials: {
    resource: "browser",
    action: "sign_in",
    kind: "send",
    tool: "browser",
  },
  browser_request_user: { resource: "browser", action: "hand_over", kind: "send", tool: "browser" },
  browser_upload: { resource: "browser", action: "upload", kind: "send", tool: "browser" },
  browser_download: { resource: "browser", action: "download", kind: "write", tool: "browser" },
  browser_run_fast: { resource: "browser", action: "run", kind: "send", tool: "browser" },

  run_command: { resource: "sandbox", action: "run", kind: "write", tool: "sandbox" },
  export_file: { resource: "sandbox", action: "export", kind: "write", tool: "sandbox" },
  // A program over the step's other tools; each of its calls has a line of its own.
  execute_typescript: { resource: "code", action: "run", kind: "write", tool: "code" },

  page_read: { ...read("pages", "read", "pages"), logged: byPath },
  page_write: { resource: "pages", action: "write", kind: "write", tool: "pages" },

  // The wizard's lists and files, the person's documents, the wizard's workspace and database.
  list_read: read("lists", "read"),
  list_write: { resource: "lists", action: "write", kind: "write" },
  files_list: read("files", "list"),
  files_keep: { resource: "files", action: "keep", kind: "write" },
  read_document: read("documents", "read"),
  scan_documents: read("documents", "scan"),
  read_workspace_file: read("workspace", "read"),
  data_query: { ...read("data", "query"), logged: true },
  data_exec: { resource: "data", action: "exec", kind: "write", logged: true },

  // The catalogue (elements/specs.ts), its every call through the gate.
  space_search: { ...read("knowledge", "search"), logged: true },
  space_list: { ...read("knowledge", "list"), logged: true },
  table_read: { ...read("knowledge", "table_read"), logged: true },
  space_document: { ...read("knowledge", "document"), logged: true },
  dateien_draft: { resource: "knowledge", action: "draft", kind: "write", logged: true },
  skill_list: { ...read("skills", "list"), logged: true },
  skill_load: { ...read("skills", "load"), logged: true },
  skill_read: { ...read("skills", "read"), logged: true },
  connection_list: { ...read("connections", "list"), logged: true },
  connection_call: { resource: "connections", action: "call", kind: "destructive", logged: true },
  wizard_list: { ...read("wizards", "list"), logged: true },
  wizard_run: { resource: "wizards", action: "run", kind: "send", logged: true },
};

/** Every tool's descriptor by its name, for tests and the Protokoll page later. */
export function toolDescriptors(): Readonly<Record<string, ToolDescriptor>> {
  return DESCRIPTORS;
}

/**
 * A tool's descriptor by the name the model calls it. A connection's tool, named for its
 * connection, is described by what it reaches: logged by `brokerCall`, the most its actions do.
 */
export function descriptorOf(name: string): ToolDescriptor | null {
  const own = Object.hasOwn(DESCRIPTORS, name) ? DESCRIPTORS[name] : undefined;
  if (own) {
    return own;
  }
  const reach = reaches.get(name);
  if (!reach?.length) {
    return null;
  }
  const most = reach.find((r) => r.kind !== "read") ?? reach[0];
  return { resource: most.connection, action: most.action, kind: most.kind, logged: true };
}
