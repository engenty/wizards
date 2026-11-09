import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSchema, type WizardStart } from "@engenty/wizards-shared/starts";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// One process with the clock and a runner's look on the line; two runners are two looks at once.
const dir = mkdtempSync(join(tmpdir(), "wizards-starts-clock-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.RUNTIME_ROLE = "doors";
process.env.FEATURES = "startTriggers=on";

/** Steps that work until the test lets them finish. */
const finish = new Map<string, () => void>();
vi.mock("../src/engine/steps.js", async (original) => ({
  ...(await original<typeof import("../src/engine/steps.js")>()),
  runAutomaticStep: async (_step: unknown, ctx: { runId: string }) => {
    await new Promise<void>((res) => finish.set(ctx.runId, res));
    return { text: "made", at: new Date().toISOString() };
  },
}));

vi.mock("../src/engine/requirements.js", async (original) => ({
  ...(await original<typeof import("../src/engine/requirements.js")>()),
  missingModelsSaid: async () => [],
}));

/** What the credits saw: a run that lost its time must give its hold back. */
const reserved: string[] = [];
const released: string[] = [];
vi.mock("../src/credits/credits.js", async (original) => {
  const real = await original<typeof import("../src/credits/credits.js")>();
  return {
    ...real,
    reserveForRun: async (id: string) => {
      reserved.push(id);
      return true;
    },
    releaseRun: async (id: string) => {
      released.push(id);
    },
  };
});

let client: typeof import("../src/db/client");
let runner: typeof import("../src/engine/runner");
let wizards: typeof import("../src/services/wizards");
let startsService: typeof import("../src/services/starts");
let clock: typeof import("../src/engine/starts");
let notices: typeof import("../src/engine/notices");

const T = "tenant-starts-clock";
const USER = "u";

const result = { id: "done", type: "result", title: "Fertig", deliverables: [] };
const work = {
  id: "work",
  type: "agent",
  title: "Work",
  instructions: "Do it.",
  tools: [],
  output: { format: "text" },
};

const working = {
  version: 1,
  title: "Working",
  description: "",
  avatar: "round",
  steps: [work, result],
};

const asking = {
  version: 1,
  title: "Asking",
  description: "",
  avatar: "round",
  steps: [
    {
      id: "first",
      type: "form",
      title: "First",
      fields: [{ id: "name", kind: "text", label: "Name", required: true }],
    },
    work,
    result,
  ],
};

const weekly = { every: "week", weekday: 1, time: "09:00", tz: "Europe/Vienna" };

/** A published wizard with one start, as the clock last left it at `handledUntil`. */
async function wizardWith(
  schedule: Record<string, unknown>,
  handledUntil: string,
  options: { definition?: unknown; start?: Record<string, unknown> } = {},
) {
  return client.withTenant(T, async () => {
    const created = await wizards.createWizard(USER, {
      definition: (options.definition ?? working) as never,
    });
    await wizards.publishWizard(USER, created.id);
    const start = startSchema.parse({
      id: `s-${created.id}`,
      kind: "schedule",
      owner: USER,
      schedule,
      handledUntil,
      ...options.start,
    });
    await client.db
      .update(client.schema.wizard)
      .set({ starts: [start] })
      .where(eq(client.schema.wizard.id, created.id));
    return { wizardId: created.id, startId: start.id };
  });
}

const runsOf = (wizardId: string) =>
  client.withTenant(T, () =>
    client.db.query.run.findMany({ where: eq(client.schema.run.wizardId, wizardId) }),
  );

const startOf = async (wizardId: string): Promise<WizardStart> =>
  client.withTenant(T, async () => {
    const w = await wizards.ownedWizard(USER, wizardId);
    return w.starts[0] as WizardStart;
  });

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

const finished = (runId: string) => async () => {
  const release = finish.get(runId);
  if (release) {
    release();
    finish.delete(runId);
  }
  const row = await client.withTenant(T, () =>
    client.db.query.run.findFirst({ where: eq(client.schema.run.id, runId) }),
  );
  return row?.status === "done";
};

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb(T);
  // Steps here stay at work on purpose: they must not fill the line for the next test.
  const { env } = await import("../src/env");
  env.limits.concurrentRuns = 1000;
  env.runner.maxRuns = 1000;
  runner = await import("../src/engine/runner");
  wizards = await import("../src/services/wizards");
  startsService = await import("../src/services/starts");
  clock = await import("../src/engine/starts");
  notices = await import("../src/engine/notices");
  runner.startRunner();
}, 60_000);

