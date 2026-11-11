/**
 * The terminal as a run's door (docs/plans/runs-on-their-own.md, `wizards run`): it asks a page's
 * fields one by one, shows what a review shows and asks to accept it, and gives the result back.
 * Answers given before (flags, a file, JSON on stdin) are not asked; nobody at a terminal and an
 * answer missing: the run waits, and `--continue` goes on with it later.
 *
 * Questions and progress go to `say` (the CLI's stderr), so stdout carries only the result.
 */
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { formContextOf } from "@engenty/wizards-engine/decisions";
import type { HostState } from "@engenty/wizards-engine/host-api";
import {
  type Field,
  type FormStep,
  isDecidedField,
  type ReviewStep,
  type Step,
  shownFields,
  type WizardDefinition,
} from "@engenty/wizards-shared/definition";
import type { RunState, StepOutput } from "@engenty/wizards-shared/run";
import type { RunServices } from "@engenty/wizards-shared/run-services";
import { HostRefusal } from "./host-refusal.js";
import type { NodeHost } from "./node-host.js";

export interface TerminalIO {
  /** Asks one line and answers what the person typed; null: nobody at a terminal to ask. */
  ask: ((question: string) => Promise<string>) | null;
  /** A line for the person: progress, a question's context, what went wrong. */
  say(line: string): void;
}

export interface DoorOptions {
  /** Answers by field id, given before the run: a page takes those of its fields and asks the rest. */
  answers: Record<string, unknown>;
  /** Accept each review without asking. */
  accept: boolean;
}

/** Where the door left the run. */
export type DoorEnd =
  /** Done, failed or cancelled. */
  | { kind: "ended"; state: HostState }
  /** The run waits for what this terminal can't give now: `why`, one line each. */
  | { kind: "waits"; state: HostState; why: string[] };

/** Kinds a terminal can't take a value of; given by flag or file, they go to the run as they are. */
const NOT_TYPED = new Set<Field["kind"]>(["image", "file", "audio", "signature", "items"]);
/** Kinds the run's page fills from the wizard's store, never from an answer. */
const NOT_ANSWERED = new Set<Field["kind"]>(["connection", "list"]);

const OVER = new Set(["done", "failed", "cancelled"]);

/**
 * Takes the run from where it stands until it ends or waits for something this terminal can't
 * give. Starts the host (a run in its folder goes on from there) and closes nothing.
 */
export async function terminalDoor(
  node: NodeHost,
  def: WizardDefinition,
  io: TerminalIO,
  options: DoorOptions,
): Promise<DoorEnd> {
  const stepOf = (id: string | null) => def.steps.find((s) => s.id === id);
  const stop = node.watch((change) => {
    for (const e of change.events) {
      if (e.type === "step_started") {
        io.say(`  ${e.message}…`);
      } else if (e.type === "wait" || e.type === "error") {
        io.say(`  ${e.message}`);
      }
    }
  });
  try {
    await node.start();
    // Each page and review is asked once with the given answers; after that, only a person answers.
    const given = { ...options.answers };
    for (;;) {
      await node.idle();
      const state = await node.state();
      const { run } = state;
      if (OVER.has(run.status)) {
        return { kind: "ended", state };
      }
      if (run.status === "waiting_signal") {
        return { kind: "waits", state, why: ["The run waits for a signal."] };
      }
      if (run.status === "sleeping" && run.wakeAt !== null) {
        // The run goes on by itself when its time comes: the host's clock wakes it.
        await changed(node, run.rev);
        continue;
      }
      if (run.status === "running" || run.status === "sleeping") {
        // Nothing moves it here any more: the step's work broke off.
        return { kind: "waits", state, why: ["The run stopped in the middle of a step."] };
      }
      const step = stepOf(run.cursor);
      if (step?.type === "form") {
        const why = await answerPage(node, def, step, run.state, given, io);
        if (why) {
          return { kind: "waits", state, why };
        }
      } else if (step?.type === "review") {
        const why = await answerReview(node, def, step, run.state, options.accept, io);
        if (why) {
          return { kind: "waits", state, why };
        }
      } else {
        return { kind: "waits", state, why: [`The run waits at “${step?.title ?? run.cursor}”.`] };
      }
    }
  } finally {
    stop();
  }
}

