import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The shortcut on the server (docs/plans/fast-creation.md, Part 4): an answer that leads to a page
// nothing has to prepare writes `waiting_input` and the new cursor itself. This process has no
// runner, as the studio and the doors: a run the answer left `running` waits for one.
const dir = mkdtempSync(join(tmpdir(), "wizards-answer-shortcut-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.RUNTIME_ROLE = "web";
// Durable runs give team steps, deadlines and notices their meaning; fastCreate comes from outside.
const outside = (process.env.FEATURES ?? "").split(",").filter((f) => f.startsWith("fastCreate"));
process.env.FEATURES = ["durableRuns=on", ...outside].join(",");

vi.mock("../src/manage.js", async (original) => ({
  ...(await original<typeof import("../src/manage.js")>()),
  managed: true,
  runMail: async () => ({ ok: true, sent: true }),
  pushToDevice: async () => ({ ok: true }),
  tenantInfo: async (id: string) => ({ id, status: "active", limits: {} }),
}));
vi.mock("../src/engine/requirements.js", async (original) => ({
  ...(await original<typeof import("../src/engine/requirements.js")>()),
  missingModelsSaid: async () => [],
}));
/** Whether the credits a run asks for are given. */
let credits: true | "out_of_credits" = true;
vi.mock("../src/credits/credits.js", async (original) => ({
  ...(await original<typeof import("../src/credits/credits.js")>()),
  reserveForRun: async () => credits,
  releaseRun: async () => undefined,
  canSpend: async () => true,
}));

let client: typeof import("../src/db/client");
let runner: typeof import("../src/engine/runner");

const T = "tenant-shortcut";
const SPACE = "space-1";
const PERSON = "u-person";
const TEAMMATE = "u-team";

const page = (id: string, more: Record<string, unknown> = {}) => ({
  id,
  type: "page",
  title: `Seite ${id}`,
  fields: [{ id: `${id}_f`, kind: "text", label: "Text" }],
  ...more,
});
const agent = {
  id: "work",
  type: "agent",
  title: "Arbeit",
  instructions: "Tu es.",
  tools: [],
  output: { format: "text" },
};
const done = { id: "done", type: "result", title: "Fertig", deliverables: [] };
const flow = (...steps: object[]) => ({
  version: 1,
  title: "Abkürzung",
  description: "",
  avatar: "round",
  steps: [...steps, done],
});

const inTenant = <R>(fn: () => Promise<R>) => client.withTenant(T, fn);
const row = (runId: string) =>
  inTenant(() => client.db.query.run.findFirst({ where: eq(client.schema.run.id, runId) }));
const woken = async (runId: string) =>
  (
    await client.controlDb.query.runIndex.findFirst({
      where: eq(client.control.runIndex.runId, runId),
    })
  )?.wokenAt?.getTime() ?? null;
const noticesOf = async (runId: string) =>
  (await inTenant(() => client.db.query.notice.findMany())).filter((n) => n.runId === runId);

async function until(ok: () => Promise<boolean>, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok()) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

/** A run of `def` on its first step, the run's person `PERSON`. */
async function startRun(def: object, startedBy?: object) {
  return inTenant(async () => {
    const wizardId = nanoid(12);
    await client.db.insert(client.schema.wizard).values({
      id: wizardId,
      shareToken: nanoid(16),
      spaceId: SPACE,
      tenantId: T,
      title: "Abkürzung",
      draft: def as never,
      publishedVersion: 1,
    });
    const runId = await runner.createRun({
      wizardId,
      definition: def as never,
      files: [],
      version: 1,
      mode: "live",
      userId: PERSON,
    });
    if (startedBy) {
      await client.db
        .update(client.schema.run)
        .set({ startedBy: startedBy as never })
        .where(eq(client.schema.run.id, runId));
    }
    return runId;
  });
}

/** Answers the page the run stands on, and says how the run was left. */
async function answer(runId: string, stepId: string, by = PERSON) {
  const before = await woken(runId);
  await inTenant(() => runner.submitPage(runId, stepId, { [`${stepId}_f`]: "x" }, { userId: by }));
  const after = await row(runId);
  // `kick` wakes the run in the control line without waiting; a shortcut does not call it.
  const kicked = await until(async () => (await woken(runId)) !== before, 300);
  return { status: after?.status, cursor: after?.cursor, state: after?.state, kicked };
}

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb(T);
  await client.controlDb
    .insert(client.control.tenant)
    .values({ id: T, status: "active" } as never)
    .onConflictDoNothing()
    .catch(() => undefined);
  runner = await import("../src/engine/runner");
  await inTenant(() =>
    client.db.insert(client.schema.space).values({ id: SPACE, tenantId: T, name: "Space" } as never),
  );
}, 60_000);