beforeEach(() => {
  reserved.length = 0;
  released.length = 0;
});

afterAll(async () => {
  for (const release of finish.values()) {
    release();
  }
  await runner?.stopRunner();
});

describe("one time, one run", () => {
  it("two runners looking at the same moment begin one run", async () => {
    const { wizardId } = await wizardWith(weekly, "2026-10-01T00:00:00.000Z");
    const now = new Date("2026-10-12T07:00:10Z");
    await Promise.all([clock.runDueSchedules(now), clock.runDueSchedules(now)]);
    const runs = await runsOf(wizardId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.occurrence).toContain("@2026-10-12T07:00:00.000Z");
    const start = await startOf(wizardId);
    expect(start.handledUntil).toBe("2026-10-12T07:00:00.000Z");
    expect(start.lastRunAt).toBe("2026-10-12T07:00:00.000Z");
    expect(start.lastSkip).toBeUndefined();
    // A runner that got as far as a hold gave it back.
    const lost = reserved.filter((id) => id !== runs[0]?.id);
    expect(released.filter((id) => lost.includes(id))).toEqual(lost);
    // A later look at the same time does nothing.
    await clock.runDueSchedules(new Date("2026-10-12T07:01:10Z"));
    expect(await runsOf(wizardId)).toHaveLength(1);
  });

  it("a crash between the run and the write leaves one run", async () => {
    const { wizardId, startId } = await wizardWith(weekly, "2026-10-01T00:00:00.000Z");
    const at = new Date("2026-10-12T07:00:00.000Z");
    // The process got this far: the run exists, the start still says the old time.
    const first = await client.withTenant(T, async () => {
      const w = await wizards.ownedWizard(USER, wizardId);
      const version = await wizards.publishedVersion(w);
      return runner.createRun({
        wizardId,
        definition: version?.definition as never,
        files: [],
        version: w.publishedVersion,
        mode: "live",
        userId: USER,
        startedBy: { kind: "schedule", startId },
        start: { kind: "schedule", at: at.toISOString() },
        occurrence: `${startId}@${at.toISOString()}`,
      });
    });
    expect((await startOf(wizardId)).handledUntil).toBe("2026-10-01T00:00:00.000Z");
    await clock.runDueSchedules(new Date("2026-10-12T07:01:00Z"));
    const runs = await runsOf(wizardId);
    expect(runs.map((r) => r.id)).toEqual([first]);
    const start = await startOf(wizardId);
    expect(start.handledUntil).toBe(at.toISOString());
    expect(start.lastRunAt).toBe(at.toISOString());
    // Its own run is not an overlap.
    expect(start.lastSkip).toBeUndefined();
  });

  it("the database refuses a second run of a time", async () => {
    const { wizardId, startId } = await wizardWith(weekly, "2026-10-01T00:00:00.000Z");
    const create = () =>
      client.withTenant(T, async () => {
        const w = await wizards.ownedWizard(USER, wizardId);
        return runner.createRun({
          wizardId,
          definition: w.draft,
          files: [],
          version: null,
          mode: "live",
          userId: USER,
          startedBy: { kind: "schedule", startId },
          occurrence: "the-same-time",
        });
      });
    const winner = await create();
    await expect(create()).rejects.toBeInstanceOf(runner.OccurrenceTaken);
    expect((await runsOf(wizardId)).map((r) => r.id)).toEqual([winner]);
    // Without a time there is no limit: a person's runs and "try it now".
    await client.withTenant(T, async () => {
      const w = await wizards.ownedWizard(USER, wizardId);
      for (let i = 0; i < 2; i++) {
        await runner.createRun({
          wizardId,
          definition: w.draft,
          files: [],
          version: null,
          mode: "test",
          userId: USER,
        });
      }
    });
    expect(await runsOf(wizardId)).toHaveLength(3);
  });
});

