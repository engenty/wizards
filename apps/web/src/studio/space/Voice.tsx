import { type BrandRule, SPACE_LIMITS, type VoiceBlock } from "@engenty/wizards-shared/spaces";
import { ListChecks, Plus, TextQuote } from "lucide-react";
import { useState } from "react";
import { type Key, t } from "../../lib/i18n";
import { Button, Textarea } from "../../ui";
import { useAutosave } from "./data";
import {
  type AddEntry,
  AddMenu,
  newId,
  RuleRows,
  Section,
  SubSectionHead,
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
        {blocks.map((b) => {
          const hint = hintOf(b.title);
          return (
            <div key={b.id} className="group/section flex flex-col gap-2">
              <SubSectionHead
                title={b.title}
                titlePlaceholder={t("space.voice.title")}
                autoFocus={titleFor === b.id}
                readOnly={readOnly}
                onChange={(patch) => set(b.id, { title: patch.title ?? b.title })}
                onRemove={() => {
                  if (
                    !b.text.trim() ||
                    confirm(
                      t("space.voice.removeConfirm", {
                        name: b.title || t("space.sectionUntitled"),
                      }),
                    )
                  ) {
                    setBlocks((all) => all.filter((x) => x.id !== b.id));
                  }
                }}
              />
              {readOnly ? (
                <p className="whitespace-pre-wrap text-[0.9375rem] text-ink-2 leading-relaxed">
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
