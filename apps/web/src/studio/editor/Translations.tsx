import { langName } from "@engenty-wizards/shared/definition";
import type { TranslationMemory } from "@engenty-wizards/shared/translation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { api } from "../../lib/api";
import { lang, t } from "../../lib/i18n";
import type { WizardDetail } from "../../lib/session";
import { Button, IconButton, Switch, Textarea } from "../../ui";

interface TranslationsAnswer {
  lang: string;
  /** The published version's texts the person reads, in their order. */
  texts: string[];
  translations: { lang: string; texts: TranslationMemory; updatedAt: string }[];
}

/**
 * The wizard in its viewers' languages: whether the page offers a translation, the languages it
 * is kept in, and each one to correct by hand. A line the author wrote stays when the wizard is
 * published again, as long as its original is unchanged.
 */
export function TranslationsSection({
  wizard,
  locked,
  onPatch,
}: {
  wizard: WizardDetail;
  locked: boolean;
  onPatch: (body: Record<string, unknown>) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const kept = useQuery({
    queryKey: ["wizard-translations", wizard.id],
    queryFn: () => api.get<TranslationsAnswer>(`/api/studio/wizards/${wizard.id}/translations`),
    enabled: wizard.published,
  });
  const qc = useQueryClient();
  const remove = useMutation({
    mutationFn: (code: string) => api.del(`/api/studio/wizards/${wizard.id}/translations/${code}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["wizard-translations", wizard.id] }),
  });
  const open = editing ? kept.data?.translations.find((x) => x.lang === editing) : null;
  if (open && kept.data) {
    return (
      <TranslationEditor
        wizardId={wizard.id}
        code={open.lang}
        texts={kept.data.texts}
        memory={open.texts}
        onClose={() => setEditing(null)}
      />
    );
  }
  return (
    <div className="flex flex-col gap-3 border-border-soft border-t pt-5">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-[0.875rem]">{t("translate.offer")}</div>
          <p className="text-[0.8125rem] text-ink-3">{t("translate.offerHint")}</p>
        </div>
        <Switch
          checked={wizard.translate}
          disabled={locked}
          onChange={(on) => onPatch({ translate: on })}
          label={t("translate.offer")}
        />
      </div>
      {kept.data?.translations.length ? (
        <ul className="flex flex-col divide-y divide-border-soft rounded-xl ring-1 ring-border-soft">
          {kept.data.translations.map((x) => (
            <li key={x.lang} className="flex items-center gap-3 py-1.5 pr-1.5 pl-3.5">
              <span className="min-w-0 flex-1 text-[0.875rem]">
                {langName(x.lang)}
                <span className="ml-2 text-[0.75rem] text-ink-3">
                  {t(
                    Object.values(x.texts).some((e) => e.by === "author")
                      ? "translate.byYou"
                      : "translate.byMachine",
                  )}{" "}
                  · {new Date(x.updatedAt).toLocaleDateString(lang)}
                </span>
              </span>
              <IconButton
                label={t("translate.edit")}
                disabled={locked}
                onClick={() => setEditing(x.lang)}
              >
                <Pencil className="size-4" />
              </IconButton>
              <IconButton
                label={t("translate.delete")}
                disabled={locked || remove.isPending}
                onClick={() => remove.mutate(x.lang)}
              >
                <Trash2 className="size-4" />
              </IconButton>
            </li>
          ))}
        </ul>
      ) : wizard.translate && wizard.published ? (
        <p className="text-[0.8125rem] text-ink-3">{t("translate.none")}</p>
      ) : null}
    </div>
  );
}

/** One language, line by line: the original beside the translation, every line editable. */
function TranslationEditor({
  wizardId,
  code,
  texts,
  memory,
  onClose,
}: {
  wizardId: string;
  code: string;
  texts: string[];
  memory: TranslationMemory;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [lines, setLines] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: () => api.put(`/api/studio/wizards/${wizardId}/translations/${code}`, { lines }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["wizard-translations", wizardId] });
      onClose();
    },
  });
  const changed = Object.keys(lines).length > 0;
  return (
    <div className="flex flex-col gap-4 border-border-soft border-t pt-5">
      <div className="flex items-center gap-2">
        <IconButton label={t("common.back")} onClick={onClose}>
          <ChevronLeft className="size-4" />
        </IconButton>
        <span className="flex-1 font-medium text-[0.875rem]">{langName(code)}</span>
        <Button size="sm" busy={save.isPending} disabled={!changed} onClick={() => save.mutate()}>
          {t("translate.save")}
        </Button>
      </div>
      <p className="text-[0.8125rem] text-ink-3">{t("translate.editHint")}</p>
      <div className="flex flex-col gap-3">
        {texts.map((original) => (
          <div key={original} className="grid gap-1.5 sm:grid-cols-2 sm:gap-3">
            <p className="text-[0.8125rem] text-ink-3 leading-relaxed">{original}</p>
            <Textarea
              minRows={1}
              maxRows={6}
              lang={code}
              value={lines[original] ?? memory[original]?.text ?? ""}
              onChange={(e) => setLines((now) => ({ ...now, [original]: e.target.value }))}
            />
          </div>
        ))}
      </div>
      {save.error ? (
        <p className="text-[0.8125rem] text-rose">{(save.error as Error).message}</p>
      ) : null}
    </div>
  );
}
