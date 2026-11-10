import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// A person's step that gave its credit hold back is answered: the run holds again right before
// its next step that costs anything, in the runner, and waits for credits there when refused.
const dir = mkdtempSync(join(tmpdir(), "wizards-credits-later-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
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
const ran = vi.fn();
vi.mock("../src/engine/steps.js", async (original) => ({
  ...(await original<typeof import("../src/engine/steps.js")>()),
  runAutomaticStep: async () => {
    ran();
    return { text: "made", at: new Date().toISOString() };
  },
}));
/** Whether the credits a run asks for are given, and how often they were asked for. */
let credits: true | "out_of_credits" = true;
const reserved = vi.fn();
vi.mock("../src/credits/credits.js", async (original) => ({
  ...(await original<typeof import("../src/credits/credits.js")>()),
  reserveForRun: async () => {
    reserved();
    return credits;
  },
  releaseRun: async () => undefined,
  canSpend: async () => true,
}));

let client: typeof import("../src/db/client");
let runner: typeof import("../src/engine/runner");

const T = "tenant-credits-later";
const SPACE = "space-1";

const def = {
  version: 1,
  title: "Später halten",
  description: "",
  avatar: "round",
  steps: [
    { id: "a", type: "form", title: "A", remind: "1d", fields: [{ id: "a_f", kind: "text", label: "T" }] },
    { id: "b", type: "form", title: "B", fields: [{ id: "b_f", kind: "text", label: "T" }] },
    { id: "work", type: "agent", title: "Arbeit", instructions: "Tu es.", tools: [], output: { format: "text" } },
    { id: "done", type: "result", title: "Fertig", deliverables: [] },
  ],
};

const inTenant = <R>(fn: () => Promise<R>) => client.withTenant(T, fn);
const row = (runId: string) =>
  inTenant(() => client.db.query.run.findFirst({ where: eq(client.schema.run.id, runId) }));

async function startRun() {
  return inTenant(async () => {
    const wizardId = nanoid(12);
    await client.db.insert(client.schema.wizard).values({
      id: wizardId,
      shareToken: nanoid(16),
      spaceId: SPACE,
      tenantId: T,
      title: "Später halten",
      draft: def as never,
      publishedVersion: 1,
    });
    return runner.createRun({
      wizardId,
      definition: def as never,
      files: [],
      version: 1,
      mode: "live",
      userId: "u",
    });
  });
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
  const { env } = await import("../src/env");
  env.limits.concurrentRuns = 1000;
  env.runner.maxRuns = 1000;
  runner = await import("../src/engine/runner");
  await inTenant(() =>
    client.db.insert(client.schema.space).values({ id: SPACE, tenantId: T, name: "Space" } as never),
  );
  runner.startRunner();
}, 60_000);

afterAll(() => runner.stopRunner?.());

describe("holding again after an answer", () => {
  it("asks for nothing at the answer and the plain page after it, then holds before the AI step", async () => {
    credits = true;
    const runId = await startRun();
    reserved.mockClear();
    await inTenant(() => runner.submitPage(runId, "a", { a_f: "x" }));
    expect(await row(runId)).toMatchObject({ status: "waiting_input", cursor: "b" });
    expect(reserved).not.toHaveBeenCalled();
    await inTenant(() => runner.submitPage(runId, "b", { b_f: "y" }));
    await vi.waitFor(async () => expect((await row(runId))?.status).toBe("done"), {
      timeout: 5000,
      interval: 25,
    });
    expect(reserved).toHaveBeenCalledTimes(1);
    expect((await row(runId))?.state.holdLater).toBeUndefined();
  });

  it("waits for credits before the AI step when they are refused; nothing that costs ran", async () => {
    const runId = await startRun();
    credits = "out_of_credits";
    ran.mockClear();
    await inTenant(() => runner.submitPage(runId, "a", { a_f: "x" }));
    await inTenant(() => runner.submitPage(runId, "b", { b_f: "y" }));
    await vi.waitFor(
      async () => {
        const r = await row(runId);
        expect(r?.status).toBe("sleeping");
        expect(r?.cursor).toBe("work");
        expect(r?.state.pause?.kind).toBe("credits");
      },
      { timeout: 5000, interval: 25 },
    );
    expect(ran).not.toHaveBeenCalled();
  });
});
