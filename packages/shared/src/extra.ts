/**
 * Extra (docs/plans/extra.md): a skill or the model asks for a stronger model and more effort for
 * the rest of a run. What that is, one step up from the step's own class and effort, inside what
 * the organization's tier and its admins' policy offer.
 */
import { EFFORTS, type Effort, MAKER_CLASSES, type Maker, type StepClass } from "./definition.js";
import type { ModelPolicy, ModelTier } from "./tiers.js";

/** What an AI step runs on: its class, the maker it names, its effort. */
export interface StepModel {
  model?: StepClass;
  maker?: Maker;
  effort?: Effort;
}

/** Who asked: a skill as it loaded, a tool as it was called, the model through `need_extra`. */
export interface ExtraBy {
  kind: "skill" | "tool" | "model";
  name: string;
}

/**
 * Extra in a run's state. `on`: the run runs on it; off where a person said no (or didn't answer),
 * which holds for the rest of the run.
 */
export interface RunExtra {
  on: boolean;
  reason: string;
  by: ExtraBy;
  at: string;
}

const NEXT: Record<StepClass, StepClass> = {
  classifier: "standard",
  low: "standard",
  standard: "high",
  high: "highest",
  highest: "highest",
};

/** The effort one level up; none given is the default, and one up from it is `high`. */
function effortUp(effort: Effort | undefined): Effort {
  if (!effort) {
    return "high";
  }
  return EFFORTS[Math.min(EFFORTS.indexOf(effort) + 1, EFFORTS.length - 1)];
}

/** Whether the tier offers a class (`high`, `anthropic/high`) and the policy lets wizards use it. */
function offered(tier: ModelTier, policy: ModelPolicy | null, id: string): boolean {
  const model = tier.classes[id]?.model;
  if (!model) {
    return false;
  }
  const list = policy?.way === "C" ? policy.purposes.wizard.models : null;
  return !list || list.includes(id) || list.includes(model);
}

/**
 * A step's model one step up: the next class (keeping the maker; `highest` only with a maker
 * that has it) and the next effort. A class the tier doesn't offer or the policy leaves out
 * stays; the effort stays at the policy's cap. Null where nothing goes up.
 */
export function stepUp(
  step: StepModel,
  bounds: { tier: ModelTier | null; policy: ModelPolicy | null } = { tier: null, policy: null },
): StepModel | null {
  const from = step.model ?? "standard";
  let model = NEXT[from];
  if (model === "highest" && !(step.maker && MAKER_CLASSES[step.maker].includes("highest"))) {
    model = from === "highest" ? "highest" : "high";
  }
  if (model !== from && bounds.tier) {
    const id = step.maker ? `${step.maker}/${model}` : model;
    if (!offered(bounds.tier, bounds.policy, id)) {
      model = from;
    }
  }
  let effort = effortUp(step.effort);
  const cap = bounds.policy?.way === "B" ? bounds.policy.purposes.wizard.effortCap : null;
  if (cap && EFFORTS.indexOf(effort) > EFFORTS.indexOf(cap)) {
    effort = step.effort && EFFORTS.indexOf(step.effort) > EFFORTS.indexOf(cap) ? step.effort : cap;
  }
  const up: StepModel = { model, ...(step.maker ? { maker: step.maker } : {}), effort };
  return model === (step.model ?? "standard") && effort === step.effort ? null : up;
}

/**
 * Whether a skill asks for Extra as it loads, and why: front matter `extra: true` (the reason is
 * the skill's description) or `extra: <reason>`, also under `metadata`. Null where it doesn't.
 */
export function skillExtra(skill: {
  description: string;
  meta?: Record<string, unknown>;
}): string | null {
  const nested = skill.meta?.metadata;
  const raw =
    skill.meta?.extra ??
    (nested && typeof nested === "object" ? (nested as Record<string, unknown>).extra : undefined);
  const said = typeof raw === "string" ? raw.trim() : raw;
  if (said === true || said === "true") {
    return skill.description;
  }
  return typeof said === "string" && said && !/^(false|no|off)$/i.test(said) ? said : null;
}
