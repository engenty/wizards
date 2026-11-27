import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-own-runner-"));
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.RUNTIME_ROLE = "runner";
process.env.RUNNER_URL = "http://shared-here";

/**
 * A shared runner beside a tenant that has a runner of its own (docs/plans/kernel-runners.md,
 * stage B): the Manage-App marks it with `features.ownRunner`, and its runs wait for that runner.
 */
const OWN = "tenant-own";
const manageAway = vi.hoisted(() => ({ now: false }));
vi.mock("../src/manage.js", async (original) => ({
  ...(await original<typeof import("../src/manage.js")>()),
  managed: true,
  tenantInfo: async (id: string) => {
    if (manageAway.now) {
      throw new Error("Manage-App away");
    }
    return {
      id,
      status: "active",
      balanceCredits: 100,
      limits: { concurrentRuns: 4 },
      features: { ownRunner: id === OWN },
      db: null,
    };
  },
}));

let client: typeof import("../src/db/client");
let control: typeof import("../src/tenants/control");
let runner: typeof import("../src/engine/runner");
let ownRunner: typeof import("../src/tenants/own-runner");

const inLine = (runId: string, tenantId: string, createdAt = new Date()) =>
  client.controlDb
    .insert(client.control.runIndex)
    .values({ runId, tenantId, active: true, createdAt } as never)
    .onConflictDoNothing();

const addRunner = (id: string, tenant: string | null, seen = new Date()) =>
  client.controlDb
    .insert(client.control.runner)
    .values({ id, url: `http://${id}`, seen, lineAt: seen, tenant })
    .onConflictDoUpdate({ target: client.control.runner.id, set: { seen, lineAt: seen } });

const ownerOf = async (runId: string) =>
  (
    await client.controlDb.query.runIndex.findFirst({
      where: eq(client.control.runIndex.runId, runId),
    })
  )?.owner ?? null;

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  control = await import("../src/tenants/control");
  runner = await import("../src/engine/runner");
  ownRunner = await import("../src/tenants/own-runner");
  await control.registerRunner();
});
afterEach(() => {
  vi.unstubAllGlobals();
  manageAway.now = false;
});

describe("a shared runner", () => {
  it("leaves the runs of a tenant with a runner of its own in line", async () => {
    await inLine("run-own", OWN, new Date(Date.now() - 60_000));
    await inLine("run-shared", "tenant-shared");
    expect((await control.waitingRuns()).map((r) => r.runId)).toEqual(["run-shared"]);
  });

  it("takes none of them when asked to, not even while the tenant's runner is down", async () => {
    expect(runner.takeNow("run-own", OWN)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await ownerOf("run-own")).toBeNull();
  });

  it("nudges the tenant's own runner, never itself or another shared one", async () => {
    await addRunner("shared-other", null);
    // No runner of its own reports: the run waits, nobody is asked.
    expect(await control.otherRunners(OWN)).toEqual([]);
    await addRunner("own-runner", OWN);
    expect((await control.otherRunners(OWN)).map((r) => r.id)).toEqual(["own-runner"]);
    expect((await control.otherRunners("tenant-shared")).map((r) => r.id)).toEqual([
      "shared-other",
    ]);

    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      asked.push(String(url));
      return new Response("{}");
    });
    const { inTenant } = await import("../src/tenants/tenant");
    inTenant(OWN, () => runner.kick("run-own"));
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    expect(asked[0]).toBe("http://own-runner/api/peer/runs/run-own/take");
    expect(await ownerOf("run-own")).toBeNull();
  });

  it("keeps to the Manage-App's last answer while it is out of reach", async () => {
    expect(await ownRunner.hasOwnRunner(OWN)).toBe(true);
    manageAway.now = true;
    expect(await ownRunner.hasOwnRunner(OWN)).toBe(true);
    expect(await ownRunner.hasOwnRunner("tenant-never-asked")).toBe(false);
  });

  it("drives RUNNER_MAX_RUNS at once", async () => {
    expect(await runner.runCap()).toBe(16);
  });
});

describe("the health check", () => {
  it("names a tenant whose runs wait with no runner of its own, and leaves it out of the line's age", async () => {
    await client.controlDb
      .delete(client.control.runner)
      .where(eq(client.control.runner.id, "own-runner"));
    const state = await control.lineState();
    expect(state.withoutRunner.map((w) => w.tenant)).toEqual([OWN]);
    // the oldest run in line is the marked tenant's; the age counts only what a runner serves
    expect(state.oldestWaiting?.getTime()).toBeGreaterThan(Date.now() - 30_000);

    const { health } = await import("../src/health");
    const line = (await health()).checks.line;
    expect(line.status).toBe("degraded");
    expect(line.error).toContain(OWN);
  });

  it("names it no more once its runner reports", async () => {
    await addRunner("own-runner", OWN);
    expect((await control.lineState()).withoutRunner).toEqual([]);
  });
});
