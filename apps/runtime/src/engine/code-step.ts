import { type CodeStep, dataRef, stepShape } from "@engenty/wizards-shared/definition";
import type { StepOutput } from "@engenty/wizards-shared/run";
import { note } from "@engenty/wizards-shared/run";
import {
  type FieldShape,
  fitData,
  type ListShape,
  recordsOf,
  shapeZod,
} from "@engenty/wizards-shared/shape";
import { snapshotFile } from "../services/files.js";
import { moduleBody, quickJs, WIZARD_CODE_MEMORY_MB } from "./quickjs.js";
import { surfaceData } from "./surface.js";
import { renderTemplate } from "./template.js";
import { type StepContext, StepError } from "./types.js";

/**
 * A code step (docs/plans/code-step.md): the wizard's own function, run once in QuickJS with no
 * model. Like the `code` tool's programs (../tools/code.ts) it has no files, network, timers or
 * modules, and here no tools either: it gets its input and returns its output, nothing else.
 */
export const CODE_STEP_LIMITS = {
  /** Wall time of one run of the function. */
  timeoutMs: 10_000,
  /** Heap of its QuickJS runtime. */
  memoryMb: WIZARD_CODE_MEMORY_MB,
  /** Characters of the input as JSON. */
  inputChars: 1_000_000,
  /** Characters of the output as JSON. */
  outputChars: 200_000,
  /** Characters of `console.log` output kept with an error. */
  logChars: 2000,
};

/**
 * Runs before the wizard's code: the same answer every run. `Math.random` starts from the same
 * seed each time, and there is no clock: today comes in as an input.
 */
const PRELUDE = `
let __seed = 0x9e3779b9;
Math.random = () => {
  __seed = (__seed + 0x6d2b79f5) | 0;
  let t = Math.imul(__seed ^ (__seed >>> 15), 1 | __seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const __noClock = () => {
  throw new Error("A code step has no clock: pass today as an input.");
};
Date.now = __noClock;
globalThis.Date = new Proxy(Date, {
  construct(target, args) {
    if (!args.length) __noClock();
    return new target(...args);
  },
  apply: __noClock,
});
`;

/** The program QuickJS runs: the prelude, the wizard's code, and the call of its `run`. */
export function codeProgram(source: string, input: Record<string, unknown>): string {
  const code = moduleBody(source);
  if (code === null) {
    throw new StepError(
      note("codeFailed", { detail: "a code step has no modules, so it can't import" }),
    );
  }
  return [
    PRELUDE,
    code,
    `if (typeof run !== "function") throw new Error("The code defines no function run(input).");`,
    `return await run(${JSON.stringify(input)});`,
  ].join("\n");
}

/**
 * What `run` gets: a path alone ("budget", "{{budget}}", "steps.find.offers", "lists.prices")
 * as its raw value, the way a widget's data reads it; text with templates in it as text.
 */
export function codeInput(
  input: Record<string, string>,
  ctx: Pick<StepContext, "def" | "state" | "scope">,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const paths: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!value.includes("{{") || /^\s*\{\{[^{}]+\}\}\s*$/.test(value)) {
      paths[key] = dataRef(value);
    } else {
      out[key] = renderTemplate(value, ctx.scope);
    }
  }
  return { ...surfaceData(paths, ctx), ...out };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** A free table's cell as the schema takes it. */
function cell(value: unknown): string | number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string" || typeof value === "number") {
    return value;
  }
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/**
 * A table with free columns as its rows, the way code writes it, turned into columns + rows,
 * the way the schema takes it (`recordsOf` turns it back).
 */
function asColumns(shape: FieldShape | ListShape["of"], value: unknown): unknown {
  if (shape.kind === "table" && !shape.columns?.length && Array.isArray(value)) {
    const rows = value.filter(isRecord);
    const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    return { columns, rows: rows.map((r) => columns.map((c) => cell(r[c]))) };
  }
  if (shape.kind === "object" && isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => {
        const f = shape.fields[k];
        return [k, f ? asColumns(f, v) : v];
      }),
    );
  }
  if (shape.kind === "list" && Array.isArray(value)) {
    return value.map((v) => asColumns(shape.of, v));
  }
  return value;
}

/**
 * What the function returned, fitted to the step's declared output and checked against it:
 * the step's json, as an AI step's would be. Refused when it does not fit.
 */
export function codeOutput(step: CodeStep, result: unknown): Record<string, unknown> {
  const shape = stepShape(step);
  const parsed = shapeZod(shape).safeParse(fitData(shape, asColumns(shape, result)));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join(".") || "the result";
    throw new StepError(note("codeOutputUnfit", { detail: `${where}: ${issue?.message ?? ""}` }));
  }
  return recordsOf(shape, parsed.data) as Record<string, unknown>;
}

/** The function's run itself, apart from the wizard: its result, or a StepError. */
export async function runCode(
  source: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const inputJson = JSON.stringify(input);
  if (inputJson.length > CODE_STEP_LIMITS.inputChars) {
    throw new StepError(
      note("codeFailed", {
        detail: `the input is longer than ${CODE_STEP_LIMITS.inputChars} characters`,
      }),
    );
  }
  const ran = await quickJs().run({
    program: codeProgram(source, input),
    toolIds: [],
    dispatch: async () => {
      throw new Error("A code step calls no tools.");
    },
    timeout: CODE_STEP_LIMITS.timeoutMs,
    abortSignal: signal,
  });
  if (!ran.success) {
    const logs = (ran.logs ?? []).join("\n").slice(-CODE_STEP_LIMITS.logChars);
    const said = ran.error?.message ?? "unknown error";
    throw new StepError(note("codeFailed", { detail: logs ? `${said}\n${logs}` : said }));
  }
  if (JSON.stringify(ran.result ?? null).length > CODE_STEP_LIMITS.outputChars) {
    throw new StepError(
      note("codeFailed", {
        detail: `the result is longer than ${CODE_STEP_LIMITS.outputChars} characters`,
      }),
    );
  }
  return ran.result;
}

/**
 * A step's `code`: the wizard's function from the workspace the run started with, run once with
 * its input; what it returns is the step's json. It acts nowhere outside, so a later try may run
 * it again.
 */
export async function runCodeStep(step: CodeStep, ctx: StepContext): Promise<StepOutput> {
  const file = await snapshotFile(ctx.files, step.code.entry);
  if (!file) {
    throw new StepError(note("codeMissing", { entry: step.code.entry }));
  }
  const result = await runCode(
    file.data.toString("utf8"),
    codeInput(step.code.input, ctx),
    ctx.signal,
  );
  const json = codeOutput(step, result);
  const surface = Array.isArray(step.output.surface)
    ? { components: step.output.surface, data: json }
    : undefined;
  return { json, ...(surface ? { surface } : {}), at: new Date().toISOString() };
}
