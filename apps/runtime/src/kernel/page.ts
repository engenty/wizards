import type { AskRow, Row } from "@engenty/wizards-kernel";
import type { Step, WizardDefinition } from "@engenty/wizards-shared/definition";
import type { RunState, StepOutput } from "@engenty/wizards-shared/run";
import type { RunRow } from "../engine/types.js";
import { stepOf } from "./batteries.js";
import type { KernelRunView } from "./host.js";

/**
 * A run of a wizard in version 0.3.0 as the run's page reads it (docs/plans/kernel.md). The page
 * draws a run of version 0.2.0: a step the person is on, and what earlier steps made. So the run is
 * shown as the small wizard it is at this moment: the steps that returned, each with what it
 * left behind, and the page it waits at, a form, a review, or the leave for an action. The page's
 * answers come back by the step's id, as for any run.
 */
const isAsk = (row: Row): row is AskRow => !("left" in row);
const at = (run: RunRow) => new Date(run.updatedAt ?? Date.now()).toISOString();

/** A step's text, where it has one: a string, or the `text` of what it returned. */
const textOf = (value: unknown): string | undefined =>
  typeof value === "string"
    ? value
    : typeof (value as { text?: unknown } | null)?.text === "string"
      ? (value as { text: string }).text
      : undefined;

/** What a step returned, as the page shows it: its text to read and edit, its documents to open. */
const outputOf = (value: unknown, when: string): StepOutput => {
  if (typeof value === "string") return { text: value, at: when };
  const text = textOf(value);
  const assets = filesOf(value);
  // A step that made files is shown by them: its images, its document. The value beside them
  // only says the same again as data.
  if (assets) return { ...(text === undefined ? {} : { text }), assets, at: when };
  return { json: value ?? {}, ...(text === undefined ? {} : { text }), at: when };
};

/** The files a step left behind, where it left any. */
const filesOf = (value: unknown): StepOutput["assets"] | undefined => {
  const assets = (value as { assets?: unknown } | null)?.assets;
  return Array.isArray(assets) && assets.length ? (assets as StepOutput["assets"]) : undefined;
};

/** The asks a machine answers: what a step does its work with. */
const WORK = new Set([
  "agent",
  "decision",
  "tool",
  "generate",
  "widget",
  "motion-graphics",
  "surface",
]);
/** The asks whose answer is files, drawn and downloaded as that kind of step does it. */
const FILES = new Set(["generate", "widget", "motion-graphics"]);

/** A step that ran, as the page lists it: it shows what the step left behind. */
const made = (id: string, value: unknown, title = id): Step =>
  ({
    id,
    type: "agent",
    title,
    instructions: "",
    tools: [],
    output: {
      format: textOf(value) === undefined && !filesOf(value) ? "json" : "markdown",
    },
  }) as unknown as Step;

