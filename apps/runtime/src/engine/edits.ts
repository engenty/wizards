/** Data of a run's json step as a person edits it: in the studio, or at a review. */
import { outputSchema } from "@engenty/wizards-engine/steps/index";
import { isDataStep, outputOf, type WizardDefinition } from "@engenty/wizards-shared/definition";
import type { StepOutput } from "@engenty/wizards-shared/run";
import { fitData } from "@engenty/wizards-shared/shape";
import { RunConflict } from "./runner.js";

/** Edited data of a json step is kept up to this size. */
const MAX_EDITED_JSON = 500_000;

/**
 * A json step's output with data someone edited: checked against the step's schema, and what
 * its view shows too. Refused when it does not fit.
 */
export function editedJson(
  def: WizardDefinition,
  stepId: string,
  output: StepOutput,
  data: Record<string, unknown>,
): StepOutput {
  const step = def.steps.find((s) => s.id === stepId);
  // A tool's answer is kept as it came; an agent step with `foreach` hands on its rows.
  if (
    !isDataStep(step) ||
    step.type === "tool" ||
    (step.type === "agent" && step.foreach) ||
    outputOf(step).format !== "json"
  ) {
    throw new RunConflict("Not a json step");
  }
  if (JSON.stringify(data).length > MAX_EDITED_JSON) {
    throw new RunConflict("Too large");
  }
  const { schema, shape } = outputSchema(step);
  const parsed = schema.safeParse(fitData(shape, data));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new RunConflict(`Does not fit the schema: ${issue?.path.join(".")} ${issue?.message}`);
  }
  const json = parsed.data;
  return {
    ...output,
    json,
    ...(output.surface ? { surface: { ...output.surface, data: json } } : {}),
  };
}
