import { decisionAsAgent, type Step } from "@engenty/wizards-shared/definition";
import type { StepOutput } from "@engenty/wizards-shared/run";
import { runMotionGraphicsStep } from "../../motion-graphics/step.js";
import { runWidgetStep } from "../../widgets/step.js";
import { runCodeStep } from "../code-step.js";
import { prepareInputs } from "../prepare.js";
import { runSurfaceStep } from "../surface.js";
import { type StepContext, StepError } from "../types.js";
import { runAgentStep } from "./agent.js";
import { runGenerateStep } from "./generate.js";
import { runToolStep } from "./tool.js";

export { outputSchema, ownJson, runAgentStep } from "./agent.js";

export async function runAutomaticStep(step: Step, ctx: StepContext): Promise<StepOutput> {
  await prepareInputs(ctx);
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
  if (step.type === "generate") {
    return runGenerateStep(step, ctx);
  }
  if (step.type === "widget") {
    return runWidgetStep(step, ctx);
  }
  if (step.type === "motion-graphics") {
    return runMotionGraphicsStep(step, ctx);
  }
  if (step.type === "surface") {
    return runSurfaceStep(step, ctx);
  }
  throw new StepError(`Step ${step.id} is not automatic.`);
}
