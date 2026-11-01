import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Dateien's mounts of a plugin's kind (`registerMountKind`): mounted through the kind's
// `prepare`, listed and indexed through its reader, a file moved at the source keeps its row by
// the source's id, a file gone by its id goes, and where the changes go on from is kept.

const dir = mkdtempSync(join(tmpdir(), "wizards-dateien-kinds-"));
const pluginsDir = join(dir, "plugins");
process.env.DATA_DIR = join(dir, "data");
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.PLUGINS_DIR = pluginsDir;
process.env.PLUGINS_WATCH = "0";
process.env.PLUGIN_JOBS = "0";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.FEATURES = "dateien=on";

function put(path: string, content: string) {
  const file = join(pluginsDir, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

// A drive in memory: files by id, and the changes it tells next.
put("drive/engenty.plugin.json", JSON.stringify({ id: "drive", name: "Drive", version: "0.1.0" }));
put(
  "drive/src/plugin.ts",
  `import { definePlugin } from "@engenty/wizards/plugin";

const memo = ((globalThis as any).__memo ??= { files: new Map(), next: null });
const entry = (id: string, f: { path: string; text: string; modified: number }) => ({
  id, path: f.path, size: f.text.length, modified: f.modified, version: String(f.modified),
});

export default definePlugin(({ server }) => {
  memo.server = server;
  server.registerMountKind({
    kind: "memo",
    async prepare({ source }) {
      if (source.tree !== "kunden") {
        throw new Error("There is no tree " + source.tree + ".");
      }
      return { source: { tree: "kunden" }, name: "Kunden", where: "memo://kunden" };
    },
    open() {
      return {
        async *list() {
          for (const [id, f] of memo.files) yield entry(id, f);
        },
        async changes(cursor) {
          if (cursor === null || !memo.next) return { changed: [], gone: [], cursor: cursor ?? "1" };
          const next = memo.next;
          memo.next = null;
          return next;
        },
        async read(path, opts) {
          const f = opts?.id ? memo.files.get(opts.id) : [...memo.files.values()].find((x) => x.path === path);
          if (!f) throw new Error("gone");
          return new TextEncoder().encode(f.text);
        },
        async stat(path, opts) {
          const f = opts?.id ? memo.files.get(opts.id) : null;
          return f ? entry(opts.id, f) : null;
        },
        async write() {
          throw new Error("read only");
        },
      };
    },
  });
});
`,
);

const memo = ((globalThis as any).__memo ??= { files: new Map(), next: null });

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;
let cookie = "";
let spaceId = "";
let mountId = "";
let client: typeof import("../src/db/client");
let mounts: typeof import("../src/mounts/mounts");

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
const local = <T>(fn: () => T | Promise<T>) => client.withTenant("local", fn);
const files = async () =>
  (await json(send("GET", `/api/studio/spaces/${spaceId}/mounts/${mountId}/files`))).files as {
    id: string;
    path: string;
  }[];

beforeAll(async () => {
  memo.files.set("a", { path: "A1/angebot.md", text: "# Angebot\n\nGlasfaser für Linz.", modified: 1 });
  memo.files.set("b", { path: "A1/notiz.txt", text: "Rahmenvertrag WIN-6.", modified: 1 });
  client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb("local");
  const { loadPlugins } = await import("../src/plugins/loader");
  await loadPlugins();
  app = (await import("../src/app")).default;
  mounts = await import("../src/mounts/mounts");
  const entered = await app.fetch(new Request(url("/api/local/enter?k=test-key")));
  cookie = (entered.headers.get("set-cookie") ?? "").split(";")[0];
  const spaces = await import("../src/services/spaces");
  spaceId = (await local(() => spaces.defaultSpace("local"))).id;
}, 60_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("Dateien, a plugin's mount kinds", () => {
  it("refuses a kind no plugin brings, and a source the kind can't reach", async () => {
    const none = await send("POST", `/api/studio/spaces/${spaceId}/mounts`, {
      kind: "nope",
      source: {},
      see: "all",
      wizards: "all",
    });
    expect(none.status).toBe(400);
    const wrong = await send("POST", `/api/studio/spaces/${spaceId}/mounts`, {
      kind: "memo",
      source: { tree: "fotos" },
      see: "all",
      wizards: "all",
    });
    expect(wrong.status).toBe(400);
    expect((await json(wrong)).error).toContain("There is no tree fotos.");
  });

  it("mounts a plugin's source: listed, indexed, found by its words", async () => {
    const res = await send("POST", `/api/studio/spaces/${spaceId}/mounts`, {
      kind: "memo",
      source: { tree: "kunden" },
      see: "all",
      wizards: "all",
    });
    expect(res.status).toBe(200);
    const mount = await json(res);
    mountId = mount.id;
    expect(mount).toMatchObject({
      name: "Kunden",
      kind: "memo",
      plugin: "drive",
      where: "memo://kunden",
    });
    await local(async () => {
      await mounts.scanMount(mountId);
      await mounts.flushMounts();
    });
    expect((await files()).map((f) => f.path)).toEqual(["A1/angebot.md", "A1/notiz.txt"]);
    const { searchKnowledge } = await import("../src/services/space-index");
    const hits = await local(() =>
      searchKnowledge(spaceId, "Glasfaser", {
        who: [
          { kind: "person", id: "local" },
          { kind: "role", id: "owner" },
        ],
        check: false,
      }),
    );
    expect(hits.hits.some((h: { path?: string }) => h.path === "dateien/kunden/A1/angebot.md")).toBe(
      true,
    );
    const again = await send("POST", `/api/studio/spaces/${spaceId}/mounts`, {
      kind: "memo",
      source: { tree: "kunden" },
      see: "all",
      wizards: "all",
    });
    expect(again.status).toBe(400);
    expect((await json(again)).error).toContain("is mounted in this space already");
  });

  it("keeps a moved file's row by the source's id, and drops one gone by its id", async () => {
    const before = await files();
    const moved = before.find((f) => f.path === "A1/angebot.md");
    memo.files.set("a", { path: "Archiv/angebot-alt.md", text: "# Angebot\n\nGlasfaser für Linz.", modified: 2 });
    memo.files.delete("b");
    memo.next = {
      changed: [
        { id: "a", path: "Archiv/angebot-alt.md", size: 29, modified: 2, version: "2" },
      ],
      gone: [],
      goneIds: ["b"],
      cursor: "2",
    };
    await local(async () => {
      await memo.server.mounts.changed(mountId);
      await mounts.flushMounts();
    });
    const after = await files();
    expect(after.map((f) => [f.id, f.path])).toEqual([[moved?.id, "Archiv/angebot-alt.md"]]);
    const [row] = await local(() =>
      client.db.all<{ cursor: string }>(sql`SELECT cursor FROM space_mount WHERE id = ${mountId}`),
    );
    expect(row.cursor).toBe("2");
    const content = await send(
      "GET",
      `/api/studio/spaces/${spaceId}/mount-files/${moved?.id}/content`,
    );
    expect(await content.text()).toContain("Glasfaser");
  });

  it("lists the plugin's mounts for the plugin", async () => {
    const listed = await local(() => memo.server.mounts.list(spaceId));
    expect(listed).toEqual([
      { id: mountId, space: spaceId, name: "Kunden", source: { tree: "kunden" }, kind: "memo" },
    ]);
  });
});
