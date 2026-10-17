import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { beforeAll, describe, expect, it, vi } from "vitest";

// Goose takes what the person writes while it works: before its next step, or after its answer.
// In developer mode a turn also sends its prompt and each step.

const dir = mkdtempSync(join(tmpdir(), "wizards-assistant-signals-"));
process.env.DATA_DIR = join(dir, "data");
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.PLUGINS_DIR = join(dir, "plugins");
process.env.PLUGINS_WATCH = "0";
process.env.PLUGIN_JOBS = "0";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.ASSISTANT_DEV = "1";

/** What the scripted model answers, one entry per model call; each may wait for the test first. */
const script: { wait?: Promise<void>; chunks: unknown[] }[] = [];
const prompts: string[] = [];
const usage = { inputTokens: { total: 120, noCache: 120 }, outputTokens: { total: 8, text: 8 } };
const say = (text: string) => [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: text },
  { type: "text-end", id: "t" },
  { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
];
const callTool = (name: string, input: unknown) => [
  { type: "stream-start", warnings: [] },
  { type: "tool-call", toolCallId: `c-${name}`, toolName: name, input: JSON.stringify(input) },
  { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
];
const model = new MockLanguageModelV3({
  doStream: async (options: any) => {
    prompts.push(JSON.stringify(options.prompt));
    const next = script.shift();
    if (!next) {
      throw new Error("The script has no more answers.");
    }
    await next.wait;
    return { stream: convertArrayToReadableStream(next.chunks as never[]) };
  },
});
vi.mock("../src/models.js", async (original) => ({
  ...(await original<typeof import("../src/models.js")>()),
  textModel: async () => ({
    model,
    ref: "test/scripted",
    vendor: "test",
    gateway: false,
    metered: true,
  }),
}));

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;
let cookie = "";

const url = (path: string) => `http://localhost:5181${path}`;
const send = (method: string, path: string, body?: unknown) =>
  app.fetch(
    new Request(url(path), {
      method,
      headers: { cookie, "content-type": "application/json", origin: "http://localhost:5181" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

/** Reads an SSE answer event by event; `until` stops once an event of that name came. */
function reader(res: Response) {
  const stream = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const seen: { event: string; data: any }[] = [];
  return {
    seen,
    async until(name: string) {
      for (;;) {
        const found = seen.find((e) => e.event === name);
        if (found) {
          return found.data;
        }
        const { done, value } = await stream.read();
        if (done) {
          throw new Error(`The stream ended before "${name}".`);
        }
        buffer += decoder.decode(value, { stream: true });
        let at = buffer.indexOf("\n\n");
        while (at !== -1) {
          const chunk = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const event = chunk.match(/^event: (.*)$/m)?.[1] ?? "message";
          const data = chunk
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim())
            .join("\n");
          seen.push({ event, data: JSON.parse(data) });
          at = buffer.indexOf("\n\n");
        }
      }
    },
  };
}

/** A promise the test resolves when it has done its part. */
function gate() {
  let open = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

beforeAll(async () => {
  const client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb("local");
  app = (await import("../src/app")).default;
  const entered = await app.fetch(new Request(url("/api/local/enter?k=test-key")));
  cookie = (entered.headers.get("set-cookie") ?? "").split(";")[0];
}, 60_000);

describe("messages written while Goose works", () => {
  it("come before its next step, after the tools' results", async () => {
    const signalled = gate();
    script.push(
      { chunks: callTool("docs_search", { query: "Modelle" }) },
      { wait: signalled.wait, chunks: say("Die Modelle stehen unter Einstellungen.") },
    );
    const res = await send("POST", "/api/studio/assistant/turn", {
      message: "Wo stelle ich die Modelle ein?",
      debug: true,
    });
    const events = reader(res);
    const { runId } = await events.until("run_started");
    // The first step's tool ran; the next step has not started yet.
    await events.until("tool_result");
    expect(
      (
        await send("POST", `/api/studio/assistant/run/${runId}/signal`, {
          ref: "p-1",
          message: "Und die Stimme?",
        })
      ).status,
    ).toBe(200);
    // prepareStep takes it before the second step asks the model.
    signalled.open();
    const taken = await events.until("signal");
    expect(taken).toMatchObject({ ref: "p-1", content: "Und die Stimme?" });
    const done = await events.until("done");
    expect(done.reply).toBe("Die Modelle stehen unter Einstellungen.");
    expect(prompts.at(-1)).toContain("Und die Stimme?");
    expect(prompts.at(-1)).toContain("What they asked before still stands");

    // Developer mode: the prompt and each step, counted over the turn.
    const prompt = events.seen.find((e) => e.event === "prompt")?.data;
    expect(prompt).toMatchObject({ model: "test/scripted" });
    expect(prompt.system).toContain("You are Goose");
    expect(prompt.tools.map((t: { name: string }) => t.name)).toContain("docs_search");
    const steps = events.seen.filter((e) => e.event === "step").map((e) => e.data);
    expect(steps.map((s) => s.step)).toEqual([1, 2]);
    expect(steps[0]).toMatchObject({ inputTokens: 120, outputTokens: 8, tools: ["docs_search"] });

    // The chat keeps the order: question, the search before the person's message, the message,
    // the answer.
    const chat = await (await send("GET", "/api/studio/assistant/chat")).json();
    expect(
      chat.messages.map((m: any) => [
        m.content,
        m.toolCalls.map((c: { toolCallName: string }) => c.toolCallName),
      ]),
    ).toEqual([
      ["Wo stelle ich die Modelle ein?", []],
      ["", ["docs_search"]],
      ["Und die Stimme?", []],
      ["Die Modelle stehen unter Einstellungen.", []],
    ]);
    expect(taken.answerId).toBe(chat.messages[1].id);
    // The next turn's history leaves out the part without text.
    const client = await import("../src/db/client");
    const chats = await import("../src/services/assistant-chats");
    const person = { id: "local", tenantId: "local", role: "owner" as const, name: "", email: "" };
    const history = await client.withTenant("local", async () =>
      chats.turnHistory(person, await chats.openChat(person)),
    );
    expect(history.messages.map((m) => m.content)).toEqual([
      "Wo stelle ich die Modelle ein?",
      "Und die Stimme?",
      "Die Modelle stehen unter Einstellungen.",
    ]);
  });

  it("start the turn again when they came after its last step", async () => {
    await send("POST", "/api/studio/assistant/chat/new");
    const asked = gate();
    const signalled = gate();
    script.push(
      {
        wait: (async () => {
          asked.open();
          await signalled.wait;
        })(),
        chunks: say("Hallo!"),
      },
      { chunks: say("Blau ist notiert.") },
    );
    const res = await send("POST", "/api/studio/assistant/turn", { message: "Hallo" });
    const events = reader(res);
    const { runId } = await events.until("run_started");
    await asked.wait;
    await send("POST", `/api/studio/assistant/run/${runId}/signal`, {
      ref: "p-2",
      message: "Merk dir Blau.",
    });
    signalled.open();
    const taken = await events.until("signal");
    expect(taken.answerId).toEqual(expect.any(String));
    const done = await events.until("done");
    expect(done.reply).toBe("Blau ist notiert.");
    // Without developer mode asked for, no steps.
    expect(events.seen.some((e) => e.event === "step")).toBe(false);
    const chat = await (await send("GET", "/api/studio/assistant/chat")).json();
    expect(chat.messages.map((m: { content: string }) => m.content)).toEqual([
      "Hallo",
      "Hallo!",
      "Merk dir Blau.",
      "Blau ist notiert.",
    ]);
    // The turn is over: nothing more goes in.
    expect(
      (
        await send("POST", `/api/studio/assistant/run/${runId}/signal`, {
          ref: "p-3",
          message: "Noch was",
        })
      ).status,
    ).toBe(404);
  });
});

describe("New chat", () => {
  it("closes the chat at once and writes its summary meanwhile", async () => {
    const before = await (await send("GET", "/api/studio/assistant/chat")).json();
    const fresh = await (await send("POST", "/api/studio/assistant/chat/new")).json();
    expect(fresh.id).not.toBe(before.id);
    const client = await import("../src/db/client");
    const chats = await import("../src/services/assistant-chats");
    const person = { id: "local", tenantId: "local", role: "owner" as const, name: "", email: "" };
    await client.withTenant("local", () => chats.closedSummaries(person));
    const { chats: earlier } = await (await send("GET", "/api/studio/assistant/chats")).json();
    expect(earlier[0]).toMatchObject({ id: before.id, summarising: false });
    expect(earlier[0].summary.length).toBeGreaterThan(0);
  });
});

describe("developer mode", () => {
  it("is offered where ASSISTANT_DEV is set", async () => {
    const me = await (await send("GET", "/api/studio/me")).json();
    expect(me.assistantDev).toBe(true);
  });
});
