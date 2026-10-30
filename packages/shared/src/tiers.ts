/**
 * Model tiers: the managed model lists of an organization with compliance needs, and how its
 * admins share out the tier's models (its policy). The Manage-App serves both in
 * `GET /v1/tenants/:id` and enforces them in its gateway (docs/manage-contract.md, "Model
 * tiers"); the runtime shows them and names the class a step asks for. Behind `modelTiers`.
 */
import { z } from "zod";
import {
  EFFORTS,
  type Effort,
  MAKER_CLASSES,
  MAKERS,
  type Maker,
  type StepClass,
} from "./definition.js";

/** What a call is for: a run, the studio outside a run (Goose, the editor), a work chat. */
export type Purpose = "wizard" | "assistant" | "work";

/** Why a class is not offered in a tier. */
type TierReason = "unbound" | "region" | "retention" | "training" | "maker";

/** What a class (`high`, `anthropic/high`, `image`) runs on in a tier, or why it doesn't. */
export type TierClass =
  | { model: string; name: string; route: string | null; region: string | null }
  | { model: null; name: string | null; reason: TierReason };

/** A model the tier offers (`tier.models`): in its list and passing its rules now. */
export interface TierModel {
  /** The catalog id: "anthropic/claude-sonnet-5.5". */
  id: string;
  name: string;
  maker: string;
  kind: "text" | "image" | "video" | "audio" | "speech";
  /** The offered classes it runs on now: "standard", "anthropic/standard". */
  classes: string[];
  /** The efforts it takes; empty for none. */
  efforts: Effort[];
  /** In the tier's preselection: what the studio's choosers show after Auto. */
  chooser: boolean;
}

export interface ModelTier {
  id: string;
  /** Shown in the studio: "EU Private". */
  name: string;
  /** Set by contract: the organization's owner can't pick another. */
  locked: boolean;
  rules: {
    /** Where calls may run ("EU"); null: anywhere. */
    regions: string[] | null;
    zdr: boolean;
    noTraining: boolean;
    search: boolean;
    /** An evaluation model may answer decisions. */
    decisions: boolean;
  };
  /** Every class the gateway knows; one missing is not offered. */
  classes: Record<string, TierClass>;
  /** What the tier offers, the preselection first. */
  models: TierModel[];
  /** Every tier there is, in order, and whether the plan offers it. */
  choices: { id: string; name: string; inPlan: boolean }[];
}

export interface PurposePolicy {
  /** Way C: the classes and models people may pick; null: the whole tier. */
  models: string[] | null;
  /** Way B: the class or model a new step or chat starts on. */
  default: string | null;
  /** Way B: the highest effort people may set. */
  effortCap: Effort | null;
  /** Way C: the efforts offered per entry of `models`. */
  efforts: Record<string, Effort[]> | null;
}

export interface ModelPolicy {
  /** A: engenty picks · B: admins set defaults · C: approved models only. */
  way: "A" | "B" | "C";
  purposes: Record<Purpose, PurposePolicy>;
  credits: boolean;
  ownKeys: boolean;
  /** A member's AI client on their own subscription, for Goose. */
  subscriptions: boolean;
  /** A model on a member's computer, for Goose. */
  localModels: boolean;
  /** Apps connected to a space over MCP: those with local models, those on subscriptions. */
  apps: { local: boolean; subscriptions: boolean };
  masking: boolean;
  /** What else to mask, in the admins' words; saved, it turns into `maskLabels`. */
  maskInstructions: string;
  /** What the masking detector looks for besides personal data: `company`, `project name`. */
  maskLabels: string[];
}

/** Masking instructions and the labels they turn into, as the Manage-App takes them. */
export const MAX_MASK_INSTRUCTIONS = 1000;
export const MAX_MASK_LABELS = 20;
export const MAX_MASK_LABEL_CHARS = 60;

/** The makers by company name, as a tier leaves one out: "EU Sovereign leaves out Anthropic". */
export const MAKER_COMPANIES: Record<Maker, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  mistral: "Mistral AI",
};

