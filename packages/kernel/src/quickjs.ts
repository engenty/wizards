import type { QuickJSContext, QuickJSWASMModule } from "quickjs-emscripten-core";
import type { Turn, TurnFn } from "./types";

/**
 * A step's code in QuickJS: the second way to run a step, for code that is not the host's own.
 * A fresh runtime with its own heap for every turn. The code gets the run to read and `ask`, and
 * nothing else: no files, network, timers or modules. The clock stands still and `Math.random`
 * is seeded, so a step that runs again from its top makes the same asks.
 *
 * A step comes here as a script that sets `__step` (`compile.ts`). A turn never waits: `ask`
 * gives back the answer of a row that has one, and a promise that stays open otherwise. When no
 * job is left the turn is over.
 *
 * `load` gives a fresh QuickJS module. It is called once, and again after a turn that broke the
 * module: a step that takes all its memory leaves QuickJS unable to free its runtime, and the
 * WebAssembly instance aborts.
 */
export function quickjsTurn(
  load: () => Promise<QuickJSWASMModule> = async () => {
    const [{ newQuickJSWASMModuleFromVariant }, variant] = await Promise.all([
      import("quickjs-emscripten-core"),
      import("@jitl/quickjs-wasmfile-release-sync"),
    ]);
    return newQuickJSWASMModuleFromVariant(variant.default);
  },
  { memoryMb = 32, maxInterrupts = 20_000 } = {},
): TurnFn {
  let module: Promise<QuickJSWASMModule> | undefined;
  return async (source, seen, replay): Promise<Turn> => {
    if (typeof source !== "string")
      return {
        asks: [],
        end: { error: "This step is not compiled; this host runs steps in QuickJS." },
      };
    module ??= load();
    const quickjs = await module;
    const runtime = quickjs.newRuntime();
    runtime.setMemoryLimit(memoryMb * 1024 * 1024);
    // Counted, not timed: in a Worker the clock does not move while code runs.
    let interrupts = 0;
    runtime.setInterruptHandler(() => ++interrupts > maxInterrupts);
    const vm = runtime.newContext();
    try {
      evaluate(
        vm,
        `${prelude({ view: seen, replay, now: Date.parse(seen.today), seed: seedOf(seen) })};0`,
      );
      evaluate(vm, `${source};0`);
      evaluate(vm, `${START};0`);
      const jobs = runtime.executePendingJobs();
      if (jobs.error) {
        try {
          return { asks: [], end: { error: message(vm.dump(jobs.error)) } };
        } finally {
          jobs.error.dispose();
        }
      }
      return JSON.parse(evaluate(vm, "JSON.stringify({ asks: __asks, end: __end })"));
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
  };
}

/** The same for every turn of one visit of a step: what it read so far decides it. */
const seedOf = (seen: { counts: Record<string, number>; last?: unknown }) =>
  [...JSON.stringify([seen.counts, seen.last ?? null])].reduce(
    (seed, char) => (Math.imul(seed, 31) + char.charCodeAt(0)) | 0,
    7,
  );

const message = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String((error as { message: unknown }).message)
    : String(error);

function evaluate(vm: QuickJSContext, code: string): string {
  const result = vm.evalCode(code, "step.js");
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
// The two globals of every other place code runs in that QuickJS lacks and a step is likely to use.
{
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  globalThis.btoa = (text) => {
    let out = "";
    for (let i = 0; i < text.length; i += 3) {
      const [a, b, c] = [text.charCodeAt(i), text.charCodeAt(i + 1), text.charCodeAt(i + 2)];
      if (a > 255 || b > 255 || c > 255) throw new Error("btoa takes Latin-1 text.");
      const n = (a << 16) | ((b || 0) << 8) | (c || 0);
      out += A[n >> 18] + A[(n >> 12) & 63] + (i + 1 < text.length ? A[(n >> 6) & 63] : "=") + (i + 2 < text.length ? A[n & 63] : "=");
    }
    return out;
  };
  globalThis.atob = (text) => {
    const clean = String(text).replace(/=+$/, "");
    let out = "";
    for (let i = 0; i < clean.length; i += 4) {
      const n = [0, 1, 2, 3].reduce((sum, k) => (sum << 6) | Math.max(0, A.indexOf(clean[i + k] ?? "A")), 0);
      out += String.fromCharCode(n >> 16);
      if (i + 2 < clean.length) out += String.fromCharCode((n >> 8) & 255);
      if (i + 3 < clean.length) out += String.fromCharCode(n & 255);
    }
    return out;
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
