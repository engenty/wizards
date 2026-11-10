import type { StepOutput } from "@engenty/wizards-shared/run";
import type { ServiceStep, StepsService } from "@engenty/wizards-shared/run-services";
import { runGenerateStep } from "../media/step.js";
import { runMotionGraphicsStep } from "../motion-graphics/step.js";
import { runServicesOn } from "../tools/acted.js";
import { runWidgetStep } from "../widgets/step.js";
import type { InProcessContext } from "./in-process.js";
import { answerJob, jobKindOf } from "./jobs.js";

/**
 * The whole steps inside the runtime. A film or a video answers `pending` with `runServices` on:
 * it is a job (./jobs.ts), and the run sleeps until it is done. Every other step, and every step
 * with the switch off, answers with its output.
 */
export type InProcessSteps = StepsService;

/** `at`: the step context under a step's id. */
export function stepsService(at: (stepId: string) => InProcessContext): InProcessSteps {
  return {
    async run(step) {
      const c = at(step.id);
      const kind = jobKindOf(step);
      if (kind && (await runServicesOn())) {
        return answerJob(step, c, kind, (ctx) => whole(step, ctx));
      }
      return whole(step, c);
    },
  };
}

function whole(step: ServiceStep, c: InProcessContext): Promise<StepOutput> {
  switch (step.type) {
    case "generate":
      return runGenerateStep(step, c);
    case "widget":
      return runWidgetStep(step, c);
    case "motion-graphics":
      return runMotionGraphicsStep(step, c);
  }
}
