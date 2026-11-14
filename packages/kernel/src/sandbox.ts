import type { QuickJSContext, QuickJSWASMModule } from "quickjs-emscripten-core";
import type { Sandbox, Turn } from "./types";

/**
 * Where a step's code runs: QuickJS, a fresh runtime with its own heap for every turn. The code
 * gets the run to read and `ask`, and nothing else: no files, network, timers or modules. The
 * clock stands still and `Math.random` is seeded, so a step that runs again from its top makes
 * the same asks.
 *
 * A turn never waits. `ask` gives back the answer of a row that has one, and a promise that
 * stays open otherwise. When no job is left, the turn is over: the step returned, threw, or
 * stands at asks without an answer.
 *
 * `load` gives a fresh QuickJS module. It is called once, and again after a turn that broke the
 * module: a step that takes all its memory leaves QuickJS unable to free its runtime, and the
 * WebAssembly instance aborts.
 */
export function createSandbox(
  load: () => Promise<QuickJSWASMModule>,
  { memoryMb = 32, maxInterrupts = 20_000 } = {},
): Sandbox {
  let module: Promise<QuickJSWASMModule> | undefined;
  return {
    async run(source, view, replay, fixed): Promise<Turn> {
      module ??= load();
      const quickjs = await module;
      const runtime = quickjs.newRuntime();
      runtime.setMemoryLimit(memoryMb * 1024 * 1024);
      // Counted, not timed: in a Worker the clock does not move while code runs.
      let interrupts = 0;
      runtime.setInterruptHandler(() => ++interrupts > maxInterrupts);
      const vm = runtime.newContext();
      try {
        evaluate(vm, `${prelude({ view, replay, ...fixed })};0`, "kernel.js");
        evaluate(vm, `${source};0`, "step.js");
        evaluate(vm, `${START};0`, "kernel.js");
        const jobs = runtime.executePendingJobs();
        if (jobs.error) {
          try {
            return { asks: [], end: { error: message(vm.dump(jobs.error)) } };
          } finally {
            jobs.error.dispose();
          }
        }
        return JSON.parse(
          evaluate(vm, "JSON.stringify({ asks: __asks, end: __end })", "kernel.js"),
        );
      } catch (error) {
        return { asks: [], end: { error: message(error) } };
      } finally {
        try {
          vm.dispose();
          runtime.dispose();
        } catch {
          module = undefined;
        }
      }
    },
  };
}

const message = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String((error as { message: unknown }).message)
    : String(error);

function evaluate(vm: QuickJSContext, code: string, file: string): string {
  const result = vm.evalCode(code, file);
  if (result.error) {
    try {
      throw new Error(message(vm.dump(result.error)));
    } finally {
      result.error.dispose();
    }
  }
  try {
    return vm.dump(result.value);
  } finally {
    result.value.dispose();
  }
}

const prelude = (data: unknown) => `"use strict";
const __in = JSON.parse(${JSON.stringify(JSON.stringify(data))});
{
  const Real = Date, at = __in.now;
  globalThis.Date = class extends Real {
    constructor(...args) { if (args.length) super(...args); else super(at); }
    static now() { return at; }
  };
  let seed = __in.seed;
  Math.random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const __asks = [];
let __end;
const __ask = (spec) => {
  const row = __in.replay[__asks.push(spec) - 1];
  if (!row) return new Promise(() => {});
  return "error" in row ? Promise.reject(new Error(row.error)) : Promise.resolve(row.answer);
};
const __run = Object.freeze({ ...__in.view, count: (id) => __in.view.counts[id] ?? 0 });
`;

const START = `
Promise.resolve()
  .then(() => __step.default(__run, __ask))
  .then(
    (result) => { __end = { done: result ?? {} }; },
    (error) => { __end = { error: String((error && error.message) || error) }; },
  );
`;
