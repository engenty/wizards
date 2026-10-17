import {
  type BrandRule,
  PROJECT_LIMITS,
  RULE_MARKS,
  type RuleMark,
} from "@engenty-wizards/shared/projects";
import { Check, FolderInput, Plus, Search, Trash2, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { type Key, t } from "../../lib/i18n";
import { Button, Card, cn, IconButton, Spinner } from "../../ui";
import type { SaveState } from "./data";

/**
 * Where the sections menu jumps to (`projectSections`): the section's heading lands at the top
 * of the page's scroll container with the page's own padding above it, and below the section
 * picker on narrow screens.
 */
export function Anchor({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div id={id} data-assist={id} className="scroll-mt-6 max-md:scroll-mt-20">
      {children}
    </div>
  );
}

/**
 * One section of the space page, as engenty lays them out: the heading and what the section is
 * for stand above the card, the card holds the content. The heading says how the last save went.
 * `plain`: the content draws its own cards, as a plugin's section does.
 */
export function Section({
  title,
  hint,
  save,
  action,
  tabs,
  locked,
  plain,
  children,
}: {
  title: string;
  hint?: string;
  save?: { state: SaveState; error: string | null };
  action?: ReactNode;
  /** Above the card: the section's parts, as tabs. */
  tabs?: ReactNode;
  /** The project is not changed here: every field and button of the section shows and takes nothing. */
  locked?: boolean;
  plain?: boolean;
  children: ReactNode;
}) {
  return (
    <section data-assist-section={title} className="flex flex-col gap-2.5">
      <div className="group/head flex items-end justify-between gap-4 px-1">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <h2 className="font-display font-semibold text-lg leading-tight">{title}</h2>
            {save?.state === "saving" ? (
              <span className="inline-flex items-center gap-1.5 text-[0.75rem] text-ink-3">
                <Spinner className="size-3" /> {t("project.saving")}
              </span>
            ) : save?.state === "saved" ? (
              <span className="inline-flex items-center gap-1 text-[0.75rem] text-moss">
                <Check className="size-3.5" /> {t("settings.saved")}
              </span>
            ) : null}
          </div>
          {hint ? <p className="mt-1 text-[0.875rem] text-ink-3 leading-snug">{hint}</p> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {tabs}
      {plain ? (
        children
      ) : (
        <Card className="p-3.5 sm:p-5">
          {locked ? (
            <fieldset disabled className="min-w-0">
              {children}
            </fieldset>
          ) : (
            children
          )}
          {save?.state === "error" && save.error ? (
            <p className="mt-4 text-[0.875rem] text-rose">{save.error}</p>
          ) : null}
        </Card>
      )}
    </section>
  );
}

/** A small search field with the magnifier in it. */
export function SearchField({
  value,
  onChange,
  onEnter,
  placeholder,
  busy,
}: {
  value: string;
  onChange: (value: string) => void;
  onEnter?: () => void;
  placeholder: string;
  busy?: boolean;
}) {
  return (
    <div className="relative">
      <Search className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-3 size-4 text-ink-4" />
      <input
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && onEnter?.()}
        className="h-9 w-full rounded-full border border-input bg-card pr-3 pl-9 text-[0.875rem] text-ink outline-none transition placeholder:text-ink-4 focus:border-focus focus:ring-4 focus:ring-focus-glow"
      />
      {busy ? (
        <Spinner className="-translate-y-1/2 absolute top-1/2 right-3 size-4 text-ink-3" />
      ) : null}
    </div>
  );
}

/** Takes files by a click or by dropping them on it. */
export function DropArea({
  onFiles,
  accept,
  multiple = true,
  className,
  children,
}: {
  onFiles: (files: File[]) => void;
  accept?: string;
  multiple?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label
      onDragOver={(e) => {
        e.preventDefault();
        e.currentTarget.dataset.over = "1";
      }}
      onDragLeave={(e) => {
        delete e.currentTarget.dataset.over;
      }}
      onDrop={(e) => {
        e.preventDefault();
        delete e.currentTarget.dataset.over;
        const files = Array.from(e.dataTransfer.files);
        if (files.length) {
          onFiles(multiple ? files : files.slice(0, 1));
        }
      }}
      className={cn(
        "flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-input border-dashed text-[0.875rem] text-ink-3 transition focus-within:border-focus focus-within:ring-4 focus-within:ring-focus-glow hover:border-ink-4 hover:text-ink data-[over]:border-focus data-[over]:bg-paper-2 data-[over]:text-ink",
        className,
      )}
    >
      {children}
      <input
        className="sr-only"
        type="file"
        accept={accept}
        multiple={multiple}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length) {
            onFiles(files);
          }
        }}
      />
    </label>
  );
}

