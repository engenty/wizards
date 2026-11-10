import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APICallError } from "ai";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "wizards-durable-retry-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.RUNTIME_ROLE = "runner";
process.env.FEATURES = "durableRuns=on";
process.env.RUNNER_CLOCK_MS = "100";
// One slot: a run in a retry's wait must leave it for the next.
process.env.RUNNER_MAX_RUNS = "1";

/** What a step does on each try, by step id; nothing listed: it makes its result. */
const script = vi.hoisted(() => ({
  steps: {} as Record<string, ((ctx: never) => unknown)[]>,
  worked: [] as { run: string; step: string }[],
  decide: [] as (() => unknown)[],
}));
vi.mock("@engenty/wizards-engine/steps/index", async (original) => ({
  ...(await original<typeof import("@engenty/wizards-engine/steps/index")>()),
  runAutomaticStep: async (step: { id: string }, ctx: { runId: string }) => {
    script.worked.push({ run: ctx.runId, step: step.id });
    const next = script.steps[step.id]?.shift();
    if (next) {
      await next(ctx as never);
    }
    return { text: `made ${step.id}`, at: new Date().toISOString() };
  },
}));
vi.mock("../src/decide.js", async (original) => ({
  ...(await original<typeof import("../src/decide.js")>()),
  decide: async () => {
    await script.decide.shift()?.();
    return { source: "llm", answers: { next: { type: "choice", choice: "none" } } };
  },
}));
vi.mock("../src/engine/requirements.js", async (original) => ({
  ...(await original<typeof import("../src/engine/requirements.js")>()),
  missingModelsSaid: async () => [],
}));
vi.mock("../src/safety.js", async (original) => ({
  ...(await original<typeof import("../src/safety.js")>()),
  guestChecksOn: async () => false,
}));
const hold = vi.hoisted(() => ({
  answer: true as boolean | "guest_budget" | Error,
  can: true,
  released: [] as string[],
}));
vi.mock("../src/credits/credits.js", async (original) => ({
  ...(await original<typeof import("../src/credits/credits.js")>()),
  canSpend: async () => hold.can,
  reserveForRun: async () => {
    if (hold.answer instanceof Error) {
      throw hold.answer;
    }
    return hold.answer;
  },
  releaseRun: async (runId: string) => {
    hold.released.push(runId);
  },
}));

let client: typeof import("../src/db/client");
let runner: typeof import("../src/engine/runner");
let wizards: typeof import("../src/services/wizards");
let reports: typeof import("../src/services/runs");
let events: typeof import("../src/engine/events");
let types: typeof import("../src/engine/types");

const T = "tenant-durable-retry";
const agent = (id: string, more: object = {}) => ({
  id,
  type: "agent",
  title: id,
  instructions: "Do it.",
  tools: [],
  output: { format: "text" },
  ...more,
});
const end = { id: "done", type: "result", title: "Fertig", deliverables: [] };
const base = { version: 1, title: "Retry", description: "", avatar: "round" };

/** As the providers throw them; failures.test.ts has them from a real server. */
const http = (statusCode: number, headers: Record<string, string> = {}) =>
  new APICallError({
    message: `status ${statusCode}`,
    url: "http://x",
    requestBodyValues: {},
    statusCode,
    responseHeaders: headers,
    isRetryable: statusCode === 429 || statusCode >= 500,
  });
const fails = (...errors: unknown[]) =>
  errors.map((err) => () => {
    throw err;
  });

const start = (steps: unknown[], options: { visitorId?: string } = {}) =>
  client.withTenant(T, async () => {
    const created = await wizards.createWizard("u", {
      definition: { ...base, steps: [agent("seed"), end] } as never,
    });
    return runner.createRun({
      wizardId: created.id,
      definition: { ...base, steps } as never,
      files: [],
      version: null,
      mode: options.visitorId ? "live" : "test",
      userId: options.visitorId ? null : "u",
      visitorId: options.visitorId ?? null,
    });
  });
const row = (id: string) =>
  client.withTenant(T, () =>
    client.db.query.run.findFirst({ where: eq(client.schema.run.id, id) }),
  );
const line = (id: string) =>
  client.controlDb.query.runIndex.findFirst({ where: eq(client.control.runIndex.runId, id) });
