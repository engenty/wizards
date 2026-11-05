import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateWizard, wizardSchema } from "@engenty/wizards-shared/definition";
import { noteText } from "@engenty/wizards-shared/run";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "wizards-run-timeline-"));
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
vi.mock("../src/engine/steps.js", async (original) => ({
  ...(await original<typeof import("../src/engine/steps.js")>()),
  runAutomaticStep: async (step: { id: string }, ctx: { runId: string }) => {
    worked.push({ run: ctx.runId, step: step.id });
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
const hold = vi.hoisted(() => ({
  answer: true as boolean,
  during: null as (() => Promise<unknown>) | null,
}));
vi.mock("../src/credits/credits.js", async (original) => ({
  ...(await original<typeof import("../src/credits/credits.js")>()),
  reserveForRun: async () => {
    const during = hold.during;
    hold.during = null;
    await during?.();
    return hold.answer;
  },
  releaseRun: async () => undefined,
}));
/** Who is signed in, for the routes: null is nobody. */
const who = vi.hoisted(() => ({
  user: null as null | { id: string; tenantId: string; role: string; name: string; email: string },
}));
vi.mock("../src/auth/index.js", async (original) => ({
  ...(await original<typeof import("../src/auth/index.js")>()),
  principalOf: async () => who.user,
}));

let client: typeof import("../src/db/client");
let runner: typeof import("../src/engine/runner");
let events: typeof import("../src/engine/events");
let template: typeof import("../src/engine/template");
let wizards: typeof import("../src/services/wizards");
let services: typeof import("../src/services/runs");
let routes: typeof import("../src/routes/runs");

const T = "local";
const agent = (id: string) => ({
  id,
  type: "agent",
  title: id,
  instructions: "Do it.",
  tools: [],
  output: { format: "text" },
});
const pause = { id: "pause", type: "wait", title: "Pause", for: "2d" };
const end = { id: "done", type: "result", title: "Fertig", deliverables: [] };
const page = {
  id: "ask",
  type: "page",
  title: "Kunde",
  fields: [
    { id: "kunde", kind: "text", label: "Kunde" },
    { id: "angebot", kind: "text", label: "Angebot", required: false },
  ],
};
const base = { version: 2, title: "Timeline", description: "", avatar: "round" };

let wizardId = "";
const start = (steps: unknown[], more: object = {}) =>
  client.withTenant(T, async () => {
    wizardId ||= (
      await wizards.createWizard("u", {
        definition: { ...base, steps: [agent("seed"), end] } as never,
      })
    ).id;
    return runner.createRun({
      wizardId,
      definition: { ...base, steps, ...more } as never,
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
const log = (id: string) =>
  client.withTenant(T, () =>
    client.db
      .select()
      .from(client.schema.runEvent)
      .where(eq(client.schema.runEvent.runId, id))
      .orderBy(asc(client.schema.runEvent.id)),
  );
const count = async (id: string, type: string) =>
  (await log(id)).filter((e) => e.type === type).length;
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
const rests = (id: string) =>
  until(async () => {
    const l = await line(id);
    return (await row(id))?.status === "sleeping" && l?.active === false && l.owner === null;
  });
/** Someone other than "u", who starts the runs here, unless `id` says it. */
const as = (role: string, id = "someone") => {
  who.user = { id, tenantId: T, role, name: "Lena Berger", email: "lena@example.com" };
};
const post = (id: string, what: string) =>
  routes.runRoutes.request(`/${id}/${what}`, { method: "POST" });
const timeline = (id: string) => routes.runRoutes.request(`/${id}/timeline`);

/**
 * A run as a runner that died left it: at work, its drive never reached a rest, nobody holds it.
 * `at`: the step it was on; `started`, whether that step's visit has begun in the log.
 */
async function leftByCrash(id: string, at: string, started: boolean) {
  await client.withTenant(T, async () => {
    if (started) {
      await events.emitEvent(id, at, "step_started", at);
    }
    await client.db
      .update(client.schema.run)
      .set({ status: "running", cursor: at, driving: true })
      .where(eq(client.schema.run.id, id));
  });
}

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  runner = await import("../src/engine/runner");
  events = await import("../src/engine/events");
  template = await import("../src/engine/template");
  wizards = await import("../src/services/wizards");
  services = await import("../src/services/runs");
  routes = await import("../src/routes/runs");
  runner.startRunner();
});
afterAll(() => runner.stopRunner());

describe("the log of a run", () => {
  it("says it started, that it waits and until when, what woke it, and each step's end", async () => {
    const id = await start([agent("before"), pause, agent("after"), end]);
    expect(await rests(id)).toBe(true);
    await client.withTenant(T, () =>
      client.db
        .update(client.schema.run)
        .set({ wakeAt: new Date(Date.now() - 1000) })
        .where(eq(client.schema.run.id, id)),
    );
    await client.controlDb
      .update(client.control.runIndex)
      .set({ wakeAt: new Date(Date.now() - 1000) })
      .where(eq(client.control.runIndex.runId, id));
    expect(await hasStatus(id, "done")).toBe(true);

    const lines = await log(id);
    expect(lines[0].type).toBe("run_started");
    expect(lines.map((l) => `${l.type}:${l.stepId ?? ""}`)).toEqual(
      expect.arrayContaining([
        "wait:pause",
        "woken:pause",
        "step_done:pause",
        "step_done:before",
        "step_done:after",
      ]),
    );
    const wait = lines.find((l) => l.type === "wait");
    // A time in the note, written out for the one who reads it.
    expect(wait?.note?.params?.until).toEqual({ at: expect.any(String) });
    expect(noteText(wait?.note as never, "de")).toMatch(/^wartet bis \S+, \d+\. /);
    expect(noteText(lines.find((l) => l.type === "woken")?.note as never, "de")).toBe(
      "Die Wartezeit ist vorbei",
    );
  });
});

describe("Continue now", () => {
  it("sets the wake time to now in both copies, and the run goes on", async () => {
    const id = await start([pause, agent("after"), end]);
    expect(await rests(id)).toBe(true);
    const before = await row(id);
    expect(before?.wakeAt?.getTime()).toBe((await line(id))?.wakeAt?.getTime());

    await client.withTenant(T, () => runner.wakeNow(id, "Lena Berger"));
    expect(await hasStatus(id, "done")).toBe(true);
    expect(worked.filter((w) => w.run === id).map((w) => w.step)).toEqual(["after"]);
    expect((await row(id))?.wakeAt).toBeNull();
    // Nothing left for the clock to wake it with.
    expect((await line(id))?.wakeAt).toBeNull();

    const woken = (await log(id)).filter((e) => e.type === "woken");
    expect(woken).toHaveLength(1);
    expect(noteText(woken[0].note as never, "de")).toBe(
      "Lena Berger hat „Jetzt weitermachen“ gewählt",
    );
  });

  it("writes the time to both copies before the run moves", async () => {
    // Holding the wake in its reservation shows the row and the line as the command left them.
    const id = await start([pause, agent("after"), end]);
    expect(await rests(id)).toBe(true);
    const asleepUntil = (await row(id))?.wakeAt?.getTime() ?? 0;
    let seen: { row?: number; left?: number } = {};
    hold.during = async () => {
      seen = {
        row: (await row(id))?.wakeAt?.getTime(),
        left: (await line(id))?.wakeAt?.getTime() ?? 0,
      };
    };
    await client.withTenant(T, () => runner.wakeNow(id, "Lena"));
    expect(await hasStatus(id, "done")).toBe(true);
    expect(seen.row).toBeLessThan(asleepUntil);
    expect(seen.row).toBeLessThanOrEqual(Date.now());
    // The clock's statement has taken the control copy on: it holds no time from before.
    expect(seen.left).toBe(0);
  });

  it("refuses a run that no longer sleeps", async () => {
    const done = await start([agent("only"), end]);
    expect(await hasStatus(done, "done")).toBe(true);
    await expect(client.withTenant(T, () => runner.wakeNow(done, "Lena"))).rejects.toMatchObject({
      note: { code: "runMovedOn" },
    });
    expect(await count(done, "woken")).toBe(0);

    const asks = await start([page, end]);
    await expect(client.withTenant(T, () => runner.wakeNow(asks, "Lena"))).rejects.toMatchObject({
      note: { code: "runMovedOn" },
    });
  });

  it("refuses a wait whose time has come", async () => {
    const id = await start([pause, end]);
    expect(await rests(id)).toBe(true);
    // Only the row: the clock would go on from the control copy.
    await client.withTenant(T, () =>
      client.db
        .update(client.schema.run)
        .set({ wakeAt: new Date(Date.now() - 1000) })
        .where(eq(client.schema.run.id, id)),
    );
    await expect(client.withTenant(T, () => runner.wakeNow(id, "Lena"))).rejects.toMatchObject({
      note: { code: "runMovedOn" },
    });
    expect(await count(id, "woken")).toBe(0);
    await client.withTenant(T, () => runner.cancel(id));
  });

  it("two at once: one goes through, the other is refused", async () => {
    const id = await start([pause, end]);
    expect(await rests(id)).toBe(true);
    const results = await Promise.allSettled([
      client.withTenant(T, () => runner.wakeNow(id, "Lena")),
      client.withTenant(T, () => runner.wakeNow(id, "Jonas")),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await hasStatus(id, "done")).toBe(true);
    expect(await count(id, "woken")).toBe(1);
  });
});

describe("Stop", () => {
  it("ends a run that sleeps, in both copies, and the clock leaves it", async () => {
    const id = await start([pause, agent("after"), end]);
    expect(await rests(id)).toBe(true);
    await client.withTenant(T, () => runner.stopRun(id, "Lena Berger"));
    expect((await row(id))?.status).toBe("cancelled");
    expect((await row(id))?.wakeAt).toBeNull();
    expect((await line(id))?.wakeAt).toBeNull();
    expect(worked.filter((w) => w.run === id)).toEqual([]);
    const stopped = (await log(id)).filter((e) => e.type === "stopped");
    expect(stopped).toHaveLength(1);
    expect(noteText(stopped[0].note as never, "de")).toBe("Lena Berger hat den Lauf gestoppt");
  });

  it("ends a run that waits for a person", async () => {
    const id = await start([page, end]);
    await client.withTenant(T, () => runner.stopRun(id, "Lena"));
    expect((await row(id))?.status).toBe("cancelled");
  });

  it("refuses a run that has moved on, and writes nothing", async () => {
    const id = await start([agent("only"), end]);
    expect(await hasStatus(id, "done")).toBe(true);
    await expect(client.withTenant(T, () => runner.stopRun(id, "Lena"))).rejects.toMatchObject({
      note: { code: "runMovedOn" },
    });
    expect((await row(id))?.status).toBe("done");
    expect(await count(id, "stopped")).toBe(0);
  });

  it("a stop and a wake at once: only the one that holds on the row as read counts", async () => {
    const id = await start([pause, end]);
    expect(await rests(id)).toBe(true);
    const results = await Promise.allSettled([
      client.withTenant(T, () => runner.stopRun(id, "Lena")),
      client.withTenant(T, () => runner.wakeNow(id, "Jonas")),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const stopped = results[0].status === "fulfilled";
    expect(await hasStatus(id, stopped ? "cancelled" : "done")).toBe(true);
  });
});

describe("the routes", () => {
  it("only the owner and the admins may use the commands", async () => {
    const id = await start([pause, end]);
    expect(await rests(id)).toBe(true);
    for (const role of ["member", "client"]) {
      as(role);
      expect((await post(id, "wake-now")).status, role).not.toBe(200);
      expect((await post(id, "stop")).status, role).not.toBe(200);
    }
    as("member");
    expect((await post(id, "wake-now")).status).toBe(403);
    expect((await post(id, "stop")).status).toBe(403);
    who.user = null;
    expect((await post(id, "wake-now")).status).toBe(404);
    expect((await post(id, "stop")).status).toBe(404);
    expect((await row(id))?.status).toBe("sleeping");

    as("admin");
    expect((await post(id, "wake-now")).status).toBe(200);
    expect(await hasStatus(id, "done")).toBe(true);

    const other = await start([pause, end]);
    expect(await rests(other)).toBe(true);
    as("owner");
    expect((await post(other, "stop")).status).toBe(200);
    expect((await row(other))?.status).toBe("cancelled");
  });

  it("a member may use the commands on a test run they started", async () => {
    const id = await start([pause, end]);
    expect(await rests(id)).toBe(true);
    as("member", "u");
    expect(((await (await timeline(id)).json()) as { canAct: boolean }).canAct).toBe(true);
    expect((await post(id, "wake-now")).status).toBe(200);
    expect(await hasStatus(id, "done")).toBe(true);

    const other = await start([pause, end]);
    expect(await rests(other)).toBe(true);
    expect((await post(other, "stop")).status).toBe(200);
    expect((await row(other))?.status).toBe("cancelled");
  });

  it("a member may not use them on a live run they started", async () => {
    const id = await start([pause, end]);
    expect(await rests(id)).toBe(true);
    await client.withTenant(T, () =>
      client.db
        .update(client.schema.run)
        .set({ mode: "live" })
        .where(eq(client.schema.run.id, id)),
    );
    as("member", "u");
    expect(((await (await timeline(id)).json()) as { canAct: boolean }).canAct).toBe(false);
    expect((await post(id, "wake-now")).status).toBe(403);
    expect((await post(id, "stop")).status).toBe(403);
    expect((await row(id))?.status).toBe("sleeping");

    as("admin");
    expect(((await (await timeline(id)).json()) as { canAct: boolean }).canAct).toBe(true);
    expect((await post(id, "stop")).status).toBe(200);
    expect((await row(id))?.status).toBe("cancelled");
  });

  it("on a wait for a signal: Stop ends it, Continue now brings its deadline forward", async () => {
    const hears = (more: object = {}) => ({
      id: "hears",
      type: "wait",
      title: "Antwort",
      signal: { name: "invoice.paid", key: "k" },
      ...more,
    });
    const listens = (id: string) => until(async () => (await row(id))?.status === "waiting_signal");
    as("owner");

    const open = await start([hears(), end]);
    expect(await listens(open)).toBe(true);
    const seen = (await (await timeline(open)).json()) as { wakeAt: string | null };
    expect(seen.wakeAt).toBeNull();
    expect((await post(open, "wake-now")).status).toBe(409);
    expect((await post(open, "stop")).status).toBe(200);
    expect((await row(open))?.status).toBe("cancelled");

    const timed = await start([
      hears({ signal: { name: "invoice.paid", key: "k", timeout: "2d" } }),
      end,
    ]);
    expect(await listens(timed)).toBe(true);
    expect(((await (await timeline(timed)).json()) as { wakeAt: string | null }).wakeAt).not.toBeNull();
    expect((await post(timed, "wake-now")).status).toBe(200);
    expect(await hasStatus(timed, "done")).toBe(true);
    expect((await row(timed))?.state.outputs.hears?.json).toMatchObject({ timedOut: true });
  });

  it("a refusal is a 409 with what to do, not a failure", async () => {
    const id = await start([agent("only"), end]);
    expect(await hasStatus(id, "done")).toBe(true);
    as("owner");
    for (const what of ["wake-now", "stop"]) {
      const res = await routes.runRoutes.request(`/${id}/${what}`, {
        method: "POST",
        headers: { "accept-language": "de" },
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain("Der Lauf ist schon");
    }
  });

  it("the timeline is for the people of the organization, and says who may act", async () => {
    const id = await start([pause, end], { label: "Hofer" });
    expect(await rests(id)).toBe(true);
    as("member");
    const seen = (await (await timeline(id)).json()) as {
      canAct: boolean;
      status: string;
      steps: unknown[];
      wakeAt: string | null;
      total: number;
      events: unknown[];
    };
    expect(seen.canAct).toBe(false);
    expect(seen.status).toBe("sleeping");
    expect(seen.steps).toHaveLength(2);
    expect(seen.wakeAt).not.toBeNull();
    expect(seen.total).toBe(seen.events.length);
    as("admin");
    expect(((await (await timeline(id)).json()) as { canAct: boolean }).canAct).toBe(true);
    who.user = null;
    expect((await timeline(id)).status).toBe(404);
    await client.withTenant(T, () => runner.cancel(id));
  });
});

describe("the label", () => {
  const scope = (values: Record<string, unknown>) =>
    ({
      def: { ...base, steps: [page, end] },
      state: { values, outputs: {}, history: [], notes: {} },
      brand: {},
    }) as never;

  it("fills from the answers, and an open gap leaves no separator", () => {
    const label = "{{kunde}} · {{angebot}}";
    expect(template.fillLabel(label, scope({ kunde: "Hofer", angebot: "A-1187" }))).toBe(
      "Hofer · A-1187",
    );
    expect(template.fillLabel(label, scope({ kunde: "Hofer" }))).toBe("Hofer");
    expect(template.fillLabel(label, scope({ angebot: "A-1187" }))).toBe("A-1187");
    expect(template.fillLabel(label, scope({}))).toBeNull();
    expect(template.fillLabel("{{a}} · {{b}} · {{c}}", scope({ a: "1", c: "3" }))).toBe("1 · 3");
    expect(
      template.fillLabel("{{kunde}} · {{x}} · {{angebot}}", scope({ kunde: "H", angebot: "A" })),
    ).toBe("H · A");
    expect(template.fillLabel("Angebot {{kunde}}", scope({ kunde: "Hofer" }))).toBe("Angebot Hofer");
    expect(template.fillLabel("Angebot {{kunde}}", scope({}))).toBeNull();
    expect(template.fillLabel("{{kunde}}", scope({ kunde: "x".repeat(500) }))?.length).toBe(200);
  });

  it("is stored on the run as its answers arrive, and a wizard without one has none", async () => {
    const id = await start([page, end], { label: "{{kunde}} · {{angebot}}" });
    expect((await row(id))?.label).toBeNull();
    await client.withTenant(T, () => runner.submitPage(id, "ask", { kunde: "Hofer Gastro" }));
    expect((await row(id))?.label).toBe("Hofer Gastro");
    expect(await hasStatus(id, "done")).toBe(true);
    expect((await row(id))?.label).toBe("Hofer Gastro");

    const none = await start([page, end]);
    await client.withTenant(T, () => runner.submitPage(none, "ask", { kunde: "Hofer" }));
    expect((await row(none))?.label).toBeNull();
  });

  it("a person's answered page is a line of the log", async () => {
    const id = await start([page, end]);
    await client.withTenant(T, () => runner.submitPage(id, "ask", { kunde: "Hofer" }));
    const lines = await log(id);
    expect(lines.filter((l) => l.type === "step_done" && l.stepId === "ask")).toHaveLength(1);
  });

  it("the validator knows what a label may read", () => {
    const issues = (label: string) =>
      validateWizard(wizardSchema.parse({ ...base, label, steps: [page, agent("find"), end] }));
    expect(issues("{{kunde}} · {{steps.find}}")).toEqual([]);
    expect(issues("{{today}}")).toEqual([]);
    expect(issues("{{nobody}}")).toEqual([
      { message: 'The label reads "{{nobody}}", which this wizard doesn\'t have.' },
    ]);
    expect(issues("{{steps.nobody}}")).toHaveLength(1);
  });

  it("reads a step's output too", async () => {
    const id = await start([agent("find"), end], { label: "{{steps.find}}" });
    expect(await hasStatus(id, "done")).toBe(true);
    expect((await row(id))?.label).toBe("made find");
  });

  it("the runs list shows it and narrows to it", async () => {
    const fresh = await client.withTenant(T, () =>
      wizards.createWizard("local", {
        definition: { ...base, steps: [page, end], label: "{{kunde}}" } as never,
      }),
    );
    const make = async (kunde: string) => {
      const id = await client.withTenant(T, () =>
        runner.createRun({
          wizardId: fresh.id,
          definition: { ...base, steps: [page, end], label: "{{kunde}}" } as never,
          files: [],
          version: null,
          mode: "test",
          userId: "local",
        }),
      );
      await client.withTenant(T, () => runner.submitPage(id, "ask", { kunde }));
      return id;
    };
    const hofer = await make("Hofer Gastro");
    const eder = await make("Eder 100%");
    const list = (q?: string) =>
      client.withTenant(T, () => services.listRuns("local", fresh.id, q));

    const all = await list();
    expect(all.map((r) => r.label).sort()).toEqual(["Eder 100%", "Hofer Gastro"]);
    expect((await list("hofer")).map((r) => r.id)).toEqual([hofer]);
    expect((await list("  gastro ")).map((r) => r.id)).toEqual([hofer]);
    // Its signs are only signs.
    expect((await list("100%")).map((r) => r.id)).toEqual([eder]);
    expect(await list("%")).toHaveLength(1);
    expect(await list("nobody")).toEqual([]);
  });
});

describe("a takeover", () => {
  it("in a step: says so once, the step keeps one start and one end", async () => {
    const id = await start([page, agent("mail"), end]);
    await leftByCrash(id, "mail", true);
    await client.withTenant(T, () => runner.kick(id));
    expect(await hasStatus(id, "done")).toBe(true);

    const lines = await log(id);
    const types = lines.map((l) => l.type);
    expect(types.filter((t) => t === "resumed")).toHaveLength(1);
    expect(types.filter((t) => t === "run_started")).toHaveLength(1);
    expect(lines.filter((l) => l.type === "step_started" && l.stepId === "mail")).toHaveLength(1);
    expect(lines.filter((l) => l.type === "step_done" && l.stepId === "mail")).toHaveLength(1);
    const resumed = lines.find((l) => l.type === "resumed");
    expect(resumed?.stepId).toBe("mail");
    expect(noteText(resumed?.note as never, "de")).toBe("Nach einer Unterbrechung weitergemacht");
    // It goes on, so the step works again: that is the point of `run_effect`, not of this log.
    expect(worked.filter((w) => w.run === id).map((w) => w.step)).toEqual(["mail"]);
  });

  it("before its step began: says so, and the step starts as usual", async () => {
    const id = await start([page, agent("mail"), end]);
    await leftByCrash(id, "mail", false);
    await client.withTenant(T, () => runner.kick(id));
    expect(await hasStatus(id, "done")).toBe(true);
    const lines = await log(id);
    expect(lines.filter((l) => l.type === "resumed")).toHaveLength(1);
    expect(lines.filter((l) => l.type === "step_started" && l.stepId === "mail")).toHaveLength(1);
  });

  it("on the way into a wait: one start, one `wait`, and the time it said", async () => {
    const id = await start([page, pause, end]);
    const until = new Date(Date.now() + 3600_000);
    await leftByCrash(id, "pause", true);
    await client.withTenant(T, () =>
      events.emitEvent(id, "pause", "wait", {
        code: "runWaitsUntil",
        params: { until: { at: until.toISOString() } },
      }),
    );
    await client.withTenant(T, () => runner.kick(id));
    expect(await rests(id)).toBe(true);

    expect((await row(id))?.wakeAt?.getTime()).toBe(until.getTime());
    expect((await line(id))?.wakeAt?.getTime()).toBe(until.getTime());
    const lines = await log(id);
    for (const type of ["resumed", "step_started", "wait"]) {
      expect(lines.filter((l) => l.type === type && l.stepId === "pause"), type).toHaveLength(1);
    }
  });

  it("a wake that comes back after a crash says it once", async () => {
    const id = await start([pause, agent("after"), end]);
    expect(await rests(id)).toBe(true);
    // The first wake got as far as saying so.
    await client.withTenant(T, () =>
      events.emitEvent(id, "pause", "woken", { code: "runWaitOver" }),
    );
    await client.withTenant(T, () =>
      client.db
        .update(client.schema.run)
        .set({ wakeAt: new Date(Date.now() - 1000), driving: true })
        .where(eq(client.schema.run.id, id)),
    );
    await client.withTenant(T, () => runner.kick(id));
    expect(await hasStatus(id, "done")).toBe(true);
    expect(await count(id, "woken")).toBe(1);
    // Nothing was at work: a run that sleeps wasn't interrupted.
    expect(await count(id, "resumed")).toBe(0);
  });

  it("no takeover, no line: answers and wakes go on without one", async () => {
    const answered = await start([page, agent("mail"), end]);
    await client.withTenant(T, () => runner.submitPage(answered, "ask", { kunde: "Hofer" }));
    expect(await hasStatus(answered, "done")).toBe(true);
    expect(await count(answered, "resumed")).toBe(0);

    const woken = await start([pause, agent("after"), end]);
    expect(await rests(woken)).toBe(true);
    await client.withTenant(T, () => runner.wakeNow(woken, "Lena"));
    expect(await hasStatus(woken, "done")).toBe(true);
    expect(await count(woken, "resumed")).toBe(0);

    expect((await row(woken))?.driving).toBe(false);
  });

  it("a rest clears the mark, whatever the process does next", async () => {
    const id = await start([pause, end]);
    expect(await rests(id)).toBe(true);
    expect((await row(id))?.driving).toBe(false);
  });
});

describe("an action that may have happened", () => {
  it("is one line, with the mail's address when there is one", async () => {
    const id = await start([page, end]);
    await client.withTenant(T, async () => {
      await events.effectUnsure(id, "ask", { tool: "gmail_send", to: "anna@kunde.at" });
      await events.effectUnsure(id, "ask", { tool: "create_event" });
    });
    const lines = (await log(id)).filter((e) => e.type === "effect_unsure");
    expect(lines).toHaveLength(2);
    expect(noteText(lines[0].note as never, "de")).toContain(
      "Mail an anna@kunde.at wurde vielleicht schon gesendet",
    );
    expect(noteText(lines[1].note as never, "de")).toContain(
      "„create_event“ ist vielleicht schon passiert",
    );
  });
});
