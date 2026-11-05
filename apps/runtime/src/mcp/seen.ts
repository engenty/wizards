import { desc, lt, sql } from "drizzle-orm";
import { db, withTenant } from "../db/client.js";
import * as schema from "../db/schema.js";

/**
 * What each AI client did with the MCP server: the test on the "Integrate" page waits for a client
 * to show up, call a tool and show the widget. In the tenant's database, as the process that
 * answers MCP need not be the one that serves the studio (RUNTIME_ROLE). A note that can't be
 * written is logged: the client's call goes on.
 */

/** How long an app stays known without a request. */
const KEEP_MS = 30 * 24 * 3600_000;

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

/** The name a client gave on `initialize`, by its sign-in: later requests do not repeat it. */
const names = new Map<string, string>();

type Message = { method?: string; params?: Record<string, unknown> };

/** Notes one MCP request: its JSON-RPC messages, from the client signed in as `signIn`. */
export async function noteRequest(
  tenantId: string,
  signIn: string,
  client: string,
  body: unknown,
): Promise<void> {
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
  const apps = appIdsOf(names.get(signIn) ?? client);
  if (!apps.length) {
    return;
  }
  const now = Date.now();
  const toolAt = messages.some((m) => m.method === "tools/call") ? now : null;
  const widgetAt = messages.some(
    (m) => m.method === "resources/read" && String(m.params?.uri ?? "").startsWith("ui://"),
  )
    ? now
    : null;
  await withTenant(tenantId, async () => {
    for (const app of apps) {
      await db
        .insert(schema.mcpAppSeen)
        .values({ app, at: now, toolAt, widgetAt })
        .onConflictDoUpdate({
          target: schema.mcpAppSeen.app,
          set: {
            at: now,
            toolAt: sql`coalesce(excluded.tool_at, ${schema.mcpAppSeen.toolAt})`,
            widgetAt: sql`coalesce(excluded.widget_at, ${schema.mcpAppSeen.widgetAt})`,
          },
        });
    }
  }).catch((err) => console.error("[mcp] noting a client:", (err as Error).message));
}

/** What the tenant's clients did, by app id. */
export async function seenApps(tenantId: string): Promise<Record<string, Seen>> {
  const rows = await withTenant(tenantId, () => db.select().from(schema.mcpAppSeen));
  return Object.fromEntries(
    rows.map((r) => [r.app, { at: r.at, toolAt: r.toolAt, widgetAt: r.widgetAt }]),
  );
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

/** Counts one tool call of an app the policy allowed or refused. */
export async function noteChecked(
  tenantId: string,
  app: string,
  person: string | null,
  allowed: boolean,
  kind: CheckedApp["kind"],
): Promise<void> {
  const now = Date.now();
  const t = schema.mcpAppCheck;
  await withTenant(tenantId, () =>
    db
      .insert(t)
      .values({
        app,
        person: person ?? "",
        kind,
        allowed: allowed ? 1 : 0,
        refused: allowed ? 0 : 1,
        at: now,
      })
      .onConflictDoUpdate({
        target: [t.app, t.person],
        set: {
          kind,
          at: now,
          allowed: sql`${t.allowed} + excluded.allowed`,
          refused: sql`${t.refused} + excluded.refused`,
        },
      }),
  ).catch((err) => console.error("[mcp] noting an app's check:", (err as Error).message));
}

/** The apps the tenant's members used on its spaces, latest first. */
export async function checkedApps(tenantId: string): Promise<CheckedApp[]> {
  const rows = await withTenant(tenantId, () =>
    db.select().from(schema.mcpAppCheck).orderBy(desc(schema.mcpAppCheck.at)),
  );
  return rows.map((r) => ({
    app: r.app,
    kind: r.kind as CheckedApp["kind"],
    person: r.person || null,
    allowed: r.allowed,
    refused: r.refused,
    at: r.at,
  }));
}

/** Forgets what is older than `KEEP_MS`, in the current tenant's context: names of people among it. */
export async function pruneSeen(now = Date.now()) {
  await db.delete(schema.mcpAppSeen).where(lt(schema.mcpAppSeen.at, now - KEEP_MS));
  await db.delete(schema.mcpAppCheck).where(lt(schema.mcpAppCheck.at, now - KEEP_MS));
}