async function until(ok: () => Promise<boolean>, ms = 8000) {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (await ok()) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}
const hasStatus = (id: string, s: string) => until(async () => (await row(id))?.status === s);
/** Resting: asleep, and no runner has it. */
const rests = (id: string) =>
  until(async () => {
    const l = await line(id);
    return (await row(id))?.status === "sleeping" && l?.active === false && l.owner === null;
  });
/** As `rests`, once this many tries were made: a wake takes a moment to come round. */
const restsAfter = (id: string, tries: number) =>
  until(
    async () =>
      steps(id).length >= tries &&
      (await row(id))?.status === "sleeping" &&
      (await line(id))?.active === false &&
      (await line(id))?.owner === null,
  );
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
const steps = (id: string) => script.worked.filter((w) => w.run === id).map((w) => w.step);
const minutesLeft = async (id: string) =>
  Math.round((((await row(id))?.wakeAt?.getTime() ?? 0) - Date.now()) / 60_000);
const eventsOf = (id: string) =>
  client.withTenant(T, () => events.recentEvents(id, 0, 50));

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  runner = await import("../src/engine/runner");
  wizards = await import("../src/services/wizards");
  reports = await import("../src/services/runs");
  events = await import("../src/engine/events");
  types = await import("../src/engine/types");
  runner.startRunner();
});
afterAll(() => runner.stopRunner());
afterEach(() => {
  script.steps = {};
  script.decide = [];
  hold.answer = true;
  hold.can = true;
});

