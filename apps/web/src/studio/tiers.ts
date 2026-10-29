/**
 * The organization's model tier and its admins' policy, as the studio shows them: read from the
 * models endpoint while `modelTiers` is on (docs/manage-contract.md, "Model tiers").
 */
import {
  type ModelPolicy,
  type ModelTier,
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
