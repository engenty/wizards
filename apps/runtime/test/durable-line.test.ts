import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// A web role, as on the cloud: `kick` only puts a run in line, a runner's look takes it.
const dir = mkdtempSync(join(tmpdir(), "wizards-durable-line-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.RUNTIME_ROLE = "doors";

/** Steps that work until the test lets them finish. */
const started = new Set<string>();
const finish = new Map<string, () => void>();
vi.mock("../src/engine/steps.js", async (original) => ({
  ...(await original<typeof import("../src/engine/steps.js")>()),
  runAutomaticStep: async (_step: unknown, ctx: { runId: string }) => {
    started.add(ctx.runId);
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

const T = "tenant-durable-line";

const definition = {
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
    { id: "done", type: "result", title: "Fertig", deliverables: [] },
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

const newRun = () =>
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

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  runner = await import("../src/engine/runner");
  control = await import("../src/tenants/control");
  wizards = await import("../src/services/wizards");
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
    expect(await until(async () => (await row(a))?.status === "done")).toBe(true);
    expect(await until(async () => (await row(b))?.status === "done")).toBe(true);
  });

  it("a wake that comes just before a run rests is not lost", async () => {
    const r = await newRun();
    expect(await until(() => started.has(r))).toBe(true);
    // A person's answer in another process wakes the run while its owner finishes the step.
    await control.wakeRun(r);
    // The owner finishes and rests the run, as `take` does.
    await control.restRun(r);
    const line = await client.controlDb.query.runIndex.findFirst({
      where: eq(client.control.runIndex.runId, r),
    });
    expect(line?.active).toBe(true);
    finish.get(r)?.();
    expect(await until(async () => (await row(r))?.status === "done")).toBe(true);
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
        .set({ state: moved as never, claim: 999 } as never)
        .where(eq(client.schema.run.id, r)),
    );
    // Now the old owner wakes up and its step ends.
    finish.get(r)?.();
    await new Promise((res) => setTimeout(res, 400));
    const after = await row(r);
    expect(after?.state.values).toEqual({ by: "new owner" });
    expect(after?.state.outputs).toEqual({});
    expect(after?.status).toBe("running");
  });
});
