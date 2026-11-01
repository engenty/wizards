import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Dateien (docs/plans/media-and-files.md, section 3): a folder of this computer mounted in a space,
// listed against its rows, indexed without its text, found by the search beside Knowledge,
// read by its path; a renamed file keeps its row and its categories; access per mount. An Ollama
// of the test's own embeds: a photo is found by what it shows.

const dir = mkdtempSync(join(tmpdir(), "wizards-dateien-"));
process.env.DATA_DIR = join(dir, "data");
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.PLUGINS_DIR = join(dir, "plugins");
process.env.PLUGINS_WATCH = "0";
process.env.PLUGIN_JOBS = "0";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.OLLAMA_URL = "http://ollama.test/v1";
process.env.FEATURES = "dateien=on,knowledgeMedia=on";

const folder = join(dir, "Kunden");

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
const who = [
  { kind: "person" as const, id: "local" },
  { kind: "role" as const, id: "owner" },
];
const search = (query: string, as = who) =>
  local(async () => {
    const { searchKnowledge } = await import("../src/services/space-index");
    return searchKnowledge(spaceId, query, { who: as, check: false });
  });
const scan = () =>
  local(async () => {
    await mounts.scanMount(mountId);
    await mounts.flushMounts();
  });

/** A vector along one of eight axes: the test's whole space of meaning. */
const axis = (i: number) => Array.from({ length: 8 }, (_, j) => (j === i ? 1 : 0));
/** The pictures by their JPEG as the index sends it, and the axis each shows. */
const pictures = new Map<string, number>();
const meaning = (text: string) => (/badebecken/i.test(text) ? 0 : 7);
const realFetch = globalThis.fetch;

/** A PNG of one colour. */
async function png(colour: string) {
  const { createCanvas } = await import("@napi-rs/canvas");
  const canvas = createCanvas(60, 40);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, 60, 40);
  return canvas.encode("png");
}

function write(path: string, text: string | Uint8Array) {
  mkdirSync(join(folder, path, ".."), { recursive: true });
  writeFileSync(join(folder, path), text);
}

beforeAll(async () => {
  write("A1 Telekom/angebot.md", "# Angebot\n\nGlasfaser für den Standort Linz, Preis 4200 Euro.\n");
  write("Erste Group/notizen.txt", "Besprechung zum Rahmenvertrag WIN-6 am Montag.");
  write("liesmich.md", "# Kunden\n\nDie Ordner sind nach Kunden geordnet.");
  write(".DS_Store", "x");
  write("~$angebot.docx", "lock");
  const { jpegOf } = await import("../src/files/pictures");
  const pool = await png("#3b8fd9");
  pictures.set((await jpegOf(pool)).toString("base64"), 0);
  write("Fotos/IMG_4001.png", pool);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const address = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!address.startsWith("http://ollama.test/")) {
      return realFetch(input, init);
    }
    const reply = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    if (address.endsWith("/api/tags")) {
      return reply({
        models: [{ name: "embeddinggemma-2:740m", capabilities: ["embedding", "vision"] }],
      });
    }
    const body = JSON.parse(String(init?.body));
    if (address.endsWith("/api/embed")) {
      return reply({
        embeddings: body.input.map((i: { image: string }) => axis(pictures.get(i.image) ?? 6)),
      });
    }
    return reply({
      data: (body.input as string[]).map((t, index) => ({ embedding: axis(meaning(t)), index })),
      usage: { prompt_tokens: 1, total_tokens: 1 },
    });
  });
  client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb("local");
  app = (await import("../src/app")).default;
  mounts = await import("../src/mounts/mounts");
  const entered = await app.fetch(new Request(url("/api/local/enter?k=test-key")));
  cookie = (entered.headers.get("set-cookie") ?? "").split(";")[0];
  const spaces = await import("../src/services/spaces");
  spaceId = (await local(() => spaces.defaultSpace("local"))).id;
}, 60_000);

