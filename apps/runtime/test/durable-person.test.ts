import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APICallError } from "ai";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "wizards-durable-person-"));
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

const worked: { run: string; step: string }[] = [];
const failing = new Map<string, unknown[]>();
vi.mock("../src/engine/steps/index.js", async (original) => ({
  ...(await original<typeof import("../src/engine/steps/index.js")>()),
  runAutomaticStep: async (step: { id: string }, ctx: { runId: string }) => {
    worked.push({ run: ctx.runId, step: step.id });
    const error = failing.get(step.id)?.shift();
    if (error) {
      throw error;
    }
    return { text: `made ${step.id}`, at: new Date().toISOString() };
  },
}));

/** Runs between an answer's reading the run and its write. */
const read = vi.hoisted(() => ({ during: null as (() => Promise<unknown>) | null }));
vi.mock("../src/engine/requirements.js", async (original) => ({
  ...(await original<typeof import("../src/engine/requirements.js")>()),
  missingModelsSaid: async () => [],
  closedChoices: async () => {
    const during = read.during;
    read.during = null;
    await during?.();
    return {};
  },
}));
vi.mock("../src/safety.js", async (original) => ({
  ...(await original<typeof import("../src/safety.js")>()),
  guestChecksOn: async () => false,
}));

/** What the Manage-App answers to a reservation. */
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
let reports: typeof import("../src/services/runs");

const T = "tenant-durable-person";
const agent = (id: string) => ({
  id,
  type: "agent",
  title: id,
  instructions: "Do it.",
  tools: [],
  output: { format: "text" },
});
const ask = (more: object = { timeout: "2d" }) => ({
  id: "ask",
  type: "form",
  title: "Ask",
  fields: [{ id: "x", kind: "text", label: "X" }],
  ...more,
});
const check = (more: object = { timeout: "2d" }) => ({
  id: "check",
  type: "review",
  title: "Check",
  show: ["made"],
  ...more,
});
const end = { id: "done", type: "result", title: "Fertig", deliverables: [] };
const base = { version: 1, title: "Person", description: "", avatar: "round" };
/** A page with a deadline whose `next` reads `timedOut`. */
const branching = [
  ask({ timeout: "2d", next: [{ when: { field: "steps.ask.timedOut", op: "eq", value: true }, goto: "late" }] }),
  agent("onTime"),
  { ...end, id: "doneOnTime" },
  agent("late"),
  end,
];

const start = (
  steps: unknown[],
  options: { mode?: "test" | "live"; startedBy?: object; fill?: object } = {},
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
      userId: "u",
      ...(options.startedBy
        ? {
            startedBy: options.startedBy as never,
            start: { kind: "schedule", at: new Date().toISOString() } as never,
            fill: options.fill as never,
          }
        : {}),
    });
  });
const row = (id: string) =>
  client.withTenant(T, () =>
    client.db.query.run.findFirst({ where: eq(client.schema.run.id, id) }),
  );
const line = (id: string) =>
  client.controlDb.query.runIndex.findFirst({ where: eq(client.control.runIndex.runId, id) });
const logOf = (id: string) =>
  client.withTenant(T, () =>
    client.db.select().from(client.schema.runEvent).where(eq(client.schema.runEvent.runId, id)),
  );
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
/** Resting at a person's step: no runner has it. */
const waits = (id: string, cursor?: string) =>
  until(async () => {
    const l = await line(id);
    const r = await row(id);
    return (
      r?.status === "waiting_input" &&
      (!cursor || r.cursor === cursor) &&
      l?.active === false &&
      l.owner === null
    );
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
const jsonOf = async (id: string, step: string) => (await row(id))?.state.outputs[step]?.json;
const inTenant = <R>(fn: () => Promise<R>) => client.withTenant(T, fn);
const http = (status: number) =>
  new APICallError({
    message: "down",
    url: "https://x.test",
    requestBodyValues: {},
    statusCode: status,
  });

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  runner = await import("../src/engine/runner");
  wizards = await import("../src/services/wizards");
  reports = await import("../src/services/runs");
  runner.startRunner();
}, 120_000);
afterAll(() => runner?.stopRunner());

