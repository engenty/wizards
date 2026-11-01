import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Pictures of a page a plugin writes (docs/plans/media-and-files.md, section 1): with
// `knowledgeMedia` on, `putPage` `images` are copied into the space once, the Markdown points at
// the copies, the search finds them by what they show, and one no page shows any more goes.

const dir = mkdtempSync(join(tmpdir(), "wizards-page-pictures-"));
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
process.env.FEATURES = "knowledgeMedia=on";

/** The pictures the web serves in this test, by their address. */
const served = new Map<string, Uint8Array>();
const fetched: string[] = [];

vi.mock("../src/tools/net-guard", async (original) => ({
  ...(await original<typeof import("../src/tools/net-guard")>()),
  safeFetch: async (url: string) => {
    fetched.push(url);
    const data = served.get(url);
    return data
      ? new Response(data, { headers: { "content-type": "image/png" } })
      : new Response("", { status: 404 });
  },
}));

let client: typeof import("../src/db/client");
let spaceId = "";
const local = <T>(fn: () => T | Promise<T>) => client.withTenant("local", fn);
const who = [
  { kind: "person" as const, id: "local" },
  { kind: "role" as const, id: "owner" },
];

const axis = (i: number) => Array.from({ length: 8 }, (_, j) => (j === i ? 1 : 0));
/** A question's axis by a word in it; any other text lies on the last axis. */
const meaning = (text: string) => (/badebecken/i.test(text) ? 0 : 7);

/** A photo-like PNG `w` × `h` (noise, so it is more than 10 KB), mostly blue or red. */
async function png(w: number, h: number, blue: boolean) {
  const { createCanvas } = await import("@napi-rs/canvas");
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(w, h);
  for (let i = 0; i < image.data.length; i += 4) {
    const strong = 200 + Math.floor(Math.random() * 55);
    const weak = Math.floor(Math.random() * 40);
    image.data.set(blue ? [weak, weak, strong, 255] : [strong, weak, weak, 255], i);
  }
  ctx.putImageData(image, 0, 0);
  return new Uint8Array(await canvas.encode("png"));
}

/** What a picture shows, to the test's embedding model: blue is water, red something else. */
async function pictureAxis(base64: string) {
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const image = await loadImage(Buffer.from(base64, "base64"));
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);
  const [r, , b] = ctx.getImageData(image.width >> 1, image.height >> 1, 1, 1).data;
  return b > r ? 0 : 5;
}

const realFetch = globalThis.fetch;

beforeAll(async () => {
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
      const out = [];
      for (const i of body.input as { image: string }[]) {
        out.push(axis(await pictureAxis(i.image)));
      }
      return reply({ embeddings: out });
    }
    return reply({
      data: (body.input as string[]).map((t, index) => ({ embedding: axis(meaning(t)), index })),
      usage: { prompt_tokens: 1, total_tokens: 1 },
    });
  });
  served.set("https://example.com/pool.png", await png(400, 300, true));
  served.set("https://example.com/bike.png", await png(300, 400, false));
  served.set("https://example.com/icon.png", await png(64, 64, false));
  client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb("local");
  const spaces = await import("../src/services/spaces");
  spaceId = (await local(() => spaces.defaultSpace("local"))).id;
}, 60_000);

afterAll(() => {
  vi.unstubAllGlobals();
});

const pictureRows = () =>
  local(() =>
    client.db.query.spaceFile.findMany({ where: (f, { eq }) => eq(f.kind, "picture") }),
  );

describe("pictures of a plugin's pages", () => {
  it("copies them once, points the Markdown at the copies and finds them by what they show", async () => {
    const { originData } = await import("../src/services/space-origin");
    const { flushIndex, searchKnowledge } = await import("../src/services/space-index");
    const data = originData("sourcer");
    const first = await local(() =>
      data.putPage({
        space: spaceId,
        key: "web:sommer",
        title: "Sommer im Freibad",
        markdown:
          "# Sommer\n\n![Becken](https://example.com/pool.png)\n\n![](https://example.com/icon.png)",
        images: [
          { url: "https://example.com/pool.png", alt: "Becken" },
          { url: "https://example.com/icon.png", alt: "" },
          { url: "https://example.com/bike.png", alt: "Rad" },
        ],
      }),
    );
    const rows = await pictureRows();
    const pool = rows.find((r) => r.source === "https://example.com/pool.png");
    const bike = rows.find((r) => r.source === "https://example.com/bike.png");
    expect(rows).toHaveLength(2);
    expect(pool).toMatchObject({ origin: "sourcer", description: "Becken" });
    const page = await local(() =>
      client.db.query.spacePage.findFirst({ where: (p, { eq }) => eq(p.id, first.id) }),
    );
    // The icon is too small to keep; the picture the text didn't show comes at its end.
    expect(page?.markdown).toBe(
      `# Sommer\n\n![Becken](asset://${pool?.id})\n\n![](https://example.com/icon.png)\n\n![Rad](asset://${bike?.id})\n`,
    );
    // Not an item of the plugin's own.
    expect((await local(() => data.list(spaceId))).map((i) => i.kind)).toEqual(["page"]);

    await flushIndex();
    const found = await local(() =>
      searchKnowledge(spaceId, "Badebecken", { check: false, who }),
    );
    expect(found.hits[0]).toMatchObject({
      key: `f:${pool?.id}`,
      open: `p:${first.id}`,
      picture: "image",
      title: "Becken",
    });
  });

  it("takes the copy another page has, and lets a picture go once no page shows it", async () => {
    const { originData } = await import("../src/services/space-origin");
    const data = originData("sourcer");
    fetched.length = 0;
    const second = await local(() =>
      data.putPage({
        space: spaceId,
        key: "web:preise",
        title: "Preise",
        markdown: "![Becken](https://example.com/pool.png)",
        images: [{ url: "https://example.com/pool.png", alt: "Becken" }],
      }),
    );
    expect(fetched).toEqual([]);
    const pool = (await pictureRows()).find((r) => r.source === "https://example.com/pool.png");
    expect(second.state).toBe("written");

    // The first page without its pictures: the bike goes, the pool stays for the second page.
    await local(() =>
      data.putPage({ space: spaceId, key: "web:sommer", title: "Sommer", markdown: "Zu." }),
    );
    expect((await pictureRows()).map((r) => r.id)).toEqual([pool?.id]);

    await local(() => data.remove(spaceId, "web:preise"));
    expect(await pictureRows()).toEqual([]);
  });
});