beforeEach(() => {
  credits = true;
});

describe("the shortcut", () => {
  it("a plain page after a page: waiting at once on the next, with no runner and no kick", async () => {
    const runId = await startRun(flow(page("a"), page("b")));
    const left = await answer(runId, "a");
    expect(left).toMatchObject({ status: "waiting_input", cursor: "b", kicked: false });
    // What the answer took with it is not left behind for a runner.
    expect(left.state?.answered).toBeUndefined();
    expect(left.state?.values).toMatchObject({ a_f: "x" });
  });

  it("a review that leads to a plain page goes on the same way", async () => {
    const def = flow(page("a"), agent, {
      id: "check",
      type: "review",
      title: "Prüfen",
      show: ["work"],
    }, page("b"));
    const runId = await startRun(def);
    // The run as a runner leaves it at the review.
    await inTenant(() =>
      client.db
        .update(client.schema.run)
        .set({ cursor: "check", status: "waiting_input" })
        .where(eq(client.schema.run.id, runId)),
    );
    const before = await woken(runId);
    await inTenant(() => runner.reviewStep(runId, "check", { type: "accept" }, { userId: PERSON }));
    const r = await row(runId);
    expect(r).toMatchObject({ status: "waiting_input", cursor: "b" });
    expect(await until(async () => (await woken(runId)) !== before, 300)).toBe(false);
  });

  it("an answer by someone on the team that leads to the person's plain page tells the person", async () => {
    const runId = await startRun(flow(page("a", { who: "team" }), page("b")));
    const left = await answer(runId, "a", TEAMMATE);
    expect(left).toMatchObject({ status: "waiting_input", cursor: "b", kicked: false });
    const told = (await noticesOf(runId)).filter((n) => n.kind === "needs_you");
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ userId: PERSON, waitKey: "step:b" });
  });

  it("the person who reached the page by their own answer is not told of it", async () => {
    const runId = await startRun(flow(page("a"), page("b")));
    await answer(runId, "a", PERSON);
    expect((await noticesOf(runId)).filter((n) => n.kind === "needs_you")).toHaveLength(0);
  });
});

describe("the slow path: the answer leaves the run running for a runner, and kicks it", () => {
  const cases: [string, object, object?][] = [
    ["an AI step", flow(page("a"), agent)],
    ["a wait", flow(page("a"), { id: "pause", type: "wait", title: "Pause", for: "1d" })],
    ["the result", flow(page("a"))],
    [
      "a page with decided fields",
      flow(page("a"), {
        id: "b",
        type: "page",
        title: "Seite b",
        fields: [{ id: "b_f", kind: "text", label: "Text", ask: "Die Person will mehr sagen" }],
      }),
    ],
    ["a page with a timeout", flow(page("a"), page("b", { timeout: "2d" }))],
    ["a page with a reminder", flow(page("a"), page("b", { remind: "1d" }))],
    ["a page the owner answers", flow(page("a"), page("b", { who: "owner" }))],
    ["a page the team answers", flow(page("a"), page("b", { who: "team" }))],
    ["a run begun by a start", flow(page("a"), page("b")), { kind: "schedule", startId: "s1" }],
  ];
  it.each(cases)("before %s", async (_name, def, startedBy) => {
    const runId = await startRun(def, startedBy);
    const left = await answer(runId, "a");
    expect(left.status).toBe("running");
    expect(left.kicked).toBe(true);
  });

  it("an `ask` rule: the run never waits on the page just answered", async () => {
    const def = flow(
      page("a", { next: [{ ask: "Die Person will mehr", goto: "b" }, { goto: "done" }] }),
      page("b"),
    );
    const runId = await startRun(def);
    const left = await answer(runId, "a");
    // The decision is the runner's: the cursor stays on the answered page, but the run does not wait there.
    expect(left).toMatchObject({ status: "running", cursor: "a", kicked: true });
    expect(left.state?.deciding).toBe("a");
  });
});

describe("credits are held before the next step that costs, not at the answer", () => {
  it.each([
    ["timeout", { timeout: "2d" }],
    ["remind", { remind: "1d" }],
  ])("a step with %s gave its hold back: the next plain page comes at once", async (_n, more) => {
    const runId = await startRun(flow(page("a", more), page("b")));
    credits = "out_of_credits";
    const left = await answer(runId, "a");
    // Nothing is asked of the Manage-App here: the run marks that it holds again later.
    expect(left).toMatchObject({ status: "waiting_input", cursor: "b", kicked: false });
    expect(left.state?.holdLater).toBe(true);
    expect(left.state?.pause).toBeUndefined();
  });
});
