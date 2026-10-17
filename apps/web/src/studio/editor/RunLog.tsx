import type { RunEvent, RunView } from "@engenty-wizards/shared/run";
import { AlertCircle, Check, ChevronDown, ChevronUp, Copy, Info, Play, Wrench } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { withBase } from "../../lib/base";
import { eventText, type Key, lang, t } from "../../lib/i18n";
import { cn, IconButton } from "../../ui";

const KIND: Record<RunEvent["type"], { Icon: typeof Play; tone: string }> = {
  step_started: { Icon: Play, tone: "text-ink-3" },
  step_done: { Icon: Check, tone: "text-moss" },
  tool: { Icon: Wrench, tone: "text-ink-3" },
  info: { Icon: Info, tone: "text-ink-3" },
  error: { Icon: AlertCircle, tone: "text-rose" },
};

const time = (at: string) =>
  new Date(at).toLocaleTimeString(lang, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

/** The time since the line before, "+1.2 s"; nothing for the first. */
function gap(ev: RunEvent, before: RunEvent | undefined): string {
  if (!before) {
    return "";
  }
  const s = (new Date(ev.at).getTime() - new Date(before.at).getTime()) / 1000;
  return `+${s.toLocaleString(lang, { maximumFractionDigits: 1 })} s`;
}

/** The log as text, to paste into the assistant's chat or a bug report. */
function logText(events: RunEvent[], titles: Record<string, string>): string {
  return events
    .map((ev, i) =>
      [
        time(ev.at),
        gap(ev, events[i - 1]),
        `[${t(`log.kind.${ev.type}` as Key)}]`,
        ev.stepId ? `${titles[ev.stepId] ?? ev.stepId}:` : "",
        eventText(ev),
      ]
        .filter(Boolean)
        .join(" "),
    )
    .join("\n");
}

const HEIGHT_KEY = "wizards.runLog.height";
const HEIGHT_DEFAULT = 240;
const HEIGHT_MIN = 96;
/** The log leaves the run and the diagram this much of the window. */
const heightMax = () => Math.max(HEIGHT_MIN, Math.round(window.innerHeight * 0.6));

/** The open log's height, dragged at its grip; remembered per browser. */
function useLogHeight() {
  const [height, setHeight] = useState(() => {
    try {
      const n = Number(localStorage.getItem(HEIGHT_KEY));
      return n ? Math.min(Math.max(n, HEIGHT_MIN), heightMax()) : HEIGHT_DEFAULT;
    } catch {
      return HEIGHT_DEFAULT;
    }
  });
  const set = (next: number) => {
    const h = Math.round(Math.min(Math.max(next, HEIGHT_MIN), heightMax()));
    setHeight(h);
    try {
      localStorage.setItem(HEIGHT_KEY, String(h));
    } catch {
      // the height only lasts this page then
    }
  };
  return { height, set };
}

/**
 * What a test run reports, line by line: when, in which step, what. It follows the newest line
 * until the person scrolls up. On a phone it starts folded to one line with the newest report.
 */
export function RunLog({
  view,
  steps,
  onSelect,
  className,
}: {
  view: RunView | null;
  /** The wizard's steps, for their titles. */
  steps: { id: string; title: string }[];
  onSelect: (stepId: string) => void;
  className?: string;
}) {
  const events = view?.events ?? [];
  const titles = Object.fromEntries(steps.map((s) => [s.id, s.title]));
  const [open, setOpen] = useState(() => !window.matchMedia("(max-width: 1023px)").matches);
  const [copied, setCopied] = useState(false);
  const size = useLogHeight();
  /** While the grip is dragged the height follows the pointer, without its transition. */
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ y: number; height: number; moved: boolean } | null>(null);
  const list = useRef<HTMLOListElement>(null);
  const follow = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new line is what scrolls
  useEffect(() => {
    const el = list.current;
    if (el && follow.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [events.length, open]);
  const last = events.at(-1);
  return (
    <div className={cn("flex min-h-0 flex-col bg-card", className)}>
      {/* The grip on its top edge: dragged, it sets the height (and opens a folded log); clicked,
          it folds the log in or out. */}
      {/* biome-ignore lint/a11y/useSemanticElements: a window splitter that moves is a focusable separator (WAI-ARIA) */}
      <div
        role="separator"
        tabIndex={0}
        aria-orientation="horizontal"
        aria-valuenow={open ? size.height : 0}
        aria-valuemin={HEIGHT_MIN}
        aria-label={t("log.grip")}
        title={t("log.grip")}
        onPointerDown={(e) => {
          if (e.button !== 0) {
            return;
          }
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          start.current = { y: e.clientY, height: open ? size.height : 0, moved: false };
        }}
        onPointerMove={(e) => {
          const from = start.current;
          if (!from || (!from.moved && Math.abs(e.clientY - from.y) < 4)) {
            return;
          }
          if (!from.moved) {
            from.moved = true;
            setDragging(true);
            setOpen(true);
          }
          size.set(from.height + (from.y - e.clientY));
        }}
        onPointerUp={() => {
          const click = start.current && !start.current.moved;
          start.current = null;
          setDragging(false);
          if (click) {
            setOpen(!open);
          }
        }}
        onPointerCancel={() => {
          start.current = null;
          setDragging(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            if (!open) {
              setOpen(e.key === "ArrowUp");
              return;
            }
            size.set(size.height + (e.key === "ArrowUp" ? 32 : -32));
          } else if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen(!open);
          }
        }}
        className="group -mb-1.5 flex h-3 shrink-0 cursor-row-resize touch-none items-center justify-center outline-none"
      >
        <span className="h-1 w-10 rounded-full bg-ink-4/40 transition group-hover:bg-ink-4 group-focus-visible:bg-ember" />
      </div>
      <div className="flex h-10 shrink-0 items-center gap-2 pr-1.5 pl-3">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span className="font-medium text-[0.75rem] text-ink-3 uppercase tracking-[0.07em]">
            {t("log.title")}
          </span>
          <span className="text-[0.75rem] text-ink-4 tabular-nums">
            {t("log.count", { count: events.length })}
          </span>
          {/* Folded, the newest line says what the run does now. */}
          {!open && last ? (
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-[0.75rem]",
                last.type === "error" ? "text-rose" : "text-ink-2",
              )}
            >
              {eventText(last)}
            </span>
          ) : null}
          {open ? (
            <ChevronDown className="ml-auto size-4 shrink-0 text-ink-3" />
          ) : (
            <ChevronUp className="ml-auto size-4 shrink-0 text-ink-3" />
          )}
        </button>
        {open && events.length ? (
          <IconButton
            label={t(copied ? "log.copied" : "log.copy")}
            onClick={() => {
              void navigator.clipboard
                .writeText(logText(events, titles))
                .then(() => setCopied(true))
                .catch(() => {});
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? <Check className="size-4 text-moss" /> : <Copy className="size-4" />}
          </IconButton>
        ) : null}
      </div>
      {/* Folded and unfolded by its height; the lines stay, so the log keeps its scroll. */}
      <div
        className={cn(
          "overflow-hidden",
          !dragging &&
            "motion-safe:transition-[height] motion-safe:duration-200 motion-safe:ease-out",
        )}
        style={{ height: open ? size.height : 0 }}
        inert={!open}
      >
        <ol
          ref={list}
          onScroll={(e) => {
            const el = e.currentTarget;
            follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
          className="h-full overflow-y-auto px-3 pb-3 text-[0.75rem]"
        >
          {events.length ? null : <li className="py-2 text-ink-3">{t("log.empty")}</li>}
          {events.map((ev, i) => {
            const { Icon, tone } = KIND[ev.type];
            const step = ev.stepId;
            return (
              <li
                key={ev.id}
                className={cn(
                  "grid grid-cols-[4.25rem_1rem_minmax(0,1fr)] items-start gap-x-2 border-border-soft/60 border-t py-1.5 first:border-t-0",
                  ev.type === "step_started" && "mt-1",
                )}
              >
                <span className="text-ink-4 tabular-nums leading-5" title={gap(ev, events[i - 1])}>
                  {time(ev.at)}
                </span>
                <Icon
                  className={cn("mt-1 size-3.5", tone)}
                  aria-label={t(`log.kind.${ev.type}` as Key)}
                />
                <span className="min-w-0 leading-5">
                  {step ? (
                    <button
                      type="button"
                      onClick={() => onSelect(step)}
                      className="mr-1.5 font-medium text-ink hover:underline"
                    >
                      {titles[step] ?? step}
                    </button>
                  ) : null}
                  <span
                    className={cn(
                      "break-words",
                      ev.type === "error" ? "text-rose" : "text-ink-2",
                      ev.type === "tool" && "font-mono text-[0.6875rem]",
                    )}
                  >
                    {eventText(ev)}
                  </span>
                  {ev.asset && view ? (
                    <img
                      src={withBase(`/api/runs/${view.id}/assets/${ev.asset}`)}
                      alt=""
                      className="mt-1 block size-12 rounded-md object-cover ring-1 ring-border-soft"
                    />
                  ) : null}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
