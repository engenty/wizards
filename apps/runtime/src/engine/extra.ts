import { type AgentStep, classIdOf, textClassOf } from "@engenty/wizards-shared/definition";
import { type ExtraBy, type StepModel, stepUp } from "@engenty/wizards-shared/extra";
import type { RunNoteCode } from "@engenty/wizards-shared/run";
import { createTool } from "@mastra/core/tools";
import type { LanguageModel } from "ai";
import { z } from "zod";
import {
  agentModel,
  costOf,
  currentTiers,
  keepsOwnLoop,
  type ResolvedModel,
  textModel,
  totalUsage,
} from "../models.js";
import { prompt } from "../prompts.js";
import type { StepContext } from "./types.js";

/**
 * Extra in a run (docs/plans/extra.md): a skill, a tool or the model asks for a stronger model
 * and more effort. The step's `extra` rule and who is there decide: switch and say so, ask the
 * person, or stay. Once on, it holds for the rest of the run; a person's no holds too.
 */

/** What the asker hears back: on from the next model call, a person's no, or no switch. */
export type ExtraOutcome = "on" | "off" | "stays";

/** The longest reason kept, in the asker's words. */
const REASON_CHARS = 200;

async function bounds() {
  const { tier, modelPolicy } = await currentTiers();
  return { tier, policy: modelPolicy };
}

/** What an AI step runs on: its own model, one step up while the run is on Extra. */
export async function stepModelOf(step: StepModel, ctx: Pick<StepContext, "state">) {
  if (!ctx.state.extra?.on) {
    return step;
  }
  return stepUp(step, await bounds()) ?? step;
}

/** The model of a step's class, maker and effort, for its run and step. */
export function resolveStepModel(m: StepModel, ctx: Pick<StepContext, "call">) {
  return textModel(textClassOf(m.model ?? "standard"), {
    ...ctx.call,
    effort: m.effort,
    makerClass: m.maker ? classIdOf(m, "standard") : undefined,
  });
}

/** Lines said in a step already, per run: an asker that asks again is not logged again. */
const told = new WeakMap<object, Set<string>>();

async function say(ctx: StepContext, code: RunNoteCode, reason: string) {
  const key = `${ctx.stepId}:${code}`;
  const said = told.get(ctx.resources) ?? new Set<string>();
  told.set(ctx.resources, said);
  if (said.has(key)) {
    return;
  }
  said.add(key);
  await ctx.emit("info", { code, params: { reason } });
}

/**
 * Something in the step asks for Extra. Decided once per run: a run on Extra stays on it, a no
 * holds. Otherwise the step's rule decides; `ask` puts it to a person of the organization, and
 * where nobody is there to answer the run stays as it is.
 */
export async function decideExtra(
  step: Pick<AgentStep, "model" | "maker" | "effort" | "extra">,
  ctx: StepContext,
  asked: string,
  by: ExtraBy,
): Promise<ExtraOutcome> {
  const now = ctx.state.extra;
  if (now) {
    return now.on ? "on" : "off";
  }
  const reason = asked.replace(/\s+/g, " ").trim().slice(0, REASON_CHARS) || by.name;
  const rule = step.extra ?? "ask";
  if (rule === "deny") {
    await say(ctx, "extraStays", reason);
    return "stays";
  }
  if (!stepUp(step, await bounds())) {
    await say(ctx, "extraTop", reason);
    return "stays";
  }
  if (rule === "ask") {
    const answer = await ctx.ask({ kind: "extra", reason, by });
    if (!answer) {
      await say(ctx, "extraNobody", reason);
      return "stays";
    }
    if (answer.type !== "done") {
      ctx.state.extra = { on: false, reason, by, at: new Date().toISOString() };
      await ctx.saveState();
      await ctx.emit("info", { code: "extraDeclined" });
      return "off";
    }
  }
  ctx.state.extra = { on: true, reason, by, at: new Date().toISOString() };
  await ctx.saveState();
  await ctx.emit("info", { code: "extraOn", params: { reason } });
  return "on";
}

/**
 * Extra inside one AI step. `ask` is what its tools call; where the run goes on Extra the step's
 * next model call switches (`prepareStep`), unless the step already runs on it or its model keeps
 * its own loop: then the next AI step starts on it. `charge` books each model call as the model
 * that made it.
 */
export function extraSwitch(
  step: AgentStep,
  ctx: StepContext,
  resolved: ResolvedModel<LanguageModel>,
  { mid }: { mid: boolean },
) {
  const startedOn = Boolean(ctx.state.extra?.on);
  let pending = false;
  let current = resolved;
  /** The model call from which the step ran on Extra; null while it hasn't switched. */
  let from: number | null = null;
  return {
    ask: async (reason: string, by: ExtraBy): Promise<ExtraOutcome> => {
      const outcome = await decideExtra(step, ctx, reason, by);
      if (outcome === "on" && mid && !startedOn && from === null && !keepsOwnLoop(resolved)) {
        pending = true;
      }
      return outcome;
    },
    prepareStep: async ({ stepNumber }: { stepNumber: number }) => {
      if (!pending) {
        return undefined;
      }
      pending = false;
      const up = stepUp(step, await bounds());
      if (!up) {
        return undefined;
      }
      const next = await resolveStepModel(up, ctx);
      // A model that keeps its own loop can't take over in the middle: the next AI step has it.
      if (keepsOwnLoop(next)) {
        return undefined;
      }
      current = next;
      from = stepNumber;
      return { model: agentModel(next) as never };
    },
    charge: async (result: object) => {
      if (from === null) {
        await ctx.chargeUsd(costOf(resolved, await totalUsage(result)));
        return;
      }
      const steps: any[] = (await (result as { steps?: unknown }).steps) as any[];
      let usd = 0;
      for (const [i, s] of (steps ?? []).entries()) {
        usd += costOf(i < from ? resolved : current, s?.usage ?? s?.output?.usage);
      }
      await ctx.chargeUsd(usd);
    },
  };
}

const HEARD: Record<ExtraOutcome, string> = {
  on: "note.extra_on",
  off: "note.extra_off",
  stays: "note.extra_stays",
};

/** What the asker reads back after asking, for a model. */
export function extraNote(outcome: ExtraOutcome): string {
  return prompt("tools", HEARD[outcome]);
}

/** `need_extra`: the model asks for Extra itself, with its reason. */
export function needExtraTool(ask: (reason: string, by: ExtraBy) => Promise<ExtraOutcome>) {
  return {
    need_extra: createTool({
      id: "need_extra",
      description: prompt("tools", "tool.need_extra"),
      inputSchema: z.object({ reason: z.string().min(1).max(REASON_CHARS) }),
      execute: async ({ reason }) => {
        const extra = await ask(reason, { kind: "model", name: "need_extra" });
        return { extra, note: extraNote(extra) };
      },
    }),
  };
}
