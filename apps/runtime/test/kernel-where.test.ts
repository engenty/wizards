import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-kernel-where-"));
process.env.DATA_DIR = DATA_DIR;
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.RUNTIME_ROLE = "runner";
process.env.RUNNER_TENANT = "tenant-a";
process.env.RUNNER_URL = "http://runner-a";

// The Manage-App: tenant-a has a runner of its own and may drive 3 runs at once.
vi.mock("../src/manage.js", async (original) => ({
  ...(await original<typeof import("../src/manage.js")>()),
  managed: true,
  tenantInfo: async (id: string) => ({
    id,
    status: "active",
    balanceCredits: 100,
    limits: { concurrentRuns: 3 },
    features: { ownRunner: id === "tenant-a" },
    db: null,
  }),
}));

/**
 * Where a step's code runs, and whose runs a runner takes (docs/plans/kernel.md, decision 6 and
 * item H.23).
 */
let host: typeof import("../src/kernel/host");
let control: typeof import("../src/tenants/control");
let client: typeof import("../src/db/client");

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  host = await import("../src/kernel/host");
  control = await import("../src/tenants/control");
});
afterEach(() => {
  delete process.env.KERNEL_STEPS;
});

describe("a step's code", () => {
  it("runs as ordinary code on a runner that is one tenant's, for the tenant's own wizard", () => {
    expect(host.stepMode({ starter: null })).toBe("native");
  });

  it("runs in QuickJS for a wizard made from someone else's", () => {
    expect(host.stepMode({ starter: "damage-report" })).toBe("quickjs");
  });

  it("runs as the runner is told, where it is told", () => {
    process.env.KERNEL_STEPS = "quickjs";
    expect(host.stepMode({ starter: null })).toBe("quickjs");
    process.env.KERNEL_STEPS = "native";
    expect(host.stepMode({ starter: "damage-report" })).toBe("native");
  });
});

describe("a runner that serves one tenant", () => {
  const inLine = (runId: string, tenantId: string) =>
    client.controlDb
      .insert(client.control.runIndex)
      .values({ runId, tenantId, active: true } as never)
      .onConflictDoNothing();

  it("sees only that tenant's runs in the line", async () => {
    await inLine("run-a", "tenant-a");
    await inLine("run-b", "tenant-b");
    expect((await control.waitingRuns()).map((r) => r.runId)).toEqual(["run-a"]);
  });

  it("says whose it is, and is the one another process asks for that tenant's run", async () => {
    await control.registerRunner();
    const now = new Date();
    await client.controlDb.insert(client.control.runner).values([
      { id: "shared", url: "http://shared", seen: now, tenant: null },
      { id: "other-a", url: "http://other-a", seen: now, tenant: "tenant-a" },
      { id: "for-b", url: "http://for-b", seen: now, tenant: "tenant-b" },
    ]);
    expect((await control.otherRunners("tenant-a")).map((r) => r.id)).toEqual(["other-a"]);
    expect((await control.otherRunners("tenant-b")).map((r) => r.id)).toEqual(["for-b"]);
    // a tenant without a runner of its own goes to the ones that serve everybody
    expect((await control.otherRunners("tenant-c")).map((r) => r.id)).toEqual(["shared"]);
  });
});

describe("a tenant's runner at work", () => {
  const file = (id: string) => join(DATA_DIR, "tenants", `${id}.db`);

  it("drives as many runs as its tenant may at once, not RUNNER_MAX_RUNS", async () => {
    const { runCap } = await import("../src/engine/runner");
    expect(await runCap()).toBe(3);
  });

  it("opens and migrates its own tenant's database, no other", async () => {
    await client.controlDb
      .insert(client.control.tenant)
      .values([{ id: "tenant-a" }, { id: "tenant-b" }, { id: "tenant-c", status: "suspended" }])
      .onConflictDoNothing();
    expect(await client.knownTenants()).toEqual(["tenant-a"]);
    expect(await client.activeTenants()).toEqual(["tenant-a"]);
    expect(await client.migrateAllTenants([])).toEqual({ migrated: 1, failed: [] });
    expect(existsSync(file("tenant-a"))).toBe(true);
    expect(existsSync(file("tenant-b"))).toBe(false);
  });

  it("does the clock's work for no other tenant", async () => {
    const { deliverAllNotices } = await import("../src/engine/notices");
    const { runDueSchedules } = await import("../src/engine/starts");
    const { watchMail } = await import("../src/engine/mail-watch");
    const { runDueJobs } = await import("../src/plugins/jobs");
    await deliverAllNotices();
    await runDueSchedules();
    await watchMail();
    await runDueJobs();
    expect(existsSync(file("tenant-b"))).toBe(false);
  });
});

describe("the authoring guide", () => {
  it("tells of wizards made of step files only while the switch is on", async () => {
    const { authoringGuide } = await import("../src/authoring/guide");
    const on = authoringGuide([], [], [], [], { kernel: true });
    expect(on).toContain('Each step is a workspace file "steps/<id>.ts"');
    expect(on).toContain("${run.input.customer}"); // the example's own text, not a gap of the guide
    expect(authoringGuide([], [], [], [], {})).not.toContain("steps/<id>.ts");
  });

  it("is what the studio's assistant is told as well, while the switch is on", async () => {
    const { systemPrompt } = await import("../src/agents/architect");
    const on = systemPrompt([], [], [], [], false, { kernel: true });
    expect(on).toContain('Each step is a workspace file "steps/<id>.ts"');
    expect(on).not.toContain("${kernel}");
    const off = systemPrompt([], [], [], [], false, {});
    expect(off).not.toContain("steps/<id>.ts");
    expect(off).not.toContain("${kernel}");
  });
});
