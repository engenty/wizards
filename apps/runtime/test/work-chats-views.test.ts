import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { beforeAll, describe, expect, it, vi } from "vitest";

// Views in a Work chat: the space's AI shows one with show_view, which checks it against the
// surface catalog (the model gets the issues of one it refused); a Form's answers come back as
// the person's message; a view's Fields upload into the space's files and read them back through
// the chat. A scripted model answers.

const dir = mkdtempSync(join(tmpdir(), "wizards-work-views-"));
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
const callTool = (id: string, name: string, input: unknown) => [
  { type: "stream-start", warnings: [] },
  { type: "tool-call", toolCallId: id, toolName: name, input: JSON.stringify(input) },
  { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
];
const script: unknown[][] = [];
const prompts: string[] = [];
const model = new MockLanguageModelV3({
  doStream: async (options: any) => {
    prompts.push(JSON.stringify(options.prompt));
    const next = script.shift();
    if (!next) {
      throw new Error("The script has no more answers.");
    }
    return { stream: convertArrayToReadableStream(next as never[]) };
  },
});
vi.mock("../src/models.js", async (original) => ({
  ...(await original<typeof import("../src/models.js")>()),
  chatModel: async () => ({
    model,
    ref: "test/scripted",
    vendor: "test",
    gateway: false,
    metered: true,
  }),
}));
vi.mock("../src/agents/subscription.js", async (original) => ({
  ...(await original<typeof import("../src/agents/subscription.js")>()),
  chatTurnWay: async () => "openai",
}));

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;
let cookie = "";
let spaceId = "";

const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
);

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
const newChat = async () => (await json(send("POST", "/chats", { spaceId }))).id as string;

const invoices = {
  title: "Offene Rechnungen",
  data: { open: 2, rows: [{ client: "Hofer Bau", amount: "€ 4.200" }] },
  components: [
    { id: "root", component: "Column", children: ["count", "list", "ask"] },
    { id: "count", component: "Metric", label: "Offen", value: { path: "/open" } },
    { id: "list", component: "Table", rows: { path: "/rows" } },
    { id: "ask", component: "Button", label: "Mahnung schreiben", action: "ask" },
  ],
};

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

describe("views in a chat", () => {
  it("shows a view the catalog accepts, and the chat keeps the call with its input", async () => {
    const id = await newChat();
    script.push(callTool("v1", "show_view", invoices), say("Zwei sind offen."));
    await (await send("POST", `/chats/${id}/messages`, { text: "Was ist offen?", ask: true })).text();
    // The tool is the model's like any other, and its description carries the catalog.
    expect(prompts.at(-1)).toContain("show_view");
    const read = await json(send("GET", `/chats/${id}`));
    const call = read.messages[1].parts.find((p: any) => p.type === "tool-show_view");
    expect(call).toMatchObject({
      state: "output-available",
      input: { title: "Offene Rechnungen", data: invoices.data },
      output: { ok: true },
    });
  });

  it("hands a view it refused back with what is wrong", async () => {
    const id = await newChat();
    const wrong = {
      data: {},
      components: [
        { id: "root", component: "Column", children: ["form"] },
        { id: "form", component: "Form", submit: "Senden", children: ["pick"] },
        { id: "pick", component: "Field", name: "pick", kind: "select", label: "Wahl" },
      ],
    };
    script.push(callTool("v2", "show_view", wrong), say("Noch einmal."));
    await (await send("POST", `/chats/${id}/messages`, { text: "Frag mich.", ask: true })).text();
    // The model's next step reads the issues as the call's result.
    expect(prompts.at(-1)).toContain("needs \\\"options\\\"");
    const read = await json(send("GET", `/chats/${id}`));
    const call = read.messages[1].parts.find((p: any) => p.type === "tool-show_view");
    expect(call.output).toMatchObject({ ok: false });
    expect(call.output.issues.join(" ")).toContain('Field "pick" (select) needs "options"');
  });

  it("keeps a Form's answers with the person's message that sends them", async () => {
    const id = await newChat();
    const form = { call: "v1", values: { day: "2026-11-03", how: "Telefon" } };
    await json(
      send("POST", `/chats/${id}/messages`, { text: "Termin\nTag: 3.11.\nWie: Telefon", form }),
    );
    const read = await json(send("GET", `/chats/${id}`));
    expect(read.messages[0]).toMatchObject({ author: { kind: "person" }, form });
    // Too much to be answers is refused.
    const huge = { call: "v1", values: { note: "x".repeat(30_000) } };
    expect((await send("POST", `/chats/${id}/messages`, { text: "x", form: huge })).status).toBe(400);
  });

  it("gives a view's Fields the chat's routes: an upload, its file, the place", async () => {
    const id = await newChat();
    const body = new FormData();
    body.set("file", new File([PIXEL], "baustelle.png", { type: "image/png" }));
    const uploaded = await json(
      app.fetch(
        new Request(url(`/api/studio/work/chats/${id}/uploads`), {
          method: "POST",
          headers: { cookie, origin: "http://localhost:5181" },
          body,
        }),
      ),
    );
    expect(uploaded).toMatchObject({ name: "baustelle.png", mime: "image/png" });
    const file = await send("GET", `/chats/${id}/assets/${uploaded.id}`);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/png");
    expect((await file.arrayBuffer()).byteLength).toBeGreaterThan(0);
    // No geocoder is set up here: the place stands on its coordinates.
    expect(await json(send("POST", `/chats/${id}/geocode`, { lat: 48.2, lng: 16.37 }))).toEqual({
      label: null,
    });
    expect((await send("GET", `/chats/nowhere/assets/${uploaded.id}`)).status).toBe(404);
    expect((await send("POST", "/chats/nowhere/geocode", { lat: 1, lng: 1 })).status).toBe(404);
  });
});
