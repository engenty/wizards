import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelClass } from "@engenty/wizards-shared/definition";
import type { RunView } from "@engenty/wizards-shared/run";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type LocalEdge, localEdge } from "../../edge/test/local-edge.js";

/**
 * A guest's run of a published wizard goes to an object of its own (docs/plans/
 * runs-on-their-own.md, 6.2): started through the wizard's page, placed on the Worker `EDGE_URL`
 * names (a local workerd, apps/edge/test/local-edge.ts), answered by the guest through the same
 * doors as a run of this runtime, and listed in the studio with its result. The object asks this
 * runtime for the run's services; this runtime is a whole one (`all`) and drives the run itself
 * once runs in objects are off for the tenant.
 *
 * Spawns workerd: run alone with `--maxWorkers=1`.
 */
const ORIGIN = "http://localhost:5181";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-runs-to-objects-"));
process.env.APP_URL = ORIGIN;
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.RUNTIME_ROLE = "all";
process.env.PLUGINS_WATCH = "0";
process.env.PLUGIN_JOBS = "0";

const ON = "durableRuns=on,runServices=on,runHosts=on,edgeRuns=on";
process.env.FEATURES = ON;

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
/** Writes about the page's topic: the model of every step, wherever the run lives. */
const writer = () => {
  const answer = (options: { prompt: unknown }) =>
    JSON.stringify(options.prompt).includes("otters") ? "Two lines on otters." : "Nothing.";
  return new MockLanguageModelV3({
    doGenerate: async (options) =>
      ({
        content: [{ type: "text", text: answer(options) }],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        warnings: [],
      }) as never,
    doStream: async (options) => ({
      stream: convertArrayToReadableStream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: answer(options) },
        { type: "text-end", id: "t" },
        { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
      ] as never[]),
    }),
  });
};
vi.mock("../src/models.js", async (original) => ({
  ...(await original<typeof import("../src/models.js")>()),
  textModel: async () => ({
    model: writer(),
    ref: "test/writer",
    vendor: "test",
    gateway: false,
    metered: false,
  }),
  systemOneAccess: async () => null,
  embeddingModel: async () => null,
  modelWays: async (classes: Iterable<ModelClass>) =>
    Object.fromEntries([...classes].map((cls) => [cls, "credits"])),
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

const T = "tenant-runs-to-objects";
const USER = "user-runs-to-objects";
const GUEST = "wz_vid=guest-objects-0123456789ab";

/** A page, an agent that writes about its answer, a review, the result with the text. */
const definition = {
  version: 1,
  title: "Otters",
  description: "",
  avatar: "round",
  steps: [
    { id: "ask", type: "form", title: "Ask", fields: [{ id: "topic", kind: "text", label: "Topic" }] },
    {
      id: "write",
      type: "agent",
      title: "Write",
      instructions: "Write about {{topic}}.",
      output: { format: "text" },
      tools: [],
    },
    { id: "check", type: "review", title: "Check", show: ["write"] },
    {
      id: "done",
      type: "result",
      title: "Done",
      deliverables: [{ from: "write", formats: ["md"] }],
    },
  ],
};

type App = { request: (path: string, init?: RequestInit) => Response | Promise<Response> };

let client: typeof import("../src/db/client");
let wizards: typeof import("../src/services/wizards");
let runs: typeof import("../src/services/runs");
let env: typeof import("../src/env").env;
let app: App;
let edge: LocalEdge;

/** What this runtime asked of the object, by path. */
const asked: string[] = [];

const inTenant = <R>(fn: () => Promise<R>) => client.withTenant(T, fn);
const record = (runId: string) =>
  inTenant(() => client.db.query.run.findFirst({ where: eq(client.schema.run.id, runId) }));

async function until<V>(get: () => Promise<V>, ok: (v: V) => boolean, ms = 60_000): Promise<V> {
  const end = Date.now() + ms;
  let v = await get();
  while (!ok(v)) {
    if (Date.now() > end) {
      throw new Error(`timed out at ${JSON.stringify(v).slice(0, 800)}`);
    }
    await new Promise((r) => setTimeout(r, 100));
    v = await get();
  }
  return v;
}

/** The object's requests: the run's services and its copies, answered by this runtime. */
async function outbound(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin !== ORIGIN) {
    return new Response("Nothing else is reachable from here.", { status: 502 });
  }
  return app.request(`${url.pathname}${url.search}`, {
    method: request.method,
    headers: Object.fromEntries(request.headers),
    body: request.method === "GET" ? undefined : await request.text(),
  });
}

/** The wizard, published: its page's link. */
async function published(): Promise<{ wizardId: string; token: string }> {
  return inTenant(async () => {
    const made = await wizards.createWizard(USER, { definition: definition as never });
    await wizards.publishWizard(USER, made.id).catch((err) => {
      throw new Error(JSON.stringify(err.data ?? err.message));
    });
    const w = await wizards.ownedWizard(USER, made.id);
    return { wizardId: made.id, token: w.shareToken };
  });
}

/** The guest's doors, with their cookie, as the wizard's page calls them. */
function guest(runId: string) {
  const headers = { "content-type": "application/json", "accept-language": "en", cookie: GUEST };
  return {
    view: async () =>
      (await (await app.request(`/api/runs/${runId}`, { headers })).json()) as RunView,
    post: (path: string, body?: unknown) =>
      app.request(`/api/runs/${runId}/${path}`, {
        method: "POST",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    stream: async () => {
      const res = await app.request(`/api/runs/${runId}/stream`, { headers });
      const reader = res.body?.getReader();
      const views: RunView[] = [];
      const decoder = new TextDecoder();
      let buffered = "";
      const reading = (async () => {
        for (;;) {
          const chunk = await reader?.read().catch(() => null);
          if (!chunk || chunk.done) {
            return;
          }
          buffered += decoder.decode(chunk.value, { stream: true });
          let end = buffered.indexOf("\n\n");
          while (end >= 0) {
            const block = buffered.slice(0, end);
            buffered = buffered.slice(end + 2);
            const data = block.split("\n").find((l) => l.startsWith("data: "));
            if (block.includes("event: view") && data) {
              views.push(JSON.parse(data.slice(6)) as RunView);
            }
            end = buffered.indexOf("\n\n");
          }
        }
      })();
      return {
        views,
        close: async () => {
          await reader?.cancel().catch(() => undefined);
          await reading;
        },
      };
    },
  };
}

/** Starts a run through the wizard's page, as a guest. */
async function start(token: string): Promise<string> {
  const res = await app.request(`/api/public/wizards/${token}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: GUEST },
    body: "{}",
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { runId: string }).runId;
}

/** The guest answers the page, approves the text, and sees the result; the stream follows. */
async function answered(runId: string) {
  const run = guest(runId);
  const first = await run.view();
  expect(first).toMatchObject({ status: "waiting_input", step: { id: "ask" } });
  const stream = await run.stream();
  const streamed = (ok: (v: RunView) => boolean) =>
    until(
      async () => stream.views.at(-1),
      (v) => Boolean(v && ok(v)),
    ) as Promise<RunView>;
  try {
    const page = await run.post("pages/ask", { values: { topic: "otters" } });
    expect(page.status).toBe(200);
    expect(((await page.json()) as { rev: number }).rev).toBeGreaterThan(first.rev);
    await streamed((v) => v.status === "waiting_input" && v.step?.id === "check");
    expect(JSON.stringify(await run.view())).toContain("Two lines on otters.");
    expect((await run.post("reviews/check", { type: "accept" })).status).toBe(200);
    await streamed((v) => v.status === "done");
  } finally {
    await stream.close();
  }
  const done = await run.view();
  expect(done).toMatchObject({ status: "done", step: { id: "done" } });
  return done;
}

/** The run in the studio: its line in the wizard's list, and the run with its result. */
async function inStudio(wizardId: string, runId: string) {
  const listed = await inTenant(() => runs.listRuns(USER, wizardId));
  expect(listed.find((r) => r.id === runId)).toMatchObject({ mode: "live", status: "done" });
  const report = await inTenant(() => runs.runReport(USER, runId, 0, "live"));
  expect(report).toMatchObject({ status: "done", step: { id: "done" } });
  expect(report.outputs.find((o) => o.stepId === "write")).toMatchObject({
    text: "Two lines on otters.",
    downloads: { md: expect.stringContaining(`/api/runs/${runId}/steps/write/download`) },
  });
}

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  wizards = await import("../src/services/wizards");
  runs = await import("../src/services/runs");
  env = (await import("../src/env")).env;
  app = (await import("../src/app")).default as unknown as App;

  edge = await localEdge({
    persist: mkdtempSync(join(tmpdir(), "wizards-runs-to-objects-edge-")),
    services: ORIGIN,
    outbound,
  });
  env.edgeUrl = edge.url;

  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(edge.url)) {
      asked.push(new URL(url).pathname);
    }
    return realFetch(input, init);
  });
}, 120_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await edge?.dispose().catch(() => undefined);
});

beforeEach(() => {
  process.env.FEATURES = ON;
});

vi.setConfig({ testTimeout: 120_000 });

describe("a guest's run of a published wizard", () => {
  it("lives in an object, is answered through the doors and shows in the studio with its result", async () => {
    const { wizardId, token } = await published();
    const runId = await start(token);

    // The record and the line name the object; the object holds the run, and the clock here
    // keeps none of its time.
    const host = { kind: "edge", url: edge.url };
    expect((await record(runId))?.host).toEqual(host);
    const line = await client.controlDb.query.runIndex.findFirst({
      where: eq(client.control.runIndex.runId, runId),
    });
    expect(line).toMatchObject({ host, wakeAt: null });
    expect(asked).toContain(`/api/peer/runs/${runId}/hand-over`);

    const done = await answered(runId);
    // The object's lines are the view's, after the tenant's own.
    expect(done.events.map((e) => [e.stepId, e.type])).toEqual(
      expect.arrayContaining([
        [null, "run_started"],
        ["write", "step_started"],
        ["write", "step_done"],
      ]),
    );
    // Everything the guest saw came from the object: its state, its changes, their answers.
    for (const call of ["state", "changes", "events"]) {
      expect(asked).toContain(`/api/peer/runs/${runId}/${call}`);
    }
    // The end's copy reached the record, at the object's revision.
    const object = edge.logs.some((l) => l.startsWith(`[run ${runId}] alarm call`));
    expect(object).toBe(true);
    expect(await record(runId)).toMatchObject({ status: "done", cursor: "done", rev: done.rev });

    await inStudio(wizardId, runId);
  });

  it("stays on this runtime while runs in objects are off for the tenant", async () => {
    process.env.FEATURES = "durableRuns=on,runServices=on,runHosts=on";
    const { wizardId, token } = await published();
    const before = asked.length;
    const runId = await start(token);
    expect((await record(runId))?.host).toBeNull();
    await answered(runId);
    await inStudio(wizardId, runId);
    expect(asked.slice(before).filter((p) => p.includes(runId))).toEqual([]);
  });

  it("a test run of the same wizard stays here, objects on or not", async () => {
    const { wizardId } = await published();
    const { runId } = await inTenant(() => runs.startTestRun(USER, wizardId));
    expect((await record(runId))?.host).toBeNull();
  });
});
