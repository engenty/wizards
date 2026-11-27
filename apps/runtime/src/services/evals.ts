import { type Entry, type Score, summary } from "@engenty/wizards-kernel";
import { kernelOf } from "@engenty/wizards-shared/kernel-file";
import { note, RUN_ENDED, type RunStatus } from "@engenty/wizards-shared/run";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { canSpend } from "../credits/credits.js";
import { db, schema } from "../db/client.js";
import { createRun, kernelRuns } from "../engine/runner.js";
import { currentTenant } from "../tenants/tenant.js";
import { notFound, ServiceError } from "./errors.js";
import { ownedWizard, requireClean } from "./wizards.js";

/**
 * A wizard in version 0.3.0 over a dataset (docs/plans/kernel.md, item 14), as `wizards eval`
 * asks for it: each entry a test run of the wizard's draft with the entry's input, its waits
 * answered from the entry, and the run judged by every eval once it stands, whatever share of
 * runs the space judges. The runs are ordinary test runs: the studio shows them with their rows
 * and scores, and what their steps and evals cost is counted as any test run's.
 */

/** One entry of a dataset: an input, and the answers to the run's waits, by step, in order. */
export const datasetSchema = z
  .array(
    z.object({
      name: z.string().min(1).max(200),
      input: z.record(z.string(), z.unknown()).default({}),
      answers: z.record(z.string(), z.array(z.unknown())).optional(),
    }),
  )
  .min(1)
  .max(200);

export type EntryResult = {
  name: string;
  runId: string;
  status: RunStatus;
  error?: string;
  scores: Score[];
};

/** How often a run is looked at while it works, and how long an entry may take at most. */
const LOOK_MS = 250;
const ENTRY_MS = 30 * 60_000;

/** The wizard by its id, else by its title, in this tenant. */
export async function wizardNamed(userId: string, named: string) {
  const byTitle = await db.query.wizard.findFirst({
    columns: { id: true },
    where: and(eq(schema.wizard.tenantId, currentTenant()), eq(schema.wizard.title, named)),
  });
  const id = byTitle?.id ?? named;
  return ownedWizard(userId, id);
}

const rested = async (runId: string, signal: AbortSignal) => {
  const until = Date.now() + ENTRY_MS;
  while (!signal.aborted && Date.now() < until) {
    const run = await db.query.run.findFirst({ where: eq(schema.run.id, runId) });
    if (!run) {
      throw notFound();
    }
    if (!run.driving && run.status !== "running") {
      return run;
    }
    await new Promise((r) => setTimeout(r, LOOK_MS));
  }
  return db.query.run.findFirst({ where: eq(schema.run.id, runId) });
};

/** Runs one entry to where it stands: its end, or a wait the entry has no answer for. */
async function runEntry(
  userId: string,
  w: Awaited<ReturnType<typeof ownedWizard>>,
  { definition, files }: Awaited<ReturnType<typeof requireClean>>,
  entry: Entry,
  signal: AbortSignal,
): Promise<EntryResult> {
  const runId = await createRun({
    wizardId: w.id,
    definition,
    files,
    version: null,
    mode: "test",
    userId,
    unattended: true,
    input: entry.input,
  });
  const left = structuredClone(entry.answers ?? {});
  let run = await rested(runId, signal);
  while (run && !RUN_ENDED.has(run.status) && !signal.aborted) {
    const waiting = (await kernelRuns.view(run)).waiting[0];
    const answer = waiting && left[waiting.step]?.shift();
    // The entry has no more to say: the run is judged as far as it came.
    if (!waiting || answer === undefined) {
      break;
    }
    await kernelRuns.answer(runId, waiting.n, answer, "dataset");
    run = await rested(runId, signal);
  }
  if (!run) {
    throw notFound();
  }
  const scores = signal.aborted ? [] : await kernelRuns.judge(run, signal);
  return {
    name: entry.name,
    runId,
    status: run.status,
    ...(run.error ? { error: run.error } : {}),
    scores,
  };
}

/**
 * Every entry in turn; `each` hears of one as soon as it is judged. Gives the runs and, for each
 * eval, its mean over them and how many could not judge.
 */
export async function evalDataset(
  userId: string,
  wizardId: string,
  dataset: Entry[],
  signal: AbortSignal,
  each: (result: EntryResult) => void | Promise<void> = () => undefined,
) {
  const w = await ownedWizard(userId, wizardId);
  if (!kernelOf(w.draft)) {
    throw new ServiceError("refused", "Only a wizard in version 0.3.0 has evals to run.");
  }
  const clean = await requireClean(w);
  const runs: EntryResult[] = [];
  for (const entry of dataset) {
    if (signal.aborted) {
      break;
    }
    if (!(await canSpend())) {
      throw new ServiceError("no_credits", note("creditsUsedUp"));
    }
    const result = await runEntry(userId, w, clean, entry, signal);
    runs.push(result);
    await each(result);
  }
  return { runs, summary: summary(runs.flatMap((run) => run.scores)) };
}
