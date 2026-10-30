/**
 * The organization's model tier and its admins' policy, as the studio shows them: read from the
 * models endpoint while `modelTiers` is on (docs/manage-contract.md, "Model tiers").
 */
import {
  EFFORTS,
  type Effort,
  MAKER_CLASSES,
  MAKERS,
  TEXT_CLASSES,
} from "@engenty/wizards-shared/definition";
import {
  type ModelPolicy,
  type ModelTier,
  type Purpose,
  type PurposePolicy,
  pickClassOf,
  policyEntry,
  splitClassId,
  type TierClass,
  type TierModel,
} from "@engenty/wizards-shared/tiers";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useFeature } from "../lib/features";
import { type Key, t } from "../lib/i18n";

const TIER_NAMES: Record<string, Key> = {
  general: "tier.name.general",
  "eu-private": "tier.name.eu-private",
  "eu-sovereign": "tier.name.eu-sovereign",
};

/** A tier as people read it: "EU-Datenschutz" for `eu-private`; the Manage-App's name for others. */
export function tierName(id: string, name: string): string {
  const key = TIER_NAMES[id];
  return key ? t(key) : name;
}

/** The models endpoint's answer with the tiers named as people read them. */
export function withTierNames<T extends { tier?: ModelTier | null }>(data: T): T {
  const { tier } = data;
  return tier
    ? {
        ...data,
        tier: {
          ...tier,
          name: tierName(tier.id, tier.name),
          choices: tier.choices.map((c) => ({ ...c, name: tierName(c.id, c.name) })),
        },
      }
    : data;
}

/** The tier and the policy; both null without a tier or while `modelTiers` is off. */
export function useModelTiers(): { tier: ModelTier | null; modelPolicy: ModelPolicy | null } {
  const on = useFeature("modelTiers");
  const { data } = useQuery({
    queryKey: ["models"],
    queryFn: () =>
      api.get<{ tier?: ModelTier | null; modelPolicy?: ModelPolicy | null }>("/api/studio/models"),
    select: withTierNames,
    enabled: on,
  });
  return on
    ? { tier: data?.tier ?? null, modelPolicy: data?.modelPolicy ?? null }
    : { tier: null, modelPolicy: null };
}

/** A tier with any rule (regions, no retention, no training): own keys and subscriptions are the organization's own responsibility there. */
export const isStrict = (tier: ModelTier | null): boolean =>
  Boolean(tier && (tier.rules.regions || tier.rules.zdr || tier.rules.noTraining));

export const offered = (cls: TierClass | undefined): cls is Extract<TierClass, { model: string }> =>
  Boolean(cls?.model);

/** Why a class is not in the tier, in a sentence. */
export function reasonText(cls: TierClass | undefined): string {
  const model = cls?.name ?? t("tier.theModel");
  return cls && !offered(cls)
    ? t(`tier.reason.${cls.reason}`, { model })
    : t("tier.reason.unbound");
}

/** "Claude Opus 5.5 · Route, Frankfurt": what a class runs on, as people read it. */
export function runsOnText(cls: Extract<TierClass, { model: string }>): string {
  const where = [cls.route, cls.region].filter(Boolean).join(", ");
  return where ? `${cls.name} · ${where}` : cls.name;
}

/** A tier's class as people read it: "Claude · High", "Video", "Standard". */
export function tierClassLabel(id: string): string {
  const { maker, cls } = splitClassId(id);
  const name = t(`class.${cls}` as Key);
  return maker ? `${t(`maker.family.${maker}`)} · ${name}` : name;
}

/** The text classes of the tier people can pick: the plain ones, then each maker's. */
export function pickable(tier: ModelTier): string[] {
  return [
    ...TEXT_CLASSES.filter((cls) => cls !== "classifier"),
    ...MAKERS.flatMap((maker) =>
      MAKER_CLASSES[maker].map((cls) => `${maker}/${cls}`).filter((id) => id in tier.classes),
    ),
  ];
}

/** The entries a purpose allows in way C: its list, or every offered class of the tier. */
export function approved(tier: ModelTier, purpose: PurposePolicy): string[] {
  return purpose.models ?? pickable(tier).filter((id) => offered(tier.classes[id]));
}

