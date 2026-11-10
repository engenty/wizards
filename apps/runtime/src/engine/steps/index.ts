import { decisionAsAgent, type Step } from "@engenty/wizards-shared/definition";
import type { StepOutput } from "@engenty/wizards-shared/run";
import { isServiceStep } from "@engenty/wizards-shared/run-services";
import { runCodeStep } from "../code-step.js";
import { runSurfaceStep } from "../surface.js";
import { type StepContext, StepError } from "../types.js";
import { runAgentStep } from "./agent.js";
import { runToolStep } from "./tool.js";

export { outputSchema, ownJson, runAgentStep } from "./agent.js";

export async function runAutomaticStep(step: Step, ctx: StepContext): Promise<StepOutput> {
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
    return ctx.services.steps.run(step);
  }
  if (step.type === "surface") {
    return runSurfaceStep(step, ctx);
  }
  throw new StepError(`Step ${step.id} is not automatic.`);
}
