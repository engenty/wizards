import { LOCALES } from "@engenty-wizards/shared/definition";
import { CalendarDays, ChevronLeft, ChevronRight, X } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { lang, t } from "../lib/i18n";
import { cn } from "./index";

/**
 * Picking a date from a month, in the studio's look: a field that opens a calendar below it.
 * Dates are "YYYY-MM-DD" strings, read on no clock but the calendar's own, so a date never
 * moves by a day across time zones. Monday is the first day of the week.
 */

const locale = () => LOCALES[lang];
const pad = (n: number) => String(n).padStart(2, "0");
const keyOf = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;
const parts = (date: string) => date.split("-").map(Number) as [number, number, number];
const utc = (date: string) => {
  const [y, m, d] = parts(date);
  return new Date(Date.UTC(y, m - 1, d, 12));
};
function shift(date: string, days: number): string {
  const d = utc(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function todayKey(): string {
  const now = new Date();
  return keyOf(now.getFullYear(), now.getMonth(), now.getDate());
}
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** "Mi., 14. Okt. 2026" / "Wed 14 Oct 2026". */
export function dateText(date: string, withWeekday = true): string {
  return new Intl.DateTimeFormat(locale(), {
    ...(withWeekday ? { weekday: "short" } : {}),
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(utc(date));
}

/** "14. – 16. Okt. 2026" / "14–16 Oct 2026". */
function rangeText(from: string, to: string): string {
  return new Intl.DateTimeFormat(locale(), {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).formatRange(utc(from), utc(to));
}

// ── The popover ───────────────────────────────────────────────────────────────

/**
 * Opens below its field, above when there is no room; it stays inside a dialog (it is drawn in
 * place, fixed to the screen) and follows the field when the page scrolls.
 */
export function usePopover() {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);

  const measure = useCallback(() => {
    const field = anchor.current?.getBoundingClientRect();
    const box = panel.current?.getBoundingClientRect();
    if (!field) {
      return;
    }
    const height = box?.height ?? 360;
    const width = box?.width ?? 304;
    const below = field.bottom + 6 + height <= window.innerHeight - 8;
    setPlace({
      top: below ? field.bottom + 6 : Math.max(8, field.top - 6 - height),
      left: Math.max(8, Math.min(field.left, window.innerWidth - width - 8)),
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    measure();
    const again = () => measure();
    window.addEventListener("resize", again);
    window.addEventListener("scroll", again, true);
    return () => {
      window.removeEventListener("resize", again);
      window.removeEventListener("scroll", again, true);
    };
  }, [open, measure]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !anchor.current?.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  const close = useCallback(() => {
    setOpen(false);
    anchor.current?.focus();
  }, []);

  return { open, setOpen, close, anchor, panel, place };
}

const fieldClass =
  "flex h-11 w-full min-w-0 items-center gap-2.5 rounded-lg border border-input bg-card px-3 text-left text-[0.9375rem] text-ink outline-none transition hover:border-ink-4 focus-visible:border-focus focus-visible:ring-4 focus-visible:ring-focus-glow disabled:pointer-events-none disabled:opacity-60";

function Field({
  anchor,
  open,
  onOpen,
  disabled,
  text,
  placeholder,
  onClear,
  id,
}: {
  anchor: RefObject<HTMLButtonElement | null>;
  open: boolean;
  onOpen: () => void;
  disabled?: boolean;
  text: string | null;
  placeholder: string;
  onClear?: () => void;
  id?: string;
}) {
  return (
    <div className="relative min-w-0">
      <button
        ref={anchor}
        id={id}
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            onOpen();
          }
        }}
        className={cn(fieldClass, open && "border-focus ring-4 ring-focus-glow", onClear && "pr-9")}
      >
        <CalendarDays className="size-4 shrink-0 text-ink-3" />
        <span className={cn("min-w-0 flex-1 truncate tabular-nums", !text && "text-ink-4")}>
          {text ?? placeholder}
        </span>
      </button>
      {onClear && !disabled ? (
        <button
          type="button"
          aria-label={t("date.clear")}
          onClick={onClear}
          className="-translate-y-1/2 absolute top-1/2 right-2 grid size-6 place-items-center rounded-full text-ink-4 transition hover:bg-paper-2 hover:text-ink"
        >
          <X className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

// ── The month ─────────────────────────────────────────────────────────────────

interface MonthProps {
  /** The day keyboard focus is on; the month shown is its month. */
  focus: string;
  setFocus: (date: string) => void;
  min?: string;
  max?: string;
  /** Picked: a day, or the two ends of a range (the second may still be missing). */
  selected: { from: string | null; to: string | null };
  /** While a range is picked: the day under the pointer, to show what it would become. */
  preview?: string | null;
  onHover?: (date: string | null) => void;
  onPick: (date: string) => void;
  onClose: () => void;
  footer?: ReactNode;
}

function Month({
  focus,
  setFocus,
  min,
  max,
  selected,
  preview,
  onHover,
  onPick,
  onClose,
  footer,
}: MonthProps) {
  const grid = useRef<HTMLDivElement>(null);
  const [y, m] = parts(focus);
  const first = new Date(Date.UTC(y, m - 1, 1, 12));
  const lead = (first.getUTCDay() + 6) % 7;
  const start = shift(keyOf(y, m - 1, 1), -lead);
  const days = Array.from({ length: 42 }, (_, i) => shift(start, i));
  const today = todayKey();
  const out = (d: string) => Boolean((min && d < min) || (max && d > max));
  const weekdays = Array.from({ length: 7 }, (_, i) =>
    new Intl.DateTimeFormat(locale(), { weekday: "short", timeZone: "UTC" })
      .format(new Date(Date.UTC(2024, 0, 1 + i, 12)))
      .replace(".", "")
      .slice(0, 2),
  );
  const title = new Intl.DateTimeFormat(locale(), {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(first);
  const month = (step: number) => {
    const d = utc(focus);
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + step);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
    return d.toISOString().slice(0, 10);
  };

  // The range as it would be with the day under the pointer as its end.
  const end = selected.to ?? (selected.from && preview ? preview : null);
  const lo = selected.from && end ? (selected.from < end ? selected.from : end) : selected.from;
  const hi = selected.from && end ? (selected.from < end ? end : selected.from) : selected.from;

  useEffect(() => {
    grid.current?.querySelector<HTMLButtonElement>(`[data-day="${focus}"]`)?.focus();
  }, [focus]);

  const keys = (e: KeyboardEvent) => {
    const moves: Record<string, () => string> = {
      ArrowLeft: () => shift(focus, -1),
      ArrowRight: () => shift(focus, 1),
      ArrowUp: () => shift(focus, -7),
      ArrowDown: () => shift(focus, 7),
      PageUp: () => month(e.shiftKey ? -12 : -1),
      PageDown: () => month(e.shiftKey ? 12 : 1),
      Home: () => shift(focus, -((utc(focus).getUTCDay() + 6) % 7)),
      End: () => shift(focus, 6 - ((utc(focus).getUTCDay() + 6) % 7)),
    };
    if (moves[e.key]) {
      e.preventDefault();
      setFocus(moves[e.key]());
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  return (
    <div className="w-[19rem] max-w-[calc(100vw-16px)] p-3">
      <div className="mb-2 flex items-center justify-between gap-2 pl-2">
        <span className="font-display font-semibold text-[0.9375rem] capitalize">{title}</span>
        <span className="flex gap-1">
          <button
            type="button"
            aria-label={t("date.prev")}
            onClick={() => setFocus(month(-1))}
            className="grid size-8 place-items-center rounded-full text-ink-3 transition hover:bg-paper-2 hover:text-ink"
          >
            <ChevronLeft className="size-4" />
          </button>
          <button
            type="button"
            aria-label={t("date.next")}
            onClick={() => setFocus(month(1))}
            className="grid size-8 place-items-center rounded-full text-ink-3 transition hover:bg-paper-2 hover:text-ink"
          >
            <ChevronRight className="size-4" />
          </button>
        </span>
      </div>
      <div className="grid grid-cols-7 text-center text-[0.6875rem] text-ink-4 uppercase tracking-wide">
        {weekdays.map((w) => (
          <span key={w} className="py-1.5">
            {w}
          </span>
        ))}
      </div>
      <div
        ref={grid}
        className="grid grid-cols-7 gap-y-0.5"
        onKeyDown={keys}
        onPointerLeave={() => onHover?.(null)}
      >
        {days.map((d) => {
          const inMonth = d.slice(0, 7) === focus.slice(0, 7);
          const isEnd = d === lo || d === hi;
          const between = Boolean(lo && hi && d > lo && d < hi);
          const disabled = out(d);
          return (
            <div
              key={d}
              className={cn(
                "relative flex h-9 items-center justify-center",
                between && "bg-ember-tint",
                lo !== hi &&
                  d === lo &&
                  "bg-linear-to-r from-transparent from-50% to-ember-tint to-50%",
                lo !== hi &&
                  d === hi &&
                  "bg-linear-to-l from-transparent from-50% to-ember-tint to-50%",
              )}
            >
              <button
                type="button"
                data-day={d}
                tabIndex={d === focus ? 0 : -1}
                disabled={disabled}
                aria-pressed={isEnd}
                aria-current={d === today ? "date" : undefined}
                aria-label={dateText(d)}
                onClick={() => onPick(d)}
                onPointerEnter={() => onHover?.(d)}
                className={cn(
                  "relative grid size-9 place-items-center rounded-full text-[0.875rem] tabular-nums outline-none transition focus-visible:ring-2 focus-visible:ring-focus coarse:size-10",
                  isEnd
                    ? "bg-primary font-semibold text-primary-foreground"
                    : between
                      ? "text-ink hover:bg-card"
                      : inMonth
                        ? "text-ink hover:bg-paper-2"
                        : "text-ink-4 hover:bg-paper-2",
                  d === today && !isEnd && "font-semibold text-ember-strong",
                  disabled && "pointer-events-none line-through opacity-35",
                )}
              >
                {Number(d.slice(8))}
                {d === today && !isEnd ? (
                  <span className="-translate-x-1/2 absolute bottom-1 left-1/2 size-1 rounded-full bg-ember" />
                ) : null}
              </button>
            </div>
          );
        })}
      </div>
      {footer ? (
        <div className="mt-2 flex items-center justify-between gap-2 border-border-soft border-t pt-2">
          {footer}
        </div>
      ) : null}
    </div>
  );
}

const panelClass =
  "fixed z-50 animate-rise rounded-xl bg-card shadow-overlay ring-1 ring-border-soft";

const linkClass =
  "rounded-md px-2 py-1 font-medium text-[0.8125rem] text-ink-2 transition hover:bg-paper-2 hover:text-ink disabled:pointer-events-none disabled:opacity-40";

// ── One date ──────────────────────────────────────────────────────────────────

export function DatePicker({
  value,
  onChange,
  min,
  max,
  placeholder,
  disabled,
  clearable,
  className,
  id,
}: {
  /** "YYYY-MM-DD", or "" for none. */
  value: string;
  onChange: (value: string) => void;
  min?: string;
  max?: string;
  placeholder?: string;
  disabled?: boolean;
  /** A small × in the field empties it. */
  clearable?: boolean;
  className?: string;
  id?: string;
}) {
  const pop = usePopover();
  const valid = DATE.test(value) ? value : "";
  const [focus, setFocus] = useState(valid || min || todayKey());
  const today = todayKey();
  const openIt = () => {
    setFocus(valid || (min && min > today ? min : today));
    pop.setOpen(true);
  };
  return (
    <div className={cn("min-w-0", className)}>
      <Field
        id={id}
        anchor={pop.anchor}
        open={pop.open}
        onOpen={() => (pop.open ? pop.setOpen(false) : openIt())}
        disabled={disabled}
        text={valid ? dateText(valid) : null}
        placeholder={placeholder ?? t("date.pick")}
        onClear={clearable && valid ? () => onChange("") : undefined}
      />
      {pop.open ? (
        <div
          ref={pop.panel}
          role="dialog"
          className={panelClass}
          style={{ top: pop.place?.top ?? -9999, left: pop.place?.left ?? -9999 }}
        >
          <Month
            focus={focus}
            setFocus={setFocus}
            min={min}
            max={max}
            selected={{ from: valid || null, to: valid || null }}
            onPick={(d) => {
              onChange(d);
              pop.close();
            }}
            onClose={pop.close}
            footer={
              <>
                <button
                  type="button"
                  className={linkClass}
                  disabled={Boolean((min && today < min) || (max && today > max))}
                  onClick={() => {
                    onChange(today);
                    pop.close();
                  }}
                >
                  {t("date.today")}
                </button>
                {valid ? (
                  <button
                    type="button"
                    className={linkClass}
                    onClick={() => {
                      onChange("");
                      pop.close();
                    }}
                  >
                    {t("date.clear")}
                  </button>
                ) : null}
              </>
            }
          />
        </div>
      ) : null}
    </div>
  );
}

// ── A range ───────────────────────────────────────────────────────────────────

/**
 * A day or a period in one calendar: the first click is the start, the second the end (the
 * same day again: one day). While the end is open the range follows the pointer.
 */
export function DateRangePicker({
  from,
  to,
  onChange,
  min,
  max,
  placeholder,
  disabled,
  className,
  id,
}: {
  from: string;
  to: string;
  onChange: (range: { from: string; to: string }) => void;
  min?: string;
  max?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
}) {
  const pop = usePopover();
  const [focus, setFocus] = useState(from || min || todayKey());
  const [start, setStart] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const has = DATE.test(from);
  const end = DATE.test(to) ? to : from;
  const text = has ? (end === from ? dateText(from) : rangeText(from, end)) : null;
  const openIt = () => {
    const today = todayKey();
    setFocus(has ? from : min && min > today ? min : today);
    setStart(null);
    setHover(null);
    pop.setOpen(true);
  };
  return (
    <div className={cn("min-w-0", className)}>
      <Field
        id={id}
        anchor={pop.anchor}
        open={pop.open}
        onOpen={() => (pop.open ? pop.setOpen(false) : openIt())}
        disabled={disabled}
        text={text}
        placeholder={placeholder ?? t("date.pickRange")}
        onClear={has ? () => onChange({ from: "", to: "" }) : undefined}
      />
      {pop.open ? (
        <div
          ref={pop.panel}
          role="dialog"
          className={panelClass}
          style={{ top: pop.place?.top ?? -9999, left: pop.place?.left ?? -9999 }}
        >
          <Month
            focus={focus}
            setFocus={setFocus}
            min={min}
            max={max}
            selected={
              start ? { from: start, to: null } : { from: has ? from : null, to: has ? end : null }
            }
            preview={start ? hover : null}
            onHover={setHover}
            onPick={(d) => {
              if (!start) {
                setStart(d);
                return;
              }
              const [a, b] = start <= d ? [start, d] : [d, start];
              onChange({ from: a, to: b });
              setStart(null);
              pop.close();
            }}
            onClose={pop.close}
            footer={
              <span className="px-2 py-1 text-[0.75rem] text-ink-3">
                {start ? t("date.pickEnd") : t("date.pickStart")}
              </span>
            }
          />
        </div>
      ) : null}
    </div>
  );
}
