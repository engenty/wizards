import type { DecisionQuestion } from "@engenty-wizards/shared/decision";
import {
  assembleSurface,
  dataRef,
  listRef,
  type SurfaceStep,
} from "@engenty-wizards/shared/definition";
import type { StepOutput } from "@engenty-wizards/shared/run";
import { note } from "@engenty-wizards/shared/run";
import { type SurfaceComponent, validateSurface } from "@engenty-wizards/shared/surface";
import { decide } from "./decide.js";
import { answersAsText, resolveRef } from "./template.js";
import { type StepContext, StepError } from "./types.js";

/**
 * A surface step: its data read from the run (answers, outputs, stored lists; the pictures a
 * step made as asset ids), its components written once — or, for a decided surface, the pieces
 * one decision keeps. Checked against the catalog before it is shown.
 */
export async function runSurfaceStep(step: SurfaceStep, ctx: StepContext): Promise<StepOutput> {
  const data = surfaceData(step.data, ctx);
  const components = step.components ?? (await decidedComponents(step, ctx));
  const issues = validateSurface(components, Object.keys(data));
  if (issues.length) {
    throw new StepError(note("viewErrors", { detail: issues.map((i) => i.message).join(" ") }));
  }
  return { surface: { components, data }, at: new Date().toISOString() };
}

/** What a surface reads: key → a field, a step's output or one of its fields, a stored list. */
export function surfaceData(
  refs: Record<string, string>,
  ctx: Pick<StepContext, "def" | "state" | "scope">,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(refs)) {
    const ref = dataRef(raw);
    const list = listRef(ref);
    if (list) {
      out[key] = (ctx.scope.lists?.[list]?.rows ?? []).map((r) => r.cells);
      continue;
    }
    const source = ctx.def.steps.find((s) => `steps.${s.id}` === ref);
    if (source && (source.type === "generate" || source.type === "widget")) {
      // Pictures and clips by asset id: the runner shows them from the run's files.
      const ids = (ctx.state.outputs[source.id]?.assets ?? []).map((a) => a.id);
      out[key] = source.type === "generate" && source.each ? ids : (ids[0] ?? null);
      continue;
    }
    const output = source ? ctx.state.outputs[source.id] : undefined;
    out[key] = output ? (output.json ?? output.text ?? null) : (resolveRef(ref, ctx.scope) ?? null);
  }
  return out;
}

/** The pieces of a decided surface one decision keeps: required ones always. */
async function decidedComponents(step: SurfaceStep, ctx: StepContext): Promise<SurfaceComponent[]> {
  const candidates = step.candidates ?? [];
  const questions: Record<string, DecisionQuestion> = {};
  for (const c of candidates) {
    if (!c.required && !c.group) {
      questions[`p_${c.id}`] = {
        type: "noul",
        instructions: `Should the view show this: ${c.description}`,
      };
    }
  }
  for (const g of step.groups ?? []) {
    const members = candidates.filter((c) => c.group === g.id && !c.required);
    if (members.length) {
      questions[`g_${g.id}`] = {
        type: "choice",
        instructions: g.instructions,
        criteria: {
          ...Object.fromEntries(members.map((c) => [c.id, c.description])),
          ...(g.optional ? { none: "None of these." } : {}),
        },
      };
    }
  }
  const kept = new Set(candidates.filter((c) => c.required).map((c) => c.id));
  if (Object.keys(questions).length) {
    const results = Object.fromEntries(
      ctx.def.steps
        .map((s) => [s.title, ctx.state.outputs[s.id]?.text ?? ""] as const)
        .filter(([, text]) => text)
        .map(([title, text]) => [title, text.slice(0, 6000)]),
    );
    const decision = await decide({
      state: { answers: answersAsText(ctx.scope), results },
      questions,
      call: ctx.call,
      signal: ctx.signal,
      charge: ctx.chargeUsd,
    });
    for (const [name, answer] of Object.entries(decision.answers)) {
      if (answer.type === "noul" && answer.noul >= 0.5) {
        kept.add(name.slice(2));
      } else if (answer.type === "choice" && answer.choice !== "none") {
        kept.add(answer.choice);
      }
    }
  }
  return assembleSurface(candidates, kept);
}
