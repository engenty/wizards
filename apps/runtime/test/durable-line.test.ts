import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// A process that serves no runner role, as the web on the cloud: `kick` only puts a run in line,
// and the runner's look started below takes it.
const dir = mkdtempSync(join(tmpdir(), "wizards-durable-line-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.RUNTIME_ROLE = "doors";

/** Steps that work until the test lets them finish, and what a test has them do meanwhile. */
const started = new Set<string>();
const finish = new Map<string, () => void>();
const during = new Map<string, () => Promise<void>>();
const signals = new Map<string, AbortSignal>();
vi.mock("../src/engine/steps/index.js", async (original) => ({
  ...(await original<typeof import("../src/engine/steps/index.js")>()),
  runAutomaticStep: async (_step: unknown, ctx: { runId: string; signal: AbortSignal }) => {
    started.add(ctx.runId);
    signals.set(ctx.runId, ctx.signal);
    await during.get(ctx.runId)?.();
    await new Promise<void>((res) => finish.set(ctx.runId, res));
    return { text: `made by ${ctx.runId}`, at: new Date().toISOString() };
  },
}));

vi.mock("../src/engine/requirements.js", async (original) => ({
  ...(await original<typeof import("../src/engine/requirements.js")>()),
  missingModelsSaid: async () => [],
}));

let client: typeof import("../src/db/client");
let runner: typeof import("../src/engine/runner");
let control: typeof import("../src/tenants/control");
let wizards: typeof import("../src/services/wizards");
let env: typeof import("../src/env").env;
let noteOf: typeof import("../src/model-errors").noteOf;

const T = "tenant-durable-line";

const result = { id: "done", type: "result", title: "Fertig", deliverables: [] };

const working = {
  version: 1,
  title: "Line",
  description: "",
  avatar: "round",
  steps: [
    {
      id: "work",
      type: "agent",
      title: "Work",
      instructions: "Do it.",
      tools: [],
      output: { format: "text" },
    },
    result,
  ],
};

const asking = {
  version: 1,
  title: "Question",
  description: "",
  avatar: "round",
  steps: [
    {
      id: "start",
      type: "form",
      title: "Start",
      fields: [{ id: "name", kind: "text", label: "Name" }],
    },
    result,
  ],
};

async function until(ok: () => boolean | Promise<boolean>, ms = 6000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok()) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

const newRun = (definition: unknown = working) =>
  client.withTenant(T, async () => {
    const created = await wizards.createWizard("u", { definition: definition as never });
    const w = await wizards.ownedWizard("u", created.id);
    return runner.createRun({
      wizardId: w.id,
      definition: w.draft,
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

const line = (id: string) =>
  client.controlDb.query.runIndex.findFirst({ where: eq(client.control.runIndex.runId, id) });

const isDone = (id: string) => async () => (await row(id))?.status === "done";

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  runner = await import("../src/engine/runner");
  control = await import("../src/tenants/control");
  wizards = await import("../src/services/wizards");
  env = (await import("../src/env")).env;
  noteOf = (await import("../src/model-errors")).noteOf;
  runner.startRunner();
});

afterAll(async () => {
  for (const release of finish.values()) {
    release();
  }
  await runner.stopRunner();
});

describe("the line, as the cloud runs it", () => {
  it("a long step does not hold up the next run", async () => {
    const a = await newRun();
    const b = await newRun();
    // Both are in line; the runner's look has to reach both while the first still works.
    expect(await until(() => started.has(a) && started.has(b))).toBe(true);
    finish.get(a)?.();
    finish.get(b)?.();
    expect(await until(isDone(a))).toBe(true);
    expect(await until(isDone(b))).toBe(true);
  });

  it("RUNNER_MAX_RUNS leaves a run in line, through a look and through a kick", async () => {
    const { maxRuns } = env.runner;
    env.runner.maxRuns = 1;
    // A kick takes a run at once in a process that is a runner.
    env.serves.runner = true;
    try {
      const [a, b] = await Promise.all([newRun(), newRun()]);
      expect(await until(() => started.has(a) || started.has(b))).toBe(true);
      const [driven, waiting] = started.has(a) ? [a, b] : [b, a];
      // Long enough for the runner's next look too.
      await new Promise((r) => setTimeout(r, 2500));
      expect(started.has(waiting)).toBe(false);
      expect(await line(waiting)).toMatchObject({ active: true, owner: null });
      // The slot comes free: the run that waited is next.
      finish.get(driven)?.();
      expect(await until(() => started.has(waiting))).toBe(true);
      finish.get(waiting)?.();
      expect(await until(isDone(driven))).toBe(true);
      expect(await until(isDone(waiting))).toBe(true);
    } finally {
      env.runner.maxRuns = maxRuns;
      env.serves.runner = false;
    }
  });

  it("a wake that comes just before a run rests is not lost", async () => {
    const r = await newRun();
    expect(await until(() => started.has(r))).toBe(true);
    // A person's answer in another process wakes the run while its owner finishes the step.
    await control.wakeRun(r);
    // The owner finishes and rests the run, as a drive does at its end.
    await control.restRun(r);
    expect((await line(r))?.active).toBe(true);
    finish.get(r)?.();
    expect(await until(isDone(r))).toBe(true);
  });

  it("a runner that lost its claim does not write over the new owner", async () => {
    const r = await newRun();
    expect(await until(() => started.has(r))).toBe(true);
    // This runner hung past the takeover: another took the run and already moved it on.
    const moved = { values: { by: "new owner" }, outputs: {}, history: [], notes: {} };
    await client.controlDb
      .update(client.control.runIndex)
      .set({ owner: "another-runner", seen: new Date() })
      .where(eq(client.control.runIndex.runId, r));
    await client.withTenant(T, () =>
      client.db
        .update(client.schema.run)
        .set({ state: moved, claim: 999 })
        .where(eq(client.schema.run.id, r)),
    );
    // Now the old owner wakes up and its step ends.
    finish.get(r)?.();
    await new Promise((res) => setTimeout(res, 400));
    const after = await row(r);
    expect(after?.state.values).toEqual({ by: "new owner" });
    expect(after?.state.outputs).toEqual({});
    // The drive ended quietly: the run is not failed, and the new owner still has it.
    expect(after).toMatchObject({ status: "running", error: null });
    expect((await line(r))?.owner).toBe("another-runner");
    // Out of the way of the other tests: nobody really owns it.
    await client.controlDb
      .update(client.control.runIndex)
      .set({ active: false, owner: null, seen: null })
      .where(eq(client.control.runIndex.runId, r));
  });

  it("the heartbeat stops a step when a newer claim is on the row", async () => {
    const r = await newRun();
    expect(await until(() => finish.has(r))).toBe(true);
    await client.controlDb
      .update(client.control.runIndex)
      .set({ owner: "another-runner", seen: new Date() })
      .where(eq(client.control.runIndex.runId, r));
    await client.withTenant(T, () =>
      client.db.update(client.schema.run).set({ claim: 999 }).where(eq(client.schema.run.id, r)),
    );
    expect(await until(() => signals.get(r)?.aborted === true, 12_000)).toBe(true);
    finish.get(r)?.();
    await client.controlDb
      .update(client.control.runIndex)
      .set({ active: false, owner: null, seen: null })
      .where(eq(client.control.runIndex.runId, r));
  }, 15_000);

  it("a run holding a slot past an hour is reported once, and goes on", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // The heartbeat's timer and clock only: the database and this test's waits stay real.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      const r = await newRun();
      expect(await until(() => finish.has(r))).toBe(true);
      const reports = () => warn.mock.calls.filter(([line]) => String(line).includes("held a slot"));
      const settled = () => new Promise((res) => setTimeout(res, 300));
      vi.advanceTimersByTime(59 * 60_000);
      await settled();
      expect(reports()).toEqual([]);
      vi.advanceTimersByTime(2 * 60_000);
      expect(await until(() => reports().length > 0)).toBe(true);
      vi.advanceTimersByTime(60 * 60_000);
      await settled();
      expect(reports()).toHaveLength(1);
      const line = String(reports()[0][0]);
      expect(line).toContain(r);
      expect(line).toContain(T);
      expect(line).toContain("step work (agent)");
      // Only a report: the step still works and the run still finishes.
      expect(signals.get(r)?.aborted).toBe(false);
      finish.get(r)?.();
      expect(await until(isDone(r))).toBe(true);
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  it("a step that answers another run is not held to its own claim", async () => {
    const page = await newRun(asking);
    const r = await newRun();
    let answered: unknown;
    during.set(r, async () => {
      answered = await runner.submitPage(page, "start", { name: "Ada" }).then(
        () => "ok",
        (err) => err,
      );
    });
    expect(await until(() => finish.has(r))).toBe(true);
    expect(answered).toBe("ok");
    expect(await until(isDone(page))).toBe(true);
    finish.get(r)?.();
    expect(await until(isDone(r))).toBe(true);
  });
});

describe("a person's write", () => {
  it("of two people answering at once, the second gets runBusy", async () => {
    const r = await newRun(asking);
    const answers = await client.withTenant(T, () =>
      Promise.allSettled([
        runner.submitPage(r, "start", { name: "Ada" }),
        runner.submitPage(r, "start", { name: "Grace" }),
      ]),
    );
    const refused = answers.filter((a) => a.status === "rejected");
    expect(answers.filter((a) => a.status === "fulfilled")).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(noteOf((refused[0] as PromiseRejectedResult).reason)).toEqual({ code: "runBusy" });
    // One answer stands, once.
    expect((await row(r))?.state.history).toEqual(["start"]);
    expect(await until(isDone(r))).toBe(true);
  });

  it("outside the commands needs the rev it read too", async () => {
    const r = await newRun(asking);
    const read = await row(r);
    if (!read) {
      throw new Error("run missing");
    }
    const state = { ...read.state, notes: { start: "seen" } };
    await client.withTenant(T, async () => {
      expect(await runner.writeRunState(read, state)).toBe(true);
      expect(await runner.writeRunState(read, { ...read.state, notes: {} })).toBe(false);
    });
    expect(await row(r)).toMatchObject({ state: { notes: { start: "seen" } }, rev: 1 });
  });
});
