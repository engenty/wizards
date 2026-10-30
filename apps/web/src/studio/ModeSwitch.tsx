import { Eye, type LucideIcon, MessageSquare, PenLine } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
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
 * a phone in the top bar. Compact: each mode is its glyph, and only the one the person is in
 * (or points at) shows its name; a card slides under the one they are in. `named` lies along
 * the wordmark of a bar that names its places, `stacked` stands in a narrow bar with the name
 * under the glyph, `row` is glyphs alone, for a bar along the top or bottom and on a phone.
 * Someone with one mode gets none.
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
  const box = useRef<HTMLFieldSetElement>(null);
  const [card, setCard] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const vertical = look === "stacked";
  // The card follows the button of the current mode, also while names open and close around it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new mode moves the card; a second mode makes the switch appear.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) {
      return;
    }
    const place = () => {
      const on = el.querySelector<HTMLElement>("[aria-pressed=true]");
      setCard(
        on ? { x: on.offsetLeft, y: on.offsetTop, w: on.offsetWidth, h: on.offsetHeight } : null,
      );
    };
    place();
    const watch = new ResizeObserver(place);
    watch.observe(el);
    for (const child of el.children) {
      watch.observe(child);
    }
    return () => watch.disconnect();
  }, [mode, modes.length]);
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
      ref={box}
      aria-label={t("mode.switch")}
      className={cn(
        "relative flex w-fit shrink-0 gap-0.5 rounded-[14px] bg-ink/5 p-1 ring-1 ring-border-soft",
        vertical && "flex-col",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute top-0 left-0 rounded-[10px] bg-card shadow-soft transition-[transform,width,height,opacity] duration-300 ease-out motion-reduce:transition-none dark:ring-1 dark:ring-border-soft",
          card ? "opacity-100" : "opacity-0",
        )}
        style={
          card
            ? { transform: `translate(${card.x}px, ${card.y}px)`, width: card.w, height: card.h }
            : undefined
        }
      />
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
            className={cn(
              "group relative flex items-center rounded-[10px] text-ink-3 transition-colors hover:text-ink focus-visible:text-ink aria-pressed:text-ink",
              vertical
                ? "w-11 flex-col justify-center py-2 coarse:py-2.5"
                : "h-8 px-2 coarse:h-9 coarse:px-2.5",
            )}
          >
            <Icon className="size-4 shrink-0" strokeWidth={2} />
            {look === "row" ? (
              <span className="sr-only">{name}</span>
            ) : (
              // The name opens from nothing: a grid track that grows from 0fr to 1fr.
              <span
                className={cn(
                  "grid transition-[grid-template-columns,grid-template-rows,opacity] duration-300 ease-out motion-reduce:transition-none",
                  vertical
                    ? "grid-rows-[0fr] opacity-0 group-hover:grid-rows-[1fr] group-hover:opacity-100 group-focus-visible:grid-rows-[1fr] group-focus-visible:opacity-100 group-aria-pressed:grid-rows-[1fr] group-aria-pressed:opacity-100"
                    : "grid-cols-[0fr] opacity-0 group-hover:grid-cols-[1fr] group-hover:opacity-100 group-focus-visible:grid-cols-[1fr] group-focus-visible:opacity-100 group-aria-pressed:grid-cols-[1fr] group-aria-pressed:opacity-100",
                )}
              >
                <span
                  className={cn(
                    "overflow-hidden whitespace-nowrap font-medium",
                    vertical ? "pt-0.5 text-center text-[0.625rem]" : "pl-1.5 text-[0.8125rem]",
                  )}
                >
                  {name}
                </span>
              </span>
            )}
          </button>
        );
      })}
    </fieldset>
  );
}