afterAll(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

describe("Dateien", () => {
  it("cuts a text into passages that know where they stand", async () => {
    const { textUnits, unitText } = await import("../src/mounts/units");
    const text = "Vorwort.\n\n# Teil\n\n## Eins\n\nErster Absatz.\n\n<!-- S. 2 -->\n\n## Zwei\n\nZweiter.";
    const units = textUnits(text);
    expect(units.map((u) => [u.heading, u.sheet])).toEqual([
      [null, null],
      ["Teil › Eins", null],
      ["Teil › Zwei", 2],
    ]);
    expect(unitText(text, units[1])).toBe("## Teil › Eins\n\nErster Absatz.\n\n<!-- S. 2 -->");
    const long = Array.from({ length: 30 }, (_, i) => `Absatz ${i} ${"x".repeat(150)}`).join("\n\n");
    const parts = textUnits(long);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.end - p.start <= 2400)).toBe(true);
    expect(parts.map((p) => long.slice(p.start, p.end)).join("").replace(/\s/g, "")).toBe(
      long.replace(/\s/g, ""),
    );
  });

  it("reviews a folder before it is mounted", async () => {
    const preview = await json(send("POST", `/api/studio/spaces/${spaceId}/mounts/preview`, { path: folder }));
    expect(preview).toMatchObject({ files: 4, folders: 3, top: 1, leftOut: 2, complete: true });
    expect(preview.first).toEqual([
      { name: "A1 Telekom", files: 1 },
      { name: "Erste Group", files: 1 },
      { name: "Fotos", files: 1 },
    ]);
  });

  it("mounts a folder: listed, indexed, found by its words", async () => {
    const res = await send("POST", `/api/studio/spaces/${spaceId}/mounts`, {
      path: folder,
      see: ["team"],
      wizards: "all",
      folderCategory: "Kunde",
    });
    expect(res.status).toBe(200);
    const mount = await json(res);
    mountId = mount.id;
    expect(mount).toMatchObject({ name: "Kunden", slug: "kunden", kind: "folder" });
    await scan();
    const { files } = await json(send("GET", `/api/studio/spaces/${spaceId}/mounts/${mountId}/files`));
    expect(files.map((f: { path: string }) => f.path)).toEqual([
      "A1 Telekom/angebot.md",
      "Erste Group/notizen.txt",
      "Fotos/IMG_4001.png",
      "liesmich.md",
    ]);
    expect(files.find((f: { name: string }) => f.name === "IMG_4001.png").thumb).toBe(true);
    expect(files.every((f: { status: string }) => f.status === "ready")).toBe(true);
    const found = await search("Rahmenvertrag WIN-6");
    expect(found.hits[0]).toMatchObject({
      kind: "mounted",
      path: "dateien/kunden/Erste Group/notizen.txt",
      title: "notizen.txt",
      categories: ["Kunde: Erste Group"],
      mount: { id: mountId, name: "Kunden" },
    });
    // No text is kept: the snippet is read from the original.
    expect(found.hits[0].text).toContain("Rahmenvertrag WIN-6");
    const units = await local(() =>
      client.db.all<{ n: number }>(sql`SELECT count(*) AS n FROM space_mount_unit`),
    );
    expect(units[0].n).toBeGreaterThan(3);
  });

  it("finds a photo by what it shows, and gives its thumbnail", async () => {
    const found = await search("ein Badebecken");
    expect(found.hits[0]).toMatchObject({
      path: "dateien/kunden/Fotos/IMG_4001.png",
      picture: "image",
    });
    const id = found.hits[0].open?.slice(2);
    const thumb = await send("GET", `/api/studio/spaces/${spaceId}/mount-files/${id}/thumb`);
    expect(thumb.headers.get("content-type")).toBe("image/jpeg");
  });

  it("filters mounted files by the folders' category", async () => {
    const found = await local(async () => {
      const { searchKnowledge } = await import("../src/services/space-index");
      return searchKnowledge(spaceId, "Glasfaser Rahmenvertrag", {
        who,
        check: false,
        where: { Kunde: "A1 Telekom" },
      });
    });
    expect(found.hits.map((h) => h.path)).toEqual(["dateien/kunden/A1 Telekom/angebot.md"]);
  });

  it("keeps a renamed file's row and its categories", async () => {
    const before = await json(send("GET", `/api/studio/spaces/${spaceId}/mounts/${mountId}/files`));
    const id = before.files.find((f: { path: string }) => f.path.endsWith("notizen.txt")).id;
    const set = await send("PUT", `/api/studio/spaces/${spaceId}/items/m:${id}/categories/${await categoryId("Kunde")}`, {
      values: ["Erste Bank"],
    });
    expect(set.status).toBe(200);
    renameSync(join(folder, "Erste Group/notizen.txt"), join(folder, "Erste Group/protokoll.txt"));
    await scan();
    const after = await json(send("GET", `/api/studio/spaces/${spaceId}/mounts/${mountId}/files`));
    const moved = after.files.find((f: { path: string }) => f.path.endsWith("protokoll.txt"));
    expect(moved.id).toBe(id);
    const found = await search("Rahmenvertrag");
    expect(found.hits[0]).toMatchObject({
      path: "dateien/kunden/Erste Group/protokoll.txt",
      categories: ["Kunde: Erste Bank"],
    });
  });

  it("opens a file where it lives, and forgets one that is gone", async () => {
    const { files } = await json(send("GET", `/api/studio/spaces/${spaceId}/mounts/${mountId}/files`));
    const file = files.find((f: { path: string }) => f.path === "liesmich.md");
    const res = await send("GET", `/api/studio/spaces/${spaceId}/mount-files/${file.id}/content`);
    expect(await res.text()).toContain("nach Kunden geordnet");
    rmSync(join(folder, "liesmich.md"));
    await scan();
    expect((await search("geordnet")).hits.filter((h) => h.kind === "mounted")).toEqual([]);
  });

  it("lets a wizard use a mount only where its rules say so", async () => {
    const wizard = [...who, { kind: "wizard" as const, id: "w1" }];
    expect((await search("Glasfaser", wizard)).hits.length).toBe(1);
    await send("PATCH", `/api/studio/spaces/${spaceId}/mounts/${mountId}`, { wizards: ["w2"] });
    expect((await search("Glasfaser", wizard)).hits).toEqual([]);
    const other = [...who, { kind: "wizard" as const, id: "w2" }];
    expect((await search("Glasfaser", other)).hits.length).toBe(1);
    const member = [
      { kind: "person" as const, id: "m1" },
      { kind: "role" as const, id: "member" },
    ];
    expect((await search("Glasfaser", member)).hits.length).toBe(1);
    await send("PATCH", `/api/studio/spaces/${spaceId}/mounts/${mountId}`, { see: [] });
    expect((await search("Glasfaser", member)).hits).toEqual([]);
    const access = await json(send("GET", `/api/studio/spaces/${spaceId}/mounts/${mountId}`));
    expect(access).toMatchObject({ see: [], wizards: ["w2"] });
    // Clients and guests see it, the team doesn't: the guest reads, and a client.
    await send("PATCH", `/api/studio/spaces/${spaceId}/mounts/${mountId}`, {
      see: ["clients", "guests"],
    });
    const guest = [{ kind: "guest" as const, id: null }];
    const client = [{ kind: "role" as const, id: "client" }];
    const readers = (s: { kind: any; id: string | null }[]) =>
      local(async () => (await import("../src/broker/rwx")).readableMounts(spaceId, s, [mountId]));
    expect((await readers(guest)).has(mountId)).toBe(true);
    expect((await readers(client)).has(mountId)).toBe(true);
    expect((await readers(member)).has(mountId)).toBe(false);
    expect(await json(send("GET", `/api/studio/spaces/${spaceId}/mounts/${mountId}`))).toMatchObject({
      see: ["clients", "guests"],
    });
  });

  it("reads a mounted file by its path for a step", async () => {
    const found = await local(() => mounts.fileByPath(spaceId, "dateien/kunden/A1 Telekom/angebot.md", who));
    expect(found?.file.name).toBe("angebot.md");
    expect(await local(() => mounts.mountFileText(found!.mount, found!.file))).toContain("Linz");
  });

  it("takes a mount out, and leaves the folder", async () => {
    expect((await send("DELETE", `/api/studio/spaces/${spaceId}/mounts/${mountId}`)).status).toBe(200);
    expect((await search("Glasfaser")).hits).toEqual([]);
    const fts = await local(() =>
      client.db.all<{ n: number }>(
        sql`SELECT count(*) AS n FROM space_mount_unit_fts WHERE space_mount_unit_fts MATCH 'Glasfaser'`,
      ),
    );
    expect(fts[0].n).toBe(0);
    const { files } = await json(send("GET", `/api/studio/spaces/${spaceId}/mounts`)).then((r) => ({ files: r.mounts }));
    expect(files).toEqual([]);
  });
});

async function categoryId(name: string): Promise<string> {
  const rows = await local(() => client.db.query.spaceCategory.findMany());
  return rows.find((c) => c.name === name)?.id as string;
}
