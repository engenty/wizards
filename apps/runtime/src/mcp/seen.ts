/**
 * What each AI client did with the MCP server since the runtime started: the test on the
 * "Integrate" page waits for a client to show up, call a tool and show the widget. Kept in memory
 * only; a restart starts the test over.
 */

/** The ids the studio lists the AI apps by, and the names they give themselves (`clientInfo`). */
const CLIENT_NAMES: [id: string, name: RegExp][] = [
  // Claude Desktop calls itself claude-ai, as claude.ai does.
  ["claude-desktop", /claude[- ]?ai|claude desktop/i],
  ["claude-ai", /claude[- ]?ai/i],
  ["claude-code", /claude[- ]?code/i],
  ["codex", /codex/i],
  ["chatgpt", /openai|chatgpt/i],
  ["cursor", /cursor/i],
  // Cursor calls itself cursor-vscode.
  ["vscode", /^(?!.*cursor).*(visual studio code|vs ?code)/i],
  ["windsurf", /windsurf|codeium/i],
  ["antigravity", /antigravity|\bagy\b/i],
  ["goose", /goose/i],
  ["openclaw", /openclaw/i],
  ["lm-studio", /lm[- ]?studio/i],
];

/** The apps a client's name stands for; mostly one. */
export function appIdsOf(client: string): string[] {
  return CLIENT_NAMES.filter(([, name]) => name.test(client)).map(([id]) => id);
}

export interface Seen {
  /** Its last request of any kind. */
  at: number;
  /** Its last tool call. */
  toolAt: number | null;
  /** The last time it fetched the wizard widget: it shows MCP Apps. */
  widgetAt: number | null;
}

const seen = new Map<string, Seen>();
/** The name a client gave on `initialize`, by its sign-in: later requests do not repeat it. */
const names = new Map<string, string>();

type Message = { method?: string; params?: Record<string, unknown> };

/** Notes one MCP request: its JSON-RPC messages, from the client signed in as `signIn`. */
export function noteRequest(tenantId: string, signIn: string, client: string, body: unknown) {
  const messages = (Array.isArray(body) ? body : [body]).filter(
    (m): m is Message => Boolean(m) && typeof m === "object",
  );
  const info = messages.find((m) => m.method === "initialize")?.params?.clientInfo as
    | { name?: string; title?: string }
    | undefined;
  const given = info?.title || info?.name;
  if (given) {
    names.set(signIn, given);
  }
  const name = names.get(signIn) ?? client;
  const now = Date.now();
  for (const id of appIdsOf(name)) {
    const key = `${tenantId}\n${id}`;
    const last = seen.get(key) ?? { at: now, toolAt: null, widgetAt: null };
    last.at = now;
    for (const m of messages) {
      if (m.method === "tools/call") {
        last.toolAt = now;
      }
      if (m.method === "resources/read" && String(m.params?.uri ?? "").startsWith("ui://")) {
        last.widgetAt = now;
      }
    }
    seen.set(key, last);
  }
}

/** What the tenant's clients did, by app id. */
export function seenApps(tenantId: string): Record<string, Seen> {
  const out: Record<string, Seen> = {};
  for (const [key, value] of seen) {
    const [tenant, id] = key.split("\n");
    if (tenant === tenantId) {
      out[id] = value;
    }
  }
  return out;
}

/** The name a sign-in's client gave on `initialize`, else the one its sign-in carries. */
export function clientNameOf(signIn: string, client: string): string {
  return names.get(signIn) ?? client;
}

/**
 * Apps whose model runs on the member's computer: what they read of a space stays there. Goose
 * is not one: it mostly thinks on a provider's model.
 */
const LOCAL_APPS = new Set(["lm-studio"]);

/**
 * Whether an app thinks on the member's computer (`local`) or on a provider under the member's
 * own subscription, from every name it goes by (the one it gave on `initialize`, its sign-in's).
 * It counts as local only where a name says so and none names another app; any other counts as
 * one on a subscription.
 */
export function appKind(...names: string[]): "local" | "subscription" {
  const ids = names.flatMap(appIdsOf);
  return ids.length && ids.every((id) => LOCAL_APPS.has(id)) ? "local" : "subscription";
}

/** An app a member used on a space, checked against the organization's model policy. */
export interface CheckedApp {
  /** As the app names itself. */
  app: string;
  kind: "local" | "subscription";
  person: string | null;
  allowed: number;
  refused: number;
  at: number;
}

const checked = new Map<string, CheckedApp>();

/** Counts one tool call of an app the policy allowed or refused. */
export function noteChecked(
  tenantId: string,
  app: string,
  person: string | null,
  allowed: boolean,
  kind: CheckedApp["kind"],
) {
  const key = `${tenantId}\n${app}\n${person ?? ""}`;
  const last = checked.get(key) ?? {
    app,
    kind,
    person,
    allowed: 0,
    refused: 0,
    at: 0,
  };
  last.at = Date.now();
  if (allowed) {
    last.allowed++;
  } else {
    last.refused++;
  }
  checked.set(key, last);
}

/** The apps the tenant's members used on its spaces since the runtime started, latest first. */
export function checkedApps(tenantId: string): CheckedApp[] {
  return [...checked]
    .filter(([key]) => key.startsWith(`${tenantId}\n`))
    .map(([, value]) => value)
    .sort((a, b) => b.at - a.at);
}
