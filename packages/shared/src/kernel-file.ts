import {
  evalFilesOf,
  KERNEL_VERSION,
  type KernelFile,
  kernelFileSchema,
  kernelIssues,
  kernelRequiresSchema,
  stepFilesOf,
  type WizardDefinition,
} from "./definition.js";
import { CONNECTION_KINDS } from "./store.js";

/**
 * What reads the file of a wizard in version 2 (docs/plans/kernel.md). The file's schema is in
 * definition.ts, beside the definition that carries it.
 */
export {
  evalFilesOf,
  KERNEL_VERSION,
  type KernelFile,
  kernelFileSchema,
  kernelIssues,
  kernelRequiresSchema,
  stepFilesOf,
};

/** The file of a definition the kernel runs; nothing for a wizard in version 1. */
export const kernelOf = (
  definition: { kernel?: KernelFile } | null | undefined,
): KernelFile | undefined => definition?.kernel;

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
