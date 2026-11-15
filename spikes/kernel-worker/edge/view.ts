import type { AskRow, Row, Run, WizardFile } from "@engenty/wizards-kernel";
import type { Step } from "@engenty/wizards-shared/definition";
import type { RunStatus, RunView, ShownStep, StepOutput } from "@engenty/wizards-shared/run";

/**
 * A run of version 0.3.0 as the runner (`@engenty/wizards-runner`) draws it: the small wizard it
 * is at this moment, the steps that returned with what they left, and the page it waits at — a
 * form, a review, or the leave for an action. Ported from the runtime's `kernelPage`
 * (apps/runtime/src/kernel/page.ts) and the parts of its `runView` a page of this Worker needs:
 * no brand, no lists, no connections, no translation, no downloads.
 */
const isAsk = (row: Row): row is AskRow => !("left" in row);

const textOf = (value: unknown): string | undefined =>
  typeof value === "string"
    ? value
    : typeof (value as { text?: unknown } | null)?.text === "string"
      ? (value as { text: string }).text
      : undefined;

const outputOf = (value: unknown, at: string): StepOutput => {
  if (typeof value === "string") return { text: value, at } as StepOutput;
  const text = textOf(value);
  return { json: value ?? {}, ...(text === undefined ? {} : { text }), at } as StepOutput;
};

/** A step that ran, as the page lists it: it shows what the step left behind. */
const made = (id: string, value: unknown, title = id): Step =>
  ({
    id,
    type: "agent",
    title,
    instructions: "",
    tools: [],
    output: { format: textOf(value) === undefined ? "json" : "markdown" },
  }) as unknown as Step;

const WORK = new Set([
  "agent",
  "decision",
  "tool",
  "generate",
  "widget",
  "motion-graphics",
  "surface",
]);

/** The waiting row a page answers: the leave for an action first, then a form or a review. */
export const pageRow = (run: Run, step?: string) => {
  const waiting = run.rows.filter(isAsk).filter((row) => row.state === "waiting");
  const here = step ? waiting.filter((row) => row.step === step) : waiting;
  return here.find((row) => row.type === "approval") ?? here.find((row) => row.type !== "approval");
};

export function viewOf(run: Run, file: WizardFile): RunView {
  const at = new Date(run.startedAt).toISOString();
  const outputs: Record<string, StepOutput> = {};
  const steps = new Map<string, Step>();
  const titles = new Map<string, string>();
  for (const row of run.rows)
    if (isAsk(row) && WORK.has(String(row.type)) && row.parent == null && row.approves == null)
      if (typeof row.title === "string") titles.set(row.step, row.title);
  for (const row of run.rows) {
    if (!("left" in row)) continue;
    steps.delete(row.step);
    steps.set(row.step, made(row.step, row.value, titles.get(row.step) ?? row.step));
    outputs[row.step] = outputOf(row.value, at);
  }
  // What the result's downloads call a step ("Post") is the name the page gives it.
  const labels = new Map(
    (file.result?.downloads ?? []).flatMap((one) => (one.label ? [[one.from, one.label]] : [])),
  );
  const shownOf = (ids: string[]): ShownStep[] =>
    ids
      .filter((id) => steps.get(id))
      .map((id) => ({
        step: {
          ...(steps.get(id) as Step),
          title: labels.get(id) ?? (steps.get(id) as Step).title,
        },
        output: outputs[id] ?? null,
        formats: [],
        label: labels.get(id) ?? null,
      }));

  const page = pageRow(run);
  let step: Step | null = null;
  let shown: ShownStep[] = [];
  let status: RunStatus;
  if (run.status === "done") {
    const from = [
      ...new Set(Object.values(file.output ?? {}).map((path) => path.split(".")[0])),
    ].filter((id) => outputs[id]);
    const ids = from.length ? from : [...steps.keys()].slice(-1);
    step = {
      id: "result",
      type: "result",
      title: file.result?.title ?? file.title,
      ...(file.result?.message ? { message: file.result.message } : {}),
      deliverables: ids.map((id) => ({ from: id, formats: [] })),
    } as unknown as Step;
    shown = shownOf(ids);
    status = "done";
  } else if (run.status === "failed" || run.status === "stopped") {
    step = run.cursor ? made(run.cursor, "", titles.get(run.cursor) ?? run.cursor) : null;
    status = run.status === "failed" ? "failed" : "cancelled";
  } else if (page?.type === "form") {
    step = {
      id: page.step,
      type: "form",
      title: String(page.title ?? (page.step === "input" ? file.title : page.step)),
      ...(page.description ? { description: page.description } : {}),
      fields: page.fields ?? [],
      ...(page.cta ? { cta: page.cta } : {}),
    } as unknown as Step;
    status = "waiting_input";
  } else if (page?.type === "review") {
    const show = ((page.show as string[] | undefined) ?? []).filter((id) => outputs[id]);
    step = {
      id: page.step,
      type: "review",
      title: String(page.title ?? page.step),
      ...(page.description ? { description: page.description } : {}),
      show,
      approve: page.approve === true,
      edit: page.edit === true,
      regenerate: page.regenerate === true,
    } as unknown as Step;
    shown = shownOf(show);
    status = "waiting_input";
  } else if (page?.type === "approval") {
    // The leave for an action: a review of what is about to be done.
    const about = `${page.step}__action`;
    const text = `**${page.call}**\n\n\`\`\`json\n${JSON.stringify(page.input ?? {}, null, 2)}\n\`\`\``;
    steps.set(about, made(about, text, String(page.call)));
    outputs[about] = outputOf(text, at);
    step = {
      id: page.step,
      type: "review",
      title: String(page.call),
      show: [about],
      approve: true,
    } as unknown as Step;
    shown = shownOf([about]);
    status = "waiting_input";
  } else {
    step = run.cursor ? made(run.cursor, "", titles.get(run.cursor) ?? run.cursor) : null;
    status = run.status === "running" ? "running" : run.wakeAt ? "sleeping" : "waiting_signal";
  }
  const first = !run.rows.some((row) => "left" in row || row.state === "done");
  const done = run.rows.filter((row) => "left" in row).length;
  return {
    id: run.id,
    status,
    wakeAt: run.wakeAt ? new Date(run.wakeAt).toISOString() : null,
    pause: null,
    signIn: null,
    waitsFor: null,
    answeredBy: null,
    mode: "live",
    wizard: {
      title: file.title,
      ...(file.description ? { description: file.description } : {}),
      ...(file.intro && first ? { intro: file.intro } : {}),
    },
    lang: file.lang ?? "en",
    translation: null,
    talk: false,
    step,
    answered: [],
    values: {},
    rev: run.rev,
    prefill: {},
    closed: {},
    outputs,
    shown,
    progress: { done, total: run.status === "done" ? done : done + 1 },
    canBack: false,
    error: run.error ?? null,
    events: [],
    brand: {
      name: file.title,
      accent: null,
      logoUrl: null,
      theme: null,
    },
    ask: null,
    question: null,
    lists: [],
    connections: [],
    connect: [],
    keeps: false,
    shareUrl: null,
    expiresAt: null,
    shareJob: null,
  } as unknown as RunView;
}
