import type { AskRow, Row } from "@engenty/wizards-kernel";
import type { Step, WizardDefinition } from "@engenty/wizards-shared/definition";
import type { RunState, StepOutput } from "@engenty/wizards-shared/run";
import type { RunRow } from "../engine/types.js";
import type { KernelRunView } from "./host.js";

/**
 * A run of a wizard in version 0.3.0 as the run's page reads it (docs/plans/kernel.md). The page
 * draws a run of version 1: a step the person is on, and what earlier steps made. So the run is
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

/** A step that ran, as the page lists it: it shows what the step left behind. */
const made = (id: string, value: unknown): Step =>
  ({
    id,
    type: "agent",
    title: id,
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
  for (const row of view.rows) {
    if ("left" in row) {
      add(made(row.step, row.value));
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
    // The downloads the file names, each from a step that left something or from a list.
    const downloads = file?.result?.downloads?.filter(
      (one) => one.from.startsWith("lists.") || outputs[one.from],
    );
    add({
      id: "result",
      type: "result",
      title: file?.title ?? run.definition.title,
      ...(file?.result?.message ? { message: file.result.message } : {}),
      deliverables: downloads ?? from.map((id) => ({ from: id, formats: ["md"] })),
    } as unknown as Step);
    cursor = "result";
  } else if (page?.type === "form") {
    add({
      id: page.step,
      type: "form",
      title: String(page.title ?? (page.step === "input" ? (file?.title ?? "") : page.step)),
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
      show,
      // As in version 1: each way to answer only where the ask names it.
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
    add(made(cursor, ""));
  }
  if (!steps.some((s) => s.type === "result")) {
    steps.push({
      id: "result__",
      type: "result",
      title: file?.title ?? run.definition.title,
      deliverables: [],
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
