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
/** The texts of each call. */
let sent: string[][] = [];
/** How long a call takes, and when each one came. */
let answerMs = 0;
let came: number[] = [];
const realFetch = globalThis.fetch;

async function units() {
  return local(() => client.db.query.spaceChunk.findMany());
}

/** A unit as it stands in the index: with a vector of `model`, or none. */
async function addUnit(ref: string, model: string | null, text = `Text ${ref}`) {
  await local(() =>
    client.db.insert(client.schema.spaceChunk).values({
      spaceId,
      plugin: "test",
      ref,
      idx: 0,
      text,
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
    came.push(Date.now());
    await new Promise((done) => setTimeout(done, answerMs));
    if (down) {
      return reply({ error: { message: "down" } }, 400);
    }
    const body = JSON.parse(String(init?.body));
    sent.push(body.input);
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

  it("keeps the old vector while the model fails, and leaves it alone for a while", async () => {
    const { flushIndex, queueVectors } = await import("../src/services/space-index");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await addUnit("later", "openai/text-embedding-3-small");
    down = true;
    await local(() => queueVectors());
    await flushIndex();
    const model = async () => (await units()).find((r) => r.ref === "later")?.model;
    expect(await model()).toBe("openai/text-embedding-3-small");
    expect(error.mock.calls[0]?.[0]).toContain("again in 20 min");
    down = false;
    // Paused: the model that just failed is asked nothing, whatever its state now.
    calls = 0;
    await local(() => queueVectors());
    await flushIndex();
    expect(calls).toBe(0);
    expect(await model()).toBe("openai/text-embedding-3-small");
    // Twenty minutes on, a round catches up.
    const later = Date.now() + 21 * 60_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(later);
    await local(() => queueVectors());
    await flushIndex();
    now.mockRestore();
    error.mockRestore();
    expect(await model()).toBe(MODEL);
  });

  it("sends long texts in calls of their own size", async () => {
    const { flushIndex, queueVectors } = await import("../src/services/space-index");
    await addUnit("long-1", null, "a".repeat(10_000));
    await addUnit("long-2", null, "b".repeat(10_000));
    await addUnit("long-3", null, "c".repeat(20_000));
    await addUnit("short", null);
    sent = [];
    await local(() => queueVectors());
    await flushIndex();
    expect(sent.map((texts) => texts.length)).toEqual([1, 1, 1, 1]);
    expect((await units()).every((r) => r.model === MODEL)).toBe(true);
  });

  it("leaves the model free between calls as long as a call took", async () => {
    const { flushIndex, queueVectors } = await import("../src/services/space-index");
    await addUnit("room-1", null, "d".repeat(3000));
    await addUnit("room-2", null, "e".repeat(3000));
    answerMs = 100;
    came = [];
    await local(() => queueVectors());
    await flushIndex();
    answerMs = 0;
    expect(came).toHaveLength(2);
    // The call, then a rest as long; a timer may come a little early.
    expect(came[1] - came[0]).toBeGreaterThanOrEqual(190);
  });

  it("leaves the texts to one process: a runner serves the studio's routes too", async () => {
    const { env } = await import("../src/env");
    const { flushIndex, queueVectors } = await import("../src/services/space-index");
    await addUnit("not-here", null);
    env.serves.vectors = false;
    calls = 0;
    await local(() => queueVectors());
    await flushIndex();
    env.serves.vectors = true;
    expect(calls).toBe(0);
    expect((await units()).find((r) => r.ref === "not-here")?.model).toBeNull();
  });
});
