import RELEASE_SYNC from "@jitl/quickjs-wasmfile-release-sync";
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSDeferredPromise,
  type QuickJSWASMModule,
} from "quickjs-emscripten-core";
import { transform } from "sucrase";

/**
 * Where a wizard's own code runs: a code step (code-step.ts) and, in the runtime, its function
 * tools and the programs an agent writes with the `code` tool. QuickJS compiled to WebAssembly,
 * a fresh runtime with its own heap for every program, no files, network, timers or modules; the
 * only way out is the `external_<id>` functions, which call `dispatch`.
 *
 * A program is TypeScript or JavaScript, the body of an async function. Sucrase takes the types
 * out (`typescript` only: what is JavaScript stays as it is). QuickJS's synchronous build: each
 * `external_*` call hands the program a promise and returns at once, so any number of calls can
 * be under way together; the host settles the promise when the call ends and runs the program's
 * pending jobs.
 */

/** Heap of one run of a wizard's code. */
export const WIZARD_CODE_MEMORY_MB = 32;

/** Stack of one program, in bytes: deep recursion fails in QuickJS before it reaches the host's. */
const MAX_STACK_SIZE_BYTES = 262_144;
/** How long the jobs a program left may run while they are drained. */
const DRAIN_BUDGET_MS = 50;
/** At most this many drain passes, so a queue that fills itself again ends. */
const MAX_DRAIN_PASSES = 10;
/**
 * How many times QuickJS asks its interrupt handler, counted as one millisecond of a program's
 * time where the clock stands still while code runs (`countQuickJsInterrupts`). QuickJS asks
 * about every ten thousand jumps and calls: a loop of plain arithmetic asks some 16 times a
 * millisecond on a laptop, one that spends its time in built-ins far less.
 */
const INTERRUPTS_PER_MS = 30;

/** Programs are stopped by QuickJS's count as well as by the clock. */
let counted = false;

/**
 * For a host whose clock stands still while code runs (workerd's `Date.now()`): a program's time
 * is also counted in QuickJS's calls of its interrupt handler, so a loop that never ends still
 * meets its timeout. Elsewhere the clock alone stops it, as it always has.
 */
export function countQuickJsInterrupts(on = true): void {
  counted = on;
}

/** What a run of a program gives back. */
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

export interface QuickJsRun {
  /** TypeScript or JavaScript, the body of an async function. */
  program: string;
  /** Allow-listed tool ids, each called as `external_<id>` (`externalName`). */
  toolIds: string[];
  dispatch(tool: string, args: unknown): Promise<unknown>;
  /** Wall time of the program, in milliseconds; also counted where the host asks for it (`countQuickJsInterrupts`). */
  timeout: number;
  abortSignal?: AbortSignal;
  onExternalCall?(tool: string, args: unknown): void;
  onExternalResult?(tool: string, durationMs: number, error?: unknown): void;
}

/** Runs programs in QuickJS; Mastra's code mode takes it as its transport. */
export interface QuickJs {
  /** Its own boundary: no sandbox needed around it. */
  readonly requiresSandbox: false;
  run(opts: QuickJsRun): Promise<QuickJsResult>;
}

/** The name of a tool's function in a program: `external_` and this. */
export function externalName(toolId: string): string {
  const cleaned = toolId.replace(/[^A-Za-z0-9_$]/g, "_");
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(cleaned) ? cleaned : `_${cleaned}`;
}

/** QuickJS's `.wasm` as its host imported it; null: the variant loads the file itself. */
let imported: WebAssembly.Module | null = null;

/**
 * For a host that compiles no WebAssembly from bytes (workerd): QuickJS's `.wasm`
 * (`@jitl/quickjs-wasmfile-release-sync/wasm`), imported as a module by the host's bundle.
 * Called before the first program.
 */
export function useQuickJsWasm(module: WebAssembly.Module): void {
  imported = module;
  loading = null;
}

