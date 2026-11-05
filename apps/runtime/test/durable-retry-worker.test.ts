import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { APICallError } from "ai";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

// One process of durable-retry-process.test.ts, which starts it per phase on one DATA_DIR. Run
// without a phase, as a test file like any other, it does nothing.
const PHASE = process.env.RETRY_PHASE;
const DIR = process.env.DATA_DIR ?? "";
const say = (what: string) => appendFileSync(join(DIR, "log"), `${process.pid} ${what}\n`);

/** Fails once in the first process, once in the second, and then works. */
let failing = 1;
vi.mock("../src/engine/steps.js", async (original) => ({
  ...(await original<typeof import("../src/engine/steps.js")>()),
  runAutomaticStep: async (step: { id: string }) => {
    say(`STEP ${step.id}`);
    if (step.id === "flaky" && failing > 0) {
      failing--;
      throw new APICallError({
        message: "status 503",
        url: "http://x",
        requestBodyValues: {},
        statusCode: 503,
        isRetryable: true,
      });
    }
    return { text: `made ${step.id}`, at: new Date().toISOString() };
  },
}));
vi.mock("../src/engine/requirements.js", async (original) => ({
  ...(await original<typeof import("../src/engine/requirements.js")>()),
  missingModelsSaid: async () => [],
}));

const T = "tenant-retry-process";
const agent = (id: string) => ({
  id,
  type: "agent",
  title: id,
  instructions: "x",
  tools: [],
  output: { format: "text" },
});
const definition = {
  version: 2,
  title: "Across processes",
  description: "",
  avatar: "round",
  steps: [agent("flaky"), agent("after"), { id: "done", type: "result", title: "Fertig", deliverables: [] }],
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

describe.runIf(PHASE)("one process of a retry", () => {
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
    const rests = async (id: string) => {
      const l = await line(id);
      return (await row(id))?.status === "sleeping" && l?.active === false && l.owner === null;
    };
    const pass = async (id: string) => {
      const past = new Date(Date.now() - 1000);
      await withTenant(T, () =>
        db.update(schema.run).set({ wakeAt: past }).where(eq(schema.run.id, id)),
      );
      await controlDb
        .update(control.runIndex)
        .set({ wakeAt: past })
        .where(eq(control.runIndex.runId, id));
    };

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
      await until(() => rests(id));
      say(`ASLEEP ${id}`);
      // The process is gone without a word: nothing of the retry may have been in it.
      process.kill(process.pid, "SIGKILL");
      await new Promise(() => undefined);
    }

    const id = process.env.RETRY_RUN ?? "";
    const asleep = await row(id);
    say(
      `FOUND status=${asleep?.status} wake=${(await line(id))?.wakeAt?.getTime() === asleep?.wakeAt?.getTime()} pause=${asleep?.state.pause?.kind} count=${asleep?.state.retries?.count}`,
    );
    await pass(id);
    runner.startRunner();
    // It wakes and fails again here: the next wait, with the count it brought along.
    await until(async () => (await row(id))?.state.retries?.count === 2 && (await rests(id)));
    const again = await row(id);
    say(
      `AGAIN count=${again?.state.retries?.count} minutes=${Math.round(((again?.wakeAt?.getTime() ?? 0) - Date.now()) / 60_000)}`,
    );
    await pass(id);
    await until(async () => (await row(id))?.status === "done");
    say(`END status=${(await row(id))?.status}`);
    await runner.stopRunner();
    expect((await row(id))?.status).toBe("done");
  });
});