describe("overlap", () => {
  it("skip leaves a time out while the last run is going, then goes on", async () => {
    const { wizardId } = await wizardWith(weekly, "2026-10-01T00:00:00.000Z");
    await clock.runDueSchedules(new Date("2026-10-12T07:00:10Z"));
    const [run] = await runsOf(wizardId);
    expect(run).toBeTruthy();

    await clock.runDueSchedules(new Date("2026-10-19T07:00:10Z"));
    expect(await runsOf(wizardId)).toHaveLength(1);
    const skipped = await startOf(wizardId);
    expect(skipped.lastSkip).toEqual({ at: "2026-10-19T07:00:00.000Z", why: "overlap" });
    expect(skipped.handledUntil).toBe("2026-10-19T07:00:00.000Z");

    expect(await until(finished(run?.id as string))).toBe(true);
    await clock.runDueSchedules(new Date("2026-10-26T08:00:10Z"));
    expect(await runsOf(wizardId)).toHaveLength(2);
    expect((await startOf(wizardId)).lastSkip).toBeUndefined();
  });

  it("a run that waits for a person counts as going", async () => {
    const { wizardId } = await wizardWith(weekly, "2026-10-01T00:00:00.000Z", {
      definition: asking,
    });
    await clock.runDueSchedules(new Date("2026-10-12T07:00:10Z"));
    expect(
      await until(async () => (await runsOf(wizardId))[0]?.status === "waiting_input"),
    ).toBe(true);
    await clock.runDueSchedules(new Date("2026-10-19T07:00:10Z"));
    expect(await runsOf(wizardId)).toHaveLength(1);
    expect((await startOf(wizardId)).lastSkip?.why).toBe("overlap");
  });

  it("allow starts the next run anyway", async () => {
    const { wizardId } = await wizardWith(
      { ...weekly, overlap: "allow" },
      "2026-10-01T00:00:00.000Z",
    );
    await clock.runDueSchedules(new Date("2026-10-12T07:00:10Z"));
    await clock.runDueSchedules(new Date("2026-10-19T07:00:10Z"));
    expect(await runsOf(wizardId)).toHaveLength(2);
  });
});

describe("lateness", () => {
  it("a week closed fires the latest time once, inside the limit", async () => {
    const { wizardId } = await wizardWith(
      { every: "day", time: "09:00", tz: "Europe/Vienna" },
      "2026-10-05T07:00:00.000Z",
    );
    await clock.runDueSchedules(new Date("2026-10-12T09:30:00Z"));
    const runs = await runsOf(wizardId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.occurrence).toContain("@2026-10-12T07:00:00.000Z");
    expect(runs[0]?.state.start?.at).toBe("2026-10-12T07:00:00.000Z");
  });

  it("a time past the limit does not start, and says so once", async () => {
    const { wizardId } = await wizardWith(
      { ...weekly, maxLateMinutes: 60 },
      "2026-10-01T00:00:00.000Z",
    );
    const now = new Date("2026-10-12T08:00:01Z");
    await clock.runDueSchedules(now);
    expect(await runsOf(wizardId)).toHaveLength(0);
    const start = await startOf(wizardId);
    expect(start.lastSkip).toEqual({ at: "2026-10-12T07:00:00.000Z", why: "late" });
    expect(start.handledUntil).toBe("2026-10-12T07:00:00.000Z");
    expect(start.failures).toBe(0);
    await clock.runDueSchedules(new Date("2026-10-12T08:01:00Z"));
    expect(await runsOf(wizardId)).toHaveLength(0);
    // Inside the limit one minute earlier it would have started: the next time does.
    await clock.runDueSchedules(new Date("2026-10-19T07:30:00Z"));
    expect(await runsOf(wizardId)).toHaveLength(1);
  });
});

describe("daylight saving in Europe/Vienna, on the clock", () => {
  /** A look every 15 minutes through the night the clocks change. */
  async function throughTheNight(wizardId: string, from: string, to: string) {
    const end = new Date(to).getTime();
    for (let t = new Date(from).getTime(); t <= end; t += 15 * 60_000) {
      await clock.runDueSchedules(new Date(t));
    }
  }

  it("a time the clocks show twice starts one run", async () => {
    const { wizardId } = await wizardWith(
      { every: "day", time: "02:30", tz: "Europe/Vienna" },
      "2026-10-24T22:00:00.000Z",
    );
    await throughTheNight(wizardId, "2026-10-24T23:00:00Z", "2026-10-25T03:00:00Z");
    const runs = await runsOf(wizardId);
    expect(runs.map((r) => r.occurrence?.split("@")[1])).toEqual(["2026-10-25T01:30:00.000Z"]);
  });

  it("a time the clocks skip starts one run, just after the gap", async () => {
    const { wizardId } = await wizardWith(
      { every: "day", time: "02:30", tz: "Europe/Vienna" },
      "2026-03-28T22:00:00.000Z",
    );
    await throughTheNight(wizardId, "2026-03-28T23:00:00Z", "2026-03-29T03:00:00Z");
    const runs = await runsOf(wizardId);
    expect(runs.map((r) => r.occurrence?.split("@")[1])).toEqual(["2026-03-29T01:30:00.000Z"]);
  });
});

