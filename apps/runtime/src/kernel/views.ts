import { type Surface, validateSurface } from "@engenty/chatviews/surface";
import type { Spec } from "@engenty/wizards-kernel";
import type { StepOutput } from "@engenty/wizards-shared/run";

/**
 * Views of a run in version 0.3.0 (docs/plans/kernel.md, C.11). An ask may carry components from
 * the surface catalog and the data they read. A step works its data out, so an ask holds values,
 * where a step of version 0.2.0 names where to read them. Here the two meet: a view is checked
 * when it is asked for, and its values are put where the page and the step executors read.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** The values a view reads, where the ask gives any. */
export const viewData = (data: unknown): Record<string, unknown> | undefined =>
  isRecord(data) && Object.keys(data).length ? data : undefined;

/** Where a step's values for a view are kept among the run's outputs. */
export const dataKey = (step: string) => `${step}__data`;

/**
 * The values of a view as the page and the step executors read them: kept as an output, and named
 * by reference, key by key.
 */
export function asRefs(
  step: string,
  data: Record<string, unknown>,
  outputs: Record<string, StepOutput>,
  at: string,
): Record<string, string> {
  outputs[dataKey(step)] = { json: data, at };
  return Object.fromEntries(Object.keys(data).map((key) => [key, `steps.${dataKey(step)}.${key}`]));
}

/** A view a step left in what it returned, as the answer of a surface ask or of an agent's. */
export function surfaceOf(value: unknown): Surface | undefined {
  const surface = isRecord(value) ? value.surface : undefined;
  return isRecord(surface) && Array.isArray(surface.components) && isRecord(surface.data)
    ? (surface as unknown as Surface)
    : undefined;
}

/**
 * What is wrong with the view of an ask a person answers, or nothing: the kernel fails such an
 * ask at once, with these words, where a wizard of version 0.2.0 is told when it is saved.
 */
export function viewIssue(spec: Spec): string | undefined {
  if (spec.type !== "form" && spec.type !== "review") {
    return undefined;
  }
  const data = Object.keys(viewData(spec.data) ?? {});
  if (!spec.components) {
    return data.length ? 'An ask reads "data" only with "components".' : undefined;
  }
  const fields = spec.type === "form" ? (spec.fields ?? []).map((field) => field.id) : [];
  const twice = data.find((key) => fields.includes(key));
  if (twice) {
    return `The data key "${twice}" is also a field of this form; they read the same name.`;
  }
  const issues = validateSurface(
    spec.components,
    [...fields, ...data],
    spec.type === "form" ? { form: fields } : {},
  );
  return issues.length ? `The view: ${issues.map((issue) => issue.message).join(" ")}` : undefined;
}
