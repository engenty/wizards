import { decisionAsAgent, type Step } from "@engenty/wizards-shared/definition";
import type { StepOutput } from "@engenty/wizards-shared/run";
import { isServiceStep, type Pending } from "@engenty/wizards-shared/run-services";
import { runCodeStep } from "../code-step.js";
import { visitEffect } from "../ids.js";
import { runSurfaceStep } from "../surface.js";
import { type StepContext, StepError } from "../types.js";
import { runAgentStep } from "./agent.js";
import { runToolStep } from "./tool.js";

export { outputSchema, ownJson, runAgentStep } from "./agent.js";

/** An automatic step's output; `pending` where a service works on a whole step and the run sleeps. */
export async function runAutomaticStep(
  step: Step,
  ctx: StepContext,
): Promise<StepOutput | Pending> {
  await ctx.services.context.prepareInputs(step.id);
  if (step.type === "agent") {
    return runAgentStep(step, ctx);
  }
  if (step.type === "decision") {
    return runAgentStep(decisionAsAgent(step), ctx, true);
  }
  if (step.type === "tool") {
    return runToolStep(step, ctx);
  }
  if (step.type === "code") {
    return runCodeStep(step, ctx);
  }
  if (isServiceStep(step)) {
    // A film is made once per visit: a restart finds the one made.
    return ctx.services.steps.run(step, ctx.signal, visitEffect(ctx));
  }
  if (step.type === "surface") {
    return runSurfaceStep(step, ctx);
  }
  throw new StepError(`Step ${step.id} is not automatic.`);
}