describe("a page with a timeout", () => {
  it("waits as a row, with the deadline in both copies, and holds no credits", async () => {
    const id = await start([ask(), agent("after"), end]);
    expect(await waits(id)).toBe(true);
    const r = await row(id);
    const wake = r?.wakeAt?.getTime() ?? 0;
    expect(Math.abs(wake - (Date.now() + 2 * 86_400_000))).toBeLessThan(60_000);
    expect((await line(id))?.wakeAt?.getTime()).toBe(wake);
    expect(hold.released).toContain(id);
    expect((await logOf(id)).map((e) => e.type)).toContain("wait");
  });

  it("moves on at the deadline: timedOut is true, its fields stay empty, it holds again", async () => {
    const id = await start([ask(), agent("after"), end]);
    expect(await waits(id)).toBe(true);
    hold.reserved.length = 0;
    await pass(id);
    expect(await hasStatus(id, "done")).toBe(true);
    expect(await jsonOf(id, "ask")).toEqual({ timedOut: true });
    expect((await row(id))?.state.values.x).toBeUndefined();
    expect((await row(id))?.wakeAt).toBeNull();
    expect(steps(id)).toEqual(["after"]);
    expect(hold.reserved).toContain(id);
    const log = (await logOf(id)).map((e) => `${e.type} ${e.stepId}`);
    expect(log).toContain("woken ask");
    expect(log).toContain("step_done ask");
  });

  it("a next rule reads timedOut, both ways", async () => {
    const late = await start(branching);
    expect(await waits(late)).toBe(true);
    await pass(late);
    expect(await hasStatus(late, "done")).toBe(true);
    expect(steps(late)).toEqual(["late"]);

    const onTime = await start(branching);
    expect(await waits(onTime)).toBe(true);
    await inTenant(() => runner.submitPage(onTime, "ask", { x: "yes" }));
    expect(await hasStatus(onTime, "done")).toBe(true);
    expect(steps(onTime)).toEqual(["onTime"]);
    expect(await jsonOf(onTime, "ask")).toEqual({ timedOut: false });
  });

  it("a wake that comes early changes nothing and puts the time back", async () => {
    const id = await start([ask(), agent("after"), end]);
    expect(await waits(id)).toBe(true);
    const before = await row(id);
    await client.controlDb
      .update(client.control.runIndex)
      .set({ wakeAt: new Date(Date.now() - 1000) })
      .where(eq(client.control.runIndex.runId, id));
    expect(
      await until(async () => (await line(id))?.wakeAt?.getTime() === before?.wakeAt?.getTime()),
    ).toBe(true);
    expect(await waits(id)).toBe(true);
    const after = await row(id);
    expect(after?.status).toBe("waiting_input");
    expect(after?.rev).toBe(before?.rev);
    expect(after?.state.outputs.ask).toBeUndefined();
    // The drive that came and left is no interrupted one: an answer now is an ordinary answer.
    expect(after?.driving).toBe(false);
    await inTenant(() => runner.submitPage(id, "ask", { x: "yes" }));
    expect(await hasStatus(id, "done")).toBe(true);
    expect((await logOf(id)).map((e) => e.type)).not.toContain("resumed");
  });

  it("a stale wake after an answer finds the run moved on", async () => {
    const id = await start([ask(), ask({ id: "ask2", timeout: "3d" }), end]);
    expect(await waits(id, "ask")).toBe(true);
    await inTenant(() => runner.submitPage(id, "ask", { x: "yes" }));
    expect(await waits(id, "ask2")).toBe(true);
    const next = (await row(id))?.wakeAt?.getTime();
    // The old time comes to the clock after all.
    await client.controlDb
      .update(client.control.runIndex)
      .set({ wakeAt: new Date(Date.now() - 1000) })
      .where(eq(client.control.runIndex.runId, id));
    expect(await until(async () => (await line(id))?.wakeAt?.getTime() === next)).toBe(true);
    expect((await row(id))?.status).toBe("waiting_input");
    expect((await row(id))?.cursor).toBe("ask2");
    expect((await row(id))?.state.outputs.ask2).toBeUndefined();
  });

  it("is kept past its deadline, as a wait", async () => {
    const id = await start([ask({ timeout: "31d" }), end], { mode: "live" });
    expect(await waits(id)).toBe(true);
    const r = await row(id);
    expect(r?.expiresAt?.getTime()).toBeGreaterThan(r?.wakeAt?.getTime() ?? Number.POSITIVE_INFINITY);
  });

  it("a test run can be sent on now, and the log says who", async () => {
    const id = await start([ask(), agent("after"), end]);
    expect(await waits(id)).toBe(true);
    await inTenant(() => runner.wakeNow(id, "Ana"));
    expect(await hasStatus(id, "done")).toBe(true);
    expect(await jsonOf(id, "ask")).toEqual({ timedOut: true });
  });

  it("the view and the report say until when", async () => {
    const id = await start([ask(), end]);
    expect(await waits(id)).toBe(true);
    const r = await row(id);
    await inTenant(async () => {
      const view = await runner.runView(r as never, {} as never);
      expect(view.wakeAt).toBe(r?.wakeAt?.toISOString());
      const report = await reports.runReport("u", id);
      expect(report.waitingFor).toMatchObject({ form: "ask", until: r?.wakeAt?.toISOString() });
    });
  });

  it("a page without one waits as it always did", async () => {
    const id = await start([ask({}), end]);
    expect(await waits(id)).toBe(true);
    expect((await row(id))?.wakeAt).toBeNull();
    expect((await line(id))?.wakeAt).toBeNull();
    expect(hold.released).not.toContain(id);
    await inTenant(() => runner.submitPage(id, "ask", { x: "yes" }));
    expect(await hasStatus(id, "done")).toBe(true);
    expect((await row(id))?.state.outputs.ask).toBeUndefined();
  });
});

