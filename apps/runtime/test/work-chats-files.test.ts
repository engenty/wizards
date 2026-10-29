import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { beforeAll, describe, expect, it, vi } from "vitest";

// Files in a Work chat: an upload lands in the space's files, a message names it, the model sees
// a picture as a file part and is told of a file it doesn't read, and the chat shows the files as
// links into the space's files. A scripted model answers.

const dir = mkdtempSync(join(tmpdir(), "wizards-work-files-"));
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
const script: unknown[][] = [];
const prompts: any[] = [];
const model = new MockLanguageModelV3({
  doStream: async (options: any) => {
    prompts.push(options.prompt);
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
const upload = (chatId: string, name: string, type: string, data: Uint8Array | string) => {
  const form = new FormData();
  form.set("file", new File([data], name, { type }));
  return app.fetch(
    new Request(url(`/api/studio/work/chats/${chatId}/files`), {
      method: "POST",
      headers: { cookie, origin: "http://localhost:5181" },
      body: form,
    }),
  );
};
const json = async (res: Response | Promise<Response>) => {
  const r = await res;
  expect(r.status, await r.clone().text()).toBeLessThan(300);
  return r.json() as Promise<any>;
};
const newChat = async () => (await json(send("POST", "/chats", { spaceId }))).id as string;
/** The parts of the person's message in the model's last prompt. */
const lastAsked = () =>
  prompts
    .at(-1)
    .filter((m: any) => m.role === "user")
    .flatMap((m: any) => m.content);

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

describe("files in a chat", () => {
  it("puts a picture into the space's files, and the model sees it with the message", async () => {
    const id = await newChat();
    const file = await json(upload(id, "karton.png", "image/png", PIXEL));
    expect(file).toMatchObject({ kind: "asset", name: "karton.png", mime: "image/png" });
    const listed = await app.fetch(
      new Request(url(`/api/studio/spaces/${spaceId}/files`), { headers: { cookie } }),
    );
    expect((await listed.json()).files.map((f: any) => f.id)).toContain(file.id);

    script.push(say("Ein Karton."));
    const res = await send("POST", `/chats/${id}/messages`, {
      text: "Was ist das?",
      files: [file.id],
      ask: true,
    });
    await res.text();
    const parts = lastAsked();
    expect(parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", text: expect.stringContaining("Was ist das?") }),
        expect.objectContaining({ type: "file", mediaType: "image/png", filename: "karton.png" }),
      ]),
    );

    // The chat shows the file as a link into the space's files, never its bytes.
    const read = await json(send("GET", `/chats/${id}`));
    expect(read.messages[0].parts).toEqual([
      expect.objectContaining({ type: "text", text: "Was ist das?" }),
      {
        type: "file",
        fileId: file.id,
        mediaType: "image/png",
        filename: "karton.png",
        url: `/api/studio/spaces/${spaceId}/files/${file.id}/content`,
      },
    ]);
    expect(JSON.stringify(read.messages[0])).not.toContain(PIXEL.toString("base64"));
  });

  it("names a file the model doesn't read, and a message of files alone names the chat", async () => {
    const id = await newChat();
    const file = await json(upload(id, "notiz.txt", "text/plain", "Lieferung am Montag."));
    expect(file).toMatchObject({ kind: "document", name: "notiz.txt" });

    script.push(say("Steht in den Dateien."));
    await (await send("POST", `/chats/${id}/messages`, { files: [file.id], ask: true })).text();
    expect(lastAsked()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", text: expect.stringContaining("notiz.txt") }),
      ]),
    );
    expect(lastAsked().some((p: any) => p.type === "file")).toBe(false);

    const read = await json(send("GET", `/chats/${id}`));
    expect(read.chat.title).toBe("notiz.txt");
    expect(read.messages[0].parts).toEqual([
      expect.objectContaining({ type: "file", fileId: file.id, filename: "notiz.txt" }),
    ]);
  });

  it("refuses an empty message, a file not in the chat's space, and too many files", async () => {
    const id = await newChat();
    expect((await send("POST", `/chats/${id}/messages`, { text: " " })).status).toBe(400);
    expect((await send("POST", `/chats/${id}/messages`, { files: ["nowhere"] })).status).toBe(404);
    const many = Array.from({ length: 11 }, (_, i) => `f${i}`);
    expect((await send("POST", `/chats/${id}/messages`, { files: many })).status).toBe(400);
    expect((await upload("nowhere", "a.txt", "text/plain", "x")).status).toBe(404);
  });
});