/** Text that reads as text and is edited in place, as a file's description is. */
export function InlineText({
  value,
  onChange,
  placeholder,
  maxLength,
  className,
  autoFocus,
  label,
  onEnter,
  fit,
}: {
  value: string;
  onChange: (value: string) => void;
  onEnter?: () => void;
  placeholder: string;
  maxLength: number;
  className?: string;
  autoFocus?: boolean;
  label: string;
  /** As wide as its text, not as its row: something can stand right after it. */
  fit?: boolean;
}) {
  const field = (
    <input
      value={value}
      size={fit ? 1 : undefined}
      aria-label={label}
      placeholder={placeholder}
      maxLength={maxLength}
      autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && onEnter) {
          e.preventDefault();
          onEnter();
        }
      }}
      className={cn(
        "-mx-1 block w-[calc(100%+0.5rem)] rounded-md bg-transparent px-1 py-0.5 outline-none transition placeholder:text-ink-4 hover:bg-paper-2 focus:bg-card focus:text-ink focus:ring-1 focus:ring-border",
        fit && "col-start-1 row-start-1 min-w-0",
        className,
      )}
    />
  );
  if (!fit) {
    return field;
  }
  // The hidden copy of the text gives the grid cell its width; the field lies on top of it.
  return (
    <span className="inline-grid min-w-0 max-w-full">
      <span
        aria-hidden
        className={cn(
          "invisible col-start-1 row-start-1 overflow-hidden whitespace-pre",
          className,
        )}
      >
        {value || placeholder}
      </span>
      {field}
    </span>
  );
}

export interface AddEntry {
  label: string;
  icon: ReactNode;
  onPick: () => void;
}

/** One button in the section's heading that opens what can be added. */
/** A menu that closes on a click outside `ref` and on Escape. */
function useMenu() {
  const [open, setOpen] = useState(false);
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
  return { open, setOpen, ref };
}