describe("an answer and a timeout in the same moment", () => {
  it("the answer lands while the wake holds credits: the answer wins, once", async () => {
    const id = await start([ask(), agent("after"), end]);
    expect(await waits(id)).toBe(true);
    let answered: unknown = "not yet";
    hold.during = () =>
      inTenant(() => runner.submitPage(id, "ask", { x: "in time" })).then(
        () => {
          answered = "ok";
        },
        (err) => {
          answered = err;
        },
      );
    // The answer holds too, so this hook runs in whichever comes first: only the wake's counts.
    await pass(id);
    expect(await hasStatus(id, "done")).toBe(true);
    expect(answered).toBe("ok");
    expect(await jsonOf(id, "ask")).toEqual({ timedOut: false });
    expect((await row(id))?.state.values.x).toBe("in time");
    expect(steps(id)).toEqual(["after"]);
    expect((await row(id))?.state.history).toEqual(["ask"]);
    expect((await logOf(id)).map((e) => e.type)).not.toContain("woken");
  });

  it("the timeout lands while the answer is being read: the answer hears it came too late", async () => {
    const id = await start([ask(), agent("after"), end]);
    expect(await waits(id)).toBe(true);
    read.during = async () => {
      await pass(id);
      expect(await until(async () => (await row(id))?.status !== "waiting_input")).toBe(true);
    };
    await expect(inTenant(() => runner.submitPage(id, "ask", { x: "late" }))).rejects.toMatchObject({
      note: { code: "answerTooLate" },
    });
    expect(await hasStatus(id, "done")).toBe(true);
    expect(await jsonOf(id, "ask")).toEqual({ timedOut: true });
    expect((await row(id))?.state.values.x).toBeUndefined();
    expect(steps(id)).toEqual(["after"]);
    expect((await row(id))?.state.history).toEqual(["ask"]);
  });

  it("an answer after the timeout hears the same", async () => {
    const id = await start([ask(), ask({ id: "ask2", timeout: "2d" }), end]);
    expect(await waits(id, "ask")).toBe(true);
    await pass(id);
    expect(await waits(id, "ask2")).toBe(true);
    await expect(inTenant(() => runner.submitPage(id, "ask", { x: "late" }))).rejects.toMatchObject({
      note: { code: "answerTooLate" },
    });
  });

  it("run at the same moment, exactly one wins, every time", { timeout: 60_000 }, async () => {
    for (let i = 0; i < 12; i++) {
      const id = await start([ask(), agent("after"), end]);
      expect(await waits(id)).toBe(true);
      await pass(id);
      const answer = await inTenant(() => runner.submitPage(id, "ask", { x: "race" })).then(
        () => true,
        () => false,
      );
      expect(await hasStatus(id, "done")).toBe(true);
      const json = (await jsonOf(id, "ask")) as { timedOut: boolean };
      expect(json.timedOut).toBe(!answer);
      expect((await row(id))?.state.values.x).toBe(answer ? "race" : undefined);
      expect(steps(id)).toEqual(["after"]);
      expect((await row(id))?.state.history).toEqual(["ask"]);
    }
  });

  it("a write of the run's state during the wake does not lose the timeout", async () => {
    const id = await start([ask(), agent("after"), end]);
    expect(await waits(id)).toBe(true);
    hold.during = async () => {
      const r = await row(id);
      await inTenant(() => runner.writeRunState(r as never, r?.state as never));
    };
    await pass(id);
    expect(await hasStatus(id, "done")).toBe(true);
    expect(await jsonOf(id, "ask")).toEqual({ timedOut: true });
    expect(steps(id)).toEqual(["after"]);
  });

  it("a stop during the wake wins", async () => {
    const id = await start([ask(), agent("after"), end]);
    expect(await waits(id)).toBe(true);
    hold.during = () => inTenant(() => runner.stopRun(id, "Ana"));
    await pass(id);
    expect(await hasStatus(id, "cancelled")).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect((await row(id))?.status).toBe("cancelled");
    expect((await row(id))?.state.outputs.ask).toBeUndefined();
    expect(steps(id)).toEqual([]);
  });

  it("a wake that takes past the heartbeat is not stopped by it", { timeout: 30_000 }, async () => {
    const id = await start([ask(), agent("after"), end]);
    expect(await waits(id)).toBe(true);
    hold.during = () => new Promise((r) => setTimeout(r, 11_000));
    await pass(id);
    expect(await until(async () => (await row(id))?.status === "done", 20_000)).toBe(true);
    expect(steps(id)).toEqual(["after"]);
  });
});

