import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APICallError } from "ai";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "wizards-pending-jobs-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.RUNTIME_ROLE = "runner";
const ON = "durableRuns=on,runServices=on";
process.env.FEATURES = ON;
process.env.RUNNER_CLOCK_MS = "100";

/** The films the step was asked for, each finished by the test. */
const films = vi.hoisted(() => ({
  made: [] as { run: string; finish: (text: string) => void; fail: (err: unknown) => void }[],
  /** Whether the step's context was still asked to go on when the film was finished. */
  aborted: [] as boolean[],
  /** The runs whose film was asked to stop. */
  stopped: [] as string[],
}));
vi.mock("../src/motion-graphics/step.js", () => ({
  runMotionGraphicsStep: (step: { id: string }, ctx: { runId: string; signal: AbortSignal }) =>
    new Promise((resolve, reject) => {
      films.made.push({
        run: ctx.runId,
        finish: (text) => {
          films.aborted.push(ctx.signal.aborted);
          resolve({ text, assets: [], at: new Date().toISOString() });
        },
        fail: reject,
      });
      ctx.signal.addEventListener(
        "abort",
        () => {
          films.stopped.push(ctx.runId);
          reject(new Error("aborted"));
        },
        { once: true },
      );
      void step;
    }),
}));
vi.mock("../src/engine/requirements.js", async (original) => ({
  ...(await original<typeof import("../src/engine/requirements.js")>()),
  missingModelsSaid: async () => [],
}));
vi.mock("../src/safety.js", async (original) => ({
  ...(await original<typeof import("../src/safety.js")>()),
  guestChecksOn: async () => false,
}));
vi.mock("../src/credits/credits.js", async (original) => ({
  ...(await original<typeof import("../src/credits/credits.js")>()),
  canSpend: async () => true,
  reserveForRun: async () => true,
  releaseRun: async () => undefined,
}));

let client: typeof import("../src/db/client");
let runner: typeof import("../src/engine/runner");
let wizards: typeof import("../src/services/wizards");
let reports: typeof import("../src/services/runs");
let events: typeof import("../src/engine/events");
let env: typeof import("../src/env").env;

const T = "tenant-pending-jobs";
const film = {
  id: "film",
  type: "motion-graphics",
  title: "Film",
  brief: "A short film.",
  skills: ["hyperframes"],
  inputs: {},
  format: "16:9",
};
const end = { id: "done", type: "result", title: "Fertig", deliverables: [] };
const base = { version: 1, title: "Film", description: "", avatar: "round" };

const start = () =>
  client.withTenant(T, async () => {
    const created = await wizards.createWizard("u", {
      definition: { ...base, steps: [film, end] } as never,
    });
    return runner.createRun({
      wizardId: created.id,
      definition: { ...base, steps: [film, end] } as never,
      files: [],
      version: null,
      mode: "test",
      userId: "u",
    });
  });
const row = (id: string) =>
  client.withTenant(T, () =>
    client.db.query.run.findFirst({ where: eq(client.schema.run.id, id) }),
  );
const jobs = (id: string) =>
  client.withTenant(T, () =>
    client.db.query.runJob.findMany({ where: eq(client.schema.runJob.runId, id) }),
  );
const line = (id: string) =>
  client.controlDb.query.runIndex.findFirst({ where: eq(client.control.runIndex.runId, id) });
async function until(ok: () => Promise<boolean>, ms = 15_000) {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (await ok()) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}
/** Asleep on its job, and no runner holds it. */
const asleepOnJob = (id: string) =>
  until(async () => {
    const r = await row(id);
    const l = await line(id);
    return (
      r?.status === "sleeping" && Boolean(r.state.job) && l?.active === false && l.owner === null
    );
  });
const hasStatus = (id: string, s: string) => until(async () => (await row(id))?.status === s);
const filmOf = (id: string) => films.made.filter((f) => f.run === id);
const linesOf = async (id: string) =>
  (await client.withTenant(T, () => events.recentEvents(id, 0, 100))).map(
    (e) => `${e.stepId ?? "-"} ${e.type}`,
  );
/** Its look-again time came: the clock wakes it. */
async function pass(id: string) {
  const past = new Date(Date.now() - 1000);
  await client.withTenant(T, () =>
    client.db.update(client.schema.run).set({ wakeAt: past }).where(eq(client.schema.run.id, id)),
  );
  await client.controlDb
    .update(client.control.runIndex)
    .set({ wakeAt: past })
    .where(eq(client.control.runIndex.runId, id));
}

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  runner = await import("../src/engine/runner");
  wizards = await import("../src/services/wizards");
  reports = await import("../src/services/runs");
  events = await import("../src/engine/events");
  env = (await import("../src/env")).env;
  runner.startRunner();
});
afterAll(() => runner.stopRunner());
afterEach(() => {
  process.env.FEATURES = ON;
});

