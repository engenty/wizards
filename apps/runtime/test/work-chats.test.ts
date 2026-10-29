import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// Work's chats (behind `workMode`): a space's chats and sections, the messages in a Mastra memory
// thread of the tenant's own database, what the sidebar shows of them, private chats.

const dir = mkdtempSync(join(tmpdir(), "wizards-work-chats-"));
process.env.DATA_DIR = join(dir, "data");
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.PLUGINS_DIR = join(dir, "plugins");
process.env.PLUGINS_WATCH = "0";
process.env.PLUGIN_JOBS = "0";
process.env.FEATURES = "workMode=on";

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

describe("work chats", () => {
  it("keeps a message in the chat's thread, with its author, and names the chat by it", async () => {
    const chat = await json(send("POST", "/chats", { spaceId }));
    expect(chat).toMatchObject({ spaceId, title: "", parentId: null });
    await json(send("POST", `/chats/${chat.id}/messages`, { text: "Mandantenbrief vorbereiten\nBis Freitag." }));
    const read = await json(send("GET", `/chats/${chat.id}`));
    expect(read.chat.title).toBe("Mandantenbrief vorbereiten");
    expect(read.messages).toEqual([
      expect.objectContaining({
        author: expect.objectContaining({ kind: "person", id: "local" }),
        parts: [expect.objectContaining({ type: "text", text: "Mandantenbrief vorbereiten\nBis Freitag." })],
      }),
    ]);
    const side = await json(send("GET", `/chats?space=${spaceId}`));
    const row = side.chats.find((c: any) => c.id === chat.id);
    expect(row.last).toMatchObject({ text: "Mandantenbrief vorbereiten Bis Freitag." });
    // Your own message is never unread.
    expect(row.unread).toBe(false);
  });

  it("finds a chat by its last message, and lists a space's sections in their order", async () => {
    const one = await json(send("POST", "/sections", { spaceId, name: "Kanzlei Huber" }));
    const two = await json(send("POST", "/sections", { spaceId, name: "Intern" }));
    await json(send("POST", `/sections/${two.id}/move`, { direction: "up" }));
    const chat = await json(send("POST", "/chats", { spaceId, sectionId: one.id }));
    await json(send("POST", `/chats/${chat.id}/messages`, { text: "Urlaubsplanung Dezember" }));
    const side = await json(send("GET", `/chats?space=${spaceId}&q=Dezember`));
    expect(side.sections.map((s: any) => s.name)).toEqual(["Intern", "Kanzlei Huber"]);
    expect(side.chats.map((c: any) => c.id)).toEqual([chat.id]);
  });

  it("puts a sub-thread in its parent's space and section, and deletes both with their messages", async () => {
    const section = await json(send("POST", "/sections", { spaceId, name: "Steuer" }));
    const parent = await json(send("POST", "/chats", { spaceId, sectionId: section.id }));
    const thread = await json(send("POST", "/chats", { parentId: parent.id }));
    expect(thread).toMatchObject({ spaceId, sectionId: section.id, parentId: parent.id });
    await json(send("POST", `/chats/${thread.id}/messages`, { text: "Fristen prüfen" }));
    expect((await json(send("GET", `/chats/${parent.id}`))).threads.map((t: any) => t.id)).toEqual([
      thread.id,
    ]);
    await json(send("DELETE", `/chats/${parent.id}`));
    expect((await send("GET", `/chats/${thread.id}`)).status).toBe(404);
    const client = await import("../src/db/client");
    const raw = await client.tenantClient("local");
    const left = await raw.execute({
      sql: "select count(*) as n from mastra_messages where thread_id = ?",
      args: [thread.id],
    });
    expect(Number(left.rows[0]?.n)).toBe(0);
  });

  it("refuses a space of nobody's", async () => {
    expect((await send("POST", "/chats", { spaceId: "nowhere" })).status).toBe(404);
    expect((await send("GET", "/chats?space=nowhere")).status).toBe(404);
  });
});
