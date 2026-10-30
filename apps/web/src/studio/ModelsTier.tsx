/**
 * Settings › Models › the organization's model tier: what it promises, what each class runs on
 * in it (`tier.classes`) and web search; and what people choose from for text (Text & reasoning). Behind `modelTiers` (docs/manage-contract.md,
 * "Model tiers").
 */
import { MAKER_CLASSES, MAKERS, TEXT_CLASSES } from "@engenty/wizards-shared/definition";
import type { ModelPolicy, ModelTier, TierClass } from "@engenty/wizards-shared/tiers";
import {
  Check,
  Clapperboard,
  Ear,
  EyeOff,
  ImageIcon,
  Lock,
  type LucideIcon,
  PenLine,
  Search,
  ShieldCheck,
  Split,
  Volume2,
} from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { type Key, t } from "../lib/i18n";
import { Card, cn } from "../ui";
import { Hint, PanelHead, Part } from "./models-parts";
import { isStrict, offered, purposeChoice, tierClassLabel } from "./tiers";

/** A promise of the tier, as a chip: kept (a check) or not (crossed out). */
function PromiseChip({ kept, children }: { kept: boolean; children: string }) {
  const Icon = kept ? Check : EyeOff;
  return (
    <span
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-full px-3 font-medium text-[0.75rem]",
        kept ? "bg-moss-tint text-moss" : "bg-paper-2 text-ink-3",
      )}
    >
      <Icon className="size-3.5" strokeWidth={kept ? 3 : 2} />
      {children}
    </span>
  );
}

/** "Runs in the EU": where the tier's calls may run, in words. */
function regionsText(regions: string[]): string {
  return regions.length === 1 && regions[0] === "eu"
    ? t("tier.promise.eu")
    : t("tier.promise.regions", { regions: regions.map((r) => r.toUpperCase()).join(", ") });
}

/** Why a class isn't offered, short, under "Not offered". */
function shortReason(cls: TierClass | undefined): string {
  const model = cls?.name ?? t("tier.theModel");
  return cls && !offered(cls)
    ? t(`tier.short.${cls.reason}`, { model })
    : t("tier.short.unbound", { model });
}

/** The classes in the order the panel lists them, each with its icon where it starts a group. */
function classRows(tier: ModelTier): { id: string; icon: LucideIcon | null; label: string }[] {
  const makers = MAKERS.flatMap((maker) =>
    MAKER_CLASSES[maker]
      .map((cls) => `${maker}/${cls}`)
      .filter((id) => id in tier.classes)
      .map((id) => ({ id, icon: null, label: tierClassLabel(id) })),
  );
  const media: [string, LucideIcon, Key][] = [
    ["classifier", Split, "models.cap.decision"],
    ["embedding", Search, "models.cap.search"],
    ["image", ImageIcon, "models.cap.image"],
    ["video", Clapperboard, "models.cap.video"],
    ["speech", Volume2, "models.cap.speech"],
    ["audio", Ear, "models.cap.listening"],
  ];
  return [
    ...TEXT_CLASSES.filter((cls) => cls !== "classifier").map((cls, i) => ({
      id: cls,
      icon: i === 0 ? PenLine : null,
      label: t(`class.${cls}`),
    })),
    ...makers,
    ...media.map(([id, icon, label]) => ({ id, icon, label: t(label) })),
  ];
}

/** What each class runs on in the tier: the model and its route, or why it isn't offered. */
function TierClasses({ tier }: { tier: ModelTier }) {
  return (
    <dl className="grid grid-cols-[1.25rem_minmax(0,9rem)_minmax(0,1fr)] items-start gap-x-3 gap-y-2 text-[0.8125rem]">
      {classRows(tier).map(({ id, icon: Icon, label }) => {
        const cls = tier.classes[id];
        const where = offered(cls) ? [cls.route, cls.region].filter(Boolean).join(", ") : "";
        return (
          <Fragment key={id}>
            <span className="pt-0.5 text-ink-3">{Icon ? <Icon className="size-4" /> : null}</span>
            <dt className="text-ink-2">{label}</dt>
            <dd className={cn("min-w-0", !offered(cls) && "text-ink-3")}>
              {offered(cls) ? (
                <span className="font-medium text-ink">{cls.name}</span>
              ) : (
                t("tier.notOffered")
              )}
              <span className="block text-[0.75rem] text-ink-3">
                {offered(cls)
                  ? id === "classifier" && !tier.rules.decisions
                    ? [where, t("tier.noEvaluationModel")].filter(Boolean).join(" · ")
                    : where
                  : shortReason(cls)}
              </span>
            </dd>
          </Fragment>
        );
      })}
    </dl>
  );
}

