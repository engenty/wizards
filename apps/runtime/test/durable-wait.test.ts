import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "wizards-durable-wait-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.RUNTIME_ROLE = "doors";
process.env.WAKE_TICK_MS = "100";

const worked: string[] = [];
vi.mock("../src/engine/steps.js", async (original) => ({
  ...(await original<typeof import("../src/engine/steps.js")>()),
  runAutomaticStep: async (step: { id: string }, ctx: { runId: string }) => {
    worked.push(`${ctx.runId}:${step.id}`);
    return { text: `made ${step.id}`, at: new Date().toISOString() };
  },
}));
vi.mock("../src/engine/requirements.js", async (original) => ({
  ...(await original<typeof import("../src/engine/requirements.js")>()),
  missingModelsSaid: async () => [],
}));

let client: typeof import("../src/db/client");
let runner: typeof import("../src/engine/runner");
let signals: typeof import("../src/engine/signals");
let wizards: typeof import("../src/services/wizards");

const T = "tenant-durable-wait";
const agent = (id: string) => ({
  id,
  type: "agent",
  title: id,
  instructions: "Do it.",
  tools: [],
  output: { format: "text" },
});
const end = { id: "done", type: "result", title: "Fertig", deliverables: [] };
const base = { version: 1, title: "Wait", description: "", avatar: "round" };

const start = (steps: unknown[]) =>
  client.withTenant(T, async () => {
    const created = await wizards.createWizard("u", { definition: { ...base, steps } as never });
    const w = await wizards.ownedWizard("u", created.id);
    const id = await runner.createRun({
      wizardId: w.id,
      definition: w.draft,
      files: [],
      version: null,
      mode: "test",
      userId: "u",
    });
    return { id, spaceId: w.projectId ?? (await runner.spaceIdOf({ wizardId: w.id })) };
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

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  runner = await import("../src/engine/runner");
  signals = await import("../src/engine/signals");
  wizards = await import("../src/services/wizards");
  runner.startRunner();
});
afterAll(() => runner.stopRunner());

describe("wait 2 days", () => {
  it("leaves every process, wakes by the clock, goes on with the next step", async () => {
    const { id } = await start([
      agent("before"),
      { id: "pause", type: "wait", title: "Pause", for: "2d" },
      agent("after"),
      end,
    ]);
    expect(await hasStatus(id, "sleeping")).toBe(true);
    expect(worked).toContain(`${id}:before`);
    expect(worked).not.toContain(`${id}:after`);
    const held = await until(async () => {
      const l = await line(id);
      return l?.active === false && l.owner === null;
    });
    expect(held).toBe(true);
    const r = await row(id);
    const due = (r?.wakeAt?.getTime() ?? 0) - Date.now();
    expect(due).toBeGreaterThan(47 * 3600_000);
    expect((await line(id))?.wakeAt?.getTime()).toBe(r?.wakeAt?.getTime());

    await pass(id);
    expect(await hasStatus(id, "done")).toBe(true);
    expect(worked).toContain(`${id}:after`);
    expect((await line(id))?.wakeAt).toBeNull();
  });

  it("an early wake finds the run as it is and puts the time back", async () => {
    const { id } = await start([{ id: "pause", type: "wait", title: "Pause", for: "2d" }, end]);
    expect(await hasStatus(id, "sleeping")).toBe(true);
    await until(async () => (await line(id))?.active === false);
    const before = (await row(id))?.wakeAt?.getTime();
    // Only the control copy is due: a lost tenant write, or a stale clock.
    await client.controlDb
      .update(client.control.runIndex)
      .set({ wakeAt: new Date(Date.now() - 1000) })
      .where(eq(client.control.runIndex.runId, id));
    expect(await until(async () => (await line(id))?.wakeAt?.getTime() === before)).toBe(true);
    expect((await row(id))?.status).toBe("sleeping");
  });

  it("a cancel while it sleeps ends it, and the clock does not wake it", async () => {
    const { id } = await start([{ id: "pause", type: "wait", title: "Pause", for: "2d" }, end]);
    expect(await hasStatus(id, "sleeping")).toBe(true);
    await client.withTenant(T, () => runner.cancel(id));
    expect((await row(id))?.status).toBe("cancelled");
    expect((await line(id))?.wakeAt).toBeNull();
  });
});

describe("wait until something arrives", () => {
  const waiting = (timeout?: string) => [
    {
      id: "reply",
      type: "wait",
      title: "Reply",
      signal: { name: "mail.received", key: "anna@example.com", ...(timeout ? { timeout } : {}) },
    },
    agent("after"),
    end,
  ];

  it("a signal wakes it, and its data is the step's output", async () => {
    const { id, spaceId } = await start(waiting());
    expect(await hasStatus(id, "waiting_signal")).toBe(true);
    expect((await row(id))?.wakeAt).toBeNull();
    const sent = await client.withTenant(T, () =>
      signals.sendSignal({
        spaceId,
        name: "mail.received",
        key: "anna@example.com",
        data: { subject: "Ja" },
        source: "test",
      }),
    );
    expect(sent.runs).toBe(1);
    expect(await hasStatus(id, "done")).toBe(true);
    expect((await row(id))?.state.outputs.reply?.json).toMatchObject({
      came: true,
      timedOut: false,
      subject: "Ja",
    });
  });

  it("another key does not wake it, and the timeout does", async () => {
    const { id, spaceId } = await start(waiting("3d"));
    expect(await hasStatus(id, "waiting_signal")).toBe(true);
    const sent = await client.withTenant(T, () =>
      signals.sendSignal({ spaceId, name: "mail.received", key: "bob@example.com", source: "test" }),
    );
    expect(sent.runs).toBe(0);
    await until(async () => (await line(id))?.active === false);
    await pass(id);
    expect(await hasStatus(id, "done")).toBe(true);
    expect((await row(id))?.state.outputs.reply?.json).toMatchObject({ came: false, timedOut: true });
  });

  it("a signal that came before the run reached its wait is not lost", async () => {
    const { id, spaceId } = await start([
      { id: "ask", type: "page", title: "Ask", fields: [{ id: "x", kind: "text", label: "X" }] },
      ...waiting(),
    ]);
    await client.withTenant(T, () =>
      signals.sendSignal({
        spaceId,
        name: "mail.received",
        key: "anna@example.com",
        data: { subject: "Früh" },
        source: "test",
      }),
    );
    await client.withTenant(T, () => runner.submitPage(id, "ask", { x: "go" }));
    expect(await hasStatus(id, "done")).toBe(true);
    expect((await row(id))?.state.outputs.reply?.json).toMatchObject({ came: true, subject: "Früh" });
  });
});
