import { Button, cn } from "@engenty/chatviews/react/ui";
import { ArrowLeft, ArrowRight, Check, RefreshCw } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { useText } from "./host.js";

const EASE = "ease-[cubic-bezier(0.3,0.7,0.2,1)]";

/**
 * A line of the list's heading: as wide as its text and shifted, not laid out, to the middle,
 * so it keeps the column's full width and can travel to the left edge.
 */
const LINE =
  "relative w-fit max-w-full transition-[left,translate] duration-700 ease-[cubic-bezier(0.3,0.7,0.2,1)] motion-reduce:transition-none";
const LINE_MIDDLE = "left-1/2 -translate-x-1/2 text-center";
/** Beside an opened choice the lines stand at the left edge; on a narrow page the list is alone again and they stay in the middle. */
const LINE_LEFT =
  "max-lg:left-1/2 max-lg:-translate-x-1/2 max-lg:text-center lg:left-0 lg:translate-x-0 lg:text-left";

/** A step by its state: reached, the one to do now, still ahead. */
const STEP_DONE = "var(--step-done)";
const STEP_NOW = "var(--step-now)";
const STEP_LATER = "color-mix(in oklab, var(--on) 38%, transparent)";

/** One thing an app can think with, as a row of the list. */
export interface SetupChoice {
  id: string;
  title: string;
  description: string;
  /** Set on the row's edge: the choice the setup recommends. */
  badge?: string;
  /** How the choice stands right now, at the row's end. */
  note?: string;
}

export function Choice({
  choice,
  selected,
  onPick,
}: {
  choice: SetupChoice;
  selected: boolean;
  onPick: () => void;
}) {
  const { title, description, badge, note } = choice;
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={selected}
      className={cn(
        "group relative flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-left transition-[background-color,color,box-shadow] duration-300",
        selected
          ? "bg-(color:--pick) text-(color:--pick-ink) shadow-elevated"
          : "bg-(color:--tile) ring-(color:--tile-ring) ring-1 hover:bg-(color:--tile-hover)",
      )}
    >
      {badge ? (
        <span className="absolute -top-2.5 right-4 rounded-full bg-(color:--badge) px-2.5 py-[3px] font-semibold text-(color:--badge-ink) text-[0.6875rem] leading-none tracking-wide shadow-[0_2px_8px_oklch(0%_0_0/0.22)]">
          {badge}
        </span>
      ) : null}
      <span
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors duration-300",
          selected ? "border-transparent bg-(color:--pick-mark)" : "border-(color:--on)/40",
        )}
      >
        {selected ? <Check className="size-3.5 text-(color:--pick)" /> : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium text-[0.9375rem]">{title}</span>
        <span
          className={cn(
            "mt-0.5 block truncate text-[0.8125rem]",
            selected ? "opacity-70" : "text-(color:--on)/65",
          )}
        >
          {description}
        </span>
      </span>
      {note ? (
        <span
          className={cn(
            "shrink-0 text-[0.75rem]",
            selected ? "opacity-70" : "text-(color:--on)/65",
          )}
        >
          {note}
        </span>
      ) : null}
      <ArrowRight
        className={cn(
          "size-4 shrink-0 transition",
          selected
            ? "opacity-70"
            : "text-(color:--on)/40 group-hover:translate-x-0.5 group-hover:text-(color:--on)/80",
        )}
      />
    </button>
  );
}

/**
 * Where the setup stands: what is chosen, its steps by name, then one dash per step. A step
 * reached is green and checked, the one to do now amber, the ones ahead dim. The dashes fill
 * like a strength meter: as many as the step the setup is on, amber on the way, all green once
 * it works.
 */
export function Stages({ name, at, done }: { name: string; at: number; done: boolean }) {
  const t = useText();
  const stages = [t("setup.stage.connect"), t("setup.stage.test"), t("setup.stage.done")];
  const level = done ? stages.length : at + 1;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 font-medium text-[0.75rem] uppercase tracking-[0.14em]">
      <span className="text-(color:--on)/70">{name}</span>
      <ol className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {stages.map((stage, i) => {
          const reached = done || i < at;
          return (
            <li
              key={stage}
              aria-current={!reached && i === at ? "step" : undefined}
              className="flex items-center gap-1 transition-colors duration-500"
              style={{ color: reached ? STEP_DONE : i === at ? STEP_NOW : STEP_LATER }}
            >
              {reached ? <Check className="size-3.5" strokeWidth={3} /> : null}
              {stage}
            </li>
          );
        })}
      </ol>
      <span aria-hidden="true" className="flex gap-1.5">
        {stages.map((stage, i) => (
          <span
            key={stage}
            className="h-[3px] w-5 rounded-full transition-colors duration-500"
            style={{
              background:
                i < level
                  ? done
                    ? STEP_DONE
                    : STEP_NOW
                  : "color-mix(in oklab, var(--on) 22%, transparent)",
            }}
          />
        ))}
      </span>
    </div>
  );
}

