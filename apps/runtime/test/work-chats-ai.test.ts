import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { beforeAll, describe, expect, it, vi } from "vitest";

// The space's AI in a Work chat: a message that asks it starts a turn whose stream the browser
// reads; a message written during that turn goes into it; one not asking it starts nothing; Stop
// ends it. A scripted model answers.

const dir = mkdtempSync(join(tmpdir(), "wizards-work-ai-"));
process.env.DATA_DIR = join(dir, "data");
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.PLUGINS_DIR = join(dir, "plugins");
process.env.PLUGINS_WATCH = "0";
process.env.PLUGIN_JOBS = "0";
process.env.FEATURES = "workMode=on";

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
const script: { wait?: Promise<void>; chunks: unknown[] }[] = [];
const prompts: string[] = [];
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
/** How often a turn was made: once per turn that starts, never for a message taken in. */
const made = { turns: 0 };
vi.mock("../src/models.js", async (original) => ({
  ...(await original<typeof import("../src/models.js")>()),
  chatModel: async () => {
    made.turns++;
    return { model, ref: "test/scripted", vendor: "test", gateway: false, metered: true };
  },
}));
vi.mock("../src/agents/subscription.js", async (original) => ({
  ...(await original<typeof import("../src/agents/subscription.js")>()),
  chatTurnWay: async () => "openai",
}));

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;
let cookie = "";
let spaceId = "";

