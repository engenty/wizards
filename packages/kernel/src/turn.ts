import type { Ask, Replay, RunView, Spec, Turn } from "./types";

const tick = () => new Promise<void>((done) => setTimeout(done, 0));

/**
 * One run of a step or an eval from its top. `ask` gives back the answer of a row that has one,
 * and a promise that stays open otherwise. The turn is over when the function returned or threw,
 * or when it stands at an ask without an answer.
 *
 * The function runs as ordinary code in the runner's own process: what keeps it from other
 * tenants is that the runner is one tenant's, or one wizard's. A step is still meant to do
 * nothing but compute and ask, because it runs again from its top when an answer comes. One that
 * waits for anything else is given `patience` milliseconds and then fails.
 */
export async function turn(
  fn: (run: RunView<any>, ask: Ask) => Promise<unknown>,
  seen: Omit<RunView, "count"> & { counts: Record<string, number> },
  replay: Replay,
  patience = 5000,
): Promise<Turn> {
  const asks: Spec[] = [];
  let end: Turn["end"];
  const ask = ((spec: Spec) => {
    const row = replay[asks.push(JSON.parse(JSON.stringify(spec))) - 1];
    if (!row) return new Promise(() => {});
    return "error" in row ? Promise.reject(new Error(row.error)) : Promise.resolve(row.answer);
  }) as Ask;
  // A copy: the step reads the run, it cannot change the rows it is worked out from.
  const { counts, ...rest } = structuredClone(seen);
  const run = Object.freeze({ ...rest, count: (id: string) => counts[id] ?? 0 });

  Promise.resolve()
    .then(() => fn(run, ask))
    .then(
      (result) => {
        end = { done: (result ?? {}) as { value?: unknown; to?: string } };
      },
      (error) => {
        end = { error: error instanceof Error ? error.message : String(error) };
      },
    );

  const until = Date.now() + patience;
  for (;;) {
    await tick();
    if (end) break;
    if (asks.some((_, i) => !replay[i])) break; // it stands at an ask
    if (Date.now() > until) {
      end = { error: "The step waits for something that is not an ask." };
      break;
    }
  }
  return { asks, end };
}