describe("a provider's short trouble", () => {
  it("sleeps with a time, frees its slot, holds no credits, and tries the step again", async () => {
    script.steps.flaky = fails(http(503));
    const id = await start([agent("flaky"), agent("after"), end]);
    expect(await rests(id)).toBe(true);
    const r = await row(id);
    expect(r?.state.pause).toEqual({ kind: "retry" });
    expect(r?.state.retries).toMatchObject({ step: "flaky", count: 1 });
    expect(r?.error).toBeNull();
    expect(await minutesLeft(id)).toBe(1);
    expect((await line(id))?.wakeAt?.getTime()).toBe(r?.wakeAt?.getTime());
    expect(hold.released).toContain(id);

    await pass(id);
    expect(await hasStatus(id, "done")).toBe(true);
    expect(steps(id)).toEqual(["flaky", "flaky", "after"]);
    const after = await row(id);
    // No wait's output, and nothing of the trouble left.
    expect(after?.state.outputs.flaky?.text).toBe("made flaky");
    expect(after?.state.outputs.flaky?.json).toBeUndefined();
    expect(after?.state.pause).toBeUndefined();
    expect(after?.state.retries).toBeUndefined();
    expect(after?.wakeAt).toBeNull();
  });

  it("the line's slot is free meanwhile: the next run starts and ends", async () => {
    script.steps.flaky = fails(http(429));
    const first = await start([agent("flaky"), end]);
    expect(await rests(first)).toBe(true);
    const second = await start([agent("other"), end]);
    expect(await hasStatus(second, "done")).toBe(true);
    expect((await row(first))?.status).toBe("sleeping");
    await client.withTenant(T, () => runner.cancel(first));
  });

  it("three retries after 1, 5 and 30 minutes, then it fails and says so", async () => {
    script.steps.flaky = fails(http(503), http(502), http(500), http(504));
    const id = await start([agent("flaky"), end]);
    for (const [i, minutes] of [1, 5, 30].entries()) {
      expect(await restsAfter(id, i + 1)).toBe(true);
      expect(await minutesLeft(id)).toBe(minutes);
      expect((await row(id))?.state.retries?.count).toBe(i + 1);
      await pass(id);
    }
    expect(await hasStatus(id, "failed")).toBe(true);
    expect(steps(id)).toHaveLength(4);
    const r = await row(id);
    expect(r?.error).toMatch(/AI service/);
    expect(r?.state.pause).toBeUndefined();

    // A person's "try again" gets every try anew.
    script.steps.flaky = fails(http(503));
    await client.withTenant(T, () => runner.retry(id));
    expect(await restsAfter(id, 5)).toBe(true);
    expect((await row(id))?.state.retries?.count).toBe(1);
    expect(await minutesLeft(id)).toBe(1);
    await client.withTenant(T, () => runner.cancel(id));
  });

  it("three retries, then the step's onFail: the run goes on and doesn't count as failed", async () => {
    script.steps.flaky = fails(http(503), http(503), http(503), http(503));
    const id = await start([agent("flaky", { onFail: "rescue" }), agent("skipped"), agent("rescue"), end]);
    for (let i = 0; i < 3; i++) {
      expect(await restsAfter(id, i + 1)).toBe(true);
      await pass(id);
    }
    expect(await hasStatus(id, "done")).toBe(true);
    expect(steps(id)).toEqual(["flaky", "flaky", "flaky", "flaky", "rescue"]);
    const r = await row(id);
    expect(r?.error).toBeNull();
    expect(r?.state.retries).toBeUndefined();
    const said = await eventsOf(id);
    expect(said.some((e) => e.type === "error" && e.stepId === "flaky")).toBe(true);
    expect(said.some((e) => e.note?.code === "stepFailedGoesOn")).toBe(true);
  });

  it("a step that works after its trouble: a later step starts its own count", async () => {
    script.steps.one = fails(http(503), http(503));
    script.steps.two = fails(http(503));
    const id = await start([agent("one"), agent("two"), end]);
    expect(await restsAfter(id, 1)).toBe(true);
    await pass(id);
    expect(await restsAfter(id, 2)).toBe(true);
    await pass(id);
    expect(await restsAfter(id, 4)).toBe(true);
    expect((await row(id))?.state.retries).toMatchObject({ step: "two", count: 1 });
    expect(await minutesLeft(id)).toBe(1);
    await pass(id);
    expect(await hasStatus(id, "done")).toBe(true);
  });

  it("an early wake finds it as it is and puts the time back", async () => {
    script.steps.flaky = fails(http(503));
    const id = await start([agent("flaky"), end]);
    expect(await rests(id)).toBe(true);
    const before = (await row(id))?.wakeAt?.getTime();
    await client.controlDb
      .update(client.control.runIndex)
      .set({ wakeAt: new Date(Date.now() - 1000) })
      .where(eq(client.control.runIndex.runId, id));
    expect(await until(async () => (await line(id))?.wakeAt?.getTime() === before)).toBe(true);
    expect(await rests(id)).toBe(true);
    expect(steps(id)).toEqual(["flaky"]);
    await client.withTenant(T, () => runner.cancel(id));
  });

  it("a cancel during a retry's wait ends it, and a wake on its way finds it over", async () => {
    script.steps.flaky = fails(http(503));
    const id = await start([agent("flaky"), end]);
    expect(await rests(id)).toBe(true);
    await client.withTenant(T, () => runner.cancel(id));
    const r = await row(id);
    expect(r?.status).toBe("cancelled");
    expect(r?.wakeAt).toBeNull();
    expect((await line(id))?.wakeAt).toBeNull();
    await client.controlDb
      .update(client.control.runIndex)
      .set({ wakeAt: new Date(Date.now() - 1000) })
      .where(eq(client.control.runIndex.runId, id));
    expect(await until(async () => (await line(id))?.wakeAt === null)).toBe(true);
    expect((await row(id))?.status).toBe("cancelled");
    expect(steps(id)).toEqual(["flaky"]);
  });

  it("what was written to the run while the step worked stays: a run_effect visit keeps its number", async () => {
    script.steps.flaky = [
      async () => {
        const r = await row(id);
        const state = { ...r?.state, visits: { flaky: 1 }, visiting: "flaky" };
        await client.withTenant(T, () => runner.writeRunState(r as never, state as never));
        throw http(503);
      },
    ];
    const id = await start([agent("flaky"), end]);
    expect(await rests(id)).toBe(true);
    expect((await row(id))?.state).toMatchObject({ visits: { flaky: 1 }, visiting: "flaky" });
    await client.withTenant(T, () => runner.cancel(id));
  });

  it("a decision that fails tries again, and no wait's output or wait comes of it", async () => {
    script.decide = fails(http(503)) as never;
    const id = await start([
      { id: "pause", type: "wait", title: "Pause", for: "2d", next: [{ ask: "Go?", goto: "after" }] },
      agent("skipped"),
      agent("after"),
      end,
    ]);
    expect(await rests(id)).toBe(true);
    await pass(id);
    expect(await until(async () => (await row(id))?.state.pause?.kind === "retry")).toBe(true);
    expect(await rests(id)).toBe(true);
    const waited = (await row(id))?.state.outputs.pause?.at;
    expect(await minutesLeft(id)).toBe(1);
    await pass(id);
    expect(await hasStatus(id, "done")).toBe(true);
    const r = await row(id);
    expect(r?.state.outputs.pause?.at).toBe(waited);
    expect(r?.state.deciding).toBeUndefined();
  });

  it("the report and the view say a retry comes", async () => {
    script.steps.flaky = fails(http(503));
    const id = await start([agent("flaky"), end]);
    expect(await rests(id)).toBe(true);
    const r = await row(id);
    const report = await client.withTenant(T, () => reports.runReportOf(r as never));
    expect(report.waitingFor).toMatchObject({
      wait: "flaky",
      pause: { kind: "retry" },
      until: r?.wakeAt?.toISOString(),
    });
    await client.withTenant(T, () => runner.cancel(id));
  });
});

