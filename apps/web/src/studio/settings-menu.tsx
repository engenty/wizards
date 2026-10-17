import { ArrowLeft, ChevronDown, ChevronLeft, ChevronRight, type LucideIcon } from "lucide-react";
import {
  type ComponentType,
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import { useMediaQuery } from "../lib/media";
import { cn } from "../ui";

/**
 * The settings' left container shows one level at a time: the sections, or — one level down —
 * the menu of the section that has one (Models, Integrate). A section hands its menu up with
 * <SubMenu>; it lands in that container, and the section's page stays the main content. The
 * space page is built the same way, with its parts in place of the sections.
 */
export interface SettingsMenu {
  /** Where the section's menu goes. */
  slot: HTMLElement | null;
  /** The narrow layout: the menus and the page take turns instead of standing side by side. */
  narrow: boolean;
  /** What the page shows inside the section, for the trail in the top bar ("Images"). */
  setDetail: (label: string | null) => void;
}

export const SettingsMenuContext = createContext<SettingsMenu>({
  slot: null,
  narrow: false,
  setDetail: () => undefined,
});

export function useSettingsMenu(): SettingsMenu {
  return useContext(SettingsMenuContext);
}

/** The section's menu, one level down in the settings' left container. */
export function SubMenu({ children }: { children: ReactNode }) {
  const { slot } = useSettingsMenu();
  return slot ? createPortal(children, slot) : null;
}

/** Names what the page shows in the top bar's trail, while it is shown. */
export function useDetail(label: string | null) {
  const { setDetail } = useSettingsMenu();
  useEffect(() => {
    setDetail(label);
    return () => setDetail(null);
  }, [label, setDetail]);
}

/** Below `md` the menus and the page take turns. */
export function useNarrow(): boolean {
  return useMediaQuery("(max-width: 767px)");
}

/** The entrance of a level: deeper from the right, back from the left, as in engenty-pro. */
export function stepClass(direction: "deeper" | "back" | null): string | false {
  return direction === "deeper"
    ? "animate-step-deeper"
    : direction === "back" && "animate-step-back";
}

type Icon = LucideIcon | ComponentType<{ className?: string }>;

/** An entry of the upper level: a section of the settings, a part of the space. */
export interface LevelEntry {
  id: string;
  label: string;
  icon: Icon;
  to: string;
}

/**
 * The left container's top row: the back arrow and the level's name — `title` above, the entry
 * that is open one level down. `root`: the upper level has a name and a way back of its own too,
 * and shows them as one level down does.
 */
export function LevelHead({
  title,
  open,
  onBack,
  root,
}: {
  title: string;
  open: LevelEntry | null;
  onBack: () => void;
  root?: { icon: Icon; label: string; backLabel: string; onBack: () => void };
}) {
  const shown = open ?? root ?? null;
  return (
    <div className="mb-2 flex h-9 min-w-0 items-center px-1">
      <div
        className={cn(
          "shrink-0 overflow-hidden transition-[width,margin,opacity] duration-200 ease-out",
          shown ? "-ml-1.5 mr-0.5 w-8 opacity-100" : "w-0 opacity-0",
        )}
      >
        <button
          type="button"
          onClick={open ? onBack : root?.onBack}
          aria-hidden={!shown}
          tabIndex={shown ? undefined : -1}
          aria-label={open ? title : root?.backLabel}
          className="grid size-8 place-items-center rounded-lg text-ink-3 transition hover:bg-accent hover:text-ink"
        >
          <ArrowLeft className="size-4" />
        </button>
      </div>
      {shown ? (
        <span className="flex min-w-0 items-center gap-2 font-medium text-[0.875rem]">
          <shown.icon className="size-4 shrink-0 text-ember-strong" />
          <span className="truncate">{shown.label}</span>
        </span>
      ) : (
        <span className="truncate font-medium text-[0.875rem]">{title}</span>
      )}
    </div>
  );
}

/** The upper level of the left container: the sections, or the space's parts. */
export function LevelList({
  entries,
  current,
  onPick,
}: {
  entries: LevelEntry[];
  current: LevelEntry | undefined;
  /** The entry that is open already was picked: its menu comes back, nothing else changes. */
  onPick: (entry: LevelEntry) => void;
}) {
  return (
    <ul className="flex flex-col gap-0.5">
      {entries.map((e) => (
        <li key={e.id}>
          <Link
            to={e.to}
            onClick={(event) => {
              if (e.id === current?.id) {
                event.preventDefault();
                onPick(e);
              }
            }}
            aria-current={e.id === current?.id ? "page" : undefined}
            className={cn(
              "group flex items-center gap-2 rounded-lg px-2 py-1 text-[0.875rem] transition max-md:py-2",
              e.id === current?.id
                ? "bg-paper-2 font-medium text-ink"
                : "text-ink-2 hover:bg-accent hover:text-ink",
            )}
          >
            <span className="grid size-7 shrink-0 place-items-center">
              <e.icon className="size-4 transition-transform duration-200 ease-out group-hover:scale-110" />
            </span>
            <span className="min-w-0 flex-1 truncate">{e.label}</span>
            {/* On a phone every row goes one step deeper. */}
            <ChevronRight className="size-4 text-ink-4 md:hidden" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** The row at the top of a deeper level: back to the level above, named. */
export function BackRow({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <button
      type="button"
      onClick={onBack}
      className="-ml-1 flex items-center gap-1 rounded-lg py-1.5 pr-3 pl-1 text-[0.8125rem] text-ink-3 transition hover:text-ink"
    >
      <ChevronLeft className="size-4" />
      {label}
    </button>
  );
}

/**
 * On a phone a step deeper comes in from the right, a step back from the left: the direction of
 * the last change of level, kept until the next one.
 */
export function useStepDirection(level: number): "deeper" | "back" | null {
  const last = useRef({ level, direction: null as "deeper" | "back" | null });
  if (level !== last.current.level) {
    last.current = { level, direction: level > last.current.level ? "deeper" : "back" };
  }
  return last.current.direction;
}

/**
 * A group of a section's menu under its small heading. `collapsible`: the heading folds it, and
 * says how many rows it holds while folded.
 */
export function MenuGroup({
  label,
  collapsible,
  open: initiallyOpen = true,
  count,
  children,
}: {
  label: string;
  collapsible?: boolean;
  open?: boolean;
  count?: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const heading = "font-medium text-[0.6875rem] text-ink-4 uppercase tracking-[0.12em]";
  return (
    <div className="mt-5 first:mt-0">
      {collapsible ? (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className={cn(
            "mb-1 flex w-full items-center gap-1 px-2 text-left hover:text-ink-2",
            heading,
          )}
        >
          <span className="flex-1">{label}</span>
          {open ? null : <span className="tabular-nums tracking-normal">{count}</span>}
          <ChevronDown
            className={cn("size-3.5 transition-transform", open ? null : "-rotate-90")}
          />
        </button>
      ) : (
        <p className={cn("mb-1 px-2", heading)}>{label}</p>
      )}
      {open ? <ul className="flex flex-col gap-0.5">{children}</ul> : null}
    </div>
  );
}

/** How a row stands, as a dot at its end: works, runs on credits, in progress, missing. */
export type MenuTone = "done" | "credits" | "on" | "off";

/** A row of a section's menu: an icon, the name, at most a badge and a dot; the rest is the page's. */
export function MenuRow({
  icon: Icon,
  label,
  badge,
  tone,
  toneLabel,
  selected,
  disabled,
  onPick,
}: {
  icon: Icon;
  label: string;
  badge?: ReactNode;
  tone?: MenuTone;
  /** What the dot means, for a pointer and a screen reader. */
  toneLabel?: string;
  selected: boolean;
  disabled?: boolean;
  onPick?: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onPick}
        disabled={disabled}
        aria-current={selected ? "page" : undefined}
        className={cn(
          "group flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-[0.875rem] transition max-md:py-2",
          selected
            ? "bg-paper-2 font-medium text-ink"
            : "text-ink-2 hover:bg-accent hover:text-ink",
          disabled && "cursor-default opacity-50 hover:bg-transparent hover:text-ink-2",
        )}
      >
        <span className="grid size-7 shrink-0 place-items-center">
          <Icon
            className={cn(
              "size-4 transition-transform duration-200 ease-out",
              !disabled && "group-hover:scale-110",
              selected ? "text-ember-strong" : "text-ink-3",
            )}
          />
        </span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {badge}
        {tone ? (
          <span
            role="img"
            title={toneLabel}
            aria-label={toneLabel}
            className={cn(
              "size-2 shrink-0 rounded-full",
              tone === "done" && "bg-moss",
              tone === "credits" && "bg-amber",
              tone === "on" && "bg-ember",
              tone === "off" && "ring-1 ring-ink-4 ring-inset",
            )}
          />
        ) : null}
        {/* On a phone a row goes one step deeper. */}
        {disabled ? null : <ChevronRight className="size-4 shrink-0 text-ink-4 md:hidden" />}
      </button>
    </li>
  );
}
