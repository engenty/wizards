import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "wizards-durable-wait-"));
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
// One slot: a step that hangs past its deadline must give it back for the next run to start.
process.env.RUNNER_MAX_RUNS = "1";
process.env.RUNNER_STEP_DEADLINES = "widget=0.005";

const worked: { run: string; step: string; model?: string }[] = [];
const abortReasons: unknown[] = [];
vi.mock("@engenty/wizards-engine/steps/index", async (original) => ({
  ...(await original<typeof import("@engenty/wizards-engine/steps/index")>()),
  runAutomaticStep: async (
    step: { id: string; type: string; model?: string },
    ctx: { runId: string; signal: AbortSignal },
  ) => {
    worked.push({ run: ctx.runId, step: step.id, model: step.model });
    if (step.type === "widget") {
      // Hangs, and hears nothing: the deadline has to free the slot by itself.
      ctx.signal.addEventListener("abort", () => abortReasons.push(ctx.signal.reason));
      await new Promise(() => undefined);
    }
    return { text: `made ${step.id}`, at: new Date().toISOString() };
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

/** What the Manage-App answers to a reservation; created runs always get theirs. */
const hold = vi.hoisted(() => ({
  answer: true as boolean | "guest_budget" | Error,
  during: null as (() => Promise<unknown>) | null,
  released: [] as string[],
  reserved: [] as string[],
}));
vi.mock("../src/credits/credits.js", async (original) => ({
  ...(await original<typeof import("../src/credits/credits.js")>()),
  reserveForRun: async (runId: string) => {
    hold.reserved.push(runId);
    const during = hold.during;
    hold.during = null;
    await during?.();
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
let shares: typeof import("../src/services/shares");
let reports: typeof import("../src/services/runs");

const T = "tenant-durable-wait";
const agent = (id: string, more: object = {}) => ({
  id,
  type: "agent",
  title: id,
  instructions: "Do it.",
  tools: [],
  output: { format: "text" },
  ...more,
});
const pause = (more: object = { for: "2d" }) => ({
  id: "pause",
  type: "wait",
  title: "Pause",
  ...more,
});
const end = { id: "done", type: "result", title: "Fertig", deliverables: [] };
const base = { version: 1, title: "Wait", description: "", avatar: "round" };

const start = (
  steps: unknown[],
  options: { mode?: "test" | "live"; visitorId?: string } = {},
) =>
  client.withTenant(T, async () => {
    const created = await wizards.createWizard("u", {
      definition: { ...base, steps: [agent("seed"), end] } as never,
    });
    return runner.createRun({
      wizardId: created.id,
      definition: { ...base, steps } as never,
      files: [],
      version: null,
      mode: options.mode ?? "test",
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
/** The time passes: both copies of the wake time are in the past. */
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
const steps = (id: string) => worked.filter((w) => w.run === id).map((w) => w.step);

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  runner = await import("../src/engine/runner");
  wizards = await import("../src/services/wizards");
  shares = await import("../src/services/shares");
  reports = await import("../src/services/runs");
  runner.startRunner();
});
afterAll(() => runner.stopRunner());

describe("wait 2 days", () => {
  it("leaves every process, wakes by the clock, goes on with the next step", async () => {
    const id = await start([agent("before"), pause(), agent("after"), end]);
    expect(await rests(id)).toBe(true);
    expect(steps(id)).toEqual(["before"]);
    const r = await row(id);
    expect((r?.wakeAt?.getTime() ?? 0) - Date.now()).toBeGreaterThan(47 * 3600_000);
    expect((await line(id))?.wakeAt?.getTime()).toBe(r?.wakeAt?.getTime());

    await pass(id);
    expect(await hasStatus(id, "done")).toBe(true);
    expect(steps(id)).toEqual(["before", "after"]);
    expect((await line(id))?.wakeAt).toBeNull();
    expect((await row(id))?.wakeAt).toBeNull();
    expect((await row(id))?.state.outputs.pause?.json).toEqual({ waited: true });
  });

  it("an early wake finds the run as it is and puts the time back", async () => {
    const id = await start([pause(), end]);
    expect(await rests(id)).toBe(true);
    const before = (await row(id))?.wakeAt?.getTime();
    // Only the control copy is due: a tenant write that never came, or a stale clock.
    await client.controlDb
      .update(client.control.runIndex)
      .set({ wakeAt: new Date(Date.now() - 1000) })
      .where(eq(client.control.runIndex.runId, id));
    expect(await until(async () => (await line(id))?.wakeAt?.getTime() === before)).toBe(true);
    expect(await rests(id)).toBe(true);
    expect((await row(id))?.wakeAt?.getTime()).toBe(before);
  });

  it("a cancel while it sleeps ends it and clears the wake", async () => {
    const id = await start([pause(), end]);
    expect(await rests(id)).toBe(true);
    await client.withTenant(T, () => runner.cancel(id));
    const r = await row(id);
    expect(r?.status).toBe("cancelled");
    expect(r?.wakeAt).toBeNull();
    expect((await line(id))?.wakeAt).toBeNull();
    // A wake that was on its way finds the run over.
    await client.controlDb
      .update(client.control.runIndex)
      .set({ wakeAt: new Date(Date.now() - 1000) })
      .where(eq(client.control.runIndex.runId, id));
    expect(await until(async () => (await line(id))?.wakeAt === null)).toBe(true);
    expect((await row(id))?.status).toBe("cancelled");
  });

  it("holds no credits while it sleeps, and holds again on waking", async () => {
    const id = await start([pause(), agent("after"), end]);
    expect(await rests(id)).toBe(true);
    expect(hold.released).toContain(id);
    const before = hold.reserved.filter((r) => r === id).length;
    await pass(id);
    expect(await hasStatus(id, "done")).toBe(true);
    expect(hold.reserved.filter((r) => r === id).length).toBe(before + 1);
  });

  it("a write of the run's state during the wake does not lose the wake", async () => {
    const id = await start([pause(), agent("after"), end]);
    expect(await rests(id)).toBe(true);
    hold.during = async () => {
      const r = await row(id);
      await client.withTenant(T, () => runner.writeRunState(r as never, r?.state as never));
    };
    await pass(id);
    expect(await hasStatus(id, "done")).toBe(true);
    expect(steps(id)).toEqual(["after"]);
  });

  it("a cancel during the wake wins", async () => {
    const id = await start([pause(), agent("after"), end]);
    expect(await rests(id)).toBe(true);
    hold.during = () => client.withTenant(T, () => runner.cancel(id));
    await pass(id);
    expect(await hasStatus(id, "cancelled")).toBe(true);
    await until(async () => (await line(id))?.owner === null);
    expect((await row(id))?.status).toBe("cancelled");
    expect(steps(id)).toEqual([]);
  });

  it("a wake that takes past the heartbeat is not stopped by it", { timeout: 30_000 }, async () => {
    const id = await start([pause(), agent("after"), end]);
    expect(await rests(id)).toBe(true);
    hold.during = () => new Promise((r) => setTimeout(r, 11_000));
    await pass(id);
    expect(await until(async () => (await row(id))?.status === "done", 20_000)).toBe(true);
    expect(steps(id)).toEqual(["after"]);
  });

  it("a person cannot answer, go back or retry while it sleeps, and is offered neither", async () => {
    const id = await start([
      { id: "ask", type: "form", title: "Ask", fields: [{ id: "x", kind: "text", label: "X" }] },
      pause(),
      end,
    ]);
    await client.withTenant(T, () => runner.submitPage(id, "ask", { x: "go" }));
    expect(await rests(id)).toBe(true);
    await client.withTenant(T, async () => {
      await expect(runner.goBack(id)).rejects.toThrow();
      await expect(runner.retry(id)).rejects.toThrow();
      await expect(runner.submitPage(id, "ask", { x: "again" })).rejects.toThrow();
      const r = await row(id);
      const view = await runner.runView(r as never, {} as never);
      expect(view.status).toBe("sleeping");
      expect(view.wakeAt).toBe(r?.wakeAt?.toISOString());
      expect(view.canBack).toBe(false);
      expect(view.talk).toBe(false);
    });
  });

  it("the report says what it waits for and when: a door does not read it as working", async () => {
    const id = await start([pause(), end]);
    expect(await rests(id)).toBe(true);
    const r = await row(id);
    const report = await client.withTenant(T, () => reports.runReportOf(r as never));
    expect(report.status).toBe("sleeping");
    expect(report.waitingFor).toMatchObject({
      wait: "pause",
      title: "Pause",
      until: r?.wakeAt?.toISOString(),
    });
  });

  it("a branch reads what the wait hands on", async () => {
    const id = await start([
      pause({
        for: "1d",
        next: [{ when: { field: "steps.pause.waited", op: "eq", value: true }, goto: "late" }],
      }),
      agent("skipped"),
      agent("late"),
      end,
    ]);
    expect(await rests(id)).toBe(true);
    await pass(id);
    expect(await hasStatus(id, "done")).toBe(true);
    expect(steps(id)).toEqual(["late"]);
  });
});

describe("wait until a date", () => {
  it("waits until an answer's date", async () => {
    const at = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const id = await start([
      { id: "ask", type: "form", title: "Ask", fields: [{ id: "due", kind: "text", label: "D" }] },
      pause({ until: "{{due}}" }),
      end,
    ]);
    await client.withTenant(T, () => runner.submitPage(id, "ask", { due: at }));
    expect(await rests(id)).toBe(true);
    expect((await row(id))?.wakeAt?.toISOString()).toBe(at);
  });

  it("a date gone by waits for nothing", async () => {
    const id = await start([pause({ until: "2020-01-01T00:00:00.000Z" }), agent("after"), end]);
    expect(await hasStatus(id, "done")).toBe(true);
    expect(steps(id)).toEqual(["after"]);
    expect((await line(id))?.wakeAt).toBeNull();
  });

  it("an answer that is no date fails the run, and says so", async () => {
    const id = await start([
      { id: "ask", type: "form", title: "Ask", fields: [{ id: "due", kind: "text", label: "D" }] },
      pause({ until: "{{due}}" }),
      end,
    ]);
    await client.withTenant(T, () => runner.submitPage(id, "ask", { due: "soon-ish" }));
    expect(await hasStatus(id, "failed")).toBe(true);
    expect((await row(id))?.error).toContain("soon-ish");
  });
});

describe("what a wait outlasts", () => {
  it("a run waiting 30 days is kept: the purge takes it only after its wake", async () => {
    const id = await start([pause({ for: "30d" }), end], { mode: "live", visitorId: "v-keep" });
    expect(await rests(id)).toBe(true);
    const r = await row(id);
    const days = 86_400_000;
    // Its wake, and the week a visitor has to come back for a result, counted from there.
    expect(r?.expiresAt?.getTime()).toBeGreaterThan(Date.now() + 36 * days);
    expect(await client.withTenant(T, () => shares.purgeExpiredRuns())).toBe(0);
    // Past the week a run would be kept without the wait.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 8 * days });
    try {
      expect(await client.withTenant(T, () => shares.purgeExpiredRuns())).toBe(0);
    } finally {
      vi.useRealTimers();
    }
    expect((await row(id))?.status).toBe("sleeping");
    expect(await line(id)).toBeTruthy();
  });

  it("a test run stays without an expiry", async () => {
    const id = await start([pause(), end]);
    expect(await rests(id)).toBe(true);
    expect((await row(id))?.expiresAt).toBeNull();
  });

  it("a guest run refused on wake waits past its wait, and goes on when the budget allows", async () => {
    const id = await start([pause(), agent("after"), end], { mode: "live", visitorId: "v-guest" });
    expect(await rests(id)).toBe(true);
    hold.answer = "guest_budget";
    try {
      await pass(id);
      expect(await until(async () => (await row(id))?.cursor === "after")).toBe(true);
      expect(await rests(id)).toBe(true);
      const r = await row(id);
      expect(r?.state.pause).toEqual({ kind: "credits" });
      expect(r?.state.outputs.pause?.json).toEqual({ waited: true });
      expect(steps(id)).toEqual([]);
    } finally {
      hold.answer = true;
    }
    await pass(id);
    expect(await hasStatus(id, "done")).toBe(true);
    // It did not wait a second time.
    expect(steps(id)).toEqual(["after"]);
  });

  it("an account out of credits on wake waits for the top-up", async () => {
    const id = await start([pause(), agent("after"), end]);
    expect(await rests(id)).toBe(true);
    hold.answer = false;
    try {
      await pass(id);
      expect(await until(async () => (await row(id))?.cursor === "after")).toBe(true);
      expect(await rests(id)).toBe(true);
      expect((await row(id))?.state.pause).toEqual({ kind: "credits" });
    } finally {
      hold.answer = true;
    }
    await pass(id);
    expect(await hasStatus(id, "done")).toBe(true);
  });

  it("nothing left to pay for needs no hold: a wait right before the result ends", async () => {
    const id = await start([pause(), end], { mode: "live", visitorId: "v-last" });
    expect(await rests(id)).toBe(true);
    hold.answer = "guest_budget";
    try {
      await pass(id);
      expect(await hasStatus(id, "done")).toBe(true);
    } finally {
      hold.answer = true;
    }
  });

  it("the Manage-App out of reach on wake is no refusal: the run sleeps on and tries again", async () => {
    const id = await start([pause(), agent("after"), end]);
    expect(await rests(id)).toBe(true);
    hold.answer = new Error("manage is down");
    await pass(id);
    const tried = hold.reserved.filter((r) => r === id).length;
    expect(await until(async () => hold.reserved.filter((r) => r === id).length > tried + 1)).toBe(
      true,
    );
    expect((await row(id))?.status).toBe("sleeping");
    hold.answer = true;
    expect(await hasStatus(id, "done")).toBe(true);
    expect(steps(id)).toEqual(["after"]);
  });
});

describe("a deadline on automatic steps", () => {
  const widget = {
    id: "stuck",
    type: "widget",
    title: "Stuck",
    entry: "index.html",
    data: {},
  };

  it("a step past its deadline fails with a clear word, and frees its slot", async () => {
    const id = await start([widget, end]);
    expect(await hasStatus(id, "failed")).toBe(true);
    expect((await row(id))?.error).toBe("The step took too long. Try again.");
    expect(abortReasons).toContain("deadline");
    // The process has one slot: it is free when the next run gets to work.
    const next = await start([agent("after"), end]);
    expect(await hasStatus(next, "done")).toBe(true);
  });

  it("other step types keep their long deadline", async () => {
    const id = await start([agent("long"), end]);
    expect(await hasStatus(id, "done")).toBe(true);
  });
});

describe("the switch off", () => {
  it("a wizard with a wait does not start; a run already asleep goes on", async () => {
    const asleep = await start([pause(), agent("after"), end]);
    expect(await rests(asleep)).toBe(true);
    process.env.FEATURES = "";
    try {
      await expect(start([pause(), end])).rejects.toThrow(/wait step/);
      await pass(asleep);
      expect(await hasStatus(asleep, "done")).toBe(true);
    } finally {
      process.env.FEATURES = "durableRuns=on";
    }
  });
});