/** Resolves once the run's revision moves past `rev`. */
function changed(node: NodeHost, rev: number): Promise<void> {
  return new Promise((resolve) => {
    const stop = node.watch((change) => {
      if (change.rev !== rev) {
        stop();
        resolve();
      }
    });
    // A change between the read and the watch.
    void node.state().then((s) => {
      if (s.run.rev !== rev) {
        stop();
        resolve();
      }
    });
  });
}

// --- pages ------------------------------------------------------------------------------------

/** Fills and sends the page; the lines that say why it can't, or null once the run took it. */
async function answerPage(
  node: NodeHost,
  def: WizardDefinition,
  step: FormStep,
  state: RunState,
  given: Record<string, unknown>,
  io: TerminalIO,
): Promise<string[] | null> {
  const context = await formContextOf(def, node.host.services.data, step, state);
  const fields = step.fields
    .filter((f) => !isDecidedField(f) || context.decided.includes(f.id))
    .filter((f) => !NOT_ANSWERED.has(f.kind))
    .map((f) => (context.options[f.id]?.length ? { ...f, options: context.options[f.id] } : f));
  const values: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.id in given) {
      values[f.id] = given[f.id];
      delete given[f.id];
    }
  }
  if (io.ask && step.title) {
    io.say("");
    io.say(step.title);
  }
  for (;;) {
    const missing: string[] = [];
    const asked = new Set<string>();
    for (;;) {
      const next = shownFields(fields, context.known, values).find(
        (f) => !(f.id in values) && !asked.has(f.id),
      );
      if (!next) {
        break;
      }
      asked.add(next.id);
      const value = await askField(next, io);
      if (value === MISSING) {
        missing.push(next.id);
      } else if (value !== undefined) {
        values[next.id] = value;
      }
    }
    if (missing.length) {
      return missing.map((id) => {
        const f = fields.find((x) => x.id === id);
        return f && NOT_TYPED.has(f.kind)
          ? `“${f.label}” can’t be answered in the terminal. Give it with --${id}=…`
          : `“${f?.label ?? id}” has no answer yet. Give it with --${id}=…`;
      });
    }
    try {
      await node.send({ kind: "answered", stepId: step.id, values });
      return null;
    } catch (err) {
      if (!(err instanceof HostRefusal && err.status === 422)) {
        throw err;
      }
      const wrong = (err.fields as { field: string; message: string }[] | undefined) ?? [];
      const lines = wrong.map((w) => {
        const label = fields.find((f) => f.id === w.field)?.label ?? w.field;
        return `${label}: ${w.message}`;
      });
      if (!io.ask) {
        return lines.length ? lines : [err.message];
      }
      for (const line of lines) {
        io.say(line);
      }
      // Asked again: the answers that were not taken.
      for (const w of wrong) {
        delete values[w.field];
      }
      if (!wrong.length) {
        return [err.message];
      }
    }
  }
}

const MISSING = Symbol("missing");