/** One line of a model chooser: what a pick asks for, and the model it runs on now. */
export interface ChooserItem {
  /** The class a pick asks for: `anthropic/standard`, `high`. */
  id: string;
  /** The catalog id of the model it runs on. */
  model: string;
  name: string;
  /** "schnell · günstig": how the model works, from its class. */
  hint: string;
  /** The efforts the model takes. */
  efforts: Effort[];
}

function hintOf(id: string): string {
  return t(`chooser.hint.${splitClassId(id).cls}` as Key);
}

/** The tier's text models. */
function textModels(tier: ModelTier): TierModel[] {
  return tier.models.filter((m) => m.kind === "text");
}

const itemOf = (model: TierModel, id: string): ChooserItem => ({
  id,
  model: model.id,
  name: model.name,
  hint: hintOf(id),
  efforts: model.efforts,
});

/** The tier's preselection for text and thinking: one line per model, in the tier's order. */
export function preselection(tier: ModelTier): ChooserItem[] {
  return textModels(tier).flatMap((m) => {
    const id = m.chooser ? pickClassOf(m.classes) : null;
    return id ? [itemOf(m, id)] : [];
  });
}

/** The tier's text models off the preselection: what admins can still approve in way C. */
export function offPreselection(tier: ModelTier): ChooserItem[] {
  return textModels(tier).flatMap((m) => {
    const id = m.chooser ? null : pickClassOf(m.classes);
    return id ? [itemOf(m, id)] : [];
  });
}

/** What admins can approve in way C: the preselection, then the tier's other text models. */
export function approvable(tier: ModelTier): ChooserItem[] {
  return [...preselection(tier), ...offPreselection(tier)];
}

/**
 * A class or model id as a chooser line; null where the tier doesn't offer it. A model id (way
 * C's list may approve one) shows as the class a pick of it asks for.
 */
export function chooserItem(tier: ModelTier, entry: string): ChooserItem | null {
  const cls = tier.classes[entry];
  const runs = offered(cls) ? cls.model : cls ? null : entry;
  const model = runs ? textModels(tier).find((m) => m.id === runs) : undefined;
  const id = model ? (cls ? entry : pickClassOf(model.classes)) : null;
  return model && id ? itemOf(model, id) : null;
}

/** One line per model: the first entry that runs on it wins. */
function oncePerModel(items: (ChooserItem | null)[]): ChooserItem[] {
  const seen = new Set<string>();
  return items.filter((item): item is ChooserItem => {
    if (!item || seen.has(item.model)) {
      return false;
    }
    seen.add(item.model);
    return true;
  });
}

/**
 * What a purpose lets people pick: the tier's offered classes in ways A and B, the admins' list
 * in way C; the efforts per class (way C's list, way B's cap); the class a new pick starts on.
 */
export function purposeChoice(tier: ModelTier, policy: ModelPolicy | null, purpose: Purpose) {
  const own = policy?.purposes[purpose] ?? null;
  const list = policy?.way === "C" && own ? approved(tier, own) : null;
  const cap = policy?.way === "B" ? (own?.effortCap ?? null) : null;
  // A class is on way C's list as itself or, where the list approves a model, as the class it runs.
  const entry = (id: string) => policyEntry(tier, policy, purpose, id);
  return {
    way: policy?.way ?? "A",
    /** Offered in the tier and, in way C, on the admins' list. */
    allowed: (id: string) => offered(tier.classes[id]) && (!list || list.includes(entry(id))),
    /** Offered in the tier, but not on way C's list. */
    notApproved: (id: string) =>
      offered(tier.classes[id]) && Boolean(list) && !list?.includes(entry(id)),
    efforts: (id: string): Effort[] =>
      list
        ? (own?.efforts?.[entry(id)] ?? [...EFFORTS])
        : cap
          ? EFFORTS.slice(0, EFFORTS.indexOf(cap) + 1)
          : [...EFFORTS],
    /**
     * The chooser's lines after Auto: the preselection, or way C's list. Way C offers no Auto:
     * a pick without a model takes the admins' default.
     */
    items: list ? oncePerModel(list.map((id) => chooserItem(tier, id))) : preselection(tier),
    auto: !list,
    /** The line a class or model id shows as: its own, or the one running the same model. */
    itemFor(id: string, items: ChooserItem[]): ChooserItem | null {
      const runs = chooserItem(tier, id)?.model;
      return items.find((i) => i.id === id) ?? items.find((i) => i.model === runs) ?? null;
    },
    default: own?.default ?? null,
    cap,
  };
}
