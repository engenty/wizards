import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The live hub and the studio's stream (docs/plans/live-changes.md, 2–3): ids of what changed in
// the tenant, numbered, resumable, from writes of this process and of others.

const dir = mkdtempSync(join(tmpdir(), "wizards-live-stream-"));
process.env.DATA_DIR = join(dir, "data");
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.PLUGINS_DIR = join(dir, "plugins");
process.env.PLUGINS_WATCH = "0";
process.env.PLUGIN_JOBS = "0";
process.env.MARKETPLACE_URL = "off";
process.env.FEATURES = "liveChanges=on";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;
let cookie = "";
let spaceId = "";
let client: typeof import("../src/db/client");
let routes: typeof import("../src/routes/live");
const url = (path: string) => `http://localhost:5181${path}`;
const local = <T>(fn: () => Promise<T>) => client.withTenant("local", fn);

const call = (method: string, path: string, body?: unknown) =>
  app.fetch(
    new Request(url(path), {
      method,
      headers: { cookie, "content-type": "application/json", origin: "http://localhost:5181" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

interface Heard {
  event: string;
  id?: string;
  data: any;
}

/** An open stream: what it heard so far, and a wait for the next event that fits. */
async function open(headers: Record<string, string> = {}, query = "") {
  const res = await app.fetch(new Request(url(`/api/studio/live${query}`), { headers: { cookie, ...headers } }));
  const heard: Heard[] = [];
  const waiters: { fit: (e: Heard) => boolean; done: (e: Heard) => void }[] = [];
  if (res.status !== 200 || !res.body) {
    return { res, heard, next: async () => undefined as unknown as Heard, close: async () => undefined };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) {
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      let cut = buffer.indexOf("\n\n");
      while (cut >= 0) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const e: Heard = { event: "message", data: null };
        for (const line of block.split("\n")) {
          const [key, ...rest] = line.split(":");
          const value = rest.join(":").trimStart();
          if (key === "event") e.event = value;
          if (key === "id") e.id = value;
          if (key === "data") e.data = value ? JSON.parse(value) : null;
        }
        heard.push(e);
        for (const w of [...waiters]) {
          if (w.fit(e)) {
            waiters.splice(waiters.indexOf(w), 1);
            w.done(e);
          }
        }
        cut = buffer.indexOf("\n\n");
      }
    }
  })();
  const next = (fit: (e: Heard) => boolean, ms = 3000) =>
    new Promise<Heard>((done, fail) => {
      const found = heard.find(fit);
      if (found) {
        return done(found);
      }
      const timer = setTimeout(() => fail(new Error(`nothing heard within ${ms} ms`)), ms);
      waiters.push({ fit, done: (e) => (clearTimeout(timer), done(e)) });
    });
  return { res, heard, next, close: () => reader.cancel() };
}

const hasItem = (item: string) => (e: Heard) =>
  e.event === "changes" && e.data.items.some((i: { item: string }) => i.item === item);

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb("local");
  app = (await import("../src/app")).default;
  routes = await import("../src/routes/live");
  const entered = await app.fetch(new Request(url("/api/local/enter?k=test-key")));
  cookie = (entered.headers.get("set-cookie") ?? "").split(";")[0];
  const projects = await import("../src/services/projects");
  spaceId = (await local(() => projects.defaultProject("local"))).id;
}, 60_000);

const streams: { close: () => Promise<unknown> }[] = [];
afterAll(async () => {
  await Promise.all(streams.map((s) => s.close()));
});

async function newPage(title: string): Promise<string> {
  const res = await call("POST", `/api/studio/projects/${spaceId}/pages`, { title });
  return ((await res.json()) as { id: string }).id;
}

describe("GET /api/studio/live", () => {
  it("says hello with the newest number and sends a save in this process at once", async () => {
    const s = await open();
    streams.push(s);
    expect(s.res.headers.get("content-type")).toContain("text/event-stream");
    expect(s.res.headers.get("x-accel-buffering")).toBe("no");
    const hello = await s.next((e) => e.event === "hello");
    expect(typeof hello.data.seq).toBe("number");
    const started = Date.now();
    const id = await newPage("Nudged");
    const heard = await s.next(hasItem(id), 900);
    expect(Date.now() - started).toBeLessThan(900);
    expect(heard.id).toBe(String(heard.data.seq));
    expect(heard.data.items).toContainEqual({ kind: "page", op: "put", item: id, projectId: spaceId, parent: null });
    await s.close();
  });

  it("hears a write of another process within the next tick", async () => {
    const s = await open();
    streams.push(s);
    await s.next((e) => e.event === "hello");
    // Another process on the same file: the runner, the doors, a second replica.
    const other = createClient({ url: `file:${join(process.env.DATA_DIR ?? "", "tenants", "local.db")}` });
    const started = Date.now();
    await other.execute({
      sql: "INSERT INTO space_page (id, tenant_id, project_id, title, markdown) VALUES ('elsewhere', 'local', ?, 'From the runner', '')",
      args: [spaceId],
    });
    await s.next(hasItem("elsewhere"), 3500);
    expect(Date.now() - started).toBeLessThan(3500);
    other.close();
    await s.close();
  });

  it("catches up from Last-Event-ID after a drop", async () => {
    const first = await open();
    const hello = await first.next((e) => e.event === "hello");
    await first.close();
    const id = await newPage("While away");
    const again = await open({ "last-event-id": String(hello.data.seq) });
    streams.push(again);
    expect((await again.next((e) => e.event === "hello")).data.seq).toBeGreaterThan(hello.data.seq);
    await again.next(hasItem(id));
    await again.close();
  });

  it("resets for a number of another database and for changes no longer kept", async () => {
    const foreign = await open({}, "?since=999999999");
    streams.push(foreign);
    expect((await foreign.next(() => true)).event).toBe("reset");
    await foreign.close();
    const before = await local(async () => (await import("../src/live/feed")).newestSeq());
    await newPage("Old");
    await newPage("Older");
    await local(async () => {
      const { sql } = await import("drizzle-orm");
      await client.db.run(sql`DELETE FROM live_change WHERE seq <= ${before + 1}`);
    });
    const gap = await open({ "last-event-id": String(before) });
    streams.push(gap);
    expect((await gap.next(() => true)).event).toBe("reset");
    await gap.close();
  });

  it("resets when more than 1000 changes come at once", async () => {
    const s = await open();
    streams.push(s);
    await s.next((e) => e.event === "hello");
    const tableId = ((await (await call("POST", `/api/studio/projects/${spaceId}/tables`, { title: "Bulk" })).json()) as { id: string }).id;
    await local(async () => {
      const { sql } = await import("drizzle-orm");
      await client.db.run(sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1100)
        INSERT INTO space_table_row (id, table_id, cells) SELECT 'bulk-' || i, ${tableId}, '{}' FROM n`);
    });
    await s.next((e) => e.event === "reset", 4000);
    await s.close();
  });

  it("answers 429 beyond the streams a person may have open", async () => {
    const saved = routes.STREAM_LIMITS.person;
    routes.STREAM_LIMITS.person = 1;
    const one = await open();
    await one.next((e) => e.event === "hello");
    const two = await open();
    expect(two.res.status).toBe(429);
    expect(((await two.res.json()) as { code: string }).code).toBe("too_many_streams");
    await one.close();
    routes.STREAM_LIMITS.person = saved;
  });

  it("is not there while the switch is off", async () => {
    process.env.FEATURES = "liveChanges=off";
    const s = await open();
    expect(s.res.status).toBe(404);
    process.env.FEATURES = "liveChanges=on";
  });
});
