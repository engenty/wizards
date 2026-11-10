import { useQuickJs, WIZARD_CODE_MEMORY_MB } from "@engenty/wizards-engine/quickjs";
import type { QuickJsCodeModeTransport } from "@mastra/quickjs";
import { onDemand } from "../on-demand.js";

/**
 * The QuickJS a wizard's own code runs on in the runtime: a code step (the engine's code-step.ts)
 * and its function tools (wizard-code.ts, ../tools/wizard.ts). The engine gets it here.
 */

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

useQuickJs(quickJs());
