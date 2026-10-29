import { Eye, type LucideIcon, MessageSquare, PenLine } from "lucide-react";
import { useNavigate } from "react-router";
import type { EngentyKind } from "../engenty/colors";
import { t } from "../lib/i18n";
import { allowedModes, MODE_HOME, type Mode, setMode, useMode } from "../lib/mode";
import type { Me } from "../lib/session";
import { cn } from "../ui";

/** Each mode's sign in the switch. */
export const MODE_ICON: Record<Mode, LucideIcon> = {
  studio: PenLine,
  work: MessageSquare,
  client: Eye,
};

/** The engenty in the bar's corner wears the mode: Studio green, Work blue, Client violet. */
export const MODE_ENGENTY: Record<Mode, EngentyKind> = {
  studio: "dome",
  work: "round",
  client: "tower",
};

/**
 * The switch between the modes, always in sight: in the app bar right under the engenty, and on
 * a phone in the top bar. `look`: `named` is a row of glyphs with their names, under the wordmark
 * of a bar that names its places; `stacked` puts each glyph over a short name, one under the
 * other, in a narrow bar; `row` is the glyphs alone side by side, in a bar along the top or
 * bottom and on a phone. Someone with one mode gets none.
 */
export function ModeSwitch({
  me,
  look,
  className,
}: {
  me: Me;
  look: "named" | "stacked" | "row";
  className?: string;
}) {
  const mode = useMode(me);
  const modes = allowedModes(me);
  const navigate = useNavigate();
  if (modes.length < 2) {
    return null;
  }
  const pick = (next: Mode) => {
    if (next !== mode) {
      setMode(me, next);
      navigate(MODE_HOME[next]);
    }
  };
  return (
    <fieldset
      aria-label={t("mode.switch")}
      className={cn(
        "shrink-0 gap-0.5 rounded-xl bg-ink/5 p-0.5 ring-1 ring-border-soft",
        look === "named" ? "grid w-full" : look === "stacked" ? "flex w-13 flex-col" : "flex",
        className,
      )}
      style={
        look === "named"
          ? { gridTemplateColumns: `repeat(${modes.length}, minmax(0, 1fr))` }
          : undefined
      }
    >
      {modes.map((m) => {
        const Icon = MODE_ICON[m];
        const name = t(`mode.${m}`);
        return (
          <button
            key={m}
            type="button"
            aria-pressed={m === mode}
            onClick={() => pick(m)}
            title={look === "row" ? name : undefined}
            aria-label={look === "row" ? name : undefined}
            className={cn(
              "rounded-lg transition",
              m === mode
                ? "bg-card text-ink shadow-soft dark:ring-1 dark:ring-border-soft"
                : "text-ink-3 hover:text-ink",
              look === "named"
                ? "flex h-8 items-center justify-center gap-1.5 font-medium text-[0.8125rem]"
                : look === "stacked"
                  ? "flex flex-col items-center gap-0.5 py-1.5 font-medium text-[0.625rem] coarse:py-2"
                  : "grid size-8 place-items-center coarse:size-9",
            )}
          >
            <Icon className={look === "named" ? "size-3.5" : "size-4"} strokeWidth={2} />
            {look === "row" ? null : name}
          </button>
        );
      })}
    </fieldset>
  );
}