describe("Retry-After", () => {
  const after = async (retryAfter: string) => {
    script.steps.flaky = fails(http(429, { "retry-after": retryAfter }));
    const id = await start([agent("flaky"), end]);
    expect(await rests(id)).toBe(true);
    const minutes = await minutesLeft(id);
    await client.withTenant(T, () => runner.cancel(id));
    return minutes;
  };

  it("sets the time of the wake", async () => {
    expect(await after("600")).toBe(10);
  });

  it("is capped: a run may sleep, but no week for a provider's word", async () => {
    expect(await after(String(7 * 86_400))).toBe(6 * 60);
  });

  it("no sooner than a look of the clock", async () => {
    expect(await after("1")).toBe(1);
  });
});

describe("what time doesn't change", () => {
  it.each([
    ["a provider's no", () => http(400)],
    ["a key that's wrong", () => http(401)],
    ["an unclear error", () => new Error("Something went wrong")],
    ["a word in a message", () => new Error("Order 429 could not be read")],
  ])("%s: fails at once", async (_, err) => {
    script.steps.bad = fails(err());
    const id = await start([agent("bad"), end]);
    expect(await hasStatus(id, "failed")).toBe(true);
    expect(steps(id)).toEqual(["bad"]);
    expect((await row(id))?.state.pause).toBeUndefined();
  });

  it("goes to onFail at once", async () => {
    script.steps.bad = fails(new Error("Something went wrong"));
    const id = await start([agent("bad", { onFail: "rescue" }), agent("skipped"), agent("rescue"), end]);
    expect(await hasStatus(id, "done")).toBe(true);
    expect(steps(id)).toEqual(["bad", "rescue"]);
  });

  it("two failing steps can't send a run round forever", async () => {
    script.steps.a = fails(...Array(9).fill(new Error("no")));
    script.steps.b = fails(...Array(9).fill(new Error("no")));
    const id = await start([agent("a", { onFail: "b" }), agent("b", { onFail: "a" }), end]);
    expect(await hasStatus(id, "failed")).toBe(true);
    expect(steps(id)).toEqual(["a", "b", "a", "b", "a", "b", "a"]);
  });
});

