import {
  type KernelFile,
  KERNEL_VERSION,
  kernelFileSchema,
  kernelRequiresSchema,
  type ValidationIssue,
  type WizardDefinition,
} from "./definition.js";

export { type KernelFile, KERNEL_VERSION, kernelFileSchema, kernelRequiresSchema };
import { CONNECTION_KINDS } from "./store.js";

/**
 * A wizard in version 2 of the format (docs/plans/kernel.md): the file. It holds what the wizard
 * needs and may reach, and the map. Nothing about a step is in it: a step is a file of the
 * wizard's workspace, `steps/<id>.ts`, with one function.
 */
/** The file of a definition the kernel runs; nothing for a wizard in version 1. */
export const kernelOf = (definition: { kernel?: KernelFile } | null | undefined): KernelFile | undefined =>
  definition?.kernel;

/** The one step a reader of version 1 sees of a wizard in version 2. */
export const KERNEL_STEP = "result";

/**
 * A definition around a file: what is stored for a wizard in version 2. Everything that reads
 * version 1 finds a whole, small definition; the kernel reads `kernel`. The file's connections
 * are there as version 1 has them, so the broker and the grant know them: a name that is a
 * built-in kind of account is that kind, any other the id of one of the space's connectors.
 * Every action is allowed in that copy, because the kernel is the one that asks.
 */
export function kernelShell(file: KernelFile): WizardDefinition {
  const kinds: readonly string[] = CONNECTION_KINDS;
  const connections = Object.entries(file.connections ?? {}).map(([name, actions]) => ({
    id: name,
    ...(kinds.includes(name) ? { kind: name } : { connector: name }),
    actions: Object.keys(actions),
    policy: Object.fromEntries(Object.keys(actions).map((action) => [action, "allow"])),
  }));
  return {
    version: 1,
    title: file.title,
    description: file.description ?? "",
    avatar: (file.avatar ?? "round") as WizardDefinition["avatar"],
    ...(file.lang ? { lang: file.lang } : {}),
    ...(connections.length ? { connections } : {}),
    steps: [{ id: KERNEL_STEP, type: "result", title: file.title, deliverables: [] }],
    kernel: file,
  } as WizardDefinition;
}

export const STEPS_DIR = "steps/";
export const EVALS_DIR = "evals/";
const CODE = /\.(ts|js|mjs)$/;

/** The steps a workspace has, by id, from its files' paths. */
export const stepFilesOf = (paths: readonly string[]): Record<string, string> =>
  Object.fromEntries(
    paths
      .filter((path) => path.startsWith(STEPS_DIR) && CODE.test(path) && !path.slice(STEPS_DIR.length).includes("/"))
      .map((path) => [path.slice(STEPS_DIR.length).replace(CODE, ""), path]),
  );

/** The evals a workspace has: what each judges, a step's id or `end`, then its name, then its path. */
export function evalFilesOf(paths: readonly string[]): Record<string, Record<string, string>> {
  const evals: Record<string, Record<string, string>> = {};
  for (const path of paths) {
    const [of, name, more] = path.startsWith(EVALS_DIR) ? path.slice(EVALS_DIR.length).split("/") : [];
    if (!of || !name || more !== undefined || !CODE.test(name)) continue;
    evals[of] ??= {};
    evals[of][name.replace(CODE, "")] = path;
  }
  return evals;
}

/**
 * Whether the file and the workspace's files fit, read without running anything: every step the
 * map names has a file, a way leads to every step file, a limit, an output and an eval name a
 * step there is.
 */
export function kernelIssues(file: KernelFile, paths: readonly string[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const steps = stepFilesOf(paths);
  const seen = new Set<string>();
  const todo = [file.start];
  while (todo.length) {
    const id = todo.pop() as string;
    if (id === "end" || seen.has(id)) continue;
    seen.add(id);
    todo.push(...(file.edges[id] ?? []));
  }
  for (const id of seen)
    if (!steps[id]) issues.push({ stepId: id, message: `The map names "${id}", there is no steps/${id}.ts.` });
  for (const id of Object.keys(steps))
    if (!seen.has(id)) issues.push({ stepId: id, message: `No way leads to steps/${id}.` });
  for (const id of Object.keys(file.edges))
    if (!seen.has(id)) issues.push({ stepId: id, message: `"${id}" has ways and none leads to it.` });
  for (const id of Object.keys(file.limits ?? {}))
    if (!steps[id]) issues.push({ message: `A limit names "${id}", there is no such step.` });
  for (const [name, from] of Object.entries(file.output ?? {}))
    if (!steps[from.split(".")[0]])
      issues.push({ message: `The output "${name}" reads "${from}", there is no such step.` });
  for (const of of Object.keys(evalFilesOf(paths)))
    if (of !== "end" && !steps[of]) issues.push({ message: `evals/${of} judges a step there is none of.` });
  return issues;
}