const url = (path: string) => `http://localhost:5181${path}`;
const send = (method: string, path: string, body?: unknown) =>
  app.fetch(
    new Request(url(`/api/studio/work${path}`), {
      method,
      headers: { cookie, "content-type": "application/json", origin: "http://localhost:5181" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
const json = async (res: Response | Promise<Response>) => {
  const r = await res;
  expect(r.status, await r.clone().text()).toBeLessThan(300);
  return r.json() as Promise<any>;
};
/** The UI message stream's chunks, as `useChat` reads them. */
async function chunks(res: Response): Promise<any[]> {
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  return (await res.text())
    .split("\n\n")
    .map((block) => block.replace(/^data: /, "").trim())
    .filter((data) => data && data !== "[DONE]")
    .map((data) => JSON.parse(data));
}
const gate = () => {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
};
const newChat = async () => (await json(send("POST", "/chats", { spaceId }))).id as string;

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

describe("the space's AI in a chat", () => {
  it("answers when asked, as a stream the chat keeps", async () => {
    const id = await newChat();
    script.push({ chunks: say("Maier hat zwei Akten.") });
    const seen = await chunks(
      await send("POST", `/chats/${id}/messages`, { text: "Welche Akten hat Maier?", ask: true }),
    );
    expect(seen.map((c) => c.type)).toEqual(expect.arrayContaining(["start", "text-delta", "finish"]));
    expect(seen.filter((c) => c.type === "text-delta").map((c) => c.delta).join("")).toBe(
      "Maier hat zwei Akten.",
    );
    // The AI's answer is unread for the person until they open the chat.
    const side = await json(send("GET", `/chats?space=${spaceId}`));
    expect(side.chats.find((c: any) => c.id === id)).toMatchObject({
      title: "Welche Akten hat Maier?",
      unread: true,
      last: { text: "Maier hat zwei Akten." },
    });
    const read = await json(send("GET", `/chats/${id}`));
    expect(read.messages.map((m: any) => m.author.kind)).toEqual(["person", "ai"]);
    expect(read.messages[1].parts).toEqual([
      expect.objectContaining({ type: "text", text: "Maier hat zwei Akten." }),
    ]);
  });

  it("uses the space's tools, and the chat keeps the call with its result", async () => {
    const id = await newChat();
    script.push({ chunks: callTool("search_space", { query: "Maier" }) }, { chunks: say("Nichts gefunden.") });
    const seen = await chunks(
      await send("POST", `/chats/${id}/messages`, { text: "Such Maier.", ask: true }),
    );
    expect(seen.map((c) => c.type)).toEqual(
      expect.arrayContaining(["tool-input-available", "tool-output-available"]),
    );
    const read = await json(send("GET", `/chats/${id}`));
    expect(read.messages[1].parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool-search_space", state: "output-available" }),
      ]),
    );
  });

  it("takes a message written during its turn into that turn, with its author", async () => {
    const id = await newChat();
    const step = gate();
    script.push({ wait: step.wait, chunks: callTool("search_space", { query: "Frist" }) });
    script.push({ chunks: say("Frist ist der 7. November.") });
    const before = prompts.length;
    const turn = send("POST", `/chats/${id}/messages`, { text: "Welche Frist?", ask: true });
    await vi.waitFor(() => expect(prompts.length).toBe(before + 1));
    const during = await json(
      send("POST", `/chats/${id}/messages`, { text: "Und für Lang?", ask: true }),
    );
    expect(during).toEqual({ sent: "taken" });
    step.open();
    await chunks(await turn);
    expect(prompts.at(-1)).toContain("Und für Lang?");
  });

  it("keeps a message that doesn't ask it out of the running turn, and builds no turn for one taken in", async () => {
    const id = await newChat();
    const step = gate();
    script.push({ wait: step.wait, chunks: callTool("search_space", { query: "Frist" }) });
    script.push({ chunks: say("Erledigt.") });
    const before = prompts.length;
    const turnsBefore = made.turns;
    const turn = send("POST", `/chats/${id}/messages`, { text: "Welche Frist hat Maier?", ask: true });
    await vi.waitFor(() => expect(prompts.length).toBe(before + 1));
    expect(
      await json(send("POST", `/chats/${id}/messages`, { text: "Ben, kannst du morgen?" })),
    ).toEqual({ sent: "kept" });
    expect(
      await json(send("POST", `/chats/${id}/messages`, { text: "Und für Lang?", ask: true })),
    ).toEqual({ sent: "taken" });
    step.open();
    await chunks(await turn);
    expect(prompts.at(-1)).not.toContain("Ben, kannst du morgen?");
    expect(prompts.at(-1)).toContain("Und für Lang?");
    expect(made.turns - turnsBefore).toBe(1);
    const read = await json(send("GET", `/chats/${id}`));
    expect(JSON.stringify(read.messages)).toContain("Ben, kannst du morgen?");
  });

  it("answers a message for after the answer at once when nothing runs, and queues it while a turn runs", async () => {
    const id = await newChat();
    script.push({ chunks: say("Sofort.") });
    const now = await chunks(
      await send("POST", `/chats/${id}/messages`, { text: "Danach bitte.", ask: true, later: true }),
    );
    expect(now.some((c) => c.type === "text-delta" && c.delta === "Sofort.")).toBe(true);
    const step = gate();
    script.push({ wait: step.wait, chunks: say("Erst das.") }, { chunks: say("Dann das.") });
    const before = prompts.length;
    const turn = send("POST", `/chats/${id}/messages`, { text: "Erst das.", ask: true });
    await vi.waitFor(() => expect(prompts.length).toBe(before + 1));
    expect(
      await json(send("POST", `/chats/${id}/messages`, { text: "Dann das.", ask: true, later: true })),
    ).toEqual({ sent: "queued" });
    step.open();
    await chunks(await turn);
    await vi.waitFor(() => expect(prompts.length).toBe(before + 2));
    expect(prompts.at(-1)).toContain("Dann das.");
  });

  it("starts nothing for a message that doesn't ask it", async () => {
    const id = await newChat();
    const before = prompts.length;
    expect(await json(send("POST", `/chats/${id}/messages`, { text: "Notiz für Ben." }))).toEqual({
      sent: "kept",
    });
    expect(prompts.length).toBe(before);
  });

  it("stops its turn", async () => {
    const id = await newChat();
    const step = gate();
    script.push({ wait: step.wait, chunks: say("Zu spät.") });
    const before = prompts.length;
    const turn = send("POST", `/chats/${id}/messages`, { text: "Fass zusammen.", ask: true });
    await vi.waitFor(() => expect(prompts.length).toBe(before + 1));
    expect(await json(send("POST", `/chats/${id}/stop`))).toEqual({ stopped: true });
    step.open();
    const seen = await chunks(await turn);
    expect(seen.some((c) => c.type === "text-delta" && c.delta === "Zu spät.")).toBe(false);
  });
});