describe("credits", () => {
  it("nothing left to pay for needs no hold: a timeout right before the result ends", async () => {
    const id = await start([ask(), end]);
    expect(await waits(id)).toBe(true);
    hold.answer = false;
    try {
      await pass(id);
      expect(await hasStatus(id, "done")).toBe(true);
    } finally {
      hold.answer = true;
    }
  });

  it("refused on timeout: the run waits for credits past the step, and goes on after a top-up", async () => {
    const id = await start([ask(), agent("after"), end]);
    expect(await waits(id)).toBe(true);
    hold.answer = false;
    try {
      await pass(id);
      expect(await hasStatus(id, "sleeping")).toBe(true);
      const r = await row(id);
      expect(r?.state.pause).toEqual({ kind: "credits" });
      expect(r?.cursor).toBe("after");
      expect(await jsonOf(id, "ask")).toEqual({ timedOut: true });
      expect(steps(id)).toEqual([]);
    } finally {
      hold.answer = true;
    }
    await pass(id);
    expect(await hasStatus(id, "done")).toBe(true);
    expect(steps(id)).toEqual(["after"]);
  });

  it("the Manage-App out of reach on timeout: the time stays due, the clock tries again", async () => {
    const id = await start([ask(), agent("after"), end]);
    expect(await waits(id)).toBe(true);
    hold.answer = new Error("no route");
    try {
      await pass(id);
      expect(await until(async () => hold.reserved.filter((r) => r === id).length >= 2)).toBe(true);
      expect((await row(id))?.status).toBe("waiting_input");
    } finally {
      hold.answer = true;
    }
    expect(await hasStatus(id, "done")).toBe(true);
    expect(await jsonOf(id, "ask")).toEqual({ timedOut: true });
  });

  it("an answer holds again before the step after it that costs", async () => {
    const id = await start([ask(), agent("after"), end]);
    expect(await waits(id)).toBe(true);
    hold.reserved.length = 0;
    await inTenant(() => runner.submitPage(id, "ask", { x: "yes" }));
    expect(await hasStatus(id, "done")).toBe(true);
    expect(hold.reserved).toContain(id);
    expect((await row(id))?.state.holdLater).toBeUndefined();
  });

  it("an answer refused credits stays, and the run waits for them", async () => {
    const id = await start([ask(), agent("after"), end]);
    expect(await waits(id)).toBe(true);
    hold.answer = false;
    try {
      await inTenant(() => runner.submitPage(id, "ask", { x: "yes" }));
      expect(await hasStatus(id, "sleeping")).toBe(true);
      const r = await row(id);
      expect(r?.state.values.x).toBe("yes");
      expect(r?.state.pause).toEqual({ kind: "credits" });
      expect(r?.cursor).toBe("after");
    } finally {
      hold.answer = true;
    }
    await pass(id);
    expect(await hasStatus(id, "done")).toBe(true);
    expect(steps(id)).toEqual(["after"]);
  });
});

