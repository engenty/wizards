import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Pictures in Knowledge by what they show (docs/plans/media-and-files.md, step 3): where the
// embedding model takes pictures and `knowledgeMedia` is on, a picture file is a unit whose vector
// is of the picture, a picture uploaded into Knowledge stays a file, and the search counts meaning
// only where the nearest units stand out. An Ollama of the test's own answers.

const dir = mkdtempSync(join(tmpdir(), "wizards-pictures-"));
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

let client: typeof import("../src/db/client");
let spaceId = "";
const local = <T>(fn: () => T | Promise<T>) => client.withTenant("local", fn);
const who = [
  { kind: "person" as const, id: "local" },
  { kind: "role" as const, id: "owner" },
];

/** A vector along one of eight axes: the test's whole space of meaning. */
const axis = (i: number) => Array.from({ length: 8 }, (_, j) => (j === i ? 1 : 0));
/** The pictures by their JPEG as the index sends it, and the axis each shows. */
const pictures = new Map<string, number>();
/** A question's axis by a word in it; any other text lies on the last axis. */
const meaning = (text: string) => (/badebecken/i.test(text) ? 0 : /fahrrad/i.test(text) ? 5 : 7);

/** A PNG of one colour, `w` × `h`. */
async function png(w: number, h: number, colour: string) {
  const { createCanvas } = await import("@napi-rs/canvas");
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, w, h);
  return new Uint8Array(await canvas.encode("png"));
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
      return reply({
        embeddings: body.input.map((i: { image: string }) => axis(pictures.get(i.image) ?? 6)),
      });
    }
    // The OpenAI-style endpoint: text.
    return reply({
      data: (body.input as string[]).map((t, index) => ({ embedding: axis(meaning(t)), index })),
      usage: { prompt_tokens: 1, total_tokens: 1 },
    });
  });
  client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb("local");
  const spaces = await import("../src/services/spaces");
  spaceId = (await local(() => spaces.defaultSpace("local"))).id;
}, 60_000);

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("pictures by what they show", () => {
  it("finds a picture without a word of the question, and stays a file in Knowledge", async () => {
    const { jpegOf } = await import("../src/files/pictures");
    const { addSpaceFile } = await import("../src/services/space-files");
    const { flushIndex, searchKnowledge } = await import("../src/services/space-index");
    const pool = await png(60, 40, "#3b8fd9");
    const bike = await png(40, 60, "#d93b3b");
    pictures.set((await jpegOf(pool)).toString("base64"), 0);
    pictures.set((await jpegOf(bike)).toString("base64"), 1);
    const asset = await local(() =>
      addSpaceFile(spaceId, { kind: "asset", name: "IMG_4001.png", mime: "image/png", data: pool }),
    );
    const document = await local(() =>
      addSpaceFile(spaceId, {
        kind: "document",
        name: "IMG_4002.png",
        mime: "image/png",
        data: bike,
      }),
    );
    // Reading a file runs after it was added.
    await vi.waitFor(async () => {
      const rows = await local(() => client.db.query.spaceFile.findMany());
      expect(rows.every((r) => r.status === "ready")).toBe(true);
    });
    await flushIndex();
    const units = await local(() =>
      client.db.query.spaceChunk.findMany({
        where: (c, { isNotNull }) => isNotNull(c.kind),
      }),
    );
    expect(units.map((u) => [u.fileId, u.kind, Boolean(u.embedding)]).sort()).toEqual(
      [
        [asset.id, "image", true],
        [document.id, "image", true],
      ].sort(),
    );
    // No vision model wrote a page of the picture: it is found by what it shows.
    const pages = await local(() => client.db.query.spacePage.findMany());
    expect(pages.filter((p) => p.fileId === document.id)).toEqual([]);

    const found = await local(() =>
      searchKnowledge(spaceId, "Badebecken unter Sonnenschirmen", { check: false, who }),
    );
    expect(found.hits[0]).toMatchObject({ open: `f:${asset.id}`, picture: "image" });
    // Nothing stands out for a question no picture or text is near: meaning adds nothing.
    const none = await local(() => searchKnowledge(spaceId, "Fahrrad", { check: false, who }));
    expect(none.hits).toEqual([]);
  });
});
