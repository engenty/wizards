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

/** The file of a definition the kernel runs; nothing for a wizard in version 0.2.0. */
export const kernelOf = (
  definition: { kernel?: KernelFile } | null | undefined,
): KernelFile | undefined => definition?.kernel;

/**
 * The file once a step's file is gone: a way to it goes where it led, and it has no ways or limit
 * of its own. A step left with no way ends the run; a run that started with it starts where it led.
 */
export function withoutStep(file: KernelFile, id: string): KernelFile {
  if (
    file.start !== id &&
    !(id in file.edges) &&
    !Object.values(file.edges).some((w) => w.includes(id))
  ) {
    return file;
  }
  const led = (file.edges[id] ?? []).filter((to) => to !== id);
  const edges = Object.fromEntries(
    Object.entries(file.edges)
      .filter(([from]) => from !== id)
      .map(([from, ways]) => {
        const kept = ways
          .flatMap((to) => (to === id ? led : [to]))
          .filter((to) => to !== from || ways.includes(from));
        const unique = kept.filter((to, i) => kept.indexOf(to) === i);
        return [from, unique.length ? unique : ["end"]];
      }),
  );
  const { [id]: _limit, ...limits } = file.limits ?? {};
  const start =
    file.start === id
      ? (led.find((to) => to !== "end" && to in edges) ?? Object.keys(edges)[0] ?? id)
      : file.start;
  return { ...file, start, edges, ...(file.limits ? { limits } : {}) };
}

/**
 * The file with a step's ways written anew, in their order: none twice, and at least one. A step
 * left without a way ends the run, and so does a step a way now leads to that had none of its own.
 */
export function withWays(file: KernelFile, from: string, ways: readonly string[]): KernelFile {
  const unique = ways.filter((to, i) => ways.indexOf(to) === i);
  const edges = { ...file.edges, [from]: unique.length ? unique : ["end"] };
  for (const to of unique) {
    if (to !== "end" && !(to in edges)) edges[to] = ["end"];
  }
  return { ...file, edges };
}

/** The file with how often a step may be reached in one run; without a number, with no limit. */
export function withLimit(file: KernelFile, id: string, limit: number | undefined): KernelFile {
  const { limits: all, ...bare } = file;
  const { [id]: _was, ...rest } = all ?? {};
  const limits = limit ? { ...rest, [id]: Math.min(Math.max(Math.round(limit), 1), 1000) } : rest;
  return Object.keys(limits).length ? { ...bare, limits } : bare;
}

/** The one step a reader of version 0.2.0 sees of a wizard in version 0.3.0. */
export const KERNEL_STEP = "result";

/**
 * The file's connections as a definition names them: a built-in kind of account is that kind, any
 * other the id of one of the space's connectors. Every action is allowed in that copy, because
 * the kernel is the one that asks.
 */
function shellConnections(file: KernelFile): NonNullable<WizardDefinition["connections"]> {
  const kinds: readonly string[] = CONNECTION_KINDS;
  return Object.entries(file.connections ?? {}).map(([name, actions]) => ({
    id: name,
    ...(kinds.includes(name) ? { kind: name } : { connector: name }),
    actions: Object.keys(actions),
    policy: Object.fromEntries(Object.keys(actions).map((action) => [action, "allow"])),
  })) as NonNullable<WizardDefinition["connections"]>;
}

/**
 * A definition with its file written anew. What the definition copies from the file for the
 * readers of version 0.2.0 follows it: its connections. Everything else of it stays.
 */
export function withKernelFile(def: WizardDefinition, file: KernelFile): WizardDefinition {
  const { connections: _was, ...rest } = def;
  const connections = shellConnections(file);
  return { ...rest, ...(connections.length ? { connections } : {}), kernel: file };
}

/** A list or a record with nothing in it is left out of the file. */
const filled = (value: unknown) =>
  Array.isArray(value) ? value.length > 0 : Object.keys(value ?? {}).length > 0;

/** The file with what the wizard needs from where it runs written anew; nothing empty is kept. */
export function withRequires(
  file: KernelFile,
  requires: NonNullable<KernelFile["requires"]>,
): KernelFile {
  const { requires: _was, ...bare } = file;
  const kept = Object.fromEntries(Object.entries(requires).filter(([, value]) => filled(value)));
  return Object.keys(kept).length ? { ...bare, requires: kept } : bare;
}

/**
 * The file with its connections written anew. A connection stays while it has no action yet: a
 * step that names one of its actions is what fails then, and says so.
 */
export function withConnections(
  file: KernelFile,
  connections: NonNullable<KernelFile["connections"]>,
): KernelFile {
  const { connections: _was, ...bare } = file;
  return Object.keys(connections).length ? { ...bare, connections } : bare;
}

/**
 * A definition around a file: what is stored for a wizard in version 0.3.0. Everything that reads
 * version 0.2.0 finds a whole, small definition; the kernel reads `kernel`. The file's connections
 * are there as version 0.2.0 has them, so the broker and the grant know them: a name that is a
 * built-in kind of account is that kind, any other the id of one of the space's connectors.
 * Every action is allowed in that copy, because the kernel is the one that asks.
 */
export function kernelShell(file: KernelFile): WizardDefinition {
  const connections = shellConnections(file);
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
  /**
   * Where the code picks one of two written-out values: what it asks, and the value for yes and
   * for no. The studio shows such a choice as words.
   */
  $either?: { if: string; then: OutlinePlain; else: OutlinePlain };
}

/** A value written out in full: a text, a number, yes or no. */
export type OutlinePlain = string | number | boolean;

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
