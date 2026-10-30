import {
  classIdOf,
  EFFORTS,
  type Effort,
  type Maker,
  type StepClass,
  TEXT_CLASSES,
  textClassOf,
  type WizardDefinition,
} from "@engenty/wizards-shared/definition";
import type { RunEstimate } from "@engenty/wizards-shared/run";
import { type ModelTier, pickedClass } from "@engenty/wizards-shared/tiers";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, ShieldCheck } from "lucide-react";
import { type KeyboardEvent, useRef } from "react";
import { api } from "../../lib/api";
import { lang, t } from "../../lib/i18n";
import { cn, Label, Segmented, Select } from "../../ui";
import { usePopover } from "../../ui/date-picker";
import {
  type ChooserItem,
  offered,
  purposeChoice,
  reasonText,
  runsOnText,
  tierClassLabel,
  useModelTiers,
} from "../tiers";

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
  const { tier, modelPolicy } = useModelTiers();
  // What the organization's admins allow for wizards: way C's list, way B's effort cap.
  const choice = tier ? purposeChoice(tier, modelPolicy, "wizard") : null;
  const id = classIdOf({ model: model ?? "standard", maker }, "standard");
  // The efforts the policy allows that the model takes; Auto's model is the tier's to pick.
  const takes = model || maker ? choice?.itemFor(id, choice.items)?.efforts : undefined;
  const allowedEfforts = (choice?.efforts(id) ?? [...EFFORTS]).filter(
    (e) => !takes || takes.includes(e),
  );
  const none = t("class.effortAuto");
  return (
    <div className="flex flex-col gap-2">
      {tier && choice ? (
        <TierModelControl
          tier={tier}
          choice={choice}
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
        disabled={EFFORTS.filter((e) => !allowedEfforts.includes(e)).map((e) =>
          t(`class.effort.${e}`),
        )}
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
 * The model of a step in an organization with a model tier: Auto, then the tier's preselection
 * (or the admins' list in way C), one line per model with how it works. A pick asks for the
 * model's class, so the step follows the tier when the class gets a newer model.
 */
function TierModelControl({
  tier,
  choice,
  model,
  maker,
  onChange,
}: {
  tier: ModelTier;
  choice: ReturnType<typeof purposeChoice>;
  model: StepClass | undefined;
  maker: Maker | undefined;
  onChange: (next: { model: StepClass | undefined; maker: Maker | undefined }) => void;
}) {
  const auto = !model && !maker;
  const id = classIdOf({ model: model ?? "standard", maker }, "standard");
  const picked = auto ? null : choice.itemFor(id, choice.items);
  const current = tier.classes[id];
  const pick = (next: string | null) => {
    const picked = next ? pickedClass(tier, next) : null;
    onChange({ model: picked?.cls, maker: picked?.maker ?? undefined });
  };
  return (
    <>
      <Label>{t("composer.model")}</Label>
      <ModelMenu
        items={choice.items}
        auto={choice.auto}
        value={auto ? null : (picked?.id ?? id)}
        label={auto ? t("chooser.auto") : (picked?.name ?? tierClassLabel(id))}
        onPick={pick}
      />
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.75rem] text-ink-2">
        <span className="inline-flex h-6 items-center gap-1 rounded-full bg-paper-2 px-2 font-medium text-ink-2">
          <ShieldCheck className="size-3.5" />
          {tier.name}
        </span>
        {auto
          ? t("chooser.auto.hint")
          : choice.notApproved(id)
            ? t("policy.notApproved")
            : offered(current)
              ? t("tier.runsOn", { model: runsOnText(current) })
              : `${t("tier.notIn", { tier: tier.name })}. ${reasonText(current)}`}
      </p>
    </>
  );
}

/** The model field: Auto and one line per model, each with how it works. */
function ModelMenu({
  items,
  auto,
  value,
  label,
  onPick,
}: {
  items: ChooserItem[];
  auto: boolean;
  /** The picked line's id; null for Auto. */
  value: string | null;
  label: string;
  onPick: (id: string | null) => void;
}) {
  const { open, setOpen, close, anchor, panel, place } = usePopover();
  const list = useRef<HTMLDivElement>(null);
  const lines = [
    ...(auto ? [{ id: null, name: t("chooser.auto"), hint: t("chooser.auto.hint") }] : []),
    ...items,
  ];

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
    const options = [
      ...(list.current?.querySelectorAll<HTMLButtonElement>("[role=option]:not([disabled])") ?? []),
    ];
    const at = options.indexOf(document.activeElement as HTMLButtonElement);
    const next = at + (event.key === "ArrowDown" ? 1 : -1);
    options[(next + options.length) % options.length]?.focus();
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
        <span className="min-w-0 flex-1 truncate">{label}</span>
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
            aria-label={t("composer.model")}
            className="flex flex-col gap-0.5"
          >
            {lines.map((line) => {
              const on = line.id === value;
              return (
                <button
                  key={line.id ?? "auto"}
                  type="button"
                  role="option"
                  aria-selected={on}
                  onClick={() => {
                    onPick(line.id);
                    close();
                  }}
                  className={cn(
                    "flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[0.875rem] outline-none transition",
                    on ? "bg-paper-2" : "hover:bg-paper-2 focus-visible:bg-paper-2",
                  )}
                >
                  <span className={cn("flex-1", on && "font-medium")}>{line.name}</span>
                  <span className="text-[0.75rem] text-ink-3">{line.hint}</span>
                  {on ? <Check className="size-4 text-ink-2" /> : <span className="size-4" />}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
