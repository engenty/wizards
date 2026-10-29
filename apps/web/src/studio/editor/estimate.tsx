import {
  EFFORTS,
  type Effort,
  MAKER_CLASSES,
  MAKERS,
  type Maker,
  type StepClass,
  TEXT_CLASSES,
  textClassOf,
  type WizardDefinition,
} from "@engenty/wizards-shared/definition";
import type { RunEstimate } from "@engenty/wizards-shared/run";
import type { ModelTier } from "@engenty/wizards-shared/tiers";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, ShieldCheck } from "lucide-react";
import { type KeyboardEvent, useRef } from "react";
import { api } from "../../lib/api";
import { lang, t } from "../../lib/i18n";
import { cn, Label, Segmented, Select } from "../../ui";
import { usePopover } from "../../ui/date-picker";
import { offered, reasonText, runsOnText, useTier } from "../tiers";

/** What a run of the draft is expected to cost. Refetched when a step's shape changes. */
export function useEstimate(wizardId: string, def: WizardDefinition) {
  const shape = def.steps
    .map((s) =>
      s.type === "agent"
        ? `${s.id}:${s.model ?? ""}:${s.tools.join("+")}:${s.output.format}`
        : s.type === "generate"
          ? `${s.id}:${s.asset}:${s.model ?? ""}:${s.options?.duration ?? ""}`
          : s.id,
    )
    .join("|");
  return useQuery({
    queryKey: ["estimate", wizardId, shape],
    queryFn: () => api.get<RunEstimate>(`/api/studio/wizards/${wizardId}/estimate`),
    staleTime: 30_000,
    // The server estimates the saved draft; give the save a moment to land.
    refetchOnMount: "always",
  });
}

const credits = (n: number) =>
  n < 10
    ? n.toLocaleString(lang, { maximumFractionDigits: 1 })
    : Math.round(n).toLocaleString(lang);

/** "≈ 12 Credits" for one step, with what the number rests on. */
export function StepCost({ estimate, stepId }: { estimate?: RunEstimate; stepId: string }) {
  const step = estimate?.available ? estimate.steps[stepId] : undefined;
  if (!step) {
    return null;
  }
  return (
    <p className="text-[0.75rem] text-ink-3 tabular-nums">
      {t("estimate.step", { n: credits(step.credits), high: credits(step.high) })}
      {" · "}
      {step.measured ? t("estimate.measured") : t("estimate.formula")}
    </p>
  );
}

/** The kind of model a step asks for, and how hard it should think. */
export function ModelClassControl({
  model,
  maker,
  effort,
  onChange,
}: {
  model: StepClass | undefined;
  maker: Maker | undefined;
  effort: Effort | undefined;
  onChange: (next: {
    model: StepClass | undefined;
    maker: Maker | undefined;
    effort: Effort | undefined;
  }) => void;
}) {
  const tier = useTier();
  const none = t("class.effortAuto");
  return (
    <div className="flex flex-col gap-2">
      {tier ? (
        <TierClassControl
          tier={tier}
          model={model}
          maker={maker}
          onChange={(next) => onChange({ ...next, effort })}
        />
      ) : (
        <>
          <Label>{t("class.label")}</Label>
          <Select
            value={textClassOf(model ?? "standard")}
            onChange={(v) => onChange({ model: v as StepClass, maker, effort })}
            options={TEXT_CLASSES.map((c) => ({ value: c, label: t(`class.${c}`) }))}
          />
          <p className="text-[0.75rem] text-ink-3">
            {t(`class.${textClassOf(model ?? "standard")}.hint`)}
          </p>
        </>
      )}
      <Label>{t("class.effort")}</Label>
      <Segmented
        value={effort ? t(`class.effort.${effort}`) : none}
        options={[none, ...EFFORTS.map((e) => t(`class.effort.${e}`))]}
        onChange={(label: string) =>
          onChange({
            model,
            maker,
            effort: EFFORTS.find((e) => t(`class.effort.${e}`) === label),
          })
        }
      />
    </div>
  );
}

/**
 * Maker and class in an organization with a model tier: the makers that have a class there,
 * each class with what it runs on in the tier, and the ones the tier doesn't offer, with why.
 */
