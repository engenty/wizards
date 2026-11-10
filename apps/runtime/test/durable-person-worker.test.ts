import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

// One process of durable-person-process.test.ts, which starts it per phase on one DATA_DIR. Run
// without a phase, as a test file like any other, it does nothing.
const PHASE = process.env.PERSON_PHASE;
const DIR = process.env.DATA_DIR ?? "";
const say = (what: string) => appendFileSync(join(DIR, "log"), `${process.pid} ${what}\n`);

vi.mock("../src/engine/steps/index.js", async (original) => ({
  ...(await original<typeof import("../src/engine/steps/index.js")>()),
  runAutomaticStep: async (step: { id: string }) => {
    say(`STEP ${step.id}`);
    return { text: `made ${step.id}`, at: new Date().toISOString() };
  },
}));
vi.mock("../src/engine/requirements.js", async (original) => ({
  ...(await original<typeof import("../src/engine/requirements.js")>()),
  missingModelsSaid: async () => [],
}));

const T = "tenant-durable-person-process";
const definition = {
  version: 1,
  title: "Across processes",
  description: "",
  avatar: "round",
  steps: [
    {
      id: "ask",
      type: "form",
      title: "Ask",
      timeout: "2d",
      remind: "1d",
      fields: [{ id: "x", kind: "text", label: "X" }],
    },
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

describe.runIf(PHASE)("one process of a person's step", () => {
  it(`phase ${PHASE}`, { timeout: 90_000 }, async () => {
    const client = await import("../src/db/client");
    await client.migrateControlDb();
    const runner = await import("../src/engine/runner");
    const wizards = await import("../src/services/wizards");
    const notices = await import("../src/engine/notices");
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
      await until(async () => (await row(id))?.status === "waiting_input");
      say(`WAITS ${id}`);
      // The process is gone without a word: nothing of the wait may have been in it.
      process.kill(process.pid, "SIGKILL");
      await new Promise(() => undefined);
    }

    const id = process.env.PERSON_RUN ?? "";
    const before = await row(id);
    const reminders = () =>
      withTenant(T, () => db.query.notice.findMany({ where: eq(schema.notice.runId, id) }));
    const due = (await reminders()).find((n) => n.kind === "reminder");
    say(`FOUND status=${before?.status} wake=${(await line(id))?.wakeAt?.getTime() === before?.wakeAt?.getTime()} reminder=${Boolean(due?.dueAt)}`);
    if (PHASE === "answer") {
      runner.startRunner();
      await withTenant(T, () => runner.submitPage(id, "ask", { x: "after the restart" }));
    } else {
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
    }
    await until(async () => (await row(id))?.status === "done", 60_000);
    await withTenant(T, () => notices.deliverNotices(new Date(Date.now() + 86_400_000 * 3)));
    const r = await row(id);
    say(`END status=${r?.status} output=${JSON.stringify(r?.state.outputs.ask?.json)} kept=${JSON.stringify(r?.state.values)} reminders=${(await reminders()).filter((n) => n.kind === "reminder").length}`);
    await runner.stopRunner();
    expect(r?.status).toBe("done");
  });
});
