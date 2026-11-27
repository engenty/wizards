import { ChevronDown, Moon, Palette, Sun } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { t } from "../lib/i18n";
import { setTheme, type ThemeMode, usePreferredTheme, useThemeMode } from "../lib/theme";
import { cn } from "../ui";
import { GroundPick } from "./GroundPick";

const THEMES = [
  { theme: "light", icon: Sun, label: "theme.light" },
  { theme: "branded", icon: Palette, label: "theme.branded" },
  { theme: "dark", icon: Moon, label: "theme.dark" },
] as const satisfies readonly { theme: ThemeMode; icon: typeof Sun; label: string }[];
const EASE = "cubic-bezier(0.3, 0.7, 0.2, 1)";

/**
 * Light · branded · dark in the look of the language switch: a thumb slides to the pick. `surface`: on a
 * card or menu; `ground`: on a vivid page, which shows dark whatever the pick — so it lights the pick.
 * The branded button opens a small menu of its colours, and picks the branded theme as well.
 */
export function ThemeSwitch({ tone = "surface" }: { tone?: "ground" | "surface" }) {
  const shown = useThemeMode();
  const preferred = usePreferredTheme();
  const ground = tone === "ground";
  const theme = ground ? preferred : shown;
  const index = THEMES.findIndex((option) => option.theme === theme);
  const [colours, setColours] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!colours) {
      return;
    }
    const away = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) {
        setColours(false);
      }
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setColours(false);
      }
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
    };
  }, [colours]);
  return (
    <div className="relative inline-flex" ref={ref}>
      <fieldset
        className={cn(
          "relative inline-flex items-center rounded-full border-0 p-0.5 ring-1",
          ground ? "bg-white/10 ring-white/15" : "bg-paper-2 ring-border-soft",
        )}
      >
        <legend className="sr-only">{t("nav.theme")}</legend>
        <span
          aria-hidden="true"
          className={cn(
            "absolute top-0.5 bottom-0.5 left-0.5 w-9 rounded-full shadow-sm motion-reduce:transition-none",
            ground ? "bg-white" : "bg-card",
          )}
          style={{
            transform: `translateX(${index * 100}%)`,
            transition: `transform 300ms ${EASE}`,
          }}
        />
        {THEMES.map(({ theme: option, icon: Icon, label }) => (
          <button
            aria-label={t(label)}
            aria-pressed={option === theme}
            className={cn(
              "relative grid h-7 w-9 cursor-pointer place-items-center rounded-full transition-colors motion-reduce:transition-none",
              ground
                ? option === theme
                  ? "text-[oklch(32%_0.15_262)]"
                  : "text-white/70 hover:text-white"
                : option === theme
                  ? "text-ink"
                  : "text-ink-3 hover:text-ink-2",
            )}
            key={option}
            aria-expanded={option === "branded" ? colours : undefined}
            aria-haspopup={option === "branded" ? "true" : undefined}
            onClick={() => {
              if (option === "branded") {
                if (theme !== "branded") {
                  setTheme(option);
                }
                setColours((open) => !open);
                return;
              }
              setColours(false);
              setTheme(option);
            }}
            title={option === "branded" ? t("theme.groundOpen") : t(label)}
            type="button"
          >
            {option === "branded" ? (
              <span className="flex items-center gap-px">
                <Icon className="size-3.5" />
                <ChevronDown className="size-2.5" strokeWidth={2.5} />
              </span>
            ) : (
              <Icon className="size-3.5" />
            )}
          </button>
        ))}
      </fieldset>
      {colours ? (
        <div className="absolute top-full right-0 z-50 mt-2 w-max animate-rise rounded-xl bg-card p-2 shadow-overlay ring-1 ring-border-soft">
          <GroundPick onPick={() => setColours(false)} />
        </div>
      ) : null}
    </div>
  );
}