describe("what a started run does", () => {
  it("a start's answers fill the page, and the owner hears it is done", async () => {
    const { wizardId, startId } = await wizardWith(weekly, "2026-10-01T00:00:00.000Z", {
      definition: asking,
      start: { answers: { name: "Ada" } },
    });
    await clock.runDueSchedules(new Date("2026-10-12T07:00:10Z"));
    const [run] = await runsOf(wizardId);
    expect(await until(finished(run?.id as string))).toBe(true);
    const [after] = await runsOf(wizardId);
    expect(after?.state.values.name).toBe("Ada");
    expect(after?.startedBy).toEqual({ kind: "schedule", startId });
    expect(
      await until(async () =>
        (
          await client.withTenant(T, () => notices.listNotices(USER))
        ).some((n) => n.runId === run?.id && n.kind === "done"),
      ),
    ).toBe(true);
  });

  it("a required field without a value waits and tells the owner", async () => {
    const { wizardId } = await wizardWith(weekly, "2026-10-01T00:00:00.000Z", {
      definition: asking,
    });
    await clock.runDueSchedules(new Date("2026-10-12T07:00:10Z"));
    const [run] = await runsOf(wizardId);
    expect(
      await until(async () =>
        (
          await client.withTenant(T, () => notices.listNotices(USER))
        ).some((n) => n.runId === run?.id && n.kind === "needs_you"),
      ),
    ).toBe(true);
    expect((await runsOf(wizardId))[0]?.status).toBe("waiting_input");
  });

  it("three times that cannot start pause it, one failure per time", async () => {
    const { wizardId } = await wizardWith(weekly, "2026-10-01T00:00:00.000Z");
    await client.withTenant(T, () =>
      client.db
        .update(client.schema.wizard)
        .set({ shareEnabled: false })
        .where(eq(client.schema.wizard.id, wizardId)),
    );
    await clock.runDueSchedules(new Date("2026-10-12T07:00:10Z"));
    // The same time looked at again counts no second failure.
    await clock.runDueSchedules(new Date("2026-10-12T07:01:10Z"));
    expect((await startOf(wizardId)).failures).toBe(1);
    await clock.runDueSchedules(new Date("2026-10-19T07:00:10Z"));
    await clock.runDueSchedules(new Date("2026-10-26T08:00:10Z"));
    const start = await startOf(wizardId);
    expect(start.failures).toBe(3);
    expect(start.on).toBe(false);
    expect(start.pausedReason).toBeTruthy();
    expect(await runsOf(wizardId)).toHaveLength(0);
    const list = await client.withTenant(T, () => notices.listNotices(USER));
    expect(list.some((n) => n.wizard.id === wizardId && n.kind === "paused")).toBe(true);
    // Paused, the clock leaves it alone.
    await clock.runDueSchedules(new Date("2026-11-02T08:00:10Z"));
    expect((await startOf(wizardId)).handledUntil).toBe("2026-10-26T08:00:00.000Z");
  });
});

