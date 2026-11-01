import { type BrandRule, SPACE_LIMITS, type VoiceBlock } from "@engenty/wizards-shared/spaces";
import { ListChecks, Plus, TextQuote, Trash2 } from "lucide-react";
import { useState } from "react";
import { type Key, t } from "../../lib/i18n";
import { askConfirm, Button, IconButton, Textarea } from "../../ui";
import { useAutosave } from "./data";
import {
  type AddEntry,
  AddMenu,
  InlineText,
  newId,
  RuleRows,
  Section,
  useRuleRows,
} from "./Section";

/** The blocks most brands write down, offered by name; any other is the brand's own. */
const PRESETS: { title: Key; hint: Key }[] = [
  { title: "space.voice.tone", hint: "space.voice.toneHint" },
  { title: "space.voice.audience", hint: "space.voice.audienceHint" },
  { title: "space.voice.positioning", hint: "space.voice.positioningHint" },
  { title: "space.voice.values", hint: "space.voice.valuesHint" },
];

/**
 * Marke › Stimme und Haltung: how the brand speaks, in blocks of text with a title (its tone,
 * whom it speaks to, where it stands, what it holds to, or one of its own), and what it says and
 * does not say as rules, one per row. The rules wait behind the switch `brandRules`.
 */
export function Voice({
  blocks: saved,
  rules: savedRules,
  ruled,
  readOnly,
  save,
}: {
  blocks: VoiceBlock[];
  rules: BrandRule[];
  /** Rules are shown and can be added. */
  ruled: boolean;
  readOnly?: boolean;
  save: (patch: { voice: VoiceBlock[]; voiceRules: BrandRule[] }) => Promise<unknown>;
}) {
  const [blocks, setBlocks] = useState(saved);
  const [titleFor, setTitleFor] = useState<string | null>(null);
  const [textFor, setTextFor] = useState<string | null>(null);
  const rules = useRuleRows(savedRules);
  const status = useAutosave({ voice: blocks, voiceRules: rules.rules }, save);
  const set = (id: string, patch: Partial<VoiceBlock>) =>
    setBlocks((all) => all.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  const full = blocks.length >= SPACE_LIMITS.voiceBlocks;
  const add = (title: string) => {
    const id = newId();
    (title ? setTextFor : setTitleFor)(id);
    setBlocks((all) => [...all, { id, title, text: "" }]);
  };
  const open = PRESETS.filter((p) => !blocks.some((b) => b.title === t(p.title)));
  const hintOf = (title: string) => PRESETS.find((p) => t(p.title) === title)?.hint;

  const entries: AddEntry[] = [
    ...(full
      ? []
      : [
          ...open.map((p) => ({
            label: t(p.title),
            icon: <TextQuote className="size-4 shrink-0" />,
            onPick: () => add(t(p.title)),
          })),
          {
            label: t("space.voice.own"),
            icon: <Plus className="size-4 shrink-0" />,
            onPick: () => add(""),
          },
        ]),
    ...(!ruled || rules.full
      ? []
      : [
          {
            label: t("space.ruleNew"),
            icon: <ListChecks className="size-4 shrink-0" />,
            onPick: () => rules.add(),
          },
        ]),
  ];

  return (
    <Section
      title={t("space.voice")}
      hint={t("space.voiceHint")}
      save={status}
      locked={readOnly}
      action={readOnly || !entries.length ? null : <AddMenu entries={entries} />}
    >
      <div className="flex flex-col gap-7">
        {/* One block per row: its title on the left, its words on the right, as Name und Claim. */}
        {blocks.length ? (
          <div className="flex flex-col divide-y divide-border-soft">
            {blocks.map((b) => {
              const hint = hintOf(b.title);
              const remove = async () => {
                if (
                  !b.text.trim() ||
                  (await askConfirm(
                    t("space.voice.removeConfirm", {
                      name: b.title || t("space.sectionUntitled"),
                    }),
                  ))
                ) {
                  setBlocks((all) => all.filter((x) => x.id !== b.id));
                }
              };
              return (
                <div
                  key={b.id}
                  className="group/row grid gap-x-6 gap-y-2 py-4 first:pt-0 last:pb-0 sm:grid-cols-[15rem_minmax(0,1fr)]"
                >
                  <div className="flex min-w-0 items-start gap-1">
                    {readOnly ? (
                      <p className="min-w-0 flex-1 font-medium text-[0.9375rem]">{b.title}</p>
                    ) : (
                      <div className="min-w-0 flex-1">
                        <InlineText
                          value={b.title}
                          label={t("space.voice.title")}
                          placeholder={t("space.voice.title")}
                          maxLength={80}
                          autoFocus={titleFor === b.id}
                          onChange={(v) => set(b.id, { title: v })}
                          className="font-medium text-[0.9375rem]"
                        />
                      </div>
                    )}
                    {readOnly ? null : (
                      <IconButton
                        label={t("space.remove")}
                        onClick={remove}
                        className="-mt-1 size-8 shrink-0 rounded-lg opacity-0 transition hover:text-rose focus-visible:opacity-100 group-hover/row:opacity-100 max-sm:opacity-100"
                      >
                        <Trash2 className="size-4" />
                      </IconButton>
                    )}
                  </div>
                  {readOnly ? (
                    <p className="whitespace-pre-wrap text-[0.9375rem] text-ink-2 leading-relaxed sm:pt-2">
                      {b.text}
                    </p>
                  ) : (
                    <Textarea
                      ref={(el) => {
                        if (el && textFor === b.id) {
                          setTextFor(null);
                          el.focus();
                        }
                      }}
                      rows={2}
                      minRows={2}
                      maxRows={14}
                      maxLength={SPACE_LIMITS.voiceText}
                      value={b.text}
                      placeholder={hint ? t(hint) : t("space.voice.textPlaceholder")}
                      onChange={(e) => set(b.id, { text: e.target.value })}
                    />
                  )}
                </div>
              );
            })}
          </div>
        ) : null}

        {/* Adding stays in reach under the blocks: an own one, or a usual one not written yet. */}
        {readOnly || full ? null : (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => add("")}>
              <Plus className="size-4" /> {t("space.voice.own")}
            </Button>
            {open.map((p) => (
              <button
                key={p.title}
                type="button"
                onClick={() => add(t(p.title))}
                className="inline-flex h-8 items-center gap-1 rounded-full bg-paper-2 px-3 text-[0.8125rem] text-ink-2 transition hover:bg-paper-3 hover:text-ink"
              >
                <Plus className="size-3.5" /> {t(p.title)}
              </button>
            ))}
          </div>
        )}

        {ruled ? (
          <RuleRows
            rules={rules}
            placeholder={t("space.voice.rulePlaceholder")}
            readOnly={readOnly}
          />
        ) : null}
      </div>
    </Section>
  );
}