function TierClassControl({
  tier,
  model,
  maker,
  onChange,
}: {
  tier: ModelTier;
  model: StepClass | undefined;
  maker: Maker | undefined;
  onChange: (next: { model: StepClass | undefined; maker: Maker | undefined }) => void;
}) {
  const chosen = model ?? "standard";
  const idOf = (cls: StepClass, by = maker) => (by ? `${by}/${cls}` : cls);
  const makers = MAKERS.filter(
    (m) => m === maker || MAKER_CLASSES[m].some((c) => offered(tier.classes[idOf(c, m)])),
  );
  const classes: readonly StepClass[] = maker ? MAKER_CLASSES[maker] : TEXT_CLASSES;

  /** Another maker keeps the class where it has it in the tier, else takes the nearest it has. */
  const pickMaker = (next: Maker | undefined) => {
    const has = (cls: StepClass) =>
      (next ? MAKER_CLASSES[next] : TEXT_CLASSES).includes(cls) &&
      offered(tier.classes[idOf(cls, next)]);
    const wanted = next ? chosen : textClassOf(chosen);
    const order: StepClass[] = [wanted, "standard", "high", "low", "highest"];
    onChange({ maker: next, model: order.find(has) ?? (next ? MAKER_CLASSES[next][0] : wanted) });
  };

  const current = tier.classes[idOf(chosen)];
  return (
    <>
      {chosen === "classifier" ? null : (
        <>
          <Label>{t("maker.label")}</Label>
          <Select
            value={maker ?? ""}
            onChange={(v) => pickMaker((v || undefined) as Maker | undefined)}
            options={[
              { value: "", label: t("maker.any") },
              ...makers.map((m) => ({ value: m, label: t(`maker.${m}`) })),
            ]}
          />
        </>
      )}
      <Label>{t("class.label")}</Label>
      <ClassMenu
        tier={tier}
        classes={classes}
        chosen={chosen}
        idOf={idOf}
        follows={maker ? `${t(`maker.${maker}`)} · ${t(`class.${chosen}`)}` : t(`class.${chosen}`)}
        onPick={(cls) => onChange({ maker, model: cls })}
      />
      <p className="text-[0.75rem] text-ink-3">{t(`class.${chosen}.hint`)}</p>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.75rem] text-ink-2">
        <span className="inline-flex h-6 items-center gap-1 rounded-full bg-paper-2 px-2 font-medium text-ink-2">
          <ShieldCheck className="size-3.5" />
          {tier.name}
        </span>
        {offered(current)
          ? t("tier.runsOn", { model: runsOnText(current) })
          : `${t("tier.notIn", { tier: tier.name })}. ${reasonText(current)}`}
      </p>
    </>
  );
}

/** The class field: each class with the model it runs on in the tier; those not offered greyed, with why. */
function ClassMenu({
  tier,
  classes,
  chosen,
  idOf,
  follows,
  onPick,
}: {
  tier: ModelTier;
  classes: readonly StepClass[];
  chosen: StepClass;
  idOf: (cls: StepClass) => string;
  follows: string;
  onPick: (cls: StepClass) => void;
}) {
  const { open, setOpen, close, anchor, panel, place } = usePopover();
  const list = useRef<HTMLDivElement>(null);

  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }
    event.preventDefault();
    const items = [
      ...(list.current?.querySelectorAll<HTMLButtonElement>("[role=option]:not([disabled])") ?? []),
    ];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = at + (event.key === "ArrowDown" ? 1 : -1);
    items[(next + items.length) % items.length]?.focus();
  };

  return (
    <div className="relative min-w-0">
      <button
        ref={anchor}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={cn(
          "flex h-11 w-full min-w-0 items-center rounded-lg border border-input bg-card px-3 text-left text-[0.9375rem] text-ink outline-none transition hover:border-ink-4 focus-visible:border-focus focus-visible:ring-4 focus-visible:ring-focus-glow",
          open && "border-focus ring-4 ring-focus-glow",
        )}
      >
        <span className="min-w-0 flex-1 truncate">{t(`class.${chosen}`)}</span>
        <ChevronDown className="size-4 shrink-0 text-ink-3" />
      </button>
      {open ? (
        <div
          ref={panel}
          onKeyDown={move}
          className="fixed z-50 flex min-w-72 max-w-[calc(100vw-16px)] animate-rise flex-col rounded-xl bg-card p-1.5 shadow-overlay ring-1 ring-border-soft"
          style={
            place
              ? { top: place.top, left: place.left, width: anchor.current?.offsetWidth }
              : { visibility: "hidden" }
          }
        >
          <div
            ref={list}
            role="listbox"
            aria-label={t("class.label")}
            className="flex flex-col gap-0.5"
          >
            {classes.map((cls) => {
              const bound = tier.classes[idOf(cls)];
              const on = offered(bound);
              return (
                <button
                  key={cls}
                  type="button"
                  role="option"
                  aria-selected={cls === chosen}
                  disabled={!on}
                  onClick={() => {
                    onPick(cls);
                    close();
                  }}
                  className={cn(
                    "flex flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left outline-none transition",
                    cls === chosen ? "bg-paper-2" : "hover:bg-paper-2 focus-visible:bg-paper-2",
                    !on && "cursor-default text-ink-4 hover:bg-transparent",
                  )}
                >
                  <span className="flex items-center gap-2 text-[0.875rem]">
                    <span className={cn("flex-1", cls === chosen && "font-medium")}>
                      {t(`class.${cls}`)}
                    </span>
                    {cls === chosen ? (
                      <Check className="size-4 text-ink-2" />
                    ) : (
                      <span className="text-[0.75rem] text-ink-3">
                        {on ? bound.name : t("tier.notIn", { tier: tier.name })}
                      </span>
                    )}
                  </span>
                  <span className={cn("text-[0.75rem]", on ? "text-ink-3" : "text-ink-4")}>
                    {on
                      ? cls === chosen
                        ? `${bound.name} · ${t(`class.${cls}.hint`)}`
                        : t(`class.${cls}.hint`)
                      : reasonText(bound)}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="mx-0.5 mt-1 border-border-soft border-t px-2 pt-2 pb-1 text-[0.75rem] text-ink-3">
            {t("tier.follows", { class: follows })}
          </p>
        </div>
      ) : null}
    </div>
  );
}
