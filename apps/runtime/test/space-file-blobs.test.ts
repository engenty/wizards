import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// A space file's bytes live in the blob store by their hash: the same bytes once, gone with the
// last row that names them, a picture's or PDF's thumbnail beside them; `wizards move-files`
// brings a file from before over once.

const dir = mkdtempSync(join(tmpdir(), "wizards-space-blobs-"));
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
let client: typeof import("../src/db/client");
let files: typeof import("../src/services/space-files");

const local = <T>(fn: () => T | Promise<T>) => client.withTenant("local", fn);
const blobFile = (hash: string) =>
  join(process.env.DATA_DIR as string, "objects", "t", "local", "blobs", hash.slice(0, 2), hash);
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const thumbFile = (hash: string) =>
  join(process.env.DATA_DIR as string, "objects", "t", "local", "derived", hash, "thumb.jpg");
const studio = (path: string) =>
  app.fetch(new Request(`http://localhost:5181/api/studio${path}`, { headers: { cookie } }));

async function png(width: number, height: number) {
  const { createCanvas } = await import("@napi-rs/canvas");
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#e0531b";
  ctx.fillRect(0, 0, width, height);
  return new Uint8Array(await canvas.encode("png"));
}

/** One A4 page with a black square: the smallest PDF pdf.js draws (it mends the offsets). */
function pdf() {
  const content = "0 0 0 rg 100 400 300 300 re f";
  return new TextEncoder().encode(
    [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >> endobj",
      `4 0 obj << /Length ${content.length} >> stream`,
      content,
      "endstream endobj",
      "trailer << /Root 1 0 R >>",
      "%%EOF",
    ].join("\n"),
  );
}

/** Width and height of a JPEG, from its first frame header. */
function jpegSize(d: Uint8Array) {
  for (let at = 2; at < d.length; ) {
    const marker = d[at + 1];
    if (marker >= 0xc0 && marker <= 0xc2) {
      return { height: (d[at + 5] << 8) | d[at + 6], width: (d[at + 7] << 8) | d[at + 8] };
    }
    at += 2 + ((d[at + 2] << 8) | d[at + 3]);
  }
  return null;
}

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb("local");
  app = (await import("../src/app")).default;
  const entered = await app.fetch(new Request("http://localhost:5181/api/local/enter?k=test-key"));
  cookie = (entered.headers.get("set-cookie") ?? "").split(";")[0];
  files = await import("../src/services/space-files");
  const spaces = await import("../src/services/spaces");
  spaceId = (await local(() => spaces.defaultSpace("local"))).id;
}, 60_000);