/**
 * What people choose from for text and thinking in wizards: Auto and the tier's preselection,
 * or the admins' list in way C, one line per model with how it works and its efforts.
 */
export function TierChooser({
  tier,
  modelPolicy,
}: {
  tier: ModelTier;
  modelPolicy: ModelPolicy | null;
}) {
  const choice = purposeChoice(tier, modelPolicy, "wizard");
  const lines = [
    ...(choice.auto
      ? [{ id: "auto", name: t("chooser.auto"), hint: t("chooser.auto.hint"), efforts: null }]
      : []),
    ...choice.items.map((i) => ({
      ...i,
      efforts: choice.efforts(i.id).filter((e) => i.efforts.includes(e)),
    })),
  ];
  return (
    <>
      <Hint>{choice.auto ? t("chooser.lead", { tier: tier.name }) : t("chooser.leadOwn")}</Hint>
      <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-start gap-x-3 gap-y-2 text-[0.8125rem]">
        {lines.map((line) => (
          <Fragment key={line.id}>
            <dt>
              <span className="font-medium text-ink">{line.name}</span>
              <span className="block text-[0.75rem] text-ink-3">{line.hint}</span>
            </dt>
            <dd className="text-[0.75rem] text-ink-3">
              {line.efforts?.length
                ? `${t("class.effort")}: ${line.efforts.map((e) => t(`class.effort.${e}` as Key)).join(", ")}`
                : null}
            </dd>
          </Fragment>
        ))}
      </dl>
    </>
  );
}

/**
 * Welche Modelle: the tier, as every member sees it; `children`, the tiers to pick from, for the
 * organization's admins.
 */
export function TierPanel({
  tier,
  modelPolicy,
  organization,
  children,
}: {
  tier: ModelTier;
  modelPolicy: ModelPolicy | null;
  organization: string | null;
  children?: ReactNode;
}) {
  const { rules } = tier;
  return (
    <div className="flex flex-col gap-6">
      <PanelHead
        icon={ShieldCheck}
        title={t("overview.scope")}
        lead={organization ? t("tier.lead", { organization }) : t("tier.leadNoName")}
        status={
          tier.locked ? (
            <span className="inline-flex h-7 items-center gap-1.5 rounded-full bg-paper-2 px-3 font-medium text-[0.75rem] text-ink-2">
              <Lock className="size-3.5" />
              {t("tier.locked")}
            </span>
          ) : null
        }
      />
      {children}
      <Card className="flex flex-col gap-6 p-5 sm:p-6">
        <Part title={t("tier.promises")} aside={<b className="text-[0.875rem]">{tier.name}</b>}>
          <div className="flex flex-wrap gap-1.5">
            {rules.regions ? <PromiseChip kept>{regionsText(rules.regions)}</PromiseChip> : null}
            {rules.zdr ? <PromiseChip kept>{t("tier.promise.zdr")}</PromiseChip> : null}
            {rules.noTraining ? (
              <PromiseChip kept>{t("tier.promise.noTraining")}</PromiseChip>
            ) : null}
            {modelPolicy ? (
              <PromiseChip kept={modelPolicy.masking}>
                {t(modelPolicy.masking ? "tier.promise.maskingOn" : "tier.promise.maskingOff")}
              </PromiseChip>
            ) : null}
          </div>
          {isStrict(tier) ? null : <Hint>{t("tier.promise.none")}</Hint>}
        </Part>
        <Part
          title={t("tier.classes")}
          aside={<span className="text-[0.75rem] text-ink-3">{t("tier.classesFollow")}</span>}
        >
          <TierClasses tier={tier} />
        </Part>
        <Part title={t("tier.search")}>
          <Hint>{t(rules.search ? "tier.searchOn" : "tier.searchOff", { tier: tier.name })}</Hint>
        </Part>
      </Card>
    </div>
  );
}
