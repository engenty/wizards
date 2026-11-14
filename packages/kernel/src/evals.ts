import { createKernel } from "./kernel.js";
import { memoryStore } from "./memory.js";
import type { AskRow, Battery, Row, Run, Score, Wizard } from "./types.js";

/**
 * Tooling for evals beyond a run's own: a wizard over a dataset, and one ask of a past run asked
 * again. Evals on a real run need none of this: a host calls `kernel.judge`.
 */
export type EvalOptions = { wizard: Wizard; batteries: Record<string, Battery> };

/** One entry of a dataset: an input, and the answers of the people, by step, in order. */
export type Entry = {
  name: string;
  input: Record<string, unknown>;
  answers?: Record<string, unknown[]>;
};

const isWaiting = (row: Row): row is AskRow => !("left" in row) && row.state === "waiting";
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

/** The mean of each eval over a list of scores, and how many of them could not judge. */
export function summary(scores: Score[]) {
  const by: Record<string, { mean?: number; scores: number; errors: number }> = {};
  for (const id of new Set(scores.map((score) => score.eval))) {
    const all = scores.filter((score) => score.eval === id);
    const numbers = all.flatMap((score) => (score.score == null ? [] : [score.score]));
    by[id] = {
      ...(numbers.length && { mean: mean(numbers) }),
      scores: numbers.length,
      errors: all.length - numbers.length,
    };
  }
  return by;
}

/**
 * Runs the wizard on every entry with the batteries given, a real model among them, answers the
 * people's asks from the entry, and judges each run. To compare two models, two prompts or two
 * versions of a step, run it twice.
 */
export async function evaluate({ wizard, batteries }: EvalOptions, dataset: Entry[]) {
  const runs: { name: string; run: Run }[] = [];
  for (const entry of dataset) {
    const kernel = createKernel({
      store: memoryStore(),
      wizards: () => wizard,
      batteries,
    });
    const left = structuredClone(entry.answers ?? {});
    let run = await kernel.start("dataset", entry.input);
    for (
      let row = run.rows.find(isWaiting);
      run.status === "waiting" && row;
      row = run.rows.find(isWaiting)
    ) {
      const answer = left[row.step]?.shift();
      if (answer === undefined) break; // the entry has no more to say: judge the run as far as it came
      run = await kernel.answer(run.id, row.n, answer, row.role);
    }
    runs.push({ name: entry.name, run: await kernel.judge(run.id) });
  }
  return { runs, summary: summary(runs.flatMap(({ run }) => run.scores ?? [])) };
}

/**
 * One ask of a past run, asked again: the run is copied, taken back to row `n` and moved on with
 * the wizard and the batteries given, so the step sees the same history and may have new code or
 * a new model. Gives the scores of that step's evals, as it was and as it is now, both judged
 * with the batteries given.
 */
export async function reask({ wizard, batteries }: EvalOptions, past: Run, n: number) {
  const store = memoryStore();
  const kernel = createKernel({ store, wizards: () => wizard, batteries });
  const copy = (id: string): Run => ({ ...structuredClone(past), id, scores: [], rev: 0 });
  await store.save(copy("before"));
  await store.save(copy("after"));
  const step = past.rows[n].step;
  const ofStep = (run: Run) => {
    const left = run.rows.find((row) => "left" in row && row.step === step && row.n > n);
    return (run.scores ?? []).filter(
      (score) => score.row === left?.n && score.eval.startsWith(`${step}/`),
    );
  };
  const before = await kernel.judge("before");
  await kernel.rewind("after", n);
  const after = await kernel.judge("after");
  return { before: ofStep(before), after: ofStep(after), run: after };
}