/** The value of one field as the person types it; undefined: left empty; MISSING: needed and not given. */
async function askField(field: Field, io: TerminalIO): Promise<unknown> {
  const fallback = field.default;
  if (!io.ask || NOT_TYPED.has(field.kind)) {
    if (fallback !== undefined) {
      return fallback;
    }
    return field.required ? MISSING : undefined;
  }
  const choices = field.kind === "select" || field.kind === "multiselect" || field.kind === "slot";
  if (choices) {
    (field.options ?? []).forEach((option, i) => {
      io.say(`  ${i + 1}  ${option}`);
    });
  }
  const hint =
    field.kind === "toggle"
      ? " (y/n)"
      : field.kind === "multiselect"
        ? " (numbers or names, separated by commas)"
        : "";
  const shown = fallback === undefined ? "" : ` [${String(fallback)}]`;
  const optional = field.required ? "" : " (optional)";
  for (;;) {
    const typed = (await io.ask(`${field.label}${hint}${optional}${shown}: `)).trim();
    if (!typed) {
      if (fallback !== undefined) {
        return fallback;
      }
      if (field.required && field.kind !== "toggle") {
        io.say(`“${field.label}” needs an answer.`);
        continue;
      }
      return field.kind === "toggle" ? false : undefined;
    }
    if (field.kind === "toggle") {
      return /^(y|yes|true|on|1)$/i.test(typed);
    }
    if (!choices) {
      return typed;
    }
    const options = field.options ?? [];
    const pick = (part: string) => {
      const n = Number(part);
      if (Number.isInteger(n) && n >= 1 && n <= options.length) {
        return options[n - 1];
      }
      return options.find((o) => o.toLowerCase() === part.toLowerCase()) ?? part;
    };
    if (field.kind === "multiselect") {
      return typed
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean)
        .map(pick);
    }
    return pick(typed);
  }
}

// --- reviews ----------------------------------------------------------------------------------

async function answerReview(
  node: NodeHost,
  def: WizardDefinition,
  step: ReviewStep,
  state: RunState,
  accept: boolean,
  io: TerminalIO,
): Promise<string[] | null> {
  io.say("");
  io.say(step.title);
  for (const id of step.show) {
    const shown = def.steps.find((s) => s.id === id);
    io.say("");
    io.say(`${shown?.title ?? id}:`);
    io.say(outputText(state.outputs[id]) || "(nothing)");
  }
  io.say("");
  if (accept) {
    await node.send({ kind: "reviewed", stepId: step.id, approved: true });
    io.say("Accepted.");
    return null;
  }
  if (!io.ask) {
    return ["The run waits for your review. Accept it with --accept."];
  }
  const declines = step.approve || step.regenerate;
  if (!declines) {
    await io.ask("Press Enter to go on. ");
    await node.send({ kind: "reviewed", stepId: step.id, approved: true });
    return null;
  }
  for (;;) {
    const typed = (await io.ask("Accept this? (y/n): ")).trim().toLowerCase();
    if (/^(y|yes)$/.test(typed)) {
      await node.send({ kind: "reviewed", stepId: step.id, approved: true });
      return null;
    }
    if (/^(n|no)$/.test(typed)) {
      break;
    }
  }
  const words = (await io.ask("What should change? (optional): ")).trim();
  if (step.approve) {
    await node.send({
      kind: "reviewed",
      stepId: step.id,
      approved: false,
      ...(words ? { note: words } : {}),
    });
  } else {
    await node.send({ kind: "regenerate", stepId: step.id, target: step.show[0], note: words });
  }
  return null;
}

// --- the result -------------------------------------------------------------------------------

/** What a step's output says, as text: its text, else its JSON, else the files it made. */
export function outputText(output: StepOutput | undefined): string {
  if (!output) {
    return "";
  }
  if (output.text?.trim()) {
    return output.text.trim();
  }
  if (output.json !== undefined) {
    return JSON.stringify(output.json, null, 2);
  }
  if (output.assets?.length) {
    return output.assets.map((a) => a.name).join("\n");
  }
  if (output.surface) {
    return "(a view: open the run in the browser to see it)";
  }
  return "";
}

/** One thing the result gives: a step's output, under the name the result step gives it. */
export interface ResultPart {
  from: string;
  label: string;
  text: string;
  json?: unknown;
  /** The files it made: the run folder's copies (`resultFiles`). */
  files: string[];
}

export interface RunResult {
  runId: string;
  status: string;
  /** What the result step says. */
  message: string | null;
  /** The data the result names (`result.data`). */
  data: Record<string, unknown> | null;
  parts: ResultPart[];
  /** What the run's failure said. */
  error: string | null;
}