/** QuickJS's WebAssembly module, loaded once for the process on the first program. */
let loading: Promise<QuickJSWASMModule> | null = null;
function wasm(): Promise<QuickJSWASMModule> {
  loading ??= newQuickJSWASMModuleFromVariant(
    imported ? newVariant(RELEASE_SYNC, { wasmModule: imported }) : RELEASE_SYNC,
  );
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

/** QuickJS with a heap of `memoryLimitMb` for each program. */
export function quickJs({ memoryLimitMb }: { memoryLimitMb: number }): QuickJs {
  return { requiresSandbox: false, run: (opts) => runProgram(opts, memoryLimitMb) };
}

/** The program without its types, as an async function; an error where it doesn't parse. */
function stripped(program: string): string {
  return transform(`(async () => {\n${program}\n})`, {
    transforms: ["typescript"],
    disableESTransforms: true,
    keepUnusedImports: true,
  }).code;
}

async function runProgram(opts: QuickJsRun, memoryLimitMb: number): Promise<QuickJsResult> {
  const { program, toolIds, dispatch, timeout, abortSignal, onExternalCall, onExternalResult } =
    opts;
  const externals = toolIds.map((toolId) => ({ toolId, externalName: externalName(toolId) }));
  const allowed = new Set(toolIds);
  const logs: string[] = [];
  const notifyCall = (tool: string, args: unknown) => {
    try {
      onExternalCall?.(tool, args);
    } catch {}
  };
  const notifyResult = (tool: string, durationMs: number, error?: unknown) => {
    try {
      onExternalResult?.(tool, durationMs, error);
    } catch {}
  };
  let body: string;
  try {
    body = stripped(program);
  } catch (error) {
    return {
      success: false,
      logs,
      error: { message: (error as Error)?.message ?? String(error), name: "SyntaxError" },
    };
  }
  const hostCall = async (tool: string, argsJson: string): Promise<string> => {
    const started = Date.now();
    let args: unknown;
    try {
      args = JSON.parse(argsJson);
    } catch {
      args = undefined;
    }
    notifyCall(tool, args);
    if (!allowed.has(tool)) {
      notifyResult(tool, Date.now() - started, new Error("not allowed"));
      return JSON.stringify({
        ok: false,
        error: { message: `Tool "${tool}" is not available in Code Mode`, name: "NotAllowedError" },
      });
    }
    try {
      const result = await dispatch(tool, args);
      const json = JSON.stringify({ ok: true, result });
      notifyResult(tool, Date.now() - started);
      return json;
    } catch (error) {
      const err = error as Error;
      notifyResult(
        tool,
        Date.now() - started,
        error instanceof Error ? error : new Error(String(error)),
      );
      return JSON.stringify({
        ok: false,
        error: { message: err?.message ?? String(error), name: err?.name },
      });
    }
  };

  const module = await wasm();
  const aborted = (): QuickJsResult => ({
    success: false,
    logs,
    error: { message: "Code Mode execution aborted", name: "AbortError" },
  });
  const timedOut = (): QuickJsResult => ({
    success: false,
    logs,
    error: { message: `Code Mode execution timed out after ${timeout}ms`, name: "TimeoutError" },
  });
  if (abortSignal?.aborted) {
    return aborted();
  }
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(memoryLimitMb * 1024 * 1024);
  runtime.setMaxStackSize(MAX_STACK_SIZE_BYTES);
  const context = runtime.newContext();
  const pending = new Set<QuickJSDeferredPromise>();
  let abandoned: { value?: { dispose(): void }; error?: { dispose(): void } } | undefined;
  let finished = false;

  const drainJobs = () => {
    const until = Date.now() + DRAIN_BUDGET_MS;
    let asked = 0;
    runtime.setInterruptHandler(
      () => Date.now() >= until || (counted && ++asked > DRAIN_BUDGET_MS * INTERRUPTS_PER_MS),
    );
    for (let pass = 0; pass < MAX_DRAIN_PASSES && Date.now() < until; pass++) {
      const jobs = runtime.executePendingJobs();
      if ("error" in jobs && jobs.error) {
        jobs.error.dispose();
      } else if (jobs.value === 0) {
        break;
      }
    }
    runtime.removeInterruptHandler();
  };
  const cleanup = () => {
    if (finished) {
      return;
    }
    finished = true;
    for (const deferred of pending) {
      deferred.dispose();
    }
    pending.clear();
    abandoned?.value?.dispose();
    abandoned?.error?.dispose();
    abandoned = undefined;
    drainJobs();
    runtime.setMemoryLimit(-1);
    context.dispose();
    runtime.dispose();
  };
  const pumpJobs = () => {
    if (finished) {
      return;
    }
    const jobs = runtime.executePendingJobs();
    if ("error" in jobs) {
      jobs.error?.dispose();
    }
  };

  const deadline = Date.now() + timeout;
  /** The program's time as QuickJS counts it, for where the clock stands still. */
  let asked = 0;
  const budget = timeout * INTERRUPTS_PER_MS;
  let interrupted: "abort" | "timeout" | undefined;
  runtime.setInterruptHandler(() => {
    if (abortSignal?.aborted) {
      interrupted = "abort";
      return true;
    }
    if (Date.now() >= deadline || (counted && ++asked > budget)) {
      interrupted = "timeout";
      return true;
    }
    return false;
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const call = context.newFunction("__hostCall", (toolHandle, argsHandle) => {
      const tool = context.getString(toolHandle);
      const argsJson = context.getString(argsHandle);
      const deferred = context.newPromise();
      pending.add(deferred);
      hostCall(tool, argsJson).then((json) => {
        if (finished) {
          return;
        }
        const resultHandle = context.newString(json);
        deferred.resolve(resultHandle);
        resultHandle.dispose();
        pending.delete(deferred);
        deferred.dispose();
      });
      deferred.settled.then(pumpJobs);
      return deferred.handle;
    });
    context.setProp(context.global, "__hostCall", call);
    call.dispose();
    const log = context.newFunction("__hostLog", (messageHandle) => {
      logs.push(context.getString(messageHandle));
    });
    context.setProp(context.global, "__hostLog", log);
    log.dispose();

    const bootstrap = context.evalCode(`
        (() => {
          const __hostCall = globalThis.__hostCall;
          const __hostLog = globalThis.__hostLog;
          delete globalThis.__hostCall;
          delete globalThis.__hostLog;

          const __rpc = (tool, args) => {
            let argsJson;
            try {
              argsJson = JSON.stringify(args === undefined ? null : args);
            } catch (e) {
              return Promise.reject(
                new Error('Arguments passed to an external_* function must be JSON-serializable'),
              );
            }
            return __hostCall(String(tool), argsJson).then((json) => {
              const res = JSON.parse(json);
              if (res.ok) return res.result;
              const err = new Error((res.error && res.error.message) || 'external tool failed');
              if (res.error && res.error.name) err.name = res.error.name;
              throw err;
            });
          };

          const __safeStringify = (value) => {
            try { return JSON.stringify(value); } catch { return String(value); }
          };
          const __log = (args) => {
            __hostLog(args.map((a) => (typeof a === 'string' ? a : __safeStringify(a))).join(' '));
          };
          globalThis.console = Object.freeze({
            log: (...args) => __log(args),
            info: (...args) => __log(args),
            warn: (...args) => __log(args),
            error: (...args) => __log(args),
          });

          for (const { externalName, toolId } of ${JSON.stringify(externals)}) {
            globalThis['external_' + externalName] = (input) => __rpc(toolId, input);
          }
        })()
      `);
    if (bootstrap.error) {
      const err = context.dump(bootstrap.error);
      bootstrap.error.dispose();
      return {
        success: false,
        logs,
        error: { message: err?.message ?? "Code Mode bootstrap failed" },
      };
    }
    bootstrap.value.dispose();

    const evaluated = context.evalCode(`
        (async () => {
          const __user = ${body}
          try {
            const __result = await __user();
            try {
              const json = JSON.stringify({ ok: true, value: __result });
              return json === undefined ? '{"ok":true}' : json;
            } catch {
              return JSON.stringify({
                ok: false,
                error: { message: 'Code Mode result is not JSON-serializable', name: 'TypeError' },
              });
            }
          } catch (e) {
            return JSON.stringify({
              ok: false,
              error: { message: (e && e.message) || String(e), name: e && e.name },
            });
          }
        })()
      `);
    if (evaluated.error) {
      const err = context.dump(evaluated.error);
      evaluated.error.dispose();
      if (interrupted === "abort" || abortSignal?.aborted) {
        return aborted();
      }
      if (interrupted === "timeout") {
        return timedOut();
      }
      return {
        success: false,
        logs,
        error: { message: err?.message ?? "Code Mode evaluation failed", name: err?.name },
      };
    }

    const guest = context.resolvePromise(evaluated.value);
    evaluated.value.dispose();
    guest.then((result) => {
      if (!finished) {
        abandoned = result;
      }
    });
    pumpJobs();
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), Math.max(0, deadline - Date.now()));
    });
    const abortPromise = new Promise<"abort">((resolve) => {
      if (!abortSignal) {
        return;
      }
      if (abortSignal.aborted) {
        resolve("abort");
        return;
      }
      onAbort = () => resolve("abort");
      abortSignal.addEventListener("abort", onAbort, { once: true });
    });
    const outcome = await Promise.race([
      guest.then((result) => ({ kind: "settled" as const, result })),
      timeoutPromise.then(() => ({ kind: "timeout" as const, result: undefined })),
      abortPromise.then(() => ({ kind: "abort" as const, result: undefined })),
    ]);
    if (outcome.kind !== "settled") {
      drainJobs();
      await Promise.resolve();
      return outcome.kind === "abort" ? aborted() : timedOut();
    }
    const settled = outcome.result;
    abandoned = undefined;
    if (settled.error) {
      const err = context.dump(settled.error);
      settled.error.dispose();
      if (interrupted === "abort" || abortSignal?.aborted) {
        return aborted();
      }
      if (interrupted === "timeout") {
        return timedOut();
      }
      return {
        success: false,
        logs,
        error: { message: err?.message ?? "Code Mode evaluation failed", name: err?.name },
      };
    }
    const json = context.getString(settled.value);
    settled.value.dispose();
    const envelope = JSON.parse(json) as {
      ok: boolean;
      value?: unknown;
      error?: QuickJsResult["error"];
    };
    return envelope.ok
      ? { success: true, result: envelope.value, logs }
      : { success: false, error: envelope.error, logs };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (onAbort) {
      abortSignal?.removeEventListener("abort", onAbort);
    }
    runtime.removeInterruptHandler();
    cleanup();
  }
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
