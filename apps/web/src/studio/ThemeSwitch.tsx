import { Moon, Palette, Sun } from "lucide-react";
import { t } from "../lib/i18n";
import { setTheme, type ThemeMode, usePreferredTheme, useThemeMode } from "../lib/theme";
import { cn } from "../ui";

const THEMES = [
  { theme: "light", icon: Sun, label: "theme.light" },
  { theme: "branded", icon: Palette, label: "theme.branded" },
  { theme: "dark", icon: Moon, label: "theme.dark" },
] as const satisfies readonly { theme: ThemeMode; icon: typeof Sun; label: string }[];
const EASE = "cubic-bezier(0.3, 0.7, 0.2, 1)";

/**
 * Light · branded · dark in the look of the language switch: a thumb slides to the pick. `surface`: on a
 * card or menu; `ground`: on a vivid page, which shows dark whatever the pick — so it lights the pick.
 */
export function ThemeSwitch({ tone = "surface" }: { tone?: "ground" | "surface" }) {
  const shown = useThemeMode();
  const preferred = usePreferredTheme();
  const ground = tone === "ground";
  const theme = ground ? preferred : shown;
  const index = THEMES.findIndex((option) => option.theme === theme);
  return (
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
        style={{ transform: `translateX(${index * 36}px)`, transition: `transform 300ms ${EASE}` }}
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
          onClick={() => setTheme(option)}
          title={t(label)}
          type="button"
        >
          <Icon className="size-3.5" />
        </button>
      ))}
    </fieldset>
  );
}
