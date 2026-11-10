import type { RunState, RunTurn } from "@engenty/wizards-shared/run";
import type { TurnRequest } from "@engenty/wizards-shared/run-services";
import type { z } from "zod";
import type { StepContext } from "../types.js";

/** What a step asks the model in one call: the step and the signal come from its context. */
export type StepTurn = Omit<TurnRequest, "stepId">;

/** One model call through the run's models service, its answer as text. */
export async function turnText(ctx: StepContext, request: StepTurn): Promise<string> {
  let text = "";
  for await (const part of ctx.services.models.turn(
    { stepId: ctx.stepId, ...request },
    ctx.signal,
  )) {
    if (part.type === "text") {
      text += part.text;
    }
  }
  return text;
}

/**
 * One model call for a structured answer (`request.output`), checked against `schema`: what
 * the schema makes of the answer, or an error where it does not fit.
 */
export async function turnObject<T>(
  ctx: StepContext,
  request: StepTurn & { output: NonNullable<TurnRequest["output"]> },
  schema: z.ZodType<T>,
): Promise<T> {
  const text = await turnText(ctx, request);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("No object generated: could not parse the response.");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error("No object generated: response did not match schema.");
  }
  return parsed.data;
}

/** The durable turn on a run's state, when it belongs to this step. */
export function turnOf(state: RunState, stepId: string): RunTurn | undefined {
  return state.turn?.stepId === stepId ? state.turn : undefined;
}
