import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// A space file's bytes live in the blob store by their hash: the same bytes once, gone with the
// last row that names them; `wizards move-files` brings a file from before over once.

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
let spaceId = "";
let client: typeof import("../src/db/client");
let files: typeof import("../src/services/space-files");

const local = <T>(fn: () => T | Promise<T>) => client.withTenant("local", fn);
const blobFile = (hash: string) =>
  join(process.env.DATA_DIR as string, "objects", "t", "local", "blobs", hash.slice(0, 2), hash);
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb("local");
  app = (await import("../src/app")).default;
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
    const { createCanvas } = await import("@napi-rs/canvas");
    const canvas = createCanvas(8, 8);
    canvas.getContext("2d").fillRect(0, 0, 8, 8);
    const png = new Uint8Array(await canvas.encode("png"));
    const logo = await local(() =>
      files.addSpaceFile(spaceId, {
        kind: "logo",
        name: "logo.png",
        mime: "image/png",
        data: png,
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
