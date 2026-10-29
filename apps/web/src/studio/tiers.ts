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
  splitClassId,
  type TierClass,
} from "@engenty/wizards-shared/tiers";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useFeature } from "../lib/features";
import { type Key, t } from "../lib/i18n";

/** The tier and the policy; both null without a tier or while `modelTiers` is off. */
export function useModelTiers(): { tier: ModelTier | null; modelPolicy: ModelPolicy | null } {
  const on = useFeature("modelTiers");
  const { data } = useQuery({
    queryKey: ["models"],
    queryFn: () =>
      api.get<{ tier?: ModelTier | null; modelPolicy?: ModelPolicy | null }>("/api/studio/models"),
    enabled: on,
  });
  return on
    ? { tier: data?.tier ?? null, modelPolicy: data?.modelPolicy ?? null }
    : { tier: null, modelPolicy: null };
}

/** The organization's model tier; null without one or while `modelTiers` is off. */
export function useTier(): ModelTier | null {
  return useModelTiers().tier;
}

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

/**
 * What a purpose lets people pick: the tier's offered classes in ways A and B, the admins' list
 * in way C; the efforts per class (way C's list, way B's cap); the class a new pick starts on.
 */
export function purposeChoice(tier: ModelTier, policy: ModelPolicy | null, purpose: Purpose) {
  const own = policy?.purposes[purpose] ?? null;
  const list = policy?.way === "C" && own ? approved(tier, own) : null;
  const cap = policy?.way === "B" ? (own?.effortCap ?? null) : null;
  return {
    way: policy?.way ?? "A",
    /** Offered in the tier and, in way C, on the admins' list. */
    allowed: (id: string) => offered(tier.classes[id]) && (!list || list.includes(id)),
    /** Offered in the tier, but not on way C's list. */
    notApproved: (id: string) => offered(tier.classes[id]) && Boolean(list) && !list?.includes(id),
    efforts: (id: string): Effort[] =>
      list
        ? (own?.efforts?.[id] ?? [...EFFORTS])
        : cap
          ? EFFORTS.slice(0, EFFORTS.indexOf(cap) + 1)
          : [...EFFORTS],
    choices: list ?? pickable(tier).filter((id) => offered(tier.classes[id])),
    default: own?.default ?? null,
    cap,
  };
}