describe("space files by hash", () => {
  it("keeps the same bytes once and lets them go with the last file", async () => {
    const data = json({ frames: [1, 2, 3] });
    const add = (name: string) =>
      local(() =>
        files.addSpaceFile(spaceId, {
          kind: "asset",
          name,
          mime: "application/json",
          data,
          description: "an animation",
        }),
      );
    const a = await add("a.json");
    const b = await add("b.json");
    expect(a.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(b.hash).toBe(a.hash);
    expect(existsSync(blobFile(a.hash as string))).toBe(true);
    const read = await local(() => files.spaceFileContent(spaceId, b.id));
    expect(JSON.parse(read.data.toString("utf8"))).toEqual({ frames: [1, 2, 3] });

    await local(() => files.removeSpaceFile(spaceId, a.id));
    expect(existsSync(blobFile(a.hash as string))).toBe(true);
    await local(() => files.removeSpaceFile(spaceId, b.id));
    expect(existsSync(blobFile(a.hash as string))).toBe(false);
  });

  it("keeps bytes a plugin's file replaced only while another row names them", async () => {
    const put = (data: Uint8Array) =>
      local(() =>
        files.putOriginFile("test-plugin", {
          space: spaceId,
          key: "price-list",
          name: "prices.json",
          mime: "application/json",
          data,
        }),
      );
    const first = json({ price: 1 });
    const id = await put(first);
    const before = await local(() => files.spaceFile(spaceId, id));
    await put(json({ price: 2 }));
    const after = await local(() => files.spaceFile(spaceId, id));
    expect(after.hash).not.toBe(before.hash);
    expect(existsSync(blobFile(before.hash as string))).toBe(false);
    await local(() => files.removeOriginFiles("test-plugin", spaceId));
    expect(existsSync(blobFile(after.hash as string))).toBe(false);
  });

  it("serves a logo's public link from its blob", async () => {
    const logo = await local(async () =>
      files.addSpaceFile(spaceId, {
        kind: "logo",
        name: "logo.png",
        mime: "image/png",
        data: await png(8, 8),
        description: "the logo",
      }),
    );
    const res = await app.fetch(new Request(`http://localhost:5181/api/public/logos/${logo.id}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect((await res.arrayBuffer()).byteLength).toBe(logo.size);
  });
});

describe("wizards move-files", () => {
  it("moves a file from its asset to the blob store, once", async () => {
    const { saveAsset } = await import("../src/files/storage");
    const { schema } = client;
    const data = json({ old: true });
    const id = await local(async () => {
      const ref = await saveAsset({
        kind: "space",
        mime: "application/json",
        name: "old.json",
        data,
      });
      await client.db.insert(schema.spaceFile).values({
        id: ref.id,
        spaceId,
        kind: "asset",
        name: "old.json",
        mime: "application/json",
        size: data.byteLength,
      });
      return ref.id;
    });
    await expect(local(() => files.spaceFileContent(spaceId, id))).rejects.toThrow();

    const { moveFiles } = await import("../src/cli/move-files");
    expect(await moveFiles()).toBe(0);
    const row = await local(() => files.spaceFile(spaceId, id));
    expect(row.hash).toMatch(/^[a-f0-9]{64}$/);
    const read = await local(() => files.spaceFileContent(spaceId, id));
    expect(JSON.parse(read.data.toString("utf8"))).toEqual({ old: true });
    const { loadAsset } = await import("../src/files/storage");
    expect(await local(() => loadAsset(id))).toBeNull();
    expect(await moveFiles()).toBe(0);
  });
});

describe("thumbnails", () => {
  it("are a 320 px JPEG of a picture and of a PDF's first page, gone with the blob", async () => {
    const picture = await local(async () =>
      files.addSpaceFile(spaceId, {
        kind: "asset",
        name: "wide.png",
        mime: "image/png",
        data: await png(1200, 600),
        description: "an orange field",
      }),
    );
    const document = await local(() =>
      files.putOriginFile("test-plugin", {
        space: spaceId,
        key: "sheet",
        name: "sheet.pdf",
        mime: "application/pdf",
        data: pdf(),
      }),
    );
    const listed = await (await studio(`/spaces/${spaceId}/files`)).json();
    const view = (id: string) => listed.files.find((f: { id: string }) => f.id === id);
    expect(view(picture.id).thumb).toBe(true);
    expect(view(document).thumb).toBe(true);

    const a = await studio(`/spaces/${spaceId}/files/${picture.id}/thumb`);
    expect(a.status).toBe(200);
    expect(a.headers.get("content-type")).toBe("image/jpeg");
    expect(jpegSize(new Uint8Array(await a.arrayBuffer()))).toEqual({ width: 320, height: 160 });
    const b = await studio(`/spaces/${spaceId}/files/${document}/thumb`);
    expect(b.status).toBe(200);
    const size = jpegSize(new Uint8Array(await b.arrayBuffer()));
    expect(size?.height).toBe(320);
    expect(size?.width).toBeLessThan(320);

    expect(existsSync(thumbFile(picture.hash as string))).toBe(true);
    await local(() => files.removeSpaceFile(spaceId, picture.id));
    expect(existsSync(thumbFile(picture.hash as string))).toBe(false);
  });

  it("aren't there for a file that is no picture", async () => {
    const data = await local(() =>
      files.addSpaceFile(spaceId, {
        kind: "asset",
        name: "data.json",
        mime: "application/json",
        data: json({ thumb: false }),
        description: "data",
      }),
    );
    expect(files.fileView(data).thumb).toBe(false);
    expect((await studio(`/spaces/${spaceId}/files/${data.id}/thumb`)).status).toBe(404);
  });
});