describe("every way into waiting", () => {
  it("createRun: a first page has its deadline from the start, and its control copy", async () => {
    const id = await start([ask(), end]);
    const r = await row(id);
    expect(r?.status).toBe("waiting_input");
    expect(r?.wakeAt).not.toBeNull();
    expect((await line(id))?.wakeAt?.getTime()).toBe(r?.wakeAt?.getTime());
  });

  it("goBack: the page has a new deadline, and it times out again", async () => {
    const id = await start([ask(), ask({ id: "ask2" }), end]);
    expect(await waits(id, "ask")).toBe(true);
    const first = (await row(id))?.wakeAt?.getTime() ?? 0;
    await inTenant(() => runner.submitPage(id, "ask", { x: "yes" }));
    expect(await waits(id, "ask2")).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    await inTenant(() => runner.goBack(id));
    const r = await row(id);
    expect(r?.cursor).toBe("ask");
    expect(r?.wakeAt?.getTime()).toBeGreaterThan(first);
    expect((await line(id))?.wakeAt?.getTime()).toBe(r?.wakeAt?.getTime());
    await pass(id);
    expect(await waits(id, "ask2")).toBe(true);
    expect(await jsonOf(id, "ask")).toEqual({ timedOut: true });
    expect((await row(id))?.state.values.x).toBeUndefined();
  });

  it("goBack to a page without a deadline takes the old one off", async () => {
    const id = await start([ask({}), ask({ id: "ask2" }), end]);
    await inTenant(() => runner.submitPage(id, "ask", { x: "yes" }));
    expect(await waits(id, "ask2")).toBe(true);
    await inTenant(() => runner.goBack(id));
    expect((await row(id))?.wakeAt).toBeNull();
    await client.controlDb
      .update(client.control.runIndex)
      .set({ wakeAt: new Date(Date.now() - 1000) })
      .where(eq(client.control.runIndex.runId, id));
    expect(await until(async () => (await line(id))?.wakeAt === null)).toBe(true);
    expect((await row(id))?.status).toBe("waiting_input");
    expect((await row(id))?.cursor).toBe("ask");
  });

  it("going back over a timed-out page answers it late, and the answer counts", async () => {
    const id = await start([ask(), ask({ id: "ask2", timeout: undefined }), end]);
    expect(await waits(id, "ask")).toBe(true);
    await pass(id);
    expect(await waits(id, "ask2")).toBe(true);
    await inTenant(() => runner.goBack(id));
    await inTenant(() => runner.submitPage(id, "ask", { x: "late, by hand" }));
    expect(await waits(id, "ask2")).toBe(true);
    expect(await jsonOf(id, "ask")).toEqual({ timedOut: false });
    expect((await row(id))?.state.values.x).toBe("late, by hand");
  });

  it("a page reached after a step has its deadline, and a review too", async () => {
    const id = await start([agent("made"), check(), end]);
    expect(await waits(id, "check")).toBe(true);
    expect((await row(id))?.wakeAt).not.toBeNull();
    await pass(id);
    expect(await hasStatus(id, "done")).toBe(true);
    expect(await jsonOf(id, "check")).toEqual({ timedOut: true });
  });

  it("regenerating at a review ends that wait; the review back has a new one", async () => {
    const id = await start([agent("made"), check({ timeout: "2d", regenerate: true }), end]);
    expect(await waits(id, "check")).toBe(true);
    await inTenant(() => runner.reviewStep(id, "check", { type: "regenerate", target: "made", note: "x" }));
    expect((await row(id))?.wakeAt).toBeNull();
    expect(await waits(id, "check")).toBe(true);
    expect((await row(id))?.wakeAt).not.toBeNull();
    expect(steps(id)).toEqual(["made", "made"]);
  });
});

