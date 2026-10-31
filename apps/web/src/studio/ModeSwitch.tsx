import { Eye, type LucideIcon, MessageSquare, PenLine } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
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
 * How much more room the shown mode takes than each of the others, in a switch whose size stays
 * put: `named` fills the bar's width, `stacked` has a fixed height in which the shown mode is a
 * square of 2.75rem, as wide as the bar's buttons, and each other one 2.125rem high.
 */
const OPEN_GROW = { named: 2, stacked: 2.75 / 2.125 } as const;

/**
 * The switch between the modes, always in sight: in the app bar right under the space, and on a
 * phone in the top bar. Compact: each mode is its glyph, and a card under the one the person is
 * in carries its name; pointing at another slides the card and the name over to it. `named`
 * lies along the wordmark of a bar that names its places, `stacked` stands in a narrow bar with
 * the name under the glyph, `row` is glyphs alone, for a bar along the top or bottom and on a
 * phone. `stack` (the phone's top bar) shows the current mode alone; a tap (or the pointer)
 * opens all of them downward over the page, with their names, and a second tap picks one.
 * Someone with one mode gets none.
 */
export function ModeSwitch({
  me,
  look,
  stack,
  className,
}: {
  me: Me;
  look: "named" | "stacked" | "row";
  stack?: boolean;
  className?: string;
}) {
  const mode = useMode(me);
  const modes = allowedModes(me);
  const navigate = useNavigate();
  const box = useRef<HTMLFieldSetElement>(null);
  // The mode pointed at (or focused), else the current one: it has the card and the name.
  const [pointed, setPointed] = useState<Mode | null>(null);
  const shown = pointed ?? mode;
  const [card, setCard] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const vertical = look === "stacked";
  // The stack opens downward: its modes stand in a column too.
  const column = vertical || Boolean(stack);
  const [fanned, setFanned] = useState(false);
  const piled = Boolean(stack) && !fanned;
  // A tap outside folds the fanned stack again.
  useEffect(() => {
    if (!(stack && fanned)) {
      return;
    }
    const fold = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) {
        setFanned(false);
        setPointed(null);
      }
    };
    document.addEventListener("pointerdown", fold);
    return () => document.removeEventListener("pointerdown", fold);
  }, [stack, fanned]);
  // The card goes straight to where the shown mode's button ends up once the names have opened
  // and closed, not after the button as it grows.
  // biome-ignore lint/correctness/useExhaustiveDependencies: another mode moves the card; a second mode makes the switch appear.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) {
      return;
    }
    const place = () => {
      const buttons = Array.from(el.querySelectorAll<HTMLElement>(":scope > button"));
      const at = buttons.findIndex((b) => b.hasAttribute("data-shown"));
      const on = buttons[at];
      if (!on) {
        setCard(null);
        return;
      }
      const style = getComputedStyle(el);
      const pad = Number.parseFloat(column ? style.paddingTop : style.paddingLeft);
      const gap = Number.parseFloat(style.gap) || 0;
      const sizes =
        look !== "row"
          ? (() => {
              // The buttons share the switch by their grow.
              const grow = OPEN_GROW[look];
              const room =
                (vertical ? el.clientHeight : el.clientWidth) -
                2 * pad -
                gap * (buttons.length - 1);
              const total = buttons.length - 1 + grow;
              return buttons.map((b) => (room * (b === on ? grow : 1)) / total);
            })()
          : buttons.map((b) => {
              const name = b.querySelector<HTMLElement>("[data-name]");
              const now = column ? b.offsetHeight : b.offsetWidth;
              // The stack's names open across its column, not along it.
              if (!name || column !== vertical) {
                return now;
              }
              const inner = name.firstElementChild as HTMLElement;
              const open = b === on ? (vertical ? inner.scrollHeight : inner.scrollWidth) : 0;
              return now - (vertical ? name.offsetHeight : name.offsetWidth) + open;
            });
      const start = pad + sizes.slice(0, at).reduce((sum, size) => sum + size + gap, 0);
      setCard(
        column
          ? { x: on.offsetLeft, y: start, w: on.offsetWidth, h: sizes[at] }
          : { x: start, y: on.offsetTop, w: sizes[at], h: on.offsetHeight },
      );
    };
    place();
    const watch = new ResizeObserver(place);
    watch.observe(el);
    for (const child of el.children) {
      watch.observe(child);
    }
    return () => watch.disconnect();
  }, [shown, modes.length, piled]);
  if (modes.length < 2) {
    return null;
  }
  const pick = (next: Mode) => {
    // On a piled stack the first tap only fans it out.
    if (piled) {
      setFanned(true);
      return;
    }
    setFanned(false);
    setPointed(null);
    if (next !== mode) {
      setMode(me, next);
      navigate(MODE_HOME[next]);
    }
  };
  // The current mode leads the stack; the others lie behind it in their order.
  const order = stack ? [mode, ...modes.filter((m) => m !== mode)] : modes;
  const fieldset = (
    <fieldset
      ref={box}
      aria-label={t("mode.switch")}
      onPointerEnter={(e) => {
        if (e.pointerType === "mouse") {
          setFanned(true);
        }
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === "mouse") {
          setPointed(null);
          setFanned(false);
        }
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) {
          setPointed(null);
          setFanned(false);
        }
      }}
      className={cn(
        "relative isolate flex shrink-0 gap-0.5 rounded-[14px] p-1 ring-1 ring-border-soft",
        // Out of the flow, the stack takes the width its names need, not the bar's room.
        look === "named" ? "w-full" : stack ? "w-max" : "w-fit",
        column && "flex-col",
        // Open, the stack lies over the page.
        stack
          ? cn(
              "absolute top-0 right-0 z-40 bg-paper-2 transition-shadow duration-300",
              fanned && "shadow-overlay",
            )
          : "bg-ink/5",
        stack ? undefined : className,
      )}
      // The height stays while names open and close.
      style={
        vertical ? { height: `calc(2.75rem + ${modes.length - 1} * 2.25rem + 0.5rem)` } : undefined
      }
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute top-0 left-0 rounded-[10px] bg-card shadow-soft transition-[transform,width,height,opacity] duration-200 ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none dark:ring-1 dark:ring-border-soft",
          card && !piled ? "opacity-100" : "opacity-0",
        )}
        style={
          card
            ? { transform: `translate(${card.x}px, ${card.y}px)`, width: card.w, height: card.h }
            : undefined
        }
      />
      {order.map((m, i) => {
        const Icon = MODE_ICON[m];
        const name = t(`mode.${m}`);
        const open = m === shown;
        return (
          <button
            key={m}
            type="button"
            aria-pressed={m === mode}
            data-shown={open || undefined}
            onClick={() => pick(m)}
            // Pointing is a low-priority update to React; rendered at once, the card moves on
            // the next frame instead of a few later.
            onMouseEnter={() => flushSync(() => setPointed(m))}
            onFocus={() => {
              setPointed(m);
              setFanned(true);
            }}
            title={look === "row" && !stack ? name : undefined}
            className={cn(
              "relative flex items-center rounded-[10px] transition-[color,margin,opacity,background-color,box-shadow,flex-grow] duration-200 ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none",
              open ? "text-ink" : "text-ink-3",
              vertical
                ? "w-11 flex-col justify-center"
                : cn("h-8 coarse:h-9", look === "row" && "px-2 coarse:px-2.5"),
              look !== "row" && "min-h-0 min-w-0 basis-0 justify-center",
              // Closed, the others hide behind the current mode.
              stack && i > 0 && (piled ? "-mt-[34px] opacity-0 coarse:-mt-[38px]" : "mt-0"),
              piled && i === 0 && "bg-card shadow-soft dark:ring-1 dark:ring-border-soft",
            )}
            style={{
              flexGrow: look === "row" ? undefined : open ? OPEN_GROW[look] : 1,
              zIndex: stack ? order.length - i : undefined,
            }}
          >
            <Icon className="size-4 shrink-0" strokeWidth={2} />
            {look === "row" && !stack ? (
              <span className="sr-only">{name}</span>
            ) : (
              // The name opens from nothing: a grid track that grows from 0fr to 1fr.
              <span
                data-name
                className={cn(
                  "grid transition-[grid-template-columns,grid-template-rows,opacity] duration-200 ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none",
                  vertical
                    ? open
                      ? "grid-rows-[1fr]"
                      : "grid-rows-[0fr] opacity-0"
                    : (stack ? fanned : open)
                      ? "grid-cols-[1fr]"
                      : "grid-cols-[0fr] opacity-0",
                )}
              >
                <span
                  className={cn(
                    "overflow-hidden whitespace-nowrap font-medium",
                    vertical
                      ? "pt-0.5 text-center text-[0.625rem]"
                      : cn("pl-1.5 text-[0.8125rem]", stack && "pr-1.5 coarse:text-[0.875rem]"),
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
  // The stack keeps the room of one button in the bar; what opens lies over the page.
  return stack ? (
    <div className={cn("relative size-10 shrink-0 coarse:size-11", className)}>{fieldset}</div>
  ) : (
    fieldset
  );
}