/**
 * On a narrow page the choices and the opened choice take turns; each starts at the top of
 * whatever scrolls around them.
 */
function toTop(from: HTMLElement | null) {
  if (window.matchMedia("(max-width: 1023px)").matches) {
    for (let el: HTMLElement | null = from; el; el = el.parentElement) {
      el.scrollTop = 0;
    }
  }
}

/** The opened choice: what it is, where it stands, and what it needs. */
export interface SetupPanel {
  name: string;
  heading: string;
  /** The step it is on: connect, test, done. */
  stage: number;
  works: boolean;
  /** A figure on the box's corner; the heading keeps clear of it. */
  figure?: ReactNode;
  content: ReactNode;
  /** Below the box: what goes on from here. */
  footer?: ReactNode;
}

/**
 * The setup: first only the question what the app thinks with, in the middle of the page. A
 * choice steps the list aside and opens what that choice needs (the sign-in, the keys, the test
 * call), its rows level with the list's.
 */
export function SetupColumns({
  eyebrow,
  title,
  sub,
  figure,
  top,
  divider,
  choices,
  selected,
  marked,
  onPick,
  recheck,
  panel,
  hidden = false,
}: {
  eyebrow?: string;
  title: string;
  sub: string;
  /** A figure that stands beside the choices while none is opened, small above them on a narrow page. */
  figure?: ReactNode;
  /** Above the choices: an account. A choice in it is picked with `pick`. */
  top?: (pick: (id: string) => void) => ReactNode;
  /** A line between what is above and the choices. */
  divider?: { label: string; note: string };
  choices: readonly SetupChoice[];
  /** The choice in effect; null: none yet. */
  selected: string | null;
  /** The row that is lit: the one just clicked, at once; else the one in effect. */
  marked: string | null;
  onPick: (id: string) => Promise<unknown> | unknown;
  /** Looks at the clients again; `note`: said beside it. */
  recheck?: { busy: boolean; run: () => void; note?: string | null };
  panel: SetupPanel | null;
  /** Something else stands in its place. */
  hidden?: boolean;
}) {
  const t = useText();
  const root = useRef<HTMLDivElement>(null);
  // A narrow page shows the opened choice alone; the person goes back to the choices from there.
  const [listOpen, setListOpen] = useState(false);
  /** On a narrow page: the opened choice is all there is to see. */
  const panelOnly = selected !== null && !listOpen;
  const pick = async (id: string) => {
    try {
      await onPick(id);
    } catch {
      return;
    }
    setListOpen(false);
    toTop(root.current);
  };
  return (
    <>
      {/* The figure of the start takes no row of its own on a wide page: it stands large beside
          the choices. On a narrow page there is no room beside anything, so it stands small
          above them. A choice brings a figure of its own, and this one steps out. */}
      {figure ? (
        <>
          <div
            aria-hidden="true"
            className={cn(
              "absolute top-6 left-1/2 z-10 origin-top -translate-x-1/2 transition-[opacity,scale,left] duration-500 motion-reduce:transition-none lg:top-[calc(6vh+5.25rem)] lg:origin-center lg:translate-x-0",
              EASE,
              selected
                ? "lg:pointer-events-none lg:left-[calc(50%-560px)] lg:scale-75 lg:opacity-0"
                : "lg:left-[calc(50%-508px)] lg:scale-100 lg:opacity-100",
              panelOnly
                ? "max-lg:pointer-events-none max-lg:scale-[0.4] max-lg:opacity-0"
                : "max-lg:scale-[0.6] max-lg:opacity-100",
            )}
          >
            <div className="animate-rise">{figure}</div>
          </div>
          <div
            aria-hidden="true"
            className={cn(
              "shrink-0 transition-[height] duration-500 motion-reduce:transition-none lg:h-0",
              EASE,
              panelOnly ? "max-lg:h-0" : "max-lg:h-[148px]",
            )}
          />
        </>
      ) : null}
      <div
        ref={root}
        className={cn(
          "flex flex-col gap-10 lg:flex-row lg:items-start lg:gap-14",
          hidden ? "hidden" : "",
        )}
      >
        <section
          className={cn(
            "flex w-full shrink-0 animate-rise flex-col lg:w-[32rem] lg:transition-[margin] lg:duration-700 motion-reduce:transition-none",
            EASE,
            selected ? "lg:ml-0" : "lg:ml-[calc(50%-16rem)]",
            panelOnly ? "max-lg:hidden" : "",
          )}
        >
          {/* Centred over the list while it stands alone; at the left edge, like the other
              column's lines, once a choice is open. */}
          <div className="flex flex-col lg:min-h-[6.5rem]">
            {eyebrow ? (
              <p
                className={cn(
                  LINE,
                  "font-medium text-(color:--on)/70 text-[0.75rem] uppercase tracking-[0.16em]",
                  selected ? LINE_LEFT : LINE_MIDDLE,
                )}
              >
                {eyebrow}
              </p>
            ) : null}
            <h1
              className={cn(
                LINE,
                "mt-2 font-display font-semibold text-[1.625rem] leading-[1.08] tracking-[-0.02em] sm:text-[1.75rem]",
                selected ? LINE_LEFT : LINE_MIDDLE,
              )}
            >
              {title}
            </h1>
            <p
              className={cn(
                LINE,
                "mt-2.5 text-(color:--on)/75 text-[0.9375rem] leading-relaxed",
                selected ? LINE_LEFT : LINE_MIDDLE,
              )}
            >
              {sub}
            </p>
          </div>
          {top?.((id) => void pick(id))}
          {divider ? (
            <div className="mt-7">
              <div className="flex items-center gap-3">
                <span className="h-px flex-1 bg-(color:--on)/25" />
                <span className="font-medium text-(color:--on)/80 text-[0.75rem] uppercase tracking-[0.14em]">
                  {divider.label}
                </span>
                <span className="h-px flex-1 bg-(color:--on)/25" />
              </div>
              <p className="mt-2 text-center text-(color:--on)/65 text-[0.8125rem] leading-snug">
                {divider.note}
              </p>
            </div>
          ) : null}
          <div className="mt-5 flex flex-col gap-2.5">
            {choices.map((choice) => (
              <Choice
                key={choice.id}
                choice={choice}
                selected={marked === choice.id}
                onPick={() => void pick(choice.id)}
              />
            ))}
          </div>
          {recheck ? (
            <div className="mt-3 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-(color:--on)/60 text-[0.8125rem]">
              <span>{recheck.note}</span>
              <Button variant="ghost" size="sm" busy={recheck.busy} onClick={recheck.run}>
                <RefreshCw className="size-3.5" /> {t("local.recheck")}
              </Button>
            </div>
          ) : null}
        </section>
        {selected && panel ? (
          <section
            key={selected}
            className={cn("min-w-0 flex-1 animate-settle", listOpen ? "max-lg:hidden" : "")}
          >
            {/* On a narrow page the opened choice stands alone: this leads back to the choices. */}
            <button
              type="button"
              onClick={() => {
                setListOpen(true);
                toTop(root.current);
              }}
              className="-ml-1.5 mb-5 inline-flex items-center gap-1.5 rounded-full px-1.5 py-1 text-(color:--on)/80 text-[0.875rem] transition hover:text-(color:--on) lg:hidden"
            >
              <ArrowLeft className="size-4" /> {t("setup.back")}
            </button>
            <div className="relative">
              {panel.figure ? (
                <div aria-hidden="true" className="absolute top-6 right-2 z-10">
                  {panel.figure}
                </div>
              ) : null}
              <div className="min-h-[6.5rem]">
                <Stages name={panel.name} at={panel.stage} done={panel.works} />
                <h2
                  key={panel.heading}
                  className={cn(
                    "mt-2 animate-rise font-display font-semibold text-[clamp(28px,3vw,40px)] leading-[1.06] tracking-[-0.03em]",
                    panel.figure ? "pr-32" : "",
                  )}
                >
                  {panel.heading}
                </h2>
              </div>
              <div className="mt-5 rounded-2xl bg-(color:--panel) p-5 ring-(color:--panel-ring) ring-1 sm:p-6">
                {panel.content}
              </div>
              {panel.footer ? <div className="mt-9">{panel.footer}</div> : null}
            </div>
          </section>
        ) : null}
      </div>
    </>
  );
}

/** Said once the test worked, above the way on. */
export function SetupReady() {
  const t = useText();
  return (
    <p
      className="mb-3 flex animate-rise items-center gap-2 font-medium text-[0.9375rem]"
      style={{ color: STEP_DONE }}
    >
      <Check className="size-4" strokeWidth={3} />
      {t("setup.ready")}
    </p>
  );
}