describe("setStarts", () => {
  const input = (over: Record<string, unknown> = {}) => ({
    id: "new-1",
    kind: "schedule",
    schedule: weekly,
    ...over,
  });

  const saved = async () => {
    const created = await client.withTenant(T, () =>
      wizards.createWizard(USER, { definition: working as never }),
    );
    const [start] = await client.withTenant(T, () =>
      startsService.setStarts(USER, created.id, [input()]),
    );
    return { wizardId: created.id, start: start as WizardStart };
  };

  it("makes a start that waits for its first time and takes nothing from the caller's clock", async () => {
    const before = Date.now();
    const { wizardId, start } = await saved();
    expect(start.id).not.toBe("new-1");
    expect(start.owner).toBe(USER);
    expect(start.schedule?.overlap).toBe("skip");
    expect(new Date(start.handledUntil as string).getTime()).toBeGreaterThanOrEqual(before);
    const [again] = await client.withTenant(T, () =>
      startsService.setStarts(USER, wizardId, [
        {
          ...start,
          handledUntil: "2020-01-01T00:00:00.000Z",
          lastRunAt: "2020-01-01T00:00:00.000Z",
          owner: "someone-else",
          failures: 2,
          schedule: { ...start.schedule, overlap: "allow" },
        },
      ]),
    );
    expect(again?.owner).toBe(USER);
    expect(again?.handledUntil).toBe(start.handledUntil);
    expect(again?.lastRunAt).toBeUndefined();
    expect(again?.failures).toBe(0);
    expect(again?.schedule?.overlap).toBe("allow");
  });

  it("a time changed or a start switched on again does not fire what passed before", async () => {
    const { wizardId, start } = await saved();
    await client.withTenant(T, () =>
      clock.changeStarts(wizardId, (all) =>
        all.map((s) => ({
          ...s,
          on: false,
          failures: 3,
          pausedReason: "no",
          handledUntil: "2020-01-01T00:00:00.000Z",
        })),
      ),
    );
    const [on] = await client.withTenant(T, () =>
      startsService.setStarts(USER, wizardId, [{ ...start, on: true }]),
    );
    expect(on?.handledUntil).not.toBe("2020-01-01T00:00:00.000Z");
    expect(on?.failures).toBe(0);
    expect(on?.pausedReason).toBeUndefined();
    await client.withTenant(T, () =>
      clock.changeStarts(wizardId, (all) =>
        all.map((s) => ({ ...s, handledUntil: "2020-01-01T00:00:00.000Z" })),
      ),
    );
    const [moved] = await client.withTenant(T, () =>
      startsService.setStarts(USER, wizardId, [
        { ...start, schedule: { ...start.schedule, time: "10:00" } },
      ]),
    );
    expect(moved?.handledUntil).not.toBe("2020-01-01T00:00:00.000Z");
  });

  it("a write of the clock and a person's write don't undo each other", async () => {
    const { wizardId, start } = await saved();
    await client.withTenant(T, () =>
      Promise.all([
        clock.changeStarts(wizardId, (all) =>
          all.map((s) => ({ ...s, lastRunAt: "2026-10-12T07:00:00.000Z" })),
        ),
        startsService.setStarts(USER, wizardId, [{ ...start, allowChanges: true }]),
      ]),
    );
    const [after] = await client.withTenant(T, () => startsService.listStarts(USER, wizardId));
    expect(after?.allowChanges).toBe(true);
    expect(after?.lastRunAt).toBe("2026-10-12T07:00:00.000Z");
  });

  it("refuses a field the wizard does not have", async () => {
    const created = await client.withTenant(T, () =>
      wizards.createWizard(USER, { definition: working as never }),
    );
    await expect(
      client.withTenant(T, () =>
        startsService.setStarts(USER, created.id, [input({ answers: { nope: 1 } })]),
      ),
    ).rejects.toThrow(/no field/);
  });
});

describe("the switch", () => {
  it("does nothing for a tenant with starts switched off", async () => {
    const { wizardId } = await wizardWith(weekly, "2026-10-01T00:00:00.000Z");
    process.env.FEATURES = "startTriggers=off";
    try {
      await clock.runDueSchedules(new Date("2026-10-12T07:00:10Z"));
    } finally {
      process.env.FEATURES = "startTriggers=on";
    }
    expect(await runsOf(wizardId)).toHaveLength(0);
    await expect(
      (async () => {
        process.env.FEATURES = "startTriggers=off";
        try {
          await client.withTenant(T, () => startsService.setStarts(USER, wizardId, []));
        } finally {
          process.env.FEATURES = "startTriggers=on";
        }
      })(),
    ).rejects.toThrow(/not switched on/);
  });
});

// The unique index itself, without createRun in between.
describe("the index", () => {
  it("is on the wizard and the time", async () => {
    const indexes = await client.withTenant(T, async () => {
      const db = await client.tenantClient(T);
      return db.execute("PRAGMA index_info('run_occurrence')");
    });
    expect(indexes.rows.map((r) => r.name)).toEqual(["wizard_id", "occurrence"]);
  });
});
