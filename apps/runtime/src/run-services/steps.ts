import type { StepOutput } from "@engenty/wizards-shared/run";
import type { ServiceStep, StepsService } from "@engenty/wizards-shared/run-services";
import { runGenerateStep } from "../media/step.js";
import { runMotionGraphicsStep } from "../motion-graphics/step.js";
import { runWidgetStep } from "../widgets/step.js";
import type { InProcessContext } from "./in-process.js";

/** The whole steps inside the runtime: each answers with its output, never `pending`. */
export interface InProcessSteps extends StepsService {
  run(step: ServiceStep): Promise<StepOutput>;
}

/** `at`: the step context under a step's id. */
export function stepsService(at: (stepId: string) => InProcessContext): InProcessSteps {
  return {
    run(step) {
      const c = at(step.id);
      switch (step.type) {
        case "generate":
          return runGenerateStep(step, c);
        case "widget":
          return runWidgetStep(step, c);
        case "motion-graphics":
          return runMotionGraphicsStep(step, c);
      }
    },
  };
}
