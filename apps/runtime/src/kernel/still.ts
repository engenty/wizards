import type { AskRow, LeftRow, Row } from "@engenty/wizards-kernel";
import {
  isOutlineCode,
  isOutlineText,
  type KernelFile,
  type KernelOutline,
  type OutlineValue,
  type StepOutline,
} from "@engenty/wizards-shared/kernel-file";
import { note, noteText } from "@engenty/wizards-shared/run";

/**
 * One step of a wizard in version 0.3.0 as a run would show it, without running it: the studio's
 * preview of the step chosen. The page is what the step's code passes to its first `ask`, as the
 * outline reads it. What a review shows comes from the latest test run; where no run has it, a
 * sample stands in, and says that it is one.
 */

/** A value of the outline as the value it is in a run; what code works out is left out. */
const plain = (value: OutlineValue | undefined): unknown => {
  if (value === undefined || isOutlineCode(value)) return undefined;
  if (isOutlineText(value))
    return value.$text.map((part) => (typeof part === "string" ? part : "…")).join("");
  if (Array.isArray(value)) return value.map(plain).filter((one) => one !== undefined);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, one]) => [key, plain(one)] as const)
        .filter(([, one]) => one !== undefined),
    );
  return value;
};

const specOf = (step: StepOutline | undefined) =>
  (plain(step?.asks[0]?.spec ?? {}) ?? {}) as Record<string, unknown>;

/** What a step would have made, where no test run made it: values by its fields, or a text. */
function sample(step: StepOutline | undefined, id: string, german: boolean): unknown {
  const spec = specOf(step);
  const fields = (Array.isArray(spec.fields) ? spec.fields : []) as {
    id?: string;
    kind?: string;
    options?: unknown[];
  }[];
  const lang = german ? "de" : "en";
  const word = noteText(note("kernelSample"), lang);
  if (spec.type !== "form" && fields.length) {
    return Object.fromEntries(
      fields.map((field) => [
        field.id ?? "",
        field.kind === "number" || field.kind === "score"
          ? 1
          : field.kind === "yesno"
            ? true
            : (field.options?.[0] ?? word),
      ]),
    );
  }
  const title = String(spec.title ?? step?.title ?? id);
  return `## ${title}\n\n${noteText(note("kernelSampleText"), lang)}`;
}

export interface KernelStill {
  rows: Row[];
  waiting: AskRow[];
  /** A page waits for the person; every other step shows as at work. */
  status: "waiting_input" | "running";
  /** The titles of the step and of the steps it shows, where their code writes them out. */
  titles: Record<string, string>;
  /** The line the step shows while it works. */
  working?: string;
}

/**
 * The still of step `stepId`; `input` is the page the file's runs start with. `made`: what each
 * step left behind in the latest test run. Nothing where the wizard has no such step.
 */
export function kernelStill(
  file: KernelFile,
  outline: KernelOutline,
  stepId: string,
  made: Record<string, unknown>,
  german: boolean,
): KernelStill | null {
  const spec =
    stepId === "input"
      ? file.input?.fields.length
        ? ({ type: "form", ...file.input } as Record<string, unknown>)
        : null
      : outline[stepId]
        ? specOf(outline[stepId])
        : null;
  if (!spec) return null;
  const person = spec.type === "form" || spec.type === "review";
  const show =
    spec.type === "review" && Array.isArray(spec.show)
      ? spec.show.filter((id): id is string => typeof id === "string")
      : [];
  const rows: LeftRow[] = show.map((id, i) => ({
    n: i + 1,
    step: id,
    left: true,
    value: made[id] ?? sample(outline[id], id, german),
    to: "",
  }));
  const ask = {
    ...spec,
    n: rows.length + 1,
    step: stepId,
    role: "user",
    state: "waiting",
  } as AskRow;
  return {
    rows: person ? [...rows, ask] : rows,
    waiting: person ? [ask] : [],
    status: person ? "waiting_input" : "running",
    titles: Object.fromEntries(
      [stepId, ...show].flatMap((id) => {
        const title = specOf(outline[id]).title ?? outline[id]?.title;
        return typeof title === "string" ? [[id, title]] : [];
      }),
    ),
    working: typeof spec.working === "string" ? spec.working : undefined,
  };
}
