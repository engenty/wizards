import { ArrowLeft, ChevronRight } from "lucide-react";
import { type ComponentType, type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import { useSideMenuSlot } from "../studio/side-menu";
import { cn } from "./index";

export interface PageMenuEntry {
  id: string;
  label: string;
  icon?: ComponentType<{ className?: string }>;
  to: string;
  /** A level below: on a wide screen the menu slides there, on a phone they are a second row. */
  entries?: PageMenuEntry[];
}

/**
 * The menu of a page with parts of its own: a list at the side with one level below that slides
 * in (as the settings do), and on a phone two rows of tabs above the content instead. `current`
 * is the id of the entry shown, at either level.
 */
export function PageMenu({
  title,
  entries,
  current,
  footer,
}: {
  title: string;
  entries: PageMenuEntry[];
  current: string;
  /** Under the list on a wide screen, e.g. what the part is for; not shown on a phone. */
  footer?: ReactNode;
}) {
  const parent = entries.find((e) => e.entries?.some((c) => c.id === current)) ?? null;
  const top = parent?.id ?? current;
  // The level shown follows the page; the back arrow goes up without leaving it.
  const parentId = parent?.id ?? null;
  const [openId, setOpenId] = useState<string | null>(parentId);
  const [direction, setDirection] = useState<"deeper" | "back" | null>(null);
  useEffect(() => {
    setOpenId((prev) => {
      if (prev !== parentId) {
        setDirection(parentId ? "deeper" : "back");
      }
      return parentId;
    });
  }, [parentId]);
  const open = entries.find((e) => e.id === openId) ?? null;
  const below = open?.entries ?? null;

  return (
    <nav aria-label={title}>
      {/* A phone: the parts as tabs, the level below as a second row. */}
      <div className="flex flex-col gap-2 md:hidden">
        <Tabs entries={entries} current={top} />
        {parent?.entries ? <Tabs entries={parent.entries} current={current} small /> : null}
      </div>

      <div className="max-md:hidden">
        <div className="mb-2 flex h-9 min-w-0 items-center px-1">
          {open ? (
            <>
              <button
                type="button"
                onClick={() => {
                  setDirection("back");
                  setOpenId(null);
                }}
                aria-label={title}
                className="-ml-1.5 mr-0.5 grid size-8 place-items-center rounded-lg text-ink-3 transition hover:bg-accent hover:text-ink"
              >
                <ArrowLeft className="size-4" />
              </button>
              <span className="flex min-w-0 items-center gap-2 font-medium text-[0.875rem]">
                {open.icon ? <open.icon className="size-4 shrink-0 text-ember-strong" /> : null}
                <span className="truncate">{open.label}</span>
              </span>
            </>
          ) : (
            <span className="truncate font-medium text-[0.875rem]">{title}</span>
          )}
        </div>
        <div
          key={open?.id ?? ""}
          className={cn(
            direction === "deeper" && "animate-step-deeper",
            direction === "back" && "animate-step-back",
          )}
        >
          <ul className="flex flex-col gap-0.5">
            {(below ?? entries).map((e) => {
              const here = below ? e.id === current : e.id === top;
              return (
                <li key={e.id}>
                  <Link
                    to={e.to}
                    aria-current={here ? "page" : undefined}
                    className={cn(
                      "group flex items-center gap-2 rounded-lg px-2 py-1 text-[0.875rem] transition",
                      here
                        ? "bg-paper-2 font-medium text-ink"
                        : "text-ink-2 hover:bg-accent hover:text-ink",
                    )}
                  >
                    <span className="grid size-7 shrink-0 place-items-center">
                      {e.icon ? (
                        <e.icon className="size-4 transition-transform duration-200 ease-out group-hover:scale-110" />
                      ) : null}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{e.label}</span>
                    {!below && e.entries?.length ? (
                      <ChevronRight className="size-4 text-ink-4" />
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
        {footer}
      </div>
    </nav>
  );
}

function Tabs({
  entries,
  current,
  small,
}: {
  entries: PageMenuEntry[];
  current: string;
  small?: boolean;
}) {
  return (
    // Wider than the screen, the row scrolls on its own; the page does not.
    <div
      className={cn(
        "-mx-1 flex min-w-0 gap-1 overflow-x-auto px-1 [scrollbar-width:none]",
        small ? "" : "rounded-full bg-paper-2 p-1",
      )}
    >
      {entries.map((e) => {
        const here = e.id === current;
        return (
          <Link
            key={e.id}
            to={e.to}
            aria-current={here ? "page" : undefined}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-full transition",
              small
                ? "h-8 px-3 text-[0.8125rem]"
                : "h-9 flex-1 justify-center px-3.5 text-[0.875rem]",
              here
                ? small
                  ? "bg-paper-2 font-medium text-ink"
                  : "bg-card font-medium text-ink shadow-soft"
                : "text-ink-3 hover:text-ink",
            )}
          >
            {e.label}
          </Link>
        );
      })}
    </div>
  );
}

/**
 * A page with a menu of its own (a `PageMenu`, or any): the menu at the page's left, or in the
 * studio's sidebar while that is open – one menu at the left, never two. `children` is the page.
 */
export function MenuPage({ menu, children }: { menu: ReactNode; children: ReactNode }) {
  const slot = useSideMenuSlot();
  if (slot) {
    return (
      <>
        {createPortal(menu, slot)}
        {children}
      </>
    );
  }
  return (
    <div className="grid gap-6 md:grid-cols-[13.5rem_minmax(0,1fr)] md:gap-8 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-10">
      <aside className="min-w-0 md:sticky md:top-6 md:self-start">{menu}</aside>
      {children}
    </div>
  );
}
