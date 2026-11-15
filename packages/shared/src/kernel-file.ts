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
 * What reads the file of a wizard in version 0.3.0 (docs/plans/kernel.md). The file's schema is in
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
    version: file.version,
    title: file.title,
    description: file.description ?? "",
    avatar: (file.avatar ?? "round") as WizardDefinition["avatar"],
    ...(file.lang ? { lang: file.lang } : {}),
    // What stands around the steps is the wizard's, in either format: the page reads it there.
    ...(file.intro ? { intro: file.intro } : {}),
    ...(file.lists?.length ? { lists: file.lists } : {}),
    ...(connections.length ? { connections } : {}),
    steps: [{ id: KERNEL_STEP, type: "result", title: file.title, deliverables: [] }],
    kernel: file,
  } as WizardDefinition;
}

/** Where a step's code works a value out: the code as it is written. */
export interface OutlineCode {
  $code: string;
}

/** A text with parts worked out in code between its words. */
export interface OutlineText {
  $text: (string | OutlineCode)[];
}

/** A value read from a step's code: what is written out, or the code where it is worked out. */
export type OutlineValue =
  | string
  | number
  | boolean
  | null
  | OutlineCode
  | OutlineText
  | OutlineValue[]
  | { [key: string]: OutlineValue };

/** One `ask` of a step: what it passes where that is written out, its code where it is not. */
export interface OutlineAsk {
  spec?: Record<string, OutlineValue>;
  code?: string;
  /**
   * Where each written-out text of `spec` stands in the file, by its path (`fields.1.label`):
   * from, to. What the studio replaces when a person types over the text.
   */
  at?: Record<string, [number, number]>;
}

/** A text as a person typed it over: its words, with the code between them as it was. */
export type OutlineEdit = string | (string | OutlineCode)[];

/** One `return` of a step: the way it names, and the condition around it. */
export interface OutlineWay {
  /** Missing where the step names no way: the first of its ways in the file is taken. */
  to?: string;
  when?: string;
  /** The way in a person's words, where the `return` gives a `why`. */
  why?: string;
  /** Set where a model decides it: the statement that has to hold, from a decision ask's `ways`. */
  ask?: string;
  /** Set where the way is worked out. */
  code?: string;
}

/** What the studio reads of one step file without running it. */
export interface StepOutline {
  /** From the comment at the top of the file. */
  title?: string;
  description?: string;
  asks: OutlineAsk[];
  ways: OutlineWay[];
  /** Why the file could not be read. */
  error?: string;
}

/** A wizard's steps by id, as read from `steps/<id>.ts`. */
export type KernelOutline = Record<string, StepOutline>;

export const isOutlineCode = (value: unknown): value is OutlineCode =>
  typeof value === "object" && value !== null && typeof (value as OutlineCode).$code === "string";

export const isOutlineText = (value: unknown): value is OutlineText =>
  typeof value === "object" && value !== null && Array.isArray((value as OutlineText).$text);
