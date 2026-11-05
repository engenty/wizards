import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Text units whose vector is of another model, or that have none, get one of the model at hand in
// the background: on a Manage-App's runtime the binding changes without a word to the runtime.
// An Ollama of the test's own answers.

const dir = mkdtempSync(join(tmpdir(), "wizards-vectors-"));
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

const MODEL = "ollama:embeddinggemma-2:740m";

let client: typeof import("../src/db/client");
let spaceId = "";
const local = <T>(fn: () => T | Promise<T>) => client.withTenant("local", fn);

/** Answers a text with a vector; while set, the OpenAI-style endpoint fails. */
let down = false;
let calls = 0;
const realFetch = globalThis.fetch;

async function units() {
  return local(() => client.db.query.spaceChunk.findMany());
}

/** A unit as it stands in the index: with a vector of `model`, or none. */
async function addUnit(ref: string, model: string | null) {
  await local(() =>
    client.db.insert(client.schema.spaceChunk).values({
      spaceId,
      plugin: "test",
      ref,
      idx: 0,
      text: `Text ${ref}`,
      embedding: model ? Buffer.from(new Float32Array([0, 1]).buffer) : null,
      model,
    }),
  );
}

beforeAll(async () => {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const address =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!address.startsWith("http://ollama.test/")) {
      return realFetch(input, init);
    }
    const reply = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (address.endsWith("/api/tags")) {
      return reply({ models: [{ name: "embeddinggemma-2:740m", capabilities: ["embedding"] }] });
    }
    calls++;
    if (down) {
      return reply({ error: { message: "down" } }, 400);
    }
    const body = JSON.parse(String(init?.body));
    return reply({
      data: (body.input as string[]).map((_, index) => ({ embedding: [1, 0], index })),
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

describe("vectors of the model at hand", () => {
  it("embeds what has none or another model's, and leaves the model's own alone", async () => {
    const { flushIndex, queueVectors } = await import("../src/services/space-index");
    await addUnit("none", null);
    await addUnit("other", "openai/text-embedding-3-small");
    await addUnit("own", MODEL);
    await local(() => queueVectors());
    await flushIndex();
    const rows = await units();
    expect(rows.map((r) => r.model)).toEqual([MODEL, MODEL, MODEL]);
    const vector = (ref: string) => {
      const found = rows.find((r) => r.ref === ref)?.embedding as Buffer;
      return Array.from(new Float32Array(new Uint8Array(found).buffer));
    };
    expect(vector("none")).toEqual([1, 0]);
    expect(vector("other")).toEqual([1, 0]);
    expect(vector("own")).toEqual([0, 1]);
    // Nothing left: the next round asks nothing of the model.
    calls = 0;
    await local(() => queueVectors());
    await flushIndex();
    expect(calls).toBe(0);
  });

  it("keeps the old vector while the model fails, and catches up in a later round", async () => {
    const { flushIndex, queueVectors } = await import("../src/services/space-index");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await addUnit("later", "openai/text-embedding-3-small");
    down = true;
    await local(() => queueVectors());
    await flushIndex();
    expect((await units()).find((r) => r.ref === "later")?.model).toBe(
      "openai/text-embedding-3-small",
    );
    down = false;
    error.mockRestore();
    await local(() => queueVectors());
    await flushIndex();
    expect((await units()).find((r) => r.ref === "later")?.model).toBe(MODEL);
  });
});
