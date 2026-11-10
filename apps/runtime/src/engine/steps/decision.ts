import { type DecisionQuestion, pOf } from "@engenty/wizards-shared/decision";
import type { AgentStep } from "@engenty/wizards-shared/definition";
import type { StepOutput } from "@engenty/wizards-shared/run";
import { decide } from "../decide.js";
import type { StepContext } from "../types.js";

/**
 * A decision step: its yes/no, choice and score fields are the questions, its prompt the state,
 * answered in one call through decide() — with probabilities where a decision model answers.
 */
export async function decideStep(
  step: AgentStep,
  state: string,
  ctx: StepContext,
): Promise<StepOutput> {
  const fields = step.output.fields ?? [];
  const questions: Record<string, DecisionQuestion> = {};
  for (const f of fields) {
    const instructions = f.description ?? f.id;
    if (f.kind === "yesno") {
      questions[f.id] = { type: "noul", instructions };
    } else if (f.kind === "choice") {
      questions[f.id] = {
        type: "choice",
        instructions,
        criteria: Object.fromEntries((f.options ?? []).map((o) => [o, null])),
      };
    } else if (f.kind === "score") {
      questions[f.id] = { type: "score", instructions, criteria: f.options ?? [] };
    }
  }
  const decision = await decide({
    state,
    questions,
    call: ctx.call,
    signal: ctx.signal,
    charge: ctx.chargeUsd,
  });
  const json: Record<string, unknown> = {};
  const decided: Record<string, number> = {};
  for (const [id, answer] of Object.entries(decision.answers)) {
    json[id] =
      answer.type === "noul"
        ? answer.noul >= 0.5
        : answer.type === "choice"
          ? answer.choice
          : answer.label;
    decided[id] = Math.round(pOf(answer) * 1000) / 1000;
  }
  const text = fields
    .map((f) => {
      const value = json[f.id];
      return `${f.description ?? f.id}: ${value === true ? "ja" : value === false ? "nein" : String(value)}`;
    })
    .join("\n");
  return { text, json, decided, at: new Date().toISOString() };
}