describe("a started run", () => {
  const wizardWithStart = (passReviews: boolean) =>
    client.withTenant(T, async () => {
      const created = await wizards.createWizard("u", {
        definition: { ...base, steps: [agent("seed"), end] } as never,
      });
      const startId = `s-${created.id}`;
      await client.db
        .update(client.schema.wizard)
        .set({ starts: [{ id: startId, kind: "schedule", passReviews }] as never })
        .where(eq(client.schema.wizard.id, created.id));
      return { wizardId: created.id, startId };
    });
  const run = (w: { wizardId: string; startId: string }, steps: unknown[], fill: object) =>
    client.withTenant(T, () =>
      runner.createRun({
        wizardId: w.wizardId,
        definition: { ...base, steps } as never,
        files: [],
        version: null,
        mode: "test",
        userId: "u",
        startedBy: { kind: "schedule", startId: w.startId },
        start: { kind: "schedule", at: new Date().toISOString() } as never,
        fill: fill as never,
      }),
    );

  it("a page its start fills goes on, and hands on that it did not time out", async () => {
    const id = await run(await wizardWithStart(false), [ask(), agent("after"), end], { x: "given" });
    expect(await hasStatus(id, "done")).toBe(true);
    expect(await jsonOf(id, "ask")).toEqual({ timedOut: false });
    expect((await row(id))?.wakeAt).toBeNull();
  });

  it("a page it cannot fill waits for the owner until the deadline, then goes on", async () => {
    const required = ask({ timeout: "2d", fields: [{ id: "x", kind: "text", label: "X", required: true }] });
    const id = await run(await wizardWithStart(false), [required, agent("after"), end], {});
    expect(await waits(id)).toBe(true);
    expect((await row(id))?.wakeAt).not.toBeNull();
    await pass(id);
    expect(await hasStatus(id, "done")).toBe(true);
    expect(await jsonOf(id, "ask")).toEqual({ timedOut: true });
    expect(steps(id)).toEqual(["after"]);
  });

  it("no setting gives an approval: passReviews passes a review, not this one", async () => {
    const w = await wizardWithStart(true);
    const approve = check({
      approve: true,
      next: [{ when: { field: "steps.check.approved", op: "eq", value: false }, goto: "end" }],
    });
    const passed = await run(w, [agent("made"), check({}), end], {});
    expect(await hasStatus(passed, "done")).toBe(true);
    const held = await run(w, [agent("made"), approve, end], {});
    expect(await waits(held, "check")).toBe(true);
  });
});

describe("a review with approve", () => {
  const steps_ = (more: object = {}) => [
    agent("made"),
    check({
      approve: true,
      next: [{ when: { field: "steps.check.approved", op: "eq", value: false }, goto: "stopped" }],
      ...more,
    }),
    agent("sent"),
    { ...end, id: "doneSent" },
    agent("stopped"),
    end,
  ];

  it("accept approves, with a note a later step can read", async () => {
    const id = await start(steps_());
    expect(await waits(id, "check")).toBe(true);
    await inTenant(() => runner.reviewStep(id, "check", { type: "accept", note: " fine " }));
    expect(await hasStatus(id, "done")).toBe(true);
    expect(await jsonOf(id, "check")).toEqual({ approved: true, note: "fine" });
    expect(steps(id)).toEqual(["made", "sent"]);
  });

  it("decline takes its own way, and says why", async () => {
    const id = await start(steps_());
    expect(await waits(id, "check")).toBe(true);
    await inTenant(() => runner.reviewStep(id, "check", { type: "decline", note: "too dear" }));
    expect(await hasStatus(id, "done")).toBe(true);
    expect(await jsonOf(id, "check")).toEqual({ approved: false, note: "too dear" });
    expect(steps(id)).toEqual(["made", "stopped"]);
  });

  it("a timeout gives no approval", async () => {
    const id = await start(steps_({ timeout: "2d" }));
    expect(await waits(id, "check")).toBe(true);
    await pass(id);
    expect(await hasStatus(id, "done")).toBe(true);
    expect(await jsonOf(id, "check")).toEqual({ timedOut: true, approved: false });
    expect(steps(id)).toEqual(["made", "stopped"]);
  });

  it("a review without approve cannot be declined", async () => {
    const id = await start([agent("made"), check({}), end]);
    expect(await waits(id, "check")).toBe(true);
    await expect(
      inTenant(() => runner.reviewStep(id, "check", { type: "decline" })),
    ).rejects.toMatchObject({ note: { code: "notAnApproval" } });
    expect((await row(id))?.status).toBe("waiting_input");
  });

  it("the report says it asks for a decision", async () => {
    const id = await start(steps_());
    expect(await waits(id, "check")).toBe(true);
    const report = await inTenant(() => reports.runReport("u", id));
    expect(report.waitingFor).toMatchObject({ review: "check", approve: true });
  });
});

