import type { KernelFile } from "@engenty/wizards-shared/definition";

/**
 * The map of a wizard in version 0.3.0 as the studio draws it (docs/plans/kernel.md): its steps in
 * one column, in an order in which each leads to the next where the map allows, and every other
 * way as a branch beside them.
 */
export interface KernelFlowStep {
  id: string;
  /** Whether the step below it is one of its ways: only then a line joins the two. */
  flowsOn: boolean;
  /** Its other ways: a step, or `end`. */
  branches: { to: string; when: string }[];
  /** How often it may be reached in one run, where the file says. */
  limit?: number;
}

/** The steps that can still be reached from `from` without passing one of `seen`. */
function reach(file: KernelFile, from: string, seen: ReadonlySet<string>): number {
  const found = new Set<string>();
  const todo = [from];
  while (todo.length) {
    const id = todo.pop() as string;
    if (id === "end" || seen.has(id) || found.has(id)) {
      continue;
    }
    found.add(id);
    todo.push(...(file.edges[id] ?? []));
  }
  return found.size;
}

export function kernelFlow(file: KernelFile): KernelFlowStep[] {
  const order: string[] = [];
  const seen = new Set<string>();
  // Every step the map knows, whether or not a way leads to it.
  const all = [file.start, ...Object.keys(file.edges), ...Object.values(file.edges).flat()].filter(
    (id) => id !== "end",
  );
  let at: string | undefined = file.start;
  while (at) {
    order.push(at);
    seen.add(at);
    // Go on by the way that still leads to the most steps, so the column is one path of the map.
    const ways: string[] = (file.edges[at] ?? []).filter((to) => to !== "end" && !seen.has(to));
    at = ways.sort((a, b) => reach(file, b, seen) - reach(file, a, seen))[0];
    at ??= all.find((id) => !seen.has(id));
  }
  return order.map((id, i) => {
    const ways = file.edges[id] ?? [];
    const next = order[i + 1];
    const flowsOn = next !== undefined && ways.includes(next);
    const limit = file.limits?.[id];
    return {
      id,
      flowsOn,
      branches: ways.filter((to) => !(flowsOn && to === next)).map((to) => ({ to, when: "" })),
      ...(limit ? { limit } : {}),
    };
  });
}

/**
 * The texts a person types over where they stand: the short ones of a page, and a step's Auftrag,
 * what an agent is told, a document is made from, a film is briefed with. Every other value is
 * changed with the assistant or in the code.
 */
const WORDS = /(^|\.)(title|description|working|label|placeholder|instructions|prompt|brief)$/;
const OPTION = /^fields\.\d+\.options\.\d+$/;

/** Whether the value at this path of an ask is a text typed over in the step's panel. */
export const typedOver = (path: string): boolean => WORDS.test(path) || OPTION.test(path);
