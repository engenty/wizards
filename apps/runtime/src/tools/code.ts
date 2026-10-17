import { AsyncLocalStorage } from "node:async_hooks";
import { createCodeMode, createTool, noopObserve, type ToolObserve } from "@mastra/core/tools";
import { QuickJsCodeModeTransport } from "@mastra/quickjs";
import type { z } from "zod";
import type { StepContext } from "../engine/types.js";
import { clip } from "./shared.js";

export interface CodeLimits {
  timeoutMs: number;
  maxCalls: number;
  maxParallel: number;
  resultChars: number;
  logChars: number;
}

/**
 * Code Mode: the model writes one TypeScript program that calls the step's tools as
 * `external_*` functions — loops, `Promise.all`, filtering and sums — and only what the program
 * returns goes back to the model.
 *
 * The program runs in QuickJS compiled to WebAssembly, inside the server process. It has no
 * files, network, timers or modules: its only way out are the step's own tools, which run on
 * the server exactly as when the model calls them. Every run gets a fresh runtime with its own
 * heap. The limits below keep one program from tying up the server or a site it calls.
 */
export const CODE_LIMITS: CodeLimits = {
  /** Wall time of one program, its tool calls included. */
  timeoutMs: 120_000,
  /** Tool calls one program may make. */
  maxCalls: 100,
  /** Tool calls of one program running at the same time. */
  maxParallel: 4,
  /** Characters of the program's answer the model reads. */
  resultChars: 20_000,
  /** Characters of `console.log` output the model reads. */
  logChars: 4000,
};

/** The id of the tool, the way the model calls it. */
export const CODE_TOOL_ID = "execute_typescript";

const program = new AsyncLocalStorage<true>();

/**
 * Whether a tool is running for a program. Nobody can be asked from inside one: a tool that needs
 * the person's yes refuses there and tells the model to call it directly.
 */
export function inProgram(): boolean {
  return program.getStore() === true;
}

/** Heap of one program's QuickJS runtime. */
const MEMORY_LIMIT_MB = 64;

/** One transport for the process; it loads the WebAssembly module once, on the first program. */
let transport: QuickJsCodeModeTransport | null = null;
function quickJs(): QuickJsCodeModeTransport {
  transport ??= new QuickJsCodeModeTransport({ memoryLimitMb: MEMORY_LIMIT_MB });
  return transport;
}

/** Runs at most `max` tasks at a time; the others wait their turn. */
function limiter(max: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (running >= max) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    running++;
    try {
      return await task();
    } finally {
      running--;
      waiting.shift()?.();
    }
  };
}

/** What a program may call: tools the server runs itself (a provider's own search has no `execute`). */
function callable(tools: Record<string, any>): Record<string, any> {
  return Object.fromEntries(
    Object.entries(tools).filter(([, tool]) => typeof tool?.execute === "function"),
  );
}

/**
 * Wraps each tool for one program run: the call count and the calls in flight are capped, and the
 * tool knows it runs for a program (`inProgram`).
 */
function guarded(tools: Record<string, any>, ctx: Pick<StepContext, "signal">, limits: CodeLimits) {
  let calls = 0;
  const slot = limiter(limits.maxParallel);
  return Object.fromEntries(
    Object.entries(tools).map(([key, tool]) => [
      key,
      {
        ...tool,
        execute: (input: unknown, options: unknown) => {
          calls++;
          if (calls > limits.maxCalls) {
            throw new Error(
              `A program makes at most ${limits.maxCalls} tool calls. Split the work.`,
            );
          }
          if (ctx.signal.aborted) {
            throw new Error("The run was stopped.");
          }
          return slot(() => program.run(true, () => tool.execute(input, options)));
        },
      },
    ]),
  );
}

/**
 * The `execute_typescript` tool over `tools`, and the instructions that tell the model how to
 * write a program. Null when there is nothing a program could call.
 */
export function codeTool(
  tools: Record<string, any>,
  ctx: Pick<StepContext, "emit" | "signal">,
  limits: CodeLimits = CODE_LIMITS,
): { tool: any; instructions: string } | null {
  const reachable = callable(tools);
  if (!Object.keys(reachable).length) {
    return null;
  }
  const config = { id: CODE_TOOL_ID, tools: reachable, timeout: limits.timeoutMs };
  // The instructions list the tools once; every program runs over fresh guards.
  const { tool: base, instructions } = createCodeMode(config, quickJs());
  const tool = createTool({
    id: CODE_TOOL_ID,
    description:
      "Run a TypeScript program that calls your tools as external_* functions: loops, Promise.all, filtering, sums. Only what it returns comes back to you. Use it when a task needs many tool calls or arithmetic over their results.",
    inputSchema: base.inputSchema as z.ZodType<{ code: string }>,
    execute: async (input, options) => {
      await ctx.emit("tool", { code: "runsProgram" });
      const run = createCodeMode(
        { ...config, tools: guarded(reachable, ctx, limits) },
        quickJs(),
      ).tool;
      // Spans need a run being traced; a call without one still runs.
      const result = (await run.execute?.(input, {
        ...(options as object),
        observe: (options as { observe?: ToolObserve })?.observe ?? noopObserve,
      } as any)) as {
        success: boolean;
        result?: unknown;
        logs?: string[];
        error?: { message: string; name?: string; line?: number };
      };
      const logs = result.logs?.length ? clip(result.logs.join("\n"), limits.logChars) : "";
      if (!result.success) {
        return { success: false, error: result.error, ...(logs ? { logs } : {}) };
      }
      const answer =
        typeof result.result === "string"
          ? result.result
          : (JSON.stringify(result.result ?? null) ?? "null");
      return {
        success: true,
        result:
          answer.length > limits.resultChars ? clip(answer, limits.resultChars) : result.result,
        ...(logs ? { logs } : {}),
      };
    },
  });
  return {
    tool,
    instructions: `${instructions}\n\nA program makes at most ${limits.maxCalls} tool calls, ${limits.maxParallel} at a time, and stops after ${limits.timeoutMs / 1000} seconds. Return only what you need: a long answer is cut at ${limits.resultChars} characters. A tool that asks the person first cannot run from a program: call it directly.`,
  };
}
