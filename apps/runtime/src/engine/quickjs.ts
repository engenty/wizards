import type { QuickJsCodeModeTransport } from "@mastra/quickjs";
import { onDemand } from "../on-demand.js";

/**
 * Where a wizard's own code runs: a code step (code-step.ts) and its function tools
 * (wizard-code.ts, ../tools/wizard.ts). QuickJS compiled to WebAssembly, a fresh runtime with its
 * own heap for every run, no files, network, timers or modules.
 */

/** Heap of one run's QuickJS runtime. */
export const WIZARD_CODE_MEMORY_MB = 32;

/**
 * One transport for the process; it loads QuickJS (on demand: ../on-demand.ts) and its
 * WebAssembly module once, on the first run.
 */
let transport: Promise<QuickJsCodeModeTransport> | null = null;
export function quickJs(): Pick<QuickJsCodeModeTransport, "run"> {
  return {
    run: async (opts) => {
      transport ??= onDemand<typeof import("@mastra/quickjs")>("@mastra/quickjs").then(
        ({ QuickJsCodeModeTransport }) =>
          new QuickJsCodeModeTransport({ memoryLimitMb: WIZARD_CODE_MEMORY_MB }),
      );
      transport.catch(() => {
        transport = null;
      });
      return (await transport).run(opts);
    },
  };
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
