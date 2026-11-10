import type { ToolStep } from "@engenty/wizards-shared/definition";
import type { StepOutput } from "@engenty/wizards-shared/run";
import { isPending } from "@engenty/wizards-shared/run-services";
import { runStepData } from "../data-step.js";
import { renderTemplate } from "../template.js";
import { type StepContext, StepError } from "../types.js";
import { listWriteInput } from "./list-write.js";

/**
 * A call's input as the step's answers fill it: string values are templates; a filled-in whole
 * number or true/false becomes one, an empty value is left out.
 */
function callInput(value: unknown, ctx: StepContext): unknown {
  if (typeof value === "string") {
    const text = renderTemplate(value, ctx.scope).trim();
    if (!text) {
      return undefined;
    }
    if (/^-?\d+(\.\d+)?$/.test(text)) {
      return Number(text);
    }
    return text === "true" ? true : text === "false" ? false : text;
  }
  if (Array.isArray(value)) {
    return value.map((v) => callInput(v, ctx)).filter((v) => v !== undefined);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .map(([k, v]) => [k, callInput(v, ctx)] as const)
        .filter(([, v]) => v !== undefined),
    );
  }
  return value;
}

/**
 * A step's `call`: one plugin tool, `list_write` or one action of a connection, no model; its
 * answer is the step's json output as it is. A connection's action runs through the broker as the
 * step, with the fields the wizard fixed: the one way a run writes as the space.
 */
export async function runToolStep(step: ToolStep, ctx: StepContext): Promise<StepOutput> {
  if (!step.call) {
    if (!step.data) {
      throw new StepError('A tool step has "call" or "data".');
    }
    return { json: await runStepData(step.data, ctx), at: new Date().toISOString() };
  }
  // What it is doing is the step's `working` line, shown as it starts, and what the tool says.
  const input =
    "tool" in step.call && step.call.tool === "list_write"
      ? listWriteInput(step.call.input, ctx)
      : callInput(step.call.input, ctx);
  const called = await ctx.services.tools.call(
    {
      stepId: step.id,
      name: "tool" in step.call ? step.call.tool : `${step.call.connection}.${step.call.action}`,
      input,
      effect: null,
    },
    ctx.signal,
  );
  if (isPending(called)) {
    throw new StepError(`${step.id}: the call did not answer.`);
  }
  const answer = called.output;
  if (
    answer &&
    typeof answer === "object" &&
    "error" in answer &&
    Object.keys(answer).length === 1
  ) {
    throw new StepError(String((answer as { error: unknown }).error));
  }
  const json =
    answer && typeof answer === "object" && !Array.isArray(answer) ? answer : { result: answer };
  return { json, at: new Date().toISOString() };
}
