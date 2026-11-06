// SPDX-License-Identifier: FSL-1.1-MIT OR MIT
import { readNumber } from "@engenty/wizards-shared/numbers";
import { lang, t } from "./i18n.js";
import { cn, Input } from "./ui.js";

/** The answer as a number, or undefined while there is none: a field holds what was typed. */
const numberOf = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return readNumber(value) ?? undefined;
};

const written = (n: number | undefined, unit?: string) =>
  n === undefined ? "–" : `${new Intl.NumberFormat(lang).format(n)}${unit ? ` ${unit}` : ""}`;

/** A number stays clean through repeated steps: 0.1 + 0.2 is 0.3 here. */
const tidy = (n: number) => Number(n.toFixed(6));

/** A number typed in, its unit after it. */
export function NumberInput({
  value,
  unit,
  placeholder,
  onChange,
}: {
  value: string;
  unit?: string;
  placeholder?: string;
  onChange: (v: unknown) => void;
}) {
  const input = (
    <Input
      inputMode="decimal"
      autoComplete="off"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
  return unit ? (
    <div className="flex items-center gap-2">
      {input}
      <span className="shrink-0 text-ink-2 text-sm">{unit}</span>
    </div>
  ) : (
    input
  );
}

/**
 * The value large above a slider. No answer yet: "–", the thumb at the start, so what the page
 * shows is never an answer nobody gave.
 */
export function NumberSlider({
  label,
  value,
  min,
  max,
  increment,
  unit,
  onChange,
}: {
  label: string;
  value: unknown;
  min: number;
  max: number;
  increment?: number;
  unit?: string;
  onChange: (v: unknown) => void;
}) {
  const n = numberOf(value);
  return (
    <div className="grid gap-2">
      <div className="font-display font-semibold text-3xl tabular-nums">{written(n, unit)}</div>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={increment ?? "any"}
        value={n ?? min}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-11 w-full cursor-pointer accent-ember"
      />
      <div className="flex justify-between text-[0.8125rem] text-ink-3 tabular-nums">
        <span>{written(min, unit)}</span>
        <span>{written(max, unit)}</span>
      </div>
    </div>
  );
}

/** Minus and plus around the value, which can also be typed; the server checks what it holds. */
export function NumberStepper({
  value,
  min,
  max,
  increment,
  unit,
  placeholder,
  onChange,
}: {
  value: unknown;
  min?: number;
  max?: number;
  increment?: number;
  unit?: string;
  placeholder?: string;
  onChange: (v: unknown) => void;
}) {
  const n = numberOf(value);
  const by = increment ?? 1;
  const move = (direction: 1 | -1) => {
    const next = tidy(n === undefined ? (min ?? 0) : n + direction * by);
    onChange(Math.min(max ?? next, Math.max(min ?? next, next)));
  };
  const button =
    "flex size-11 shrink-0 items-center justify-center rounded-full border border-input bg-card text-ink-2 text-xl transition hover:border-ink-4 hover:text-ink disabled:pointer-events-none disabled:opacity-40";
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        aria-label={t("run.less")}
        className={button}
        disabled={n !== undefined && min !== undefined && n <= min}
        onClick={() => move(-1)}
      >
        −
      </button>
      <Input
        inputMode="decimal"
        autoComplete="off"
        className="text-center tabular-nums"
        value={value === undefined || value === null ? "" : String(value)}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {unit ? <span className="shrink-0 text-ink-2 text-sm">{unit}</span> : null}
      <button
        type="button"
        aria-label={t("run.more")}
        className={button}
        disabled={n !== undefined && max !== undefined && n >= max}
        onClick={() => move(1)}
      >
        +
      </button>
    </div>
  );
}

/** One row with a round button per choice, for choices that need a line of text. */
export function ListChoice({
  name,
  value,
  options,
  disabled,
  label,
  onChange,
}: {
  name: string;
  value: string;
  options: string[];
  disabled: Set<string>;
  label: (option: string) => string;
  onChange: (v: unknown) => void;
}) {
  return (
    <div className="grid gap-2">
      {options.map((option) => {
        const on = value === option;
        const shut = disabled.has(option);
        return (
          <label
            key={option}
            className={cn(
              "flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border px-4 py-2.5 text-[0.9375rem] transition",
              on ? "border-ember bg-ember-tint text-ink" : "border-input bg-card text-ink-2",
              shut ? "pointer-events-none opacity-60 line-through" : "hover:border-ink-4",
            )}
          >
            <input
              type="radio"
              name={name}
              checked={on}
              disabled={shut}
              onChange={() => onChange(option)}
              className="size-4 shrink-0 accent-ember"
            />
            <span>{label(option)}</span>
          </label>
        );
      })}
    </div>
  );
}
