import { type BrandLink, SPACE_LIMITS } from "@engenty/wizards-shared/spaces";
import { AtSign, Globe, Link2, Plus, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { t } from "../../lib/i18n";
import { IconButton, Input } from "../../ui";
import { useAutosave } from "./data";
import { type AddEntry, AddMenu, newId, Section } from "./Section";

/** The places most brands are found, offered by name; any other is the space's own. */
const PRESETS: { label: string; placeholder: string }[] = [
  { label: "Website", placeholder: "https://…" },
  { label: "LinkedIn", placeholder: "linkedin.com/company/…" },
  { label: "Instagram", placeholder: "instagram.com/…" },
  { label: "Facebook", placeholder: "facebook.com/…" },
  { label: "YouTube", placeholder: "youtube.com/@…" },
  { label: "TikTok", placeholder: "tiktok.com/@…" },
  { label: "X", placeholder: "x.com/…" },
];

const iconOf = (label: string) =>
  label === "Website" ? Globe : PRESETS.some((p) => p.label === label) ? AtSign : Link2;

/**
 * Info › Links: where the space is found on the web, its website and profiles, each with a label.
 * Saved as typed; the runtime adds https:// where an address has no scheme.
 */
export function Links({
  links: saved,
  readOnly,
  save,
}: {
  links: BrandLink[];
  readOnly?: boolean;
  save: (links: BrandLink[]) => Promise<unknown>;
}) {
  const [rows, setRows] = useState(saved);
  const focus = useRef<string | null>(null);
  const status = useAutosave(
    rows.map((r) => ({ ...r, label: r.label.trim(), url: r.url.trim() })).filter((r) => r.url),
    save,
  );
  const set = (id: string, patch: Partial<BrandLink>) =>
    setRows((all) => all.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const add = (label: string) => {
    const id = newId();
    focus.current = `${id}:${label ? "url" : "label"}`;
    setRows((all) => [...all, { id, label, url: "" }]);
  };
  const takeFocus = (name: string) => (el: HTMLElement | null) => {
    if (el && focus.current === name) {
      focus.current = null;
      el.focus();
    }
  };
  const open = PRESETS.filter((p) => !rows.some((r) => r.label === p.label));
  const full = rows.length >= SPACE_LIMITS.links;
  const entries: AddEntry[] = [
    ...open.map((p) => {
      const Icon = iconOf(p.label);
      return {
        label: p.label,
        icon: <Icon className="size-4 shrink-0" />,
        onPick: () => add(p.label),
      };
    }),
    {
      label: t("space.links.own"),
      icon: <Plus className="size-4 shrink-0" />,
      onPick: () => add(""),
    },
  ];

  return (
    <Section
      title={t("space.links")}
      hint={t("space.linksHint")}
      save={status}
      locked={readOnly}
      action={readOnly || full ? null : <AddMenu entries={entries} />}
    >
      <div className="flex flex-col gap-2">
        {rows.map((row) => {
          const Icon = iconOf(row.label);
          return (
            <div
              key={row.id}
              className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-2 sm:grid-cols-[auto_minmax(0,2fr)_minmax(0,3fr)_auto]"
            >
              <span className="grid size-11 place-items-center text-ink-3">
                <Icon className="size-4" />
              </span>
              <Input
                ref={takeFocus(`${row.id}:label`)}
                value={row.label}
                maxLength={80}
                readOnly={readOnly}
                placeholder={t("space.links.label")}
                onChange={(e) => set(row.id, { label: e.target.value })}
                className="max-sm:col-span-1 max-sm:font-medium"
              />
              <Input
                ref={takeFocus(`${row.id}:url`)}
                value={row.url}
                maxLength={600}
                readOnly={readOnly}
                inputMode="url"
                placeholder={PRESETS.find((p) => p.label === row.label)?.placeholder ?? "https://…"}
                onChange={(e) => set(row.id, { url: e.target.value })}
                className="max-sm:col-span-2 max-sm:col-start-2 max-sm:row-start-2"
              />
              {readOnly ? null : (
                <IconButton
                  label={t("space.remove")}
                  onClick={() => setRows((all) => all.filter((r) => r.id !== row.id))}
                  className="size-11 rounded-lg hover:text-rose max-sm:col-start-3 max-sm:row-start-1"
                >
                  <Trash2 className="size-4" />
                </IconButton>
              )}
            </div>
          );
        })}
      </div>
      {!rows.length && !readOnly ? (
        <div className="flex flex-wrap items-center gap-2">
          {PRESETS.slice(0, 4).map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => add(p.label)}
              className="inline-flex h-8 items-center gap-1 rounded-full bg-paper-2 px-3 text-[0.8125rem] text-ink-2 transition hover:bg-paper-3 hover:text-ink"
            >
              <Plus className="size-3.5" /> {p.label}
            </button>
          ))}
        </div>
      ) : null}
    </Section>
  );
}