/** The result step the run ended at, or the last one. */
function resultStepOf(def: WizardDefinition, cursor: string | null) {
  const at = def.steps.find((s) => s.id === cursor);
  return at?.type === "result" ? at : def.steps.findLast((s) => s.type === "result");
}

/** The parts of the result: the steps its deliverables name, else every step's output. */
function partsOf(def: WizardDefinition, state: RunState, cursor: string | null) {
  const result = resultStepOf(def, cursor);
  const named = result?.type === "result" ? result.deliverables : [];
  const from = named.length
    ? named.map((d) => ({ from: d.from, label: d.label }))
    : Object.keys(state.outputs).map((id) => ({ from: id, label: undefined }));
  return from
    .filter((p) => state.outputs[p.from])
    .map((p) => ({
      ...p,
      label: p.label ?? (def.steps.find((s: Step) => s.id === p.from)?.title || p.from),
      output: state.outputs[p.from],
    }));
}

/** The folder in a run's folder the result's files are kept in. */
export const RESULT_FILES = "result";

/** A file's name in the result folder: its own, made safe, after its id so two never meet. */
const fileName = (id: string, name: string) =>
  `${id}-${basename(name).replace(/[^\p{L}\p{N}._-]+/gu, "_") || "file"}`;

/**
 * Keeps the files of the result in the run's folder, while the run's token still reaches them:
 * call it as the run reaches its end, before its tenant takes the end.
 */
export async function keepResultFiles(
  files: RunServices["files"],
  def: WizardDefinition,
  run: { state: RunState; cursor: string | null },
  dir: string,
): Promise<void> {
  const assets = partsOf(def, run.state, run.cursor).flatMap((p) => p.output.assets ?? []);
  if (!assets.length) {
    return;
  }
  await mkdir(join(dir, RESULT_FILES), { recursive: true });
  for (const asset of assets) {
    const read = await files.read(asset.id);
    if (read) {
      await writeFile(join(dir, RESULT_FILES, fileName(asset.id, asset.name)), read.data);
    }
  }
}

/** The run's result as the terminal gives it back. */
export function resultOf(
  runId: string,
  def: WizardDefinition,
  state: HostState,
  dir: string,
): RunResult {
  const { run } = state;
  const result = resultStepOf(def, run.cursor);
  return {
    runId,
    status: run.status,
    message: result?.type === "result" && run.status === "done" ? (result.message ?? null) : null,
    data: (run.state.data as Record<string, unknown> | undefined) ?? null,
    parts: partsOf(def, run.state, run.cursor).map((p) => ({
      from: p.from,
      label: p.label,
      text: outputText(p.output),
      ...(p.output.json === undefined ? {} : { json: p.output.json }),
      files: (p.output.assets ?? []).map((a) => join(dir, RESULT_FILES, fileName(a.id, a.name))),
    })),
    error: state.error,
  };
}

/**
 * Writes the result to `out`: each part as a file of its own (`<step>.md`, `.json` for JSON), and
 * its files copied there. Answers the paths it wrote.
 */
export async function writeResult(result: RunResult, out: string): Promise<string[]> {
  await mkdir(out, { recursive: true });
  const written: string[] = [];
  for (const part of result.parts) {
    if (part.json !== undefined) {
      const path = join(out, `${part.from}.json`);
      await writeFile(path, `${JSON.stringify(part.json, null, 2)}\n`);
      written.push(path);
    } else if (part.text && !part.files.length) {
      const path = join(out, `${part.from}.md`);
      await writeFile(path, `${part.text}\n`);
      written.push(path);
    }
    for (const file of part.files) {
      const path = join(out, basename(file));
      try {
        await copyFile(file, path);
        written.push(path);
      } catch {
        // Not kept: the run ended before its files were fetched.
      }
    }
  }
  if (result.data) {
    const path = join(out, "data.json");
    await writeFile(path, `${JSON.stringify(result.data, null, 2)}\n`);
    written.push(path);
  }
  return written;
}
