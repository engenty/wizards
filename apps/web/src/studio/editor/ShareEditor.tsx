import type { ResultStep, ShareOption } from "@engenty-wizards/shared/definition";
import type { ShareTargetInfo } from "@engenty-wizards/shared/sharing";
import { useQuery } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { type Key, lang, t } from "../../lib/i18n";
import { IconButton, Input, Segmented, Select, Textarea } from "../../ui";

const MODES = ["default", "own", "off"] as const;
type Mode = (typeof MODES)[number];

const MODE_LABEL: Record<Mode, Key> = {
  default: "shareEditor.default",
  own: "shareEditor.own",
  off: "shareEditor.off",
};
const HINT: Record<Mode, Key> = {
  default: "shareEditor.defaultHint",
  own: "shareEditor.ownHint",
  off: "shareEditor.offHint",
};

/**
 * Where a result can be sent or published: the default targets, none, or the wizard's own list —
 * each with its own name and a prefilled form.
 */
export function ShareEditor({
  wizardId,
  step,
  set,
}: {
  wizardId: string;
  step: ResultStep;
  set: (step: ResultStep) => void;
}) {
  const targets = useQuery({
    queryKey: ["share-targets", wizardId, lang],
    queryFn: () =>
      api.get<ShareTargetInfo[]>(`/api/studio/wizards/${wizardId}/share-targets?lang=${lang}`),
  });
  const known = targets.data ?? [];
  const mode: Mode = !step.share ? "default" : step.share.length ? "own" : "off";
  const options = step.share ?? [];
  const setOptions = (share: ShareOption[] | undefined) => set({ ...step, share });
  const patch = (index: number, next: ShareOption) =>
    setOptions(options.map((o, i) => (i === index ? next : o)));

  return (
    <>
      <Segmented
        value={mode}
        options={[...MODES]}
        label={(o) => t(MODE_LABEL[o as Mode])}
        onChange={(next: Mode) =>
          setOptions(
            next === "default"
              ? undefined
              : next === "off"
                ? []
                : options.length
                  ? options
                  : [{ target: known.find((k) => k.usable)?.id ?? "email" }],
          )
        }
      />
      <p className="text-[0.8125rem] text-ink-3 leading-relaxed">{t(HINT[mode])}</p>
      {options.map((option, index) => {
        const info = known.find((k) => k.id === option.target);
        return (
          <div
            key={`${index}:${option.target}`}
            className="flex flex-col gap-2 rounded-lg bg-paper p-3 ring-1 ring-border-soft"
          >
            <div className="flex items-center gap-2">
              <Select
                className="min-w-0 flex-1"
                value={option.target}
                onChange={(target) => patch(index, { target, label: option.label })}
                options={[
                  ...known.map((k) => ({
                    value: k.id,
                    label: `${k.name}${k.agent ? ` · ${t("shareEditor.agent")}` : ""}${k.usable ? "" : ` (${t("shareEditor.notSetUp")})`}`,
                  })),
                  ...(info ? [] : [{ value: option.target, label: option.target }]),
                ]}
              />
              <IconButton
                label={t("shareEditor.removeTarget")}
                onClick={() => {
                  const rest = options.filter((_, i) => i !== index);
                  // The last one removed: back to the default targets, not to none.
                  setOptions(rest.length ? rest : undefined);
                }}
              >
                <Trash2 className="size-4" />
              </IconButton>
            </div>
            <Input
              value={option.label ?? ""}
              placeholder={t("shareEditor.labelPlaceholder", { name: info?.name ?? option.target })}
              onChange={(e) => patch(index, { ...option, label: e.target.value || undefined })}
            />
            {(info?.fields ?? []).map((field) => {
              const value = option.values?.[field.id] ?? "";
              const change = (text: string) => {
                const values = { ...option.values, [field.id]: text };
                if (!text) {
                  delete values[field.id];
                }
                patch(index, {
                  ...option,
                  values: Object.keys(values).length ? values : undefined,
                });
              };
              return field.kind === "textarea" ? (
                <Textarea
                  key={field.id}
                  minRows={2}
                  value={value}
                  placeholder={t("shareEditor.prefilled", { label: field.label })}
                  onChange={(e) => change(e.target.value)}
                />
              ) : (
                <Input
                  key={field.id}
                  value={value}
                  placeholder={t("shareEditor.prefilled", { label: field.label })}
                  onChange={(e) => change(e.target.value)}
                />
              );
            })}
          </div>
        );
      })}
      {mode === "own" ? (
        <>
          <button
            type="button"
            onClick={() =>
              setOptions([...options, { target: known.find((k) => k.usable)?.id ?? "email" }])
            }
            className="inline-flex h-8 items-center gap-1 self-start rounded-full px-2.5 text-[0.75rem] text-ink-2 hover:bg-accent"
          >
            <Plus className="size-3.5" /> {t("shareEditor.addTarget")}
          </button>
          <p className="text-[0.75rem] text-ink-4 leading-relaxed">
            {t("shareEditor.templatesHint")} {"{{email}}"}, {"{{steps.offer}}"}, {"{{brand.name}}"}.
          </p>
        </>
      ) : null}
    </>
  );
}
