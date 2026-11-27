import type { Wizard } from "./types.js";

/** Reads a wizard without running it: whether the map and the step files fit. */
export function describe({ file, steps, evals = {} }: Wizard): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  const todo = [file.start];
  while (todo.length) {
    const id = todo.pop() as string;
    if (id === "end" || seen.has(id)) continue;
    seen.add(id);
    todo.push(...(file.edges[id] ?? []));
  }
  for (const id of seen)
    if (!steps[id]) issues.push(`The map names "${id}", there is no steps/${id}.`);
  for (const id of Object.keys(steps))
    if (!seen.has(id)) issues.push(`No way leads to steps/${id}.`);
  for (const id of Object.keys(file.limits ?? {}))
    if (!steps[id]) issues.push(`A limit names "${id}", there is no steps/${id}.`);
  for (const [name, from] of Object.entries(file.output ?? {}))
    if (!steps[from.split(".")[0]])
      issues.push(`The output "${name}" reads "${from}", there is no such step.`);
  for (const of of Object.keys(evals))
    if (of !== "end" && !steps[of]) issues.push(`evals/${of} judges a step there is none of.`);
  return issues;
}
