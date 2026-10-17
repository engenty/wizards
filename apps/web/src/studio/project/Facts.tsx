import {
  BASIC_FACTS,
  detectFactType,
  FACT_TYPES,
  type FactType,
  factKey,
  PROJECT_LIMITS,
  type ProjectFact,
} from "@engenty-wizards/shared/projects";
import {
  AlignLeft,
  Calendar,
  Check,
  Hash,
  Link2,
  type LucideIcon,
  Mail,
  Phone,
  Plus,
  ToggleLeft,
  Trash2,
  Type,
  Wand2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { t } from "../../lib/i18n";
import { Button, cn, IconButton, Input, Switch, Textarea } from "../../ui";
import { useAutosave } from "./data";
import { Section } from "./Section";

interface Row extends ProjectFact {
  id: string;
}

const isYes = (value: string) => /^(ja|yes|true)$/i.test(value.trim());

const TYPE_ICONS: Record<FactType, LucideIcon> = {
  text: Type,
  longtext: AlignLeft,
  number: Hash,
  date: Calendar,
  url: Link2,
  email: Mail,
  phone: Phone,
  boolean: ToggleLeft,
};

/**
 * The fact's type as an icon; a click opens the choice. "Automatisch" reads the type off the
 * value and says which one that is right now.
 */
function TypeMenu({
  type,
  detected,
  onChange,
}: {
  type: FactType | undefined;
  detected: FactType;
  onChange: (type: FactType | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) {
      return;
    }
    const outside = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const Icon = TYPE_ICONS[type ?? detected];
  const label = `${t("project.factType")}: ${t(`project.type.${type ?? detected}`)}`;
  const item =
    "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[0.875rem] text-ink-2 hover:bg-accent hover:text-ink";
  const pick = (next: FactType | undefined) => {
    onChange(next);
    setOpen(false);
  };
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          // Opens upwards where the window has no room below.
          setUp(window.innerHeight - e.currentTarget.getBoundingClientRect().bottom < 400);
          setOpen((o) => !o);
        }}
        className={cn(
          "inline-flex size-11 items-center justify-center rounded-lg transition hover:bg-accent hover:text-ink",
          open ? "bg-accent text-ink" : type ? "text-ink-2" : "text-ink-4",
        )}
      >
        <Icon className="size-4" />
      </button>
      {open ? (
        <div
          role="menu"
          className={cn(
            "absolute right-0 z-50 w-56 animate-rise rounded-xl bg-card p-1.5 shadow-overlay ring-1 ring-border-soft",
            up ? "bottom-12" : "top-12",
          )}
        >
          <button
            type="button"
            role="menuitemradio"
            aria-checked={!type}
            className={item}
            onClick={() => pick(undefined)}
          >
            <Wand2 className="size-4 shrink-0" />
            <span className="flex-1">{t("project.factAuto")}</span>
            <span className="text-[0.75rem] text-ink-4">{t(`project.type.${detected}`)}</span>
            <Check className={cn("size-4 shrink-0", type && "invisible")} />
          </button>
          <div className="mx-2 my-1 h-px bg-border-soft" />
          {FACT_TYPES.map((ft) => {
            const ItemIcon = TYPE_ICONS[ft];
            return (
              <button
                key={ft}
                type="button"
                role="menuitemradio"
                aria-checked={type === ft}
                className={item}
                onClick={() => pick(ft)}
              >
                <ItemIcon className="size-4 shrink-0" />
                <span className="flex-1">{t(`project.type.${ft}`)}</span>
                <Check className={cn("size-4 shrink-0", type !== ft && "invisible")} />
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/**
 * What the project knows as label and value. The type is read off the value and can be chosen
 * by hand; only a long text and a yes/no get an editor of their own.
 */
export function Facts({
  facts,
  save,
  readOnly,
}: {
  facts: ProjectFact[];
  save: (facts: ProjectFact[]) => Promise<unknown>;
  /** The facts are there to read: no value is changed, none added or removed. */
  readOnly?: boolean;
}) {
  const next = useRef(0);
  const focus = useRef<string | null>(null);
  const [rows, setRows] = useState<Row[]>(() =>
    facts.map((f) => ({ ...f, id: `f${next.current++}` })),
  );
  // A row is a fact once its label is set and has been left: that is when it gets its key.
  const status = useAutosave(
    rows
      .filter((r) => r.key && r.label.trim())
      .map(({ key, label, value, type }) => ({
        key,
        label: label.trim(),
        value,
        ...(type ? { type } : {}),
      })),
    save,
  );
  const set = (id: string, patch: Partial<Row>) =>
    setRows((all) => all.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  /** A new row at the end of the list, or at its start: right under the heading's button. */
  const add = (fact: Partial<ProjectFact>, focusOn: "label" | "value", first = false) => {
    const id = `f${next.current++}`;
    focus.current = `${id}:${focusOn}`;
    const row = { id, key: "", label: "", value: "", ...fact };
    setRows((all) => (first ? [row, ...all] : [...all, row]));
  };
  const takeFocus = (name: string) => (el: HTMLElement | null) => {
    if (el && focus.current === name) {
      focus.current = null;
      el.focus();
    }
  };
  const basics = BASIC_FACTS.filter((key) => !rows.some((r) => r.key === key));
  return (
    <Section
      title={t("project.facts")}
      hint={t("project.factsHint")}
      save={status}
      locked={readOnly}
      action={
        rows.length < PROJECT_LIMITS.facts && !readOnly ? (
          <Button variant="secondary" size="sm" onClick={() => add({}, "label", true)}>
            <Plus className="size-4" /> {t("project.factAdd")}
          </Button>
        ) : null
      }
    >
      <div className="flex flex-col gap-2">
        {rows.map((row) => {
          const detected = detectFactType(row.value);
          const type = row.type ?? detected;
          return (
            <div
              key={row.id}
              className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-start gap-x-1 gap-y-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto_auto]"
            >
              <Input
                ref={takeFocus(`${row.id}:label`)}
                value={row.label}
                placeholder={t("project.factLabel")}
                title={row.key ? `{{facts.${row.key}}}` : undefined}
                onChange={(e) => set(row.id, { label: e.target.value })}
                onBlur={() => {
                  if (!row.key && row.label.trim()) {
                    set(row.id, {
                      key: factKey(
                        row.label,
                        rows.map((r) => r.key),
                      ),
                    });
                  }
                }}
                className="max-sm:col-span-3 max-sm:font-medium sm:mr-1"
              />
              {row.type === "boolean" ? (
                <div className="flex h-11 items-center gap-3">
                  <Switch
                    checked={isYes(row.value)}
                    label={row.label}
                    onChange={(on) =>
                      set(row.id, { value: on ? t("project.yes") : t("project.no") })
                    }
                  />
                  <span className="text-[0.875rem] text-ink-2">
                    {isYes(row.value) ? t("project.yes") : t("project.no")}
                  </span>
                </div>
              ) : (
                <Textarea
                  ref={takeFocus(`${row.id}:value`)}
                  rows={1}
                  minRows={type === "longtext" ? 2 : 1}
                  maxRows={10}
                  value={row.value}
                  placeholder={t("project.factValue")}
                  onChange={(e) => set(row.id, { value: e.target.value })}
                  className="min-h-11"
                />
              )}
              <TypeMenu
                type={row.type}
                detected={detected}
                onChange={(next) => set(row.id, { type: next })}
              />
              {readOnly ? null : (
                <IconButton
                  label={t("project.remove")}
                  onClick={() => setRows((all) => all.filter((r) => r.id !== row.id))}
                  className="size-11 rounded-lg hover:text-rose"
                >
                  <Trash2 className="size-4" />
                </IconButton>
              )}
            </div>
          );
        })}
      </div>
      {rows.length < PROJECT_LIMITS.facts && !readOnly ? (
        <div className={`flex flex-wrap items-center gap-2 ${rows.length ? "mt-4" : ""}`}>
          <Button variant="secondary" size="sm" onClick={() => add({}, "label")}>
            <Plus className="size-4" /> {t("project.factAdd")}
          </Button>
          {basics.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => add({ key, label: t(`fact.${key}`) }, "value")}
              className="inline-flex h-8 items-center gap-1 rounded-full bg-paper-2 px-3 text-[0.8125rem] text-ink-2 transition hover:bg-paper-3 hover:text-ink"
            >
              <Plus className="size-3.5" /> {t(`fact.${key}`)}
            </button>
          ))}
        </div>
      ) : null}
    </Section>
  );
}
