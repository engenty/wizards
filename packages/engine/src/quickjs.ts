/**
 * Where a wizard's own code runs: a code step (code-step.ts) and, in the runtime, its function
 * tools. QuickJS compiled to WebAssembly, a fresh runtime with its own heap for every run, no
 * files, network, timers or modules.
 *
 * The host gives the QuickJS it runs on (`useQuickJs`): the runtime's loads `@mastra/quickjs` on
 * demand. The engine runs QuickJS itself next (docs/plans/runs-on-their-own.md, package 2.1).
 */

/** Heap of one run's QuickJS runtime. */
export const WIZARD_CODE_MEMORY_MB = 32;

/** What a run of a program in QuickJS gives back. */
export interface QuickJsResult {
  /** Whether the program ran to completion without throwing. */
  success: boolean;
  /** The value the program returned. */
  result?: unknown;
  /** Its console output, in order. */
  logs?: string[];
  /** Why it failed. */
  error?: { message: string; name?: string };
}

/** Runs a program in QuickJS: its `external_<id>` calls go to `dispatch`. */
export interface QuickJs {
  run(opts: {
    /** Plain JavaScript or TypeScript, the body of an async function. */
    program: string;
    /** Allow-listed tool ids, each called as `external_<id>`. */
    toolIds: string[];
    dispatch(tool: string, args: unknown): Promise<unknown>;
    timeout: number;
    abortSignal?: AbortSignal;
  }): Promise<QuickJsResult>;
}

let given: QuickJs | null = null;

/** The host's QuickJS, for the code step and whatever else of the host runs a wizard's code. */
export function useQuickJs(quickJs: QuickJs): void {
  given = quickJs;
}

/** The QuickJS the host gave. */
export function quickJs(): QuickJs {
  if (!given) {
    throw new Error("No QuickJS: the host gives one with useQuickJs().");
  }
  return given;
}

/**
 * The wizard's code as the body of a function: `export function run` reads as it would in a
 * module, and the body of a function takes no export. Null when it imports: there are no modules.
 */
export function moduleBody(source: string): string | null {
  if (/^\s*import\s/m.test(source)) {
    return null;
  }
  return source.replace(/^([ \t]*)export\s+(default\s+)?/gm, "$1");
}