describe("a film with the run's services on", () => {
  it("is a job: the run sleeps while it renders, looks at work, and ends with the film", async () => {
    const id = await start();
    expect(await asleepOnJob(id)).toBe(true);
    const asleep = await row(id);
    const [job] = await jobs(id);
    expect(asleep?.state.job).toEqual({ stepId: "film", id: job.id });
    expect(job).toMatchObject({ stepId: "film", kind: "film", status: "running" });
    expect(job.owner).toBe(env.runner.id);
    // It looks at its job by itself now and then: what finds a job whose process is gone.
    expect(asleep?.wakeAt?.getTime()).toBeGreaterThan(Date.now());
    expect((await line(id))?.wakeAt?.getTime()).toBe(asleep?.wakeAt?.getTime());

    // Whoever looks sees the film at work, as before.
    const view = await client.withTenant(T, () =>
      runner.runView(asleep as never, { name: "Space" } as never),
    );
    expect(view.status).toBe("running");
    expect(view.wakeAt).toBeNull();
    expect(view.pause).toBeNull();
    const timeline = await client.withTenant(T, () => reports.runTimeline(asleep as never, true));
    expect(timeline.status).toBe("running");
    expect(timeline.wakeAt).toBeNull();

    filmOf(id)[0].finish("the film");
    expect(await hasStatus(id, "done")).toBe(true);
    const after = await row(id);
    expect(after?.state.outputs.film?.text).toBe("the film");
    expect(after?.state.job).toBeUndefined();
    expect(filmOf(id)).toHaveLength(1);
    // The film went on after its drive had ended.
    expect(films.aborted.at(-1)).toBe(false);
    expect((await jobs(id))[0].status).toBe("done");
    // One visit of the step, as when it rendered in the drive.
    const lines = await linesOf(id);
    expect(lines.filter((l) => l === "film step_started")).toHaveLength(1);
    expect(lines.filter((l) => l === "film step_done")).toHaveLength(1);
    expect(lines.some((l) => l.startsWith("film wait"))).toBe(false);
  });

  it("asked by its clock while it renders, the run sleeps on and starts nothing new", async () => {
    const id = await start();
    expect(await asleepOnJob(id)).toBe(true);
    const job = (await row(id))?.state.job;
    await pass(id);
    await until(async () => ((await row(id))?.wakeAt?.getTime() ?? 0) > Date.now());
    expect(await asleepOnJob(id)).toBe(true);
    expect((await row(id))?.state.job).toEqual(job);
    expect(filmOf(id)).toHaveLength(1);
    expect(await jobs(id)).toHaveLength(1);

    filmOf(id)[0].finish("the film");
    expect(await hasStatus(id, "done")).toBe(true);
  });

  it("a failed film is the step's failure, with its class: a new try starts a new job", async () => {
    const id = await start();
    expect(await asleepOnJob(id)).toBe(true);
    filmOf(id)[0].fail(
      new APICallError({
        message: "status 503",
        url: "http://x",
        requestBodyValues: {},
        statusCode: 503,
        isRetryable: true,
      }),
    );
    expect(await until(async () => (await row(id))?.state.pause?.kind === "retry")).toBe(true);
    const waiting = await row(id);
    expect(waiting?.status).toBe("sleeping");
    expect(waiting?.state.job).toBeUndefined();
    expect((await jobs(id))[0]).toMatchObject({
      status: "failed",
      error: { failure: { class: "retry", retryAfterMs: null } },
    });

    await pass(id);
    expect(await until(async () => filmOf(id).length === 2)).toBe(true);
    expect(await asleepOnJob(id)).toBe(true);
    filmOf(id)[1].finish("the second film");
    expect(await hasStatus(id, "done")).toBe(true);
    expect((await row(id))?.state.outputs.film?.text).toBe("the second film");
    expect(await jobs(id)).toHaveLength(2);
  });

  it("a cancel while it renders stops the film", { timeout: 60_000 }, async () => {
    const id = await start();
    expect(await asleepOnJob(id)).toBe(true);
    await client.withTenant(T, () => runner.cancel(id));
    expect(await hasStatus(id, "cancelled")).toBe(true);
    // The job hears it at its next heartbeat, and the film is asked to stop.
    expect(await until(async () => films.stopped.includes(id), 30_000)).toBe(true);
    expect((await jobs(id))[0].status).toBe("running");
  });
});

describe("a film with the run's services off", () => {
  it("renders in the drive, as before: no job, and the run never sleeps", async () => {
    process.env.FEATURES = "durableRuns=on";
    const id = await start();
    expect(await until(async () => filmOf(id).length === 1)).toBe(true);
    const r = await row(id);
    expect(r?.status).toBe("running");
    expect(r?.state.job).toBeUndefined();
    filmOf(id)[0].finish("the film");
    expect(await hasStatus(id, "done")).toBe(true);
    expect(await jobs(id)).toHaveLength(0);
  });
});
