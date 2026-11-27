import type { AskRow } from "@engenty/wizards-kernel";
import type { WizardDefinition } from "@engenty/wizards-shared/definition";
import type { KernelFile, OutlineValue, StepOutline } from "@engenty/wizards-shared/kernel-file";
import type { OutlineStep } from "@engenty/wizards-shared/marketplace-entry";
import { stepOf } from "./batteries.js";
import { stepOutline } from "./outline.js";

/**
 * A wizard in version 0.3.0 as a template's page shows it (docs/plans/kernel.md): its steps in the
 * order of the map, read from their files without running them, and the asks they make as the
 * steps of version 0.2.0 they stand for, so the price is worked out as for every wizard.
 */

/** What an ask passes, where it is written out: a value worked out by code is left out. */
const written = (spec: Record<string, OutlineValue> | undefined): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(spec ?? {}).filter(
      ([, value]) => !(value && typeof value === "object" && "$code" in (value as object)),
    ),
  );

/** The steps in the order the map reaches them: the first, then each one's ways. */
function inOrder(file: KernelFile): string[] {
  const seen: string[] = [];
  const queue = [file.start];
  while (queue.length) {
    const id = queue.shift() as string;
    if (id === "end" || seen.includes(id)) continue;
    seen.push(id);
    queue.push(...(file.edges[id] ?? []));
  }
  return [...seen, ...Object.keys(file.edges).filter((id) => !seen.includes(id))];
}

/** Each step's file read, by id; a file that is not there reads as a step with no asks. */
async function outlines(
  file: KernelFile,
  files: Record<string, Buffer | string>,
): Promise<Map<string, StepOutline>> {
  const out = new Map<string, StepOutline>();
  for (const id of inOrder(file)) {
    const source = files[`steps/${id}.ts`];
    out.set(
      id,
      source === undefined
        ? { asks: [], ways: [] }
        : await stepOutline(typeof source === "string" ? source : source.toString("utf8")),
    );
  }
  return out;
}

/** The kind of a step, as a template's page names it: what its first ask is, else a model's. */
const kindOf = (step: StepOutline) => String(written(step.asks[0]?.spec).type ?? "agent");

export async function kernelCatalog(
  definition: WizardDefinition,
  files: Record<string, Buffer | string>,
): Promise<{ outline: OutlineStep[]; priced: WizardDefinition }> {
  const file = definition.kernel as KernelFile;
  const read = await outlines(file, files);
  const outline: OutlineStep[] = [...read].map(([id, step]) => {
    const first = written(step.asks[0]?.spec);
    return {
      id,
      type: kindOf(step),
      title: step.title ?? id,
      ...(typeof first.asset === "string" ? { asset: first.asset } : {}),
      ...((file.edges[id] ?? []).length > 1
        ? { branches: (file.edges[id] ?? []).slice(1).map((to) => ({ to, when: "" })) }
        : {}),
    };
  });
  // The asks a model answers, as steps: the price reads their class and what they make.
  const steps = [...read].flatMap(([id, step]) =>
    step.asks
      .map(
        (ask, n): Record<string, unknown> => ({
          ...written(ask.spec),
          n,
          step: id,
          role: "",
          state: "waiting",
        }),
      )
      .filter((row) =>
        ["agent", "decision", "generate", "widget", "motion-graphics"].includes(String(row.type)),
      )
      .map((row) => ({ ...stepOf(definition, row as unknown as AskRow), id: `${id}.${row.n}` })),
  );
  return { outline, priced: { ...definition, steps } as WizardDefinition };
}
