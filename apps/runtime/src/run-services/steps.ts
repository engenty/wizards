import { StepError } from "@engenty/wizards-engine/types";
import { note, type StepOutput } from "@engenty/wizards-shared/run";
import type { ServiceStep, StepsService } from "@engenty/wizards-shared/run-services";
import { actOnce, effectOn } from "../broker/effect.js";
import { runGenerateStep } from "../media/step.js";
import { runMotionGraphicsStep } from "../motion-graphics/step.js";
import { runServicesOn } from "../tools/acted.js";
import { askOf } from "../tools/code.js";
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
    async run(step, _signal, effect) {
      const c = at(step.id);
      const id = await effectOn(effect);
      // Made once per visit: the row keeps the finished output, never a `pending`.
      const work = (ctx: InProcessContext) => (id ? wholeOnce(step, ctx, id) : whole(step, ctx));
      const kind = jobKindOf(step);
      if (kind && (await runServicesOn())) {
        return answerJob(step, c, kind, work);
      }
      return work(c);
    },
  };
}

/**
 * The step under its effect id: a restart, or a job started again after its process went, answers
 * with the output made, its files by reference.
 */
async function wholeOnce(step: ServiceStep, c: InProcessContext, id: string): Promise<StepOutput> {
  const made = await actOnce(
    { id, runId: c.runId, stepId: step.id, tool: `step:${step.type}` },
    () => whole(step, c),
    { ask: askOf(c), summary: step.title, service: c.def.title, own: true },
  );
  if ("unsure" in made) {
    throw new StepError(note("stepMayHaveHappened", { what: step.title }));
  }
  return made.done;
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