describe("a step that may have done something out there", () => {
  const acts =
    (err: unknown) =>
    (ctx: { resources: { acted: boolean } }): never => {
      ctx.resources.acted = true;
      throw err;
    };

  it("is not started again by itself: the mail would go out twice", async () => {
    script.steps.sends = [acts(http(503)) as never];
    const id = await start([agent("sends"), end]);
    expect(await hasStatus(id, "failed")).toBe(true);
    expect(steps(id)).toEqual(["sends"]);
  });

  it("goes to onFail", async () => {
    script.steps.sends = [acts(http(503)) as never];
    const id = await start([agent("sends", { onFail: "rescue" }), agent("skipped"), agent("rescue"), end]);
    expect(await hasStatus(id, "done")).toBe(true);
    expect(steps(id)).toEqual(["sends", "rescue"]);
  });

  it("is not started again after a top-up either", async () => {
    script.steps.sends = [acts(http(402)) as never];
    const id = await start([agent("sends"), end]);
    expect(await hasStatus(id, "failed")).toBe(true);
    expect(steps(id)).toEqual(["sends"]);
  });

  /** A durable turn's mark, as a process that acted left it on the row. */
  const turnActed = (err: unknown) => async (ctx: never) => {
    const c = ctx as {
      runId: string;
      stepId: string;
      state: { turn?: object; visiting?: string };
      saveState(): Promise<void>;
    };
    c.state.turn = { stepId: c.stepId, id: `${c.runId}.t`, acted: true };
    c.state.visiting = c.stepId;
    await c.saveState();
    throw err;
  };

  it("a turn's mark on the row counts: a later process has no `acted` to read", async () => {
    script.steps.sends = [turnActed(http(503))];
    const id = await start([agent("sends"), end]);
    expect(await hasStatus(id, "failed")).toBe(true);
    expect(steps(id)).toEqual(["sends"]);
  });

  it("onFail closes the step's turn and visit: coming back is a new one", async () => {
    script.steps.sends = [turnActed(http(503))];
    const id = await start([agent("sends", { onFail: "after" }), agent("after"), end]);
    expect(await hasStatus(id, "done")).toBe(true);
    const r = await row(id);
    expect(r?.state.turn).toBeUndefined();
    expect(r?.state.visiting).toBeUndefined();
    expect(steps(id)).toEqual(["sends", "after"]);
  });

  it("what acted before does not count for the next step", async () => {
    script.steps.sends = [(ctx: { resources: { acted: boolean } }) => { ctx.resources.acted = true; }] as never;
    script.steps.flaky = fails(http(503));
    const id = await start([agent("sends"), agent("flaky"), end]);
    expect(await rests(id)).toBe(true);
    expect((await row(id))?.state.pause).toEqual({ kind: "retry" });
    await client.withTenant(T, () => runner.cancel(id));
  });

  it("a refused sign-in did nothing, so it waits like any other", async () => {
    script.steps.sends = [
      ((ctx: { resources: { acted: boolean } }) => {
        ctx.resources.acted = true;
        throw new types.SignInNeeded("Gmail", { code: "stepCallRefused" } as never);
      }) as never,
    ];
    const id = await start([agent("sends"), end]);
    expect(await rests(id)).toBe(true);
    expect((await row(id))?.state.pause).toEqual({ kind: "sign_in", service: "Gmail" });
    await client.withTenant(T, () => runner.cancel(id));
  });
});