export function AddMenu({ entries }: { entries: AddEntry[] }) {
  const { open, setOpen, ref } = useMenu();
  return (
    <div className="relative" ref={ref}>
      <Button
        variant="secondary"
        size="sm"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Plus className="size-4" /> {t("project.add")}
      </Button>
      {open ? (
        <div
          role="menu"
          className="absolute top-10 right-0 z-50 w-56 animate-rise rounded-xl bg-card p-1.5 shadow-overlay ring-1 ring-border-soft"
        >
          {entries.map((e) => (
            <button
              key={e.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                e.onPick();
              }}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[0.875rem] text-ink-2 hover:bg-accent hover:text-ink"
            >
              {e.icon}
              {e.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export const newId = () => Math.random().toString(36).slice(2, 10);

/** Moves an entry between a section's standard part and its sub-sections: an icon over the native picker. */
export function MoveButton({
  options,
  value,
  onChange,
  className,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <label
      title={t("project.sectionMove")}
      className={cn(
        "relative inline-flex size-8 shrink-0 items-center justify-center rounded-full text-ink-3 transition hover:text-ink coarse:size-11",
        className,
      )}
    >
      <FolderInput className="size-4" />
      <select
        aria-label={t("project.sectionMove")}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Rules as rows, each with an id so a row added in between gets the focus. */
export function useRuleRows(saved: BrandRule[]) {
  const [rows, setRows] = useState(() =>
    saved.map((r) => ({ id: newId(), text: r.text, mark: r.mark ?? ("bullet" as RuleMark) })),
  );
  const [focus, setFocus] = useState<string | null>(null);
  /** A new row after `at`, or at the end. */
  const add = (at = rows.length - 1) => {
    if (rows.length >= PROJECT_LIMITS.logoRules) {
      return;
    }
    const id = newId();
    setFocus(id);
    // A new row takes the sign of the one it follows: a list of don'ts goes on as one.
    const mark = rows[at]?.mark ?? "bullet";
    setRows((all) => [...all.slice(0, at + 1), { id, text: "", mark }, ...all.slice(at + 1)]);
  };
  return {
    rows,
    setRows,
    focus,
    add,
    /** As saved: a bullet is the sign of none. */
    rules: rows.map(({ text, mark }): BrandRule => (mark === "bullet" ? { text } : { text, mark })),
    full: rows.length >= PROJECT_LIMITS.logoRules,
  };
}

const MARK_LABELS: Record<RuleMark, Key> = {
  bullet: "project.markBullet",
  do: "project.markDo",
  dont: "project.markDont",
  question: "project.markQuestion",
  important: "project.markImportant",
  number: "project.markNumber",
};

/** The sign before a rule, in a tinted disc; `n` is the place of a numbered one. */
function Mark({ mark, n }: { mark: RuleMark; n: number }) {
  const disc = "grid size-5 place-items-center rounded-full font-semibold text-[0.6875rem]";
  switch (mark) {
    case "do":
      return (
        <span className={cn(disc, "bg-moss-tint text-moss")}>
          <Check className="size-3" strokeWidth={3} />
        </span>
      );
    case "dont":
      return (
        <span className={cn(disc, "bg-rose-tint text-rose")}>
          <X className="size-3" strokeWidth={3} />
        </span>
      );
    case "question":
      return <span className={cn(disc, "bg-amber-tint text-ink-2")}>?</span>;
    case "important":
      return <span className={cn(disc, "bg-ember-tint text-ember-strong")}>!</span>;
    case "number":
      return <span className={cn(disc, "bg-paper-2 text-ink-2 tabular-nums")}>{n}</span>;
    default:
      return (
        <span className="grid size-5 place-items-center">
          <span className="size-1.5 rounded-full bg-ink-4" />
        </span>
      );
  }
}

/** The sign before a rule, picked from a small menu. */
function MarkPicker({
  mark,
  n,
  onChange,
}: {
  mark: RuleMark;
  n: number;
  onChange: (mark: RuleMark) => void;
}) {
  const { open, setOpen, ref } = useMenu();
  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t(MARK_LABELS[mark])}
        title={t(MARK_LABELS[mark])}
        onClick={() => setOpen((o) => !o)}
        className="grid size-7 place-items-center rounded-full transition hover:bg-paper-2"
      >
        <Mark mark={mark} n={n} />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute top-7 left-0 z-50 w-44 animate-rise rounded-xl bg-card p-1.5 shadow-overlay ring-1 ring-border-soft"
        >
          {RULE_MARKS.map((m) => (
            <button
              key={m}
              type="button"
              role="menuitemradio"
              aria-checked={m === mark}
              onClick={() => {
                onChange(m);
                setOpen(false);
              }}
              className={cn(
                "flex w-full items-center gap-3 rounded-lg px-2.5 py-1.5 text-left text-[0.875rem] hover:bg-accent hover:text-ink",
                m === mark ? "text-ink" : "text-ink-2",
              )}
            >
              <span className="grid size-5 place-items-center">
                <Mark mark={m} n={1} />
              </span>
              {t(MARK_LABELS[m])}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The rules of a part of the brand: one per row, written in place; Enter starts the next. */
export function RuleRows({
  rules,
  placeholder,
  readOnly,
}: {
  rules: ReturnType<typeof useRuleRows>;
  placeholder: string;
  readOnly?: boolean;
}) {
  if (!rules.rows.length) {
    return null;
  }
  /** A numbered rule's place among the numbered ones. */
  const numberOf = (i: number) =>
    rules.rows.slice(0, i + 1).filter((r) => r.mark === "number").length;
  return (
    <div>
      <h3 className="font-medium text-[0.9375rem]">{t("project.rules")}</h3>
      {readOnly ? null : (
        <p className="text-[0.875rem] text-ink-3 leading-snug">{t("project.rulesHint")}</p>
      )}
      <ul className="mt-2 flex flex-col">
        {rules.rows.map((rule, i) => (
          <li key={rule.id} className="group/rule flex items-center gap-1.5 py-0.5">
            {readOnly ? (
              <>
                <span className="grid size-7 shrink-0 place-items-center">
                  <Mark mark={rule.mark} n={numberOf(i)} />
                </span>
                <span className="py-0.5 text-[0.9375rem] text-ink">{rule.text}</span>
              </>
            ) : (
              <>
                <MarkPicker
                  mark={rule.mark}
                  n={numberOf(i)}
                  onChange={(mark) =>
                    rules.setRows((all) => all.map((r) => (r.id === rule.id ? { ...r, mark } : r)))
                  }
                />
                <InlineText
                  value={rule.text}
                  label={t("project.rules")}
                  placeholder={placeholder}
                  maxLength={200}
                  autoFocus={rule.id === rules.focus}
                  onChange={(text) =>
                    rules.setRows((all) => all.map((r) => (r.id === rule.id ? { ...r, text } : r)))
                  }
                  onEnter={() => rules.add(i)}
                  className="text-[0.9375rem] text-ink"
                />
                <IconButton
                  label={t("project.remove")}
                  onClick={() => rules.setRows((all) => all.filter((r) => r.id !== rule.id))}
                  className="size-7 opacity-0 transition focus:opacity-100 group-hover/rule:opacity-100 coarse:opacity-100 hover:text-rose"
                >
                  <Trash2 className="size-3.5" />
                </IconButton>
              </>
            )}
          </li>
        ))}
      </ul>
      {readOnly || rules.full ? null : (
        <AddRow label={t("project.ruleNew")} onClick={() => rules.add()} className="mt-1" />
      )}
    </div>
  );
}

/** "+ …" at the end of a list of rows: one more of them. */
export function AddRow({
  label,
  onClick,
  className,
}: {
  label: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 self-start rounded-full py-1 pr-2 text-[0.875rem] text-ink-3 transition hover:text-ink",
        className,
      )}
    >
      <span className="grid size-7 place-items-center">
        <Plus className="size-4" />
      </span>
      {label}
    </button>
  );
}

/**
 * A sub-section's head: its title and, where the section has one, when to use it, written in
 * place; removed on hover. `kind`, an icon with its name, stands muted after the title.
 */
export function SubSectionHead({
  title,
  description,
  titlePlaceholder,
  descriptionPlaceholder,
  kind,
  autoFocus,
  readOnly,
  onChange,
  onRemove,
}: {
  title: string;
  /** None: the section has no description. */
  description?: string;
  titlePlaceholder: string;
  descriptionPlaceholder?: string;
  kind?: { icon: ReactNode; label: string };
  autoFocus?: boolean;
  readOnly?: boolean;
  onChange: (patch: { title?: string; description?: string }) => void;
  onRemove: () => void;
}) {
  const muted = kind ? (
    <span
      role="img"
      aria-label={kind.label}
      title={kind.label}
      className="shrink-0 self-center text-ink-4 [&>svg]:size-4"
    >
      {kind.icon}
    </span>
  ) : null;
  return (
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1">
        {readOnly ? (
          <>
            <div className="flex items-baseline gap-2">
              <h3 className="min-w-0 truncate font-medium text-[0.9375rem]">{title}</h3>
              {muted}
            </div>
            {description ? (
              <p className="text-[0.875rem] text-ink-3 leading-snug">{description}</p>
            ) : null}
          </>
        ) : (
          <>
            <div className="flex items-baseline gap-2">
              <InlineText
                fit={Boolean(kind)}
                value={title}
                label={titlePlaceholder}
                placeholder={titlePlaceholder}
                maxLength={80}
                autoFocus={autoFocus}
                onChange={(v) => onChange({ title: v })}
                className="font-medium text-[0.9375rem]"
              />
              {muted}
            </div>
            {descriptionPlaceholder === undefined ? null : (
              <InlineText
                value={description ?? ""}
                label={descriptionPlaceholder}
                placeholder={descriptionPlaceholder}
                maxLength={400}
                onChange={(v) => onChange({ description: v })}
                className="text-[0.875rem] text-ink-3"
              />
            )}
          </>
        )}
      </div>
      {readOnly ? null : (
        <IconButton
          label={t("project.sectionRemove")}
          onClick={onRemove}
          className="opacity-0 transition focus:opacity-100 group-hover/section:opacity-100 coarse:opacity-100 hover:text-rose"
        >
          <Trash2 className="size-4" />
        </IconButton>
      )}
    </div>
  );
}