describe("what else may happen to the run", () => {
  it("stopped from the timeline: over, and the clock has nothing left", async () => {
    const id = await start([ask(), agent("after"), end]);
    expect(await waits(id)).toBe(true);
    await inTenant(() => runner.stopRun(id, "Ana"));
    const r = await row(id);
    expect(r?.status).toBe("cancelled");
    expect(r?.wakeAt).toBeNull();
    expect((await line(id))?.wakeAt).toBeNull();
    await expect(inTenant(() => runner.submitPage(id, "ask", { x: "no" }))).rejects.toThrow();
    expect(steps(id)).toEqual([]);
  });

  it("a retry on the way to a page: the deadline starts when the page is reached", async () => {
    failing.set("flaky", [http(503)]);
    const id = await start([agent("flaky"), ask(), end]);
    expect(await hasStatus(id, "sleeping")).toBe(true);
    expect((await row(id))?.state.retries?.count).toBe(1);
    await pass(id);
    expect(await waits(id, "ask")).toBe(true);
    const r = await row(id);
    expect(r?.state.retries).toBeUndefined();
    expect(Math.abs((r?.wakeAt?.getTime() ?? 0) - (Date.now() + 2 * 86_400_000))).toBeLessThan(60_000);
  });

  it("a retry after a timeout: what the timeout handed on stays", async () => {
    failing.set("flaky", [http(503)]);
    const id = await start([ask(), agent("flaky"), end]);
    expect(await waits(id)).toBe(true);
    await pass(id);
    expect(await until(async () => (await row(id))?.state.retries?.count === 1)).toBe(true);
    expect(await hasStatus(id, "sleeping")).toBe(true);
    expect(await jsonOf(id, "ask")).toEqual({ timedOut: true });
    await pass(id);
    expect(await hasStatus(id, "done")).toBe(true);
    expect(await jsonOf(id, "ask")).toEqual({ timedOut: true });
    expect(steps(id)).toEqual(["flaky", "flaky"]);
  });

  it("try again after a step failed for good, at a step behind a timed-out page", async () => {
    failing.set("broken", [http(400)]);
    const id = await start([ask(), agent("broken"), end]);
    expect(await waits(id)).toBe(true);
    await pass(id);
    expect(await hasStatus(id, "failed")).toBe(true);
    await inTenant(() => runner.retry(id));
    expect(await hasStatus(id, "done")).toBe(true);
    expect(await jsonOf(id, "ask")).toEqual({ timedOut: true });
  });
});

describe("the switch off", () => {
  it("a new run's page has no deadline; a run already waiting still times out", async () => {
    const waiting = await start([ask(), agent("after"), end]);
    expect(await waits(waiting)).toBe(true);
    process.env.FEATURES = "";
    try {
      const id = await start([ask({ timeout: "2d", remind: "1d" }), end]);
      expect(await waits(id)).toBe(true);
      expect((await row(id))?.wakeAt).toBeNull();
      expect(hold.released).not.toContain(id);
      await pass(waiting);
      expect(await hasStatus(waiting, "done")).toBe(true);
    } finally {
      process.env.FEATURES = "durableRuns=on";
    }
  });
});