describe("out of credits", () => {
  it("leaves a notice for whoever isn't looking, and it counts while the run sleeps", async () => {
    hold.can = false;
    const id = await start([agent("work"), end]);
    expect(await rests(id)).toBe(true);
    const notices = await client.withTenant(T, () =>
      client.db.query.notice.findMany({ where: eq(client.schema.notice.runId, id) }),
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: "needs_you", waitKey: "pause:credits", userId: "u" });
    expect(notices[0].detail).toContain("credits");
    await client.withTenant(T, () => runner.cancel(id));
  });

  it("before a step: waits for the owner, says so once, and a top-up goes on", async () => {
    hold.can = false;
    const id = await start([agent("work"), end]);
    expect(await rests(id)).toBe(true);
    const r = await row(id);
    expect(r?.state.pause).toEqual({ kind: "credits" });
    expect(r?.error).toBeNull();
    expect(steps(id)).toEqual([]);
    expect(await minutesLeft(id)).toBeLessThanOrEqual(30);

    // Still none: it looks again and stays, with no second word.
    hold.answer = false;
    const before = (await row(id))?.rev ?? 0;
    await pass(id);
    expect(await until(async () => ((await row(id))?.rev ?? 0) > before)).toBe(true);
    expect(await rests(id)).toBe(true);
    expect((await row(id))?.state.pause).toEqual({ kind: "credits" });
    expect((await row(id))?.wakeAt?.getTime()).toBeGreaterThan(Date.now());
    const told = (await eventsOf(id)).filter((e) => e.note?.code === "stepWaitsCredits");
    expect(told).toHaveLength(1);

    // The top-up.
    hold.can = true;
    hold.answer = true;
    await pass(id);
    expect(await hasStatus(id, "done")).toBe(true);
    expect(steps(id)).toEqual(["work"]);
    expect((await row(id))?.state.pause).toBeUndefined();
  });

  it("during a step, as the gateway's 402: the step starts again after the top-up", async () => {
    script.steps.work = fails(http(402));
    const id = await start([agent("work"), end]);
    expect(await rests(id)).toBe(true);
    expect((await row(id))?.state.pause).toEqual({ kind: "credits" });
    await pass(id);
    expect(await hasStatus(id, "done")).toBe(true);
    expect(steps(id)).toEqual(["work", "work"]);
  });

  it("the Manage-App out of reach on a look is no refusal", async () => {
    hold.can = false;
    const id = await start([agent("work"), end]);
    expect(await rests(id)).toBe(true);
    hold.can = true;
    hold.answer = new Error("fetch failed");
    await pass(id);
    await new Promise((r) => setTimeout(r, 400));
    expect((await row(id))?.status).toBe("sleeping");
    expect((await row(id))?.state.pause).toEqual({ kind: "credits" });
    hold.answer = true;
    expect(await hasStatus(id, "done")).toBe(true);
  });

  it("nobody comes for 30 days: it fails, and it can still be tried again", async () => {
    hold.can = false;
    const id = await start([agent("work"), end]);
    expect(await rests(id)).toBe(true);
    hold.answer = false;
    const r = await row(id);
    await client.withTenant(T, () =>
      client.db
        .update(client.schema.run)
        .set({
          state: {
            ...r?.state,
            retries: { ...r?.state.retries, since: new Date(Date.now() - 31 * 86_400_000).toISOString() },
          } as never,
        })
        .where(eq(client.schema.run.id, id)),
    );
    await pass(id);
    expect(await hasStatus(id, "failed")).toBe(true);
    const failed = await row(id);
    expect(failed?.error).toMatch(/credits/i);
    expect(failed?.state.pause).toBeUndefined();
    expect(failed?.wakeAt).toBeNull();
    hold.can = true;
    hold.answer = true;
    await client.withTenant(T, () => runner.retry(id));
    expect(await hasStatus(id, "done")).toBe(true);
  });

  it("the report has no time for it, and tells the door to say so", async () => {
    hold.can = false;
    const id = await start([agent("work"), end]);
    expect(await rests(id)).toBe(true);
    const report = await client.withTenant(T, async () =>
      reports.runReportOf((await row(id)) as never),
    );
    expect(report.waitingFor).toMatchObject({ wait: "work", until: null, pause: { kind: "credits" } });
    await client.withTenant(T, () => runner.cancel(id));
  });
});

describe("a connection that needs signing in", () => {
  it("waits for a person, looks again, says so once, and goes on after", async () => {
    const needs = () => new types.SignInNeeded("Gmail", { code: "stepCallRefused" } as never);
    script.steps.mail = [
      () => {
        throw needs();
      },
      () => {
        throw needs();
      },
    ];
    const id = await start([agent("mail"), end]);
    expect(await restsAfter(id, 1)).toBe(true);
    expect((await row(id))?.state.pause).toEqual({ kind: "sign_in", service: "Gmail" });
    await pass(id);
    expect(await restsAfter(id, 2)).toBe(true);
    const told = (await eventsOf(id)).filter((e) => e.note?.code === "stepWaitsSignIn");
    expect(told).toHaveLength(1);
    await pass(id);
    expect(await hasStatus(id, "done")).toBe(true);
    expect(steps(id)).toEqual(["mail", "mail", "mail"]);
  });
});

describe("the switch off", () => {
  it("the first error fails the run, onFail or not, and an empty account fails it too", async () => {
    const features = process.env.FEATURES;
    process.env.FEATURES = "durableRuns=off";
    try {
      script.steps.flaky = fails(http(503));
      const id = await start([agent("flaky", { onFail: "rescue" }), agent("rescue"), end]);
      expect(await hasStatus(id, "failed")).toBe(true);
      expect(steps(id)).toEqual(["flaky"]);
      hold.can = false;
      const poor = await start([agent("work"), end]);
      expect(await hasStatus(poor, "failed")).toBe(true);
      expect((await row(poor))?.error).toMatch(/credits/i);
    } finally {
      process.env.FEATURES = features;
    }
  });
});
