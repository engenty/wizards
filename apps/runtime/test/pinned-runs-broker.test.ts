import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { eq } from "drizzle-orm";
import { describe, it, vi } from "vitest";
import * as pinned from "./fixtures/pinned-runs/runs.js";

/*
 * The broker of pinned-runs-services.test.ts: a process of its own (`RUNTIME_ROLE=broker`) on the
 * data folder of the runner it serves, with the model of pinned-runs.test.ts. It keeps what the
 * model was asked and the tool's calls in files of that folder, where the runner reads them, and
 * serves until the runner's test leaves a `stop` file. Run without `PINNED_BROKER_PORT`, as a test
 * file like any other, it does nothing.
 */
const PORT = process.env.PINNED_BROKER_PORT;
const DIR = process.env.DATA_DIR ?? "";
if (PORT) {
  process.env.APP_URL = "http://localhost:5181";
  process.env.LOCAL_ACCESS_KEY = "test-key";
  process.env.MARKETPLACE_URL = "off";
  process.env.AI_GATEWAY_API_KEY = "";
  process.env.OPENAI_API_KEY = "";
  process.env.ANTHROPIC_API_KEY = "";
  process.env.RUNTIME_ROLE = "broker";
  process.env.FEATURES = "durableRuns=on,runServices=on";
  process.env.PLUGINS_DIR = fileURLToPath(
    new URL("./fixtures/pinned-runs/plugins", import.meta.url),
  );
  process.env.PLUGINS_WATCH = "0";
  process.env.PLUGIN_JOBS = "0";
  // The tool of the pinned plugin keeps each call here.
  (globalThis as { __pinnedStamps?: unknown }).__pinnedStamps = {
    push: (stamp: unknown) => appendFileSync(join(DIR, "stamps"), `${JSON.stringify(stamp)}\n`),
  };
}

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const say = (text: string) => [
  { type: "stream-start", warnings: [] },
  ...(text
    ? [
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: text },
        { type: "text-end", id: "t" },
      ]
    : []),
  { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
];

/** How often each run's step asked, here. */
const asked = new Map<string, number>();

/** The model of pinned-runs.test.ts, scripted by the run's wizard; each call kept in `calls`. */
const modelFor = (run: string, step: string, decides: boolean, script: pinned.PinnedRun["script"]) => {
  const answer = (options: { prompt: unknown }) => {
    const name = `${step}${decides ? "?" : ""}`;
    appendFileSync(join(DIR, "calls"), `${JSON.stringify({ run, name })}\n`);
    const n = (asked.get(`${run} ${name}`) ?? 0) + 1;
    asked.set(`${run} ${name}`, n);
    return script({ step, decides, prompt: JSON.stringify(options.prompt), n });
  };
  return new MockLanguageModelV3({
    doGenerate: async (options) => {
      const text = answer(options);
      return {
        content: text ? [{ type: "text", text }] : [],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        warnings: [],
      } as never;
    },
    doStream: async (options) => ({
      stream: convertArrayToReadableStream(say(answer(options)) as never[]),
    }),
  });
};

/** The pinned run whose wizard the run has, by its title. */
async function scriptOf(runId: string): Promise<pinned.PinnedRun["script"]> {
  const client = await import("../src/db/client");
  const run = await client.db.query.run.findFirst({ where: eq(client.schema.run.id, runId) });
  const found = Object.values(pinned).find(
    (p): p is pinned.PinnedRun => (p as pinned.PinnedRun).title === run?.definition.title,
  );
  return found?.script ?? (() => "");
}

vi.mock("../src/models.js", async (original) => ({
  ...(await original<typeof import("../src/models.js")>()),
  textModel: async (cls: string, meta: { runId?: string; stepId?: string } = {}) => ({
    model: modelFor(
      meta.runId ?? "-",
      meta.stepId ?? "-",
      cls === "classifier",
      await scriptOf(meta.runId ?? "-"),
    ),
    ref: "test/scripted",
    vendor: "test",
    gateway: false,
    metered: false,
  }),
  systemOneAccess: async () => null,
}));
vi.mock("../src/safety.js", async (original) => ({
  ...(await original<typeof import("../src/safety.js")>()),
  guestChecksOn: async () => false,
}));
vi.mock("../src/engine/requirements.js", async (original) => ({
  ...(await original<typeof import("../src/engine/requirements.js")>()),
  missingModelsSaid: async () => [],
}));
vi.mock("../src/credits/credits.js", async (original) => ({
  ...(await original<typeof import("../src/credits/credits.js")>()),
  canSpend: async () => true,
  reserveForRun: async () => true,
  releaseRun: async () => undefined,
}));

describe.runIf(PORT)("the broker of the pinned runs", () => {
  it("serves the runs' services until the runner is done", { timeout: 600_000 }, async () => {
    const client = await import("../src/db/client");
    await client.migrateControlDb();
    await (await import("../src/plugins/loader")).loadPlugins();
    const { serve } = await import("@hono/node-server");
    const app = (await import("../src/app")).default;
    const server = serve({ fetch: app.fetch, port: Number(PORT), hostname: "127.0.0.1" });
    writeFileSync(join(DIR, "broker-ready"), String(process.pid));
    const stop = join(DIR, "stop");
    const until = Date.now() + 590_000;
    while (!existsSync(stop) && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 100));
    }
    server.close();
  });
});
