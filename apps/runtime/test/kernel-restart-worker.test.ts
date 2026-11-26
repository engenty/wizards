import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { kernelShell } from "@engenty/wizards-shared/kernel-file";
import { asc, eq } from "drizzle-orm";
import { describe, it, vi } from "vitest";

// One process of kernel-restart-process.test.ts, which starts it per phase on one DATA_DIR. Run
// without a phase, as a test file like any other, it does nothing.
const PHASE = process.env.KERNEL_PHASE;
const DIR = process.env.DATA_DIR ?? "";
const say = (what: string) => appendFileSync(join(DIR, "log"), `${process.pid} ${what}\n`);

vi.mock("../src/engine/steps.js", async (original) => ({
  ...(await original<typeof import("../src/engine/steps.js")>()),
  runAutomaticStep: async (step: { id: string; type: string }) => {
    say(`STEP ${step.id} ${step.type}`);
    return { json: { id: "msg_9" }, at: new Date().toISOString() };
  },
}));
vi.mock("../src/engine/requirements.js", async (original) => ({
  ...(await original<typeof import("../src/engine/requirements.js")>()),
  missingModelsSaid: async () => [],
  missingConnectionsSaid: async () => [],
}));
vi.mock("../src/safety.js", async (original) => ({
  ...(await original<typeof import("../src/safety.js")>()),
  guestChecksOn: async () => false,
}));
vi.mock("../src/credits/credits.js", async (original) => ({
  ...(await original<typeof import("../src/credits/credits.js")>()),
  reserveForRun: async () => true,
  releaseRun: async () => undefined,
}));

const T = "tenant-kernel-restart";

/** One wizard that stands at every kind of wait in turn: a person, a time, a signal, leave. */
const file = {
  version: "0.3.0",
  title: "Across restarts",
  description: "",
  connections: { gmail: { "users.messages.send": "ask" } },
  input: { fields: [{ id: "order", label: "Order", kind: "text", required: true }] },
  start: "check",
  edges: { check: ["nap"], nap: ["paid"], paid: ["send"], send: ["end"] },
  output: { note: "check.note", woke: "nap.timedOut", amount: "paid.amount", sent: "send.id" },
};
const steps = {
  "steps/check.ts": `export default async (run, ask) => ({
  value: await ask({ type: "form", title: "Check", fields: [{ id: "note", label: "Note", kind: "text", required: true }] }),
});
`,
  "steps/nap.ts": `export default async (run, ask) => ({ value: await ask({ type: "wait", timeout: "3s" }) });
`,
  "steps/paid.ts": `export default async (run, ask) => {
  const signal = await ask({ type: "wait", signal: "order.paid", key: run.input.order, fields: ["amount"], timeout: "2d" });
  return { value: { came: signal?.came === true, amount: signal?.data?.amount ?? null } };
};
`,
  "steps/send.ts": `export default async (run, ask) => ({
  value: await ask({ type: "tool", call: "gmail.users.messages.send", input: { userId: "me", body: { raw: run.input.order } } }),
});
`,
};

async function until(ok: () => Promise<boolean>, ms = 60_000) {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (await ok()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out");
}

describe.runIf(PHASE)("one process of a run of version 0.3.0", () => {
  it(`phase ${PHASE}`, { timeout: 90_000 }, async () => {
    const client = await import("../src/db/client");
    await client.migrateControlDb();
    const runner = await import("../src/engine/runner");
    const signals = await import("../src/engine/signals");
    const wizards = await import("../src/services/wizards");
    const files = await import("../src/services/files");
    const { control, controlDb, db, schema, withTenant } = client;
    const row = (id: string) =>
      withTenant(T, () => db.query.run.findFirst({ where: eq(schema.run.id, id) }));
    const line = (id: string) =>
      controlDb.query.runIndex.findFirst({ where: eq(control.runIndex.runId, id) });
    const view = async (id: string) => {
      const run = await row(id);
      return withTenant(T, () => runner.kernelRuns.view(run as never));
    };
    /** The run stands at a wait and no process holds it. */
    const rests = (id: string, status: string) =>
      until(async () => {
        const [run, l] = [await row(id), await line(id)];
        return run?.status === status && !run.driving && l?.active === false && l.owner === null;
      });
    /** The process is gone without a word: nothing of the wait may have been in it. */
    const die = async () => {
      process.kill(process.pid, "SIGKILL");
      await new Promise(() => undefined);
    };
    /** What the next process finds of the run before it does anything. */
    const found = async (id: string) => {
      const [run, v] = [await row(id), await view(id)];
      const waiting = v.waiting.map((r) => `${r.step}:${r.type}`).join(",");
      const wait = await withTenant(T, () =>
        db.query.runWait.findFirst({ where: eq(schema.runWait.runId, id) }),
      );
      say(`FOUND status=${run?.status} cursor=${run?.cursor} waiting=${waiting} wait=${wait?.name ?? "-"}`);
      return v;
    };

    if (PHASE === "start") {
      runner.startRunner();
      const id = await withTenant(T, async () => {
        const made = await wizards.createWizard("u", { definition: kernelShell(file as never) as never });
        await files.seedFiles(made.id, steps);
        return runner.createRun({
          wizardId: made.id,
          definition: kernelShell(file as never) as never,
          files: (await files.draftFiles(made.id)) as never,
          version: null,
          mode: "test",
          userId: "u",
          input: { order: "R-1" },
        });
      });
      await rests(id, "waiting_input");
      say(`AT person ${id}`);
      await die();
    }

    const id = process.env.KERNEL_RUN ?? "";
    const v = await found(id);

    if (PHASE === "person") {
      runner.startRunner();
      await withTenant(T, () => runner.kernelRuns.answer(id, v.waiting[0].n, { note: "go" }, "u"));
      await rests(id, "sleeping");
      say(`AT time ${id}`);
      await die();
    }

    if (PHASE === "time") {
      // The time passes while no process runs.
      const due = (await row(id))?.wakeAt?.getTime() ?? 0;
      await new Promise((r) => setTimeout(r, Math.max(0, due - Date.now()) + 200));
      runner.startRunner();
      await rests(id, "waiting_signal");
      say(`AT signal ${id}`);
      await die();
    }

    if (PHASE === "signal") {
      runner.startRunner();
      const run = await row(id);
      const sent = await withTenant(T, async () =>
        signals.sendSignal({
          spaceId: await runner.spaceIdOf({ wizardId: run?.wizardId ?? "" }),
          scope: signals.wizardScope(run?.wizardId ?? ""),
          name: "order.paid",
          key: "R-1",
          data: { amount: 42 },
          source: "test",
        }),
      );
      say(`SENT runs=${sent.runs}`);
      await rests(id, "waiting_input");
      say(`AT leave ${id}`);
      await die();
    }

    if (PHASE === "leave") {
      runner.startRunner();
      await withTenant(T, () => runner.kernelRuns.answer(id, v.waiting.at(-1)?.n ?? -1, { allow: true }, "u"));
      await until(async () => (await row(id))?.status === "done");
      const rows = await withTenant(T, () =>
        db.select().from(schema.runRow).where(eq(schema.runRow.runId, id)).orderBy(asc(schema.runRow.n)),
      );
      say(`ROWS ${rows.map((r) => `${r.step}:${r.kind}:${r.state ?? "-"}`).join(" ")}`);
      say(`END status=${(await row(id))?.status} output=${JSON.stringify((await view(id)).output)}`);
      await runner.stopRunner();
    }
  });
});
