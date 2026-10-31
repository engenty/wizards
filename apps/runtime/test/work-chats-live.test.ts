import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { LiveEvent } from "../src/live/hub";

// Work's chats live: a change of a chat reaches the studio's live feed (a private chat only its
// members), and while the AI answers, others in the chat follow its turn from the start.

const dir = mkdtempSync(join(tmpdir(), "wizards-work-live-"));
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
const script: { wait?: Promise<void>; chunks: unknown[] }[] = [];
let calls = 0;
const model = new MockLanguageModelV3({
  doStream: async () => {
    calls++;
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
  chatModel: async () => ({ model, ref: "test/scripted", vendor: "test", gateway: false, metered: true }),
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

beforeAll(async () => {
  const client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb("local");
  app = (await import("../src/app")).default;
  const entered = await app.fetch(new Request(url("/api/local/enter?k=test-key")));
  cookie = (entered.headers.get("set-cookie") ?? "").split(";")[0];
  const spaces = await import("../src/services/spaces");
  spaceId = (await client.withTenant("local", () => spaces.defaultSpace("local"))).id;
}, 60_000);

describe("work chats live", () => {
  it("tell the live feed of a new chat and a message in it", async () => {
    const { subscribe } = await import("../src/live/hub");
    const heard: LiveEvent[] = [];
    const stop = await subscribe("local", null, (e) => heard.push(e));
    const heardOf = (id: string) =>
      heard.flatMap((e) => (e.event === "changes" ? e.items : [])).filter((i) => i.kind === "chat" && i.item === id);
    const chat = await json(send("POST", "/chats", { spaceId }));
    await vi.waitFor(() => expect(heardOf(chat.id).length).toBe(1));
    // Changes of one item heard together are one; a later change is heard on its own.
    heard.length = 0;
    await json(send("POST", `/chats/${chat.id}/messages`, { text: "Hallo" }));
    await vi.waitFor(() => expect(heardOf(chat.id).length).toBe(1));
    stop();
  });

  it("keep a private chat's changes to its members", async () => {
    const client = await import("../src/db/client");
    const { chatChangesFor } = await import("../src/services/work-chats");
    const open = await json(send("POST", "/chats", { spaceId }));
    const closed = await json(send("POST", "/chats", { spaceId, private: true }));
    const other = { id: "ben", tenantId: "local", role: "member" as const, name: "Ben", email: "" };
    const me = { ...other, id: "local", role: "owner" as const };
    const items = [
      { kind: "chat", op: "put", item: open.id, spaceId: spaceId, parent: null },
      { kind: "chat", op: "put", item: closed.id, spaceId: spaceId, parent: null },
      { kind: "chat", op: "put", item: "sec1", spaceId: spaceId, parent: "section" },
      { kind: "wizard", op: "put", item: "w1", spaceId: spaceId, parent: null },
    ];
    const forBen = await client.withTenant("local", () => chatChangesFor(other, items));
    // A chat Ben doesn't see reaches him as gone, its id alone: it leaves his sidebar if it was there.
    expect(forBen).toEqual([
      items[0],
      { kind: "chat", op: "del", item: closed.id, spaceId: null, parent: null },
      items[2],
      items[3],
    ]);
    const forMe = await client.withTenant("local", () => chatChangesFor(me, items));
    expect(forMe.map((i) => i.item)).toEqual([open.id, closed.id, "sec1", "w1"]);
  });

  it("let another reader follow the AI's turn from its start, and say when it answers", async () => {
    const chat = await json(send("POST", "/chats", { spaceId }));
    const step = gate();
    script.push({ wait: step.wait, chunks: say("Hier ist die Antwort.") });
    const before = calls;
    const turn = send("POST", `/chats/${chat.id}/messages`, { text: "Frage?", ask: true });
    await vi.waitFor(() => expect(calls).toBe(before + 1));
    const read = await json(send("GET", `/chats/${chat.id}`));
    expect(read.chat.answeringSince).toEqual(expect.any(String));
    const follower = await send("GET", `/chats/${chat.id}/follow`);
    expect(follower.status).toBe(200);
    step.open();
    const [asker, followed] = await Promise.all([chunks(await turn), chunks(follower)]);
    const text = (cs: any[]) => cs.filter((c) => c.type === "text-delta").map((c) => c.delta).join("");
    expect(text(followed)).toBe("Hier ist die Antwort.");
    expect(followed.map((c) => c.type)).toEqual(asker.map((c) => c.type));
    expect((await json(send("GET", `/chats/${chat.id}`))).chat.answeringSince).toBe(null);
    expect((await send("GET", `/chats/${chat.id}/follow`)).status).toBe(204);
  });

  it("keeps the books of a turn that was queued for after the answer", async () => {
    const chat = await json(send("POST", "/chats", { spaceId }));
    const step = gate();
    script.push({ wait: step.wait, chunks: say("Erste Antwort.") }, { chunks: say("Zweite Antwort.") });
    const before = calls;
    const turn = send("POST", `/chats/${chat.id}/messages`, { text: "Erste Frage?", ask: true });
    await vi.waitFor(() => expect(calls).toBe(before + 1));
    expect(
      await json(send("POST", `/chats/${chat.id}/messages`, { text: "Zweite Frage?", ask: true, later: true })),
    ).toEqual({ sent: "queued" });
    step.open();
    await chunks(await turn);
    await vi.waitFor(() => expect(calls).toBe(before + 2));
    await vi.waitFor(async () => {
      const side = await json(send("GET", `/chats?space=${spaceId}`));
      expect(side.chats.find((c: any) => c.id === chat.id).last.text).toBe("Zweite Antwort.");
    });
    expect((await json(send("GET", `/chats/${chat.id}`))).chat.answeringSince).toBe(null);
  });

  it("don't show a chat as answering once its turn is older than a turn may run", async () => {
    const client = await import("../src/db/client");
    const { eq } = await import("drizzle-orm");
    const chat = await json(send("POST", "/chats", { spaceId }));
    await client.withTenant("local", () =>
      client.db
        .update(client.schema.chat)
        .set({ answeringSince: new Date(Date.now() - 21 * 60_000) })
        .where(eq(client.schema.chat.id, chat.id)),
    );
    expect((await json(send("GET", `/chats/${chat.id}`))).chat.answeringSince).toBe(null);
    expect((await send("GET", `/chats/${chat.id}/follow`)).status).toBe(204);
  });
});