export function kernelPage(run: RunRow, view: KernelRunView): RunRow {
  const when = at(run);
  const file = run.definition.kernel;
  const outputs: Record<string, StepOutput> = {};
  const steps: Step[] = [];
  const add = (step: Step) => {
    const i = steps.findIndex((s) => s.id === step.id);
    if (i >= 0) {
      steps.splice(i, 1);
    }
    steps.push(step);
  };
  // The ask each step did its work with: the last one of it a machine answered.
  const work = new Map<string, AskRow>();
  for (const row of view.rows) {
    if (isAsk(row) && WORK.has(String(row.type)) && row.parent == null && row.approves == null) {
      work.set(row.step, row);
    }
  }
  /**
   * A step as the page lists it, in the words of its ask. Where it left files, it is the kind of
   * step that makes them, so they are shown and downloaded as an image, a document or a film.
   */
  const stepFor = (id: string, value: unknown): Step => {
    const ask = work.get(id);
    if (!ask) {
      // No ask yet: the step is shown by what its file writes out.
      const own = view.titles?.[id];
      return {
        ...made(id, value, own?.title ?? id),
        ...(own?.working ? { working: own.working } : {}),
      } as Step;
    }
    const title = typeof ask.title === "string" && ask.title ? ask.title : id;
    const said = typeof ask.working === "string" ? { working: ask.working } : {};
    return FILES.has(String(ask.type)) && (filesOf(value) || value === "")
      ? ({ ...stepOf(run.definition, ask), id, title } as Step)
      : ({ ...made(id, value, title), ...said } as Step);
  };
  for (const row of view.rows) {
    if ("left" in row) {
      add(stepFor(row.step, row.value));
      outputs[row.step] = outputOf(row.value, when);
    }
  }
  const waiting = view.waiting.filter((row) => isAsk(row));
  const page = waiting.find((row) => row.type === "approval") ?? waiting[0];
  let cursor: string | null = view.cursor;
  const values: Record<string, unknown> = {};
  if (view.status === "done") {
    // The result shows what the file's output reads, step by step; without one, the last step.
    const named = Object.values(file?.output ?? {})
      .map((path) => path.split(".")[0])
      .filter((id, i, all) => outputs[id] && all.indexOf(id) === i);
    const from = named.length ? named : steps.map((s) => s.id).slice(-1);
    // The downloads the file names, each from a step that left something or from a list. A run
    // that took another way, with none of them, shows what its output reads.
    const downloads = file?.result?.downloads?.filter(
      (one) => one.from.startsWith("lists.") || outputs[one.from],
    );
    add({
      id: "result",
      type: "result",
      title: file?.result?.title ?? file?.title ?? run.definition.title,
      ...(file?.result?.message ? { message: file.result.message } : {}),
      deliverables: downloads?.length
        ? downloads
        : from.map((id) => ({ from: id, formats: ["md"] })),
    } as unknown as Step);
    cursor = "result";
  } else if (page?.type === "form") {
    add({
      id: page.step,
      type: "form",
      title: String(page.title ?? (page.step === "input" ? (file?.title ?? "") : page.step)),
      ...(page.description ? { description: page.description } : {}),
      fields: page.fields ?? [],
      // How the page is laid out, where the ask says so.
      ...(page.groups ? { groups: page.groups } : {}),
      ...(page.cta ? { cta: page.cta } : {}),
      ...(page.components ? { components: page.components } : {}),
      ...(page.data ? { data: page.data } : {}),
    } as unknown as Step);
    cursor = page.step;
  } else if (page?.type === "review") {
    // What a step left behind, or a list the wizard keeps.
    const show = ((page.show as string[] | undefined) ?? []).filter(
      (id) => outputs[id] || id.startsWith("lists."),
    );
    if (!show.length) {
      const about = `${page.step}__about`;
      add(made(about, String(page.message ?? page.title ?? page.step)));
      outputs[about] = outputOf(String(page.message ?? page.title ?? page.step), when);
      show.push(about);
    }
    add({
      id: page.step,
      type: "review",
      title: String(page.title ?? page.step),
      // What to check, in the step's own words.
      ...(page.description ? { description: page.description } : {}),
      show,
      // As in version 0.2.0: each way to answer only where the ask names it.
      approve: page.approve === true,
      edit: page.edit === true,
      regenerate: page.regenerate === true,
    } as unknown as Step);
    cursor = page.step;
  } else if (page?.type === "approval") {
    // The leave for an action: a review of what is about to be done.
    const about = `${page.step}__action`;
    const text = `**${page.call}**\n\n\`\`\`json\n${JSON.stringify(page.input ?? {}, null, 2)}\n\`\`\``;
    add(made(about, text));
    outputs[about] = outputOf(text, when);
    add({
      id: page.step,
      type: "review",
      title: String(page.call),
      show: [about],
      approve: true,
    } as unknown as Step);
    cursor = page.step;
  } else if (cursor) {
    // At work, or waiting for a signal or a time: the step it stands in.
    add(stepFor(cursor, ""));
  }
  if (!steps.some((s) => s.type === "result")) {
    steps.push({
      id: "result__",
      type: "result",
      title: file?.title ?? run.definition.title,
      deliverables: [],
    } as unknown as Step);
  }
  // The page shows the wizard's intro above its first page, and counts a run's first page by the
  // steps before it. A run of version 0.3.0 lists a step only once it returned, so a page answered
  // before any step returned stands before the one it is on: the intro stays the run's (the chat
  // greets with it), and shows above the first page only.
  const first = !view.rows.some((row) => "left" in row || row.state === "done");
  if (!first && cursor && steps.findIndex((s) => s.id === cursor) === 0) {
    steps.unshift({
      id: "answered__",
      type: "form",
      title: file?.title ?? run.definition.title,
      fields: [],
    } as unknown as Step);
  }
  const { kernel: _kernel, ...shell } = run.definition;
  const state: RunState = { values, outputs, history: [], notes: {} };
  return {
    ...run,
    definition: { ...shell, steps } as WizardDefinition,
    cursor,
    state,
  };
}
