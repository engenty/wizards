import { isLang, LANG_NAMES, LANGS, langName } from "@engenty-wizards/shared/definition";
import { useLayoutEffect, useRef, useState } from "react";
import { localSide, t, useLang } from "../lib/i18n";
import { useMediaQuery } from "../lib/media";
import { usePickLang } from "../lib/session";
import { cn, Select } from "../ui";

/** Inner padding of each option, either side. */
const PAD_X = 12;
const EASE = "cubic-bezier(0.3, 0.7, 0.2, 1)";

/** A phone's width (below `sm`): there the switch names both languages by their code, EN · DE. */
const PHONE = "(max-width: 639px)";

/**
 * English and the person's own language (`localSide`), EN · DE as on the landing page: the
 * language in effect is lit and named in full, and the app turns to the pick in place. Nothing
 * where the person has no language beside English: the account page picks among all of them.
 * `ground`: on a vivid page; `surface`: on a card or menu.
 */
export function LangSwitch({
  tone = "ground",
  ink,
}: {
  tone?: "ground" | "surface";
  /** The text on the thumb of a `ground` switch: the page's colour, deep. */
  ink?: string;
}) {
  const lang = useLang();
  const pickLang = usePickLang();
  const local = localSide();
  if (!local) {
    return null;
  }
  return (
    <LangPill
      langs={["en", local]}
      value={lang}
      onPick={(code) => {
        if (isLang(code)) {
          pickLang(code);
        }
      }}
      tone={tone}
      ink={ink}
    />
  );
}

/**
 * Two languages side by side, any two (a wizard's own and the viewer's): the one in effect is
 * lit and named in full, the other shows its code. A thumb slides to the pick while the options
 * grow and shrink to their labels.
 */
export function LangPill({
  langs,
  value,
  onPick,
  tone = "ground",
  ink,
  label,
}: {
  langs: [string, string];
  value: string;
  onPick: (code: string) => void;
  tone?: "ground" | "surface";
  /** The text on the thumb of a `ground` switch: the page's colour, deep. */
  ink?: string;
  /** What a side is named in full; default: the language's own name. */
  label?: (code: string) => string;
}) {
  const narrow = useMediaQuery(PHONE);
  const probes = useRef<Record<string, HTMLSpanElement | null>>({});
  const [sizes, setSizes] = useState<Record<string, number> | null>(null);
  const full = (code: string) => (label ? label(code) : langName(code));
  const key = langs.join("|");

  // The labels' widths as rendered; again once the web font is in.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the labels to measure follow the languages
  useLayoutEffect(() => {
    const measure = () => {
      const next: Record<string, number> = {};
      for (const [k, el] of Object.entries(probes.current)) {
        next[k] = el ? Math.ceil(el.getBoundingClientRect().width) : 0;
      }
      setSizes(next);
    };
    measure();
    void document.fonts?.ready.then(measure);
  }, [key]);

  const width = (code: string) =>
    sizes
      ? (sizes[code === value && !narrow ? `${code}-full` : `${code}-short`] ?? 0) + PAD_X * 2
      : undefined;
  const offset = sizes
    ? langs.slice(0, langs.indexOf(value)).reduce((sum, code) => sum + (width(code) ?? 0), 0)
    : 0;
  const timing = `300ms ${EASE}`;
  const ground = tone === "ground";

  return (
    <fieldset
      className={cn(
        "relative inline-flex items-center rounded-full border-0 p-0.5 ring-1",
        ground ? "bg-white/10 ring-white/15" : "bg-paper-2 ring-border-soft",
      )}
    >
      <legend className="sr-only">{t("nav.language")}</legend>
      {sizes ? (
        <span
          aria-hidden="true"
          className={cn(
            "absolute top-0.5 bottom-0.5 left-0.5 rounded-full shadow-sm motion-reduce:transition-none",
            ground ? "bg-white" : "bg-card",
          )}
          style={{
            width: width(value),
            transform: `translateX(${offset}px)`,
            transition: `transform ${timing}, width ${timing}`,
          }}
        />
      ) : null}
      {langs.map((code) => {
        const selected = code === value;
        return (
          <button
            aria-pressed={selected}
            className={cn(
              "relative h-7 cursor-pointer overflow-hidden whitespace-nowrap rounded-full font-medium text-[0.75rem] motion-reduce:transition-none",
              ground
                ? selected
                  ? "text-[oklch(32%_0.15_262)]"
                  : "text-white/70"
                : selected
                  ? "text-ink"
                  : "text-ink-3",
            )}
            key={code}
            lang={code}
            onClick={() => {
              if (!selected) {
                onPick(code);
              }
            }}
            style={{
              width: width(code),
              transition: `width ${timing}, color ${timing}`,
              ...(ground && selected && ink ? { color: ink } : {}),
            }}
            title={full(code)}
            type="button"
          >
            {[full(code), code.toUpperCase()].map((text, i) => {
              const shown = selected && !narrow ? i === 0 : i === 1;
              return (
                <span
                  key={`${i}:${text}`}
                  aria-hidden={!shown}
                  className="absolute inset-0 grid place-items-center motion-reduce:transition-none"
                  style={{ opacity: shown ? 1 : 0, transition: `opacity 220ms ${EASE}` }}
                >
                  {text}
                </span>
              );
            })}
            {/* Measured, never seen: the label widths the options size to. */}
            <span
              ref={(el) => {
                probes.current[`${code}-full`] = el;
              }}
              aria-hidden="true"
              className="invisible absolute"
            >
              {full(code)}
            </span>
            <span
              ref={(el) => {
                probes.current[`${code}-short`] = el;
              }}
              aria-hidden="true"
              className="invisible absolute"
            >
              {code.toUpperCase()}
            </span>
            {/* Holds the height and, before the sizes are measured, the width. */}
            <span className="invisible px-3">{selected ? full(code) : code.toUpperCase()}</span>
          </button>
        );
      })}
    </fieldset>
  );
}

/** Every language engenty speaks, for the account page: the pick also sets the switch's other side. */
export function LangPick() {
  const lang = useLang();
  const pickLang = usePickLang();
  return (
    <Select
      className="w-44"
      value={lang}
      onChange={(next) => {
        if (isLang(next)) {
          pickLang(next);
        }
      }}
      options={LANGS.map((code) => ({ value: code, label: LANG_NAMES[code] }))}
    />
  );
}
