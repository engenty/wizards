import type { Run, Store } from "./types";

/** A store in memory. Only JSON is kept between two calls, as a database would. */
export function memoryStore(): Store {
  const runs = new Map<string, string>();
  return {
    load: async (id) => (runs.has(id) ? JSON.parse(runs.get(id) as string) : undefined),
    save: async (run: Run) => {
      const kept = runs.get(run.id);
      if (kept && JSON.parse(kept).rev !== run.rev) throw new Error("Someone else moved this run.");
      run.rev++;
      runs.set(run.id, JSON.stringify(run));
    },
  };
}
