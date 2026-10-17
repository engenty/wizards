import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// The studio's assistant: one chat per person and team that a turn writes into, "new chat" with a
// summary written meanwhile, earlier chats to read and search, the guides it reads, the browser's
// tool results.

const dir = mkdtempSync(join(tmpdir(), "wizards-assistant-"));
process.env.DATA_DIR = join(dir, "data");
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.PLUGINS_DIR = join(dir, "plugins");
process.env.PLUGINS_WATCH = "0";
process.env.PLUGIN_JOBS = "0";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;
let cookie = "";
let spaceId = "";

const url = (path: string) => `http://localhost:5181${path}`;
const send = (method: string, path: string, body?: unknown) =>
  app.fetch(
    new Request(url(path), {
      method,
      headers: { cookie, "content-type": "application/json", origin: "http://localhost:5181" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
const json = async (res: Response | Promise<Response>) => (await res).json() as Promise<any>;

/** The events of an SSE answer, by name. */
async function events(res: Response): Promise<{ event: string; data: any }[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((chunk) => chunk.trim())
    .map((chunk) => {
      const event = chunk.match(/^event: (.*)$/m)?.[1] ?? "message";
      const data = chunk
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("\n");
      return { event, data: JSON.parse(data) };
    });
}

beforeAll(async () => {
  const client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb("local");
  app = (await import("../src/app")).default;
  const entered = await app.fetch(new Request(url("/api/local/enter?k=test-key")));
  cookie = (entered.headers.get("set-cookie") ?? "").split(";")[0];
  const projects = await import("../src/services/projects");
  spaceId = (await client.withTenant("local", () => projects.defaultProject("local"))).id;
}, 60_000);

describe("one chat per person", () => {
  it("starts empty and keeps the person's message of a turn", async () => {
    const first = await json(send("GET", "/api/studio/assistant/chat"));
    expect(first).toEqual({ id: expect.any(String), messages: [] });

    // No model is set up here: the turn says so, the message stays in the chat.
    const res = await send("POST", "/api/studio/assistant/turn", {
      message: "Wo stelle ich die Modelle ein?",
      projectId: spaceId,
      page: { route: "/space/info", title: "Space / Info & brand" },
      tools: [
        {
          name: "navigate",
          description: "Open a page",
          parameters: { type: "object", properties: { to: { type: "string" } } },
        },
      ],
      lang: "de",
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const seen = await events(res);
    expect(seen[0]).toEqual({
      event: "run_started",
      data: { threadId: first.id, runId: expect.any(String), messageId: expect.any(String) },
    });
    expect(seen.at(-1)?.event).toBe("error");

    const chat = await json(send("GET", "/api/studio/assistant/chat"));
    expect(chat.id).toBe(first.id);
    expect(chat.messages).toEqual([
      expect.objectContaining({
        id: seen[0].data.messageId,
        role: "user",
        content: "Wo stelle ich die Modelle ein?",
        page: { route: "/space/info", title: "Space / Info & brand" },
      }),
    ]);
  });

  it("refuses a turn with a tool name the model could not take", async () => {
    const res = await send("POST", "/api/studio/assistant/turn", {
      message: "Hallo",
      tools: [{ name: "Not A Name", description: "", parameters: {} }],
    });
    expect(res.status).toBe(400);
  });

  it("closes the chat with a summary on New chat, to read and to search later", async () => {
    const before = await json(send("GET", "/api/studio/assistant/chat"));
    const fresh = await json(send("POST", "/api/studio/assistant/chat/new"));
    expect(fresh.id).not.toBe(before.id);
    expect(fresh.messages).toEqual([]);
    // An empty chat stays as it is.
    expect((await json(send("POST", "/api/studio/assistant/chat/new"))).id).toBe(fresh.id);

    // The chat closed at once; its summary is written meanwhile.
    const client = await import("../src/db/client");
    const chats_ = await import("../src/services/assistant-chats");
    const person = { id: "local", tenantId: "local", role: "owner" as const, name: "", email: "" };
    await client.withTenant("local", () => chats_.closedSummaries(person));
    const { chats } = await json(send("GET", "/api/studio/assistant/chats"));
    expect(chats).toEqual([
      expect.objectContaining({
        id: before.id,
        // Without a model the summary is an excerpt: the first question.
        title: "Wo stelle ich die Modelle ein?",
        summary: expect.stringContaining("Modelle"),
      }),
    ]);
    const read = await json(send("GET", `/api/studio/assistant/chats/${before.id}`));
    expect(read.messages).toHaveLength(1);
    expect((await send("GET", "/api/studio/assistant/chats/nope")).status).toBe(404);

    const hits = await client.withTenant("local", () => chats_.searchChats(person, "Modelle"));
    expect(hits.map((h) => h.chatId)).toContain(before.id);
    // Another person of the team finds nothing of it.
    const other = { ...person, id: "someone-else" };
    expect(await client.withTenant("local", () => chats_.searchChats(other, "Modelle"))).toEqual([]);
    // The next turn carries the closed chat's summary.
    const open = await client.withTenant("local", () => chats_.openChat(person));
    const history = await client.withTenant("local", () => chats_.turnHistory(person, open));
    expect(history.earlier).toEqual([expect.objectContaining({ id: before.id })]);
  });

  it("folds the older messages of a long chat into its running summary", async () => {
    const client = await import("../src/db/client");
    const chats = await import("../src/services/assistant-chats");
    const person = { id: "local", tenantId: "local", role: "owner" as const, name: "", email: "" };
    await client.withTenant("local", async () => {
      const chat = await chats.openChat(person);
      for (let i = 0; i < 30; i++) {
        await chats.addMessage(chat.id, {
          role: i % 2 ? "assistant" : "user",
          content: `Nachricht ${i}`,
        });
      }
      await chats.foldChat(chat.id);
      const folded = await chats.openChat(person);
      expect(folded.folded).toBe(30 - chats.TURN_MESSAGES);
      expect(folded.summary).toContain("Nachricht 0");
      const history = await chats.turnHistory(person, folded);
      expect(history.messages).toHaveLength(chats.TURN_MESSAGES);
      expect(history.messages[0].content).toBe(`Nachricht ${30 - chats.TURN_MESSAGES}`);
      expect(history.running).toBe(folded.summary);
    });
  });

  it("keeps where the person wants the assistant", async () => {
    expect(await json(send("GET", "/api/studio/assistant/layout"))).toEqual({ layout: "bottom" });
    await send("PUT", "/api/studio/assistant/layout", { layout: "sidebar" });
    expect(await json(send("GET", "/api/studio/assistant/layout"))).toEqual({ layout: "sidebar" });
    expect((await send("PUT", "/api/studio/assistant/layout", { layout: "left" })).status).toBe(400);
  });
});

describe("the browser's tools", () => {
  it("hand the result to the turn that waits, for its person only", async () => {
    const { answerBrowser, awaitBrowser } = await import("../src/assistant/browser");
    const waiting = awaitBrowser("local", "call-1");
    expect(answerBrowser("someone-else", "call-1", { opened: "/x" })).toBe(false);
    const res = await send("POST", "/api/studio/assistant/tool/call-1", {
      result: { opened: "/settings/models" },
    });
    expect(res.status).toBe(200);
    expect(await waiting).toEqual({ opened: "/settings/models" });
    // Nobody waits any more.
    expect((await send("POST", "/api/studio/assistant/tool/call-1", { result: 1 })).status).toBe(404);
  });

  it("tell the model when the page is gone", async () => {
    const { awaitBrowser } = await import("../src/assistant/browser");
    const abort = new AbortController();
    const waiting = awaitBrowser("local", "call-2", abort.signal);
    abort.abort();
    expect(await waiting).toEqual({ error: expect.stringContaining("closed") });
  });
});

describe("the guides", () => {
  it("are found by words and read by page", async () => {
    const { readDoc, searchDocs } = await import("../src/assistant/docs");
    const hits = searchDocs("model class Highest assistant");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((h) => h.page)).toContain("user/models");
    expect(hits[0].url).toMatch(/^https:\/\/engenty\.ai\/docs\//);
    const page = readDoc("user/models");
    expect(page).toMatchObject({ page: "user/models", url: "https://engenty.ai/docs/user/models" });
    expect((page as { text: string }).text).toContain("Highest");
    expect(readDoc("https://engenty.ai/docs/user/assistant")).toMatchObject({ page: "user/assistant" });
    expect(readDoc("nothing-here")).toMatchObject({ error: expect.any(String) });
  });
});
