import type { ToolStep } from "@engenty/wizards-shared/definition";
import type { StepOutput } from "@engenty/wizards-shared/run";
import { callConnection } from "../../tools/connector.js";
import { callPluginTool } from "../../tools/plugin.js";
import { runStepData } from "../data-step.js";
import { renderTemplate } from "../template.js";
import { type StepContext, StepError } from "../types.js";

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
 * A step's `call`: one plugin tool or one action of a connection, no model; its answer is the
 * step's json output as it is. A connection's action runs through the broker as the step, with
 * the fields the wizard fixed: the one way a run writes as the space.
 */
export async function runToolStep(step: ToolStep, ctx: StepContext): Promise<StepOutput> {
  if (!step.call) {
    if (!step.data) {
      throw new StepError('A tool step has "call" or "data".');
    }
    return { json: await runStepData(step.data, ctx), at: new Date().toISOString() };
  }
  // What it is doing is the step's `working` line, shown as it starts, and what the tool says.
  const input = callInput(step.call.input, ctx);
  const answer =
    "tool" in step.call
      ? await callPluginToolOnce(step.call.tool, input, ctx)
      : await callConnection(step.call, input, ctx);
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

/** What a plugin's tool does nobody knows here, so a later try of the step does not repeat it. */
function callPluginToolOnce(tool: string, input: unknown, ctx: StepContext) {
  ctx.resources.acted = true;
  return callPluginTool(tool, input, ctx);
}