/** The makers by their models' name, as a maker class reads: "Claude · High". */
export const MAKER_FAMILIES: Record<Maker, string> = {
  anthropic: "Claude",
  openai: "GPT",
  google: "Gemini",
  mistral: "Mistral",
};

/** A tier's class id split: `anthropic/high` → maker and class; `video` → no maker. */
export function splitClassId(id: string): { maker: Maker | null; cls: string } {
  const [maker, cls] = id.split("/");
  return cls && (MAKERS as readonly string[]).includes(maker)
    ? { maker: maker as Maker, cls }
    : { maker: null, cls: id };
}

const LEVELS: readonly string[] = ["low", "standard", "high", "highest"];

/** The class a pick of a model asks for: a maker class first, so it follows the tier's binding. */
export function pickClassOf(classes: string[]): string | null {
  const picked = classes.filter((id) => LEVELS.includes(splitClassId(id).cls));
  return picked.find((id) => splitClassId(id).maker) ?? picked[0] ?? null;
}

/**
 * A pick of a chooser as the class a step or chat asks for: a class id as it is, a model id of
 * `tier.models` as the class it runs on. Null where it is neither a level people pick (`low`,
 * `standard`, `high`) nor a maker class the maker has.
 */
export function pickedClass(
  tier: ModelTier,
  id: string,
): { maker: Maker | null; cls: StepClass } | null {
  const model = tier.models.find((m) => m.id === id);
  const classId = model ? pickClassOf(model.classes) : id;
  if (!classId) {
    return null;
  }
  const { maker, cls } = splitClassId(classId);
  if (!LEVELS.includes(cls)) {
    return null;
  }
  // `highest` exists only as a maker class.
  const fits = maker ? MAKER_CLASSES[maker].includes(cls as StepClass) : cls !== "highest";
  return fits ? { maker, cls: cls as StepClass } : null;
}

/**
 * What a call for a tier's class asks the gateway for (docs/manage-contract.md, "Model tiers"):
 * the class, or the model it runs on where the purpose's way-C list approves that model and not
 * the class.
 */
export function policyEntry(
  tier: ModelTier,
  policy: ModelPolicy | null,
  purpose: Purpose,
  classId: string,
): string {
  const list = policy?.way === "C" ? policy.purposes[purpose].models : null;
  const model = tier.classes[classId]?.model;
  return list && !list.includes(classId) && model && list.includes(model) ? model : classId;
}

/** Why a call was refused by the gateway for the organization's tier or policy. */
export type TierRefusalType = "outside_tier" | "not_in_policy";

const purposePolicySchema = z.object({
  models: z.array(z.string().min(1).max(200)).max(100).nullable(),
  default: z.string().min(1).max(200).nullable(),
  effortCap: z.enum(EFFORTS).nullable(),
  efforts: z.record(z.string(), z.array(z.enum(EFFORTS)).min(1)).nullable(),
});

/**
 * A policy as the studio's admins save it, checked for its shape only: the Manage-App checks it
 * against the plan and the tier and keeps what the way uses. The masking fields left out stay
 * as saved.
 */
export const modelPolicySchema = z.object({
  way: z.enum(["A", "B", "C"]),
  purposes: z.object({
    wizard: purposePolicySchema,
    assistant: purposePolicySchema,
    work: purposePolicySchema,
  }),
  credits: z.boolean(),
  ownKeys: z.boolean(),
  subscriptions: z.boolean(),
  localModels: z.boolean(),
  apps: z.object({ local: z.boolean(), subscriptions: z.boolean() }),
  masking: z.boolean(),
  maskInstructions: z.string().max(MAX_MASK_INSTRUCTIONS).optional(),
  maskLabels: z
    .array(z.string().trim().min(1).max(MAX_MASK_LABEL_CHARS))
    .max(MAX_MASK_LABELS)
    .optional(),
});

export type ModelPolicyInput = z.infer<typeof modelPolicySchema>;
