import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

// One process of pending-jobs-process.test.ts, which starts it per phase on one DATA_DIR. Run
// without a phase, as a test file like any other, it does nothing.
const PHASE = process.env.JOB_PHASE;
const DIR = process.env.DATA_DIR ?? "";
const say = (what: string) => appendFileSync(join(DIR, "log"), `${process.pid} ${what}\n`);

/** The film renders for good in the first process, and at once in the second. */
vi.mock("../src/motion-graphics/step.js", () => ({
  runMotionGraphicsStep: (step: { id: string }) => {
    say(`FILM ${step.id}`);
    return PHASE === "start"
      ? new Promise(() => undefined)
      : Promise.resolve({
          text: `film by ${process.pid}`,
          assets: [],
          at: new Date().toISOString(),
        });
  },
}));
vi.mock("../src/engine/requirements.js", async (original) => ({
  ...(await original<typeof import("../src/engine/requirements.js")>()),
  missingModelsSaid: async () => [],
}));

const T = "tenant-job-process";
const definition = {
  version: 1,
  title: "A film across processes",
  description: "",
  avatar: "round",
  steps: [
    {
      id: "film",
      type: "motion-graphics",
      title: "Film",
      brief: "A short film.",
      skills: ["hyperframes"],
      inputs: {},
      format: "16:9",
    },
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

describe.runIf(PHASE)("one process of a film", () => {
  it(`phase ${PHASE}`, { timeout: 90_000 }, async () => {
    const client = await import("../src/db/client");
    await client.migrateControlDb();
    const runner = await import("../src/engine/runner");
    const wizards = await import("../src/services/wizards");
    const { env } = await import("../src/env");
    const { control, controlDb, db, schema, withTenant } = client;
    const row = (id: string) =>
      withTenant(T, () => db.query.run.findFirst({ where: eq(schema.run.id, id) }));
    const job = (id: string) =>
      withTenant(T, () => db.query.runJob.findFirst({ where: eq(schema.runJob.runId, id) }));
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
        return (
          (await row(id))?.status === "sleeping" &&
          (await job(id))?.status === "running" &&
          l?.active === false &&
          l.owner === null
        );
      });
      say(`ASLEEP ${id} ${env.runner.id}`);
      // The process is gone without a word, in the middle of the film.
      process.kill(process.pid, "SIGKILL");
      await new Promise(() => undefined);
    }

    const id = process.env.JOB_RUN ?? "";
    const asleep = await row(id);
    const left = await job(id);
    say(
      `FOUND status=${asleep?.status} job=${asleep?.state.job?.id === left?.id} jobStatus=${left?.status} owner=${left?.owner}`,
    );
    // The time passes in which the first process would have said it still works on the film, and
    // the run's own look at its job comes.
    const past = new Date(Date.now() - 60_000);
    await withTenant(T, async () => {
      await db.update(schema.runJob).set({ seen: past }).where(eq(schema.runJob.runId, id));
      await db.update(schema.run).set({ wakeAt: past }).where(eq(schema.run.id, id));
    });
    await controlDb
      .update(control.runIndex)
      .set({ wakeAt: past })
      .where(eq(control.runIndex.runId, id));
    runner.startRunner();
    await until(async () => (await row(id))?.status === "done");
    const done = await row(id);
    const finished = await job(id);
    say(
      `END status=${done?.status} text=${done?.state.outputs.film?.text?.replaceAll(" ", "_")} jobStatus=${finished?.status} owner=${finished?.owner === env.runner.id ? "this" : finished?.owner} job=${done?.state.job ? "left" : "gone"}`,
    );
    await runner.stopRunner();
    expect(done?.status).toBe("done");
  });
});
