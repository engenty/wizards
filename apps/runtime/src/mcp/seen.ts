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
