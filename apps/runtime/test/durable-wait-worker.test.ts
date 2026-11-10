import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

// One process of durable-wait-process.test.ts, which starts it per phase on one DATA_DIR. Run
// without a phase, as a test file like any other, it does nothing.
const PHASE = process.env.WAIT_PHASE;
const DIR = process.env.DATA_DIR ?? "";
const say = (what: string) => appendFileSync(join(DIR, "log"), `${process.pid} ${what}\n`);

vi.mock("../src/engine/steps/index.js", async (original) => ({
  ...(await original<typeof import("../src/engine/steps/index.js")>()),
  runAutomaticStep: async (step: { id: string }) => {
    say(`STEP ${step.id}`);
    // Inside the step, with its drive at work: what a real crash breaks off.
    if (process.env.WAIT_KILL_IN === step.id) {
      process.kill(process.pid, "SIGKILL");
      await new Promise(() => undefined);
    }
    return { text: `made ${step.id}`, at: new Date().toISOString() };
  },
}));
vi.mock("../src/engine/requirements.js", async (original) => ({
  ...(await original<typeof import("../src/engine/requirements.js")>()),
  missingModelsSaid: async () => [],
}));

const T = "tenant-durable-process";
const definition = {
  version: 1,
  title: "Across processes",
  description: "",
  avatar: "round",
  steps: [
    { id: "before", type: "agent", title: "b", instructions: "x", tools: [], output: { format: "text" } },
    { id: "pause", type: "wait", title: "Pause", for: "2d" },
    { id: "after", type: "agent", title: "a", instructions: "x", tools: [], output: { format: "text" } },
    { id: "done", type: "result", title: "Fertig", deliverables: [] },
  ],
};

async function until(ok: () => Promise<boolean>, ms = 30_000) {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (await ok()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out");
}

describe.runIf(PHASE)("one process of a wait", () => {
  it(`phase ${PHASE}`, { timeout: 90_000 }, async () => {
    const client = await import("../src/db/client");
    await client.migrateControlDb();
    const runner = await import("../src/engine/runner");
    const wizards = await import("../src/services/wizards");
    const { control, controlDb, db, schema, withTenant } = client;
    const row = (id: string) =>
      withTenant(T, () => db.query.run.findFirst({ where: eq(schema.run.id, id) }));
    const line = (id: string) =>
      controlDb.query.runIndex.findFirst({ where: eq(control.runIndex.runId, id) });

    if (PHASE === "start") {
      runner.startRunner();
      const id = await withTenant(T, async () => {
        const made = await wizards.createWizard("u", { definition: definition as never });
        return runner.createRun({
          wizardId: made.id,
          definition: definition as never,
          files: [],
          version: null,
          mode: "test",
          userId: "u",
        });
      });
      await until(async () => {
        const l = await line(id);
        return (await row(id))?.status === "sleeping" && l?.active === false && l.owner === null;
      });
      say(`ASLEEP ${id}`);
      // The process is gone without a word: nothing of the wait may have been in it.
      process.kill(process.pid, "SIGKILL");
      await new Promise(() => undefined);
    }

    if (PHASE === "die-in-step") {
      runner.startRunner();
      const id = await withTenant(T, async () => {
        const made = await wizards.createWizard("u", { definition: definition as never });
        const run = await runner.createRun({
          wizardId: made.id,
          definition: definition as never,
          files: [],
          version: null,
          mode: "test",
          userId: "u",
        });
        say(`MADE ${run}`);
        return run;
      });
      // The step kills this process; the wait is only for a step that never came.
      await until(async () => (await row(id))?.status === "failed", 60_000);
      return;
    }

    if (PHASE === "take-over") {
      const id = process.env.WAIT_RUN ?? "";
      runner.startRunner();
      // Its claim has to go stale first, up to 30 s.
      await until(async () => (await row(id))?.status === "sleeping", 60_000);
      const lines = await withTenant(T, () =>
        db.select().from(schema.runEvent).where(eq(schema.runEvent.runId, id)),
      );
      for (const l of lines) {
        say(`LOG ${l.type} ${l.stepId ?? "-"}`);
      }
      say(`END status=${(await row(id))?.status}`);
      await runner.stopRunner();
      return;
    }

    const id = process.env.WAIT_RUN ?? "";
    const asleep = await row(id);
    say(`FOUND status=${asleep?.status} wake=${(await line(id))?.wakeAt?.getTime() === asleep?.wakeAt?.getTime()}`);
    // The time passes while no process runs.
    const past = new Date(Date.now() - 1000);
    await withTenant(T, () =>
      db.update(schema.run).set({ wakeAt: past }).where(eq(schema.run.id, id)),
    );
    await controlDb
      .update(control.runIndex)
      .set({ wakeAt: past })
      .where(eq(control.runIndex.runId, id));
    runner.startRunner();
    await until(async () => (await row(id))?.status === "done");
    say(`END status=${(await row(id))?.status}`);
    await runner.stopRunner();
    expect((await row(id))?.status).toBe("done");
  });
});
