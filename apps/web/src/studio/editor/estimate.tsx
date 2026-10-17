import {
  EFFORTS,
  type Effort,
  TEXT_CLASSES,
  type TextClass,
  type WizardDefinition,
} from "@engenty-wizards/shared/definition";
import type { RunEstimate } from "@engenty-wizards/shared/run";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { lang, t } from "../../lib/i18n";
import { Label, Segmented, Select } from "../../ui";

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
  effort,
  onChange,
}: {
  model: TextClass | undefined;
  effort: Effort | undefined;
  onChange: (next: { model: TextClass | undefined; effort: Effort | undefined }) => void;
}) {
  const none = t("class.effortAuto");
  return (
    <div className="flex flex-col gap-2">
      <Label>{t("class.label")}</Label>
      <Select
        value={model ?? "high"}
        onChange={(v) => onChange({ model: v as TextClass, effort })}
        options={TEXT_CLASSES.map((c) => ({ value: c, label: t(`class.${c}`) }))}
      />
      <p className="text-[0.75rem] text-ink-3">{t(`class.${model ?? "high"}.hint`)}</p>
      <Label>{t("class.effort")}</Label>
      <Segmented
        value={effort ? t(`class.effort.${effort}`) : none}
        options={[none, ...EFFORTS.map((e) => t(`class.effort.${e}`))]}
        onChange={(label: string) =>
          onChange({ model, effort: EFFORTS.find((e) => t(`class.effort.${e}`) === label) })
        }
      />
    </div>
  );
}
