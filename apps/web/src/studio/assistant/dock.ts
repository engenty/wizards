import { useSyncExternalStore } from "react";

/**
 * Where Goose's chat stands at the bottom of the page, per browser: in the middle, at the right,
 * or where it was put down (`free`); how high its thread is; whether the developer mode is on.
 * And moving it: dragged by its grip it follows the pointer, near the bottom it snaps to the
 * middle or the right, near the right side (above the bottom) into the sidebar.
 */

export type DockPlace = "center" | "right" | "free";

export interface DockPrefs {
  place: DockPlace;
  /** Where it was put down: from the page column's left and bottom edge, in px. */
  free: { left: number; bottom: number } | null;
  /** The thread's height in px, set with the handle on top; null: as high as it needs. */
  height: number | null;
  /** The developer mode, where it is offered. */
  dev: boolean;
}

const KEY = "wizards.assistant";
const DEFAULT: DockPrefs = { place: "center", free: null, height: null, dev: false };

function read(): DockPrefs {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<DockPrefs> | null;
    return {
      place: stored?.place === "right" || stored?.place === "free" ? stored.place : "center",
      free:
        typeof stored?.free?.left === "number" && typeof stored.free.bottom === "number"
          ? { left: stored.free.left, bottom: stored.free.bottom }
          : null,
      height: typeof stored?.height === "number" ? stored.height : null,
      dev: stored?.dev === true,
    };
  } catch {
    return DEFAULT;
  }
}

let prefs = read();
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) {
    listener();
  }
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function setDockPrefs(patch: Partial<DockPrefs>) {
  prefs = { ...prefs, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // it lasts this page then
  }
  notify();
}

export function useDockPrefs(): DockPrefs {
  return useSyncExternalStore(subscribe, () => prefs);
}

// --- moving it ---------------------------------------------------------------------------------

/** How near the bottom or the right side the chat has to come to snap there. */
const SNAP = 64;
/** The chat's width at most, and its distance from the column's edges. */
export const DOCK_WIDTH = 600;
const PAD = 12;

export type DockZone = "center" | "right" | "sidebar";

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface DockDrag {
  /** Where the chat is now, in the page column. */
  left: number;
  top: number;
  width: number;
  /** Where it would snap if dropped now; null: it stays where it is put. */
  zone: DockZone | null;
  /** That zone's place, for the outline; kept while the outline fades out. */
  spot: Rect | null;
}

let drag: DockDrag | null = null;
const dragListeners = new Set<() => void>();
function setDrag(next: DockDrag | null) {
  drag = next;
  for (const listener of dragListeners) {
    listener();
  }
}

export function useDockDrag(): DockDrag | null {
  return useSyncExternalStore(
    (listener) => {
      dragListeners.add(listener);
      return () => dragListeners.delete(listener);
    },
    () => drag,
  );
}

/** The chat's width in a column this wide. */
export const dockWidth = (column: number) => Math.min(DOCK_WIDTH, column - 2 * PAD);

/**
 * Where the chat can snap to, in the column: the middle at the bottom, the right at the bottom
 * where the column has room beside it, and the sidebar where the window is wide enough.
 */
function spots(column: DOMRect, height: number, sidebar: boolean) {
  const width = dockWidth(column.width);
  const top = column.height - PAD - height;
  return {
    center: { left: (column.width - width) / 2, top, width, height },
    right:
      column.width >= width + 2 * PAD + 240
        ? { left: column.width - PAD - width, top, width, height }
        : null,
    sidebar: sidebar
      ? { left: column.width - 400 + 8, top: 8, width: 384, height: column.height - 16 }
      : null,
  };
}

/** Whether the bottom right is a place of its own in a column this wide. */
export const hasRight = (column: number) => column >= dockWidth(column) + 2 * PAD + 240;

/**
 * Starts moving the chat from its grip. Window listeners follow the pointer, so the grip may go
 * (out of the sidebar, the chat at the bottom takes its place). A press without a move is a click.
 */
export function startDockDrag(
  e: React.PointerEvent,
  opts: {
    column: () => HTMLElement | null;
    /** What moves: the chat's card with its bar. */
    frame: () => HTMLElement | null;
    /** The sidebar is offered on this window. */
    sidebar: boolean;
    /** Dragged out of the sidebar: the chat comes to the bottom when the move starts. */
    onLeave?: () => void;
    /** Pressed and let go without a move. */
    onClick?: () => void;
    onDrop: (zone: DockZone | "free", free?: { left: number; bottom: number }) => void;
  },
) {
  if (e.button !== 0) {
    return;
  }
  e.preventDefault();
  const start = { x: e.clientX, y: e.clientY };
  const box = opts.frame()?.getBoundingClientRect();
  // Where the pointer holds the chat: where it was grabbed, or – out of the sidebar – near its grip.
  const grab = box ? { x: start.x - box.left, y: start.y - box.top } : { x: 28, y: 24 };
  let moving = false;
  let last: DockDrag | null = null;
  // Only the pointer that grabbed it: another (a second finger, a mouse beside a pen) does not move it.
  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== e.pointerId) {
      return;
    }
    if (!moving && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 5) {
      return;
    }
    if (!moving) {
      moving = true;
      document.body.style.userSelect = "none";
      opts.onLeave?.();
    }
    const column = opts.column()?.getBoundingClientRect();
    if (!column) {
      return;
    }
    const frame = opts.frame()?.getBoundingClientRect();
    const width = dockWidth(column.width);
    const height = frame?.height ?? 160;
    const left = Math.min(
      Math.max(ev.clientX - column.left - grab.x, 8),
      Math.max(8, column.width - 120),
    );
    const top = Math.min(
      Math.max(ev.clientY - column.top - grab.y, 8),
      Math.max(8, column.height - height - 8),
    );
    const at = spots(column, height, opts.sidebar);
    const nearBottom = column.height - (top + height) < SNAP;
    // The side is a strip as the bottom is: the chat's right edge near the column's (above the
    // bottom, whose right end is a place of its own), or the pointer at the window's edge.
    const nearSide = column.width - (left + width) < SNAP || window.innerWidth - ev.clientX < SNAP;
    let zone: DockZone | null = null;
    if (at.sidebar && nearSide && (!nearBottom || window.innerWidth - ev.clientX < SNAP)) {
      zone = "sidebar";
    } else if (nearBottom) {
      const mid = left + width / 2;
      zone =
        at.right &&
        Math.abs(mid - (at.right.left + width / 2)) < Math.abs(mid - (at.center.left + width / 2))
          ? "right"
          : "center";
    }
    last = { left, top, width, zone, spot: (zone && at[zone]) || last?.spot || null };
    setDrag(last);
  };
  const up = (ev: PointerEvent) => {
    if (ev.pointerId !== e.pointerId) {
      return;
    }
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    document.body.style.userSelect = "";
    const ended = last;
    setDrag(null);
    if (!moving) {
      opts.onClick?.();
      return;
    }
    if (!ended) {
      return;
    }
    if (ended.zone) {
      opts.onDrop(ended.zone);
      return;
    }
    const column = opts.column()?.getBoundingClientRect();
    const height = opts.frame()?.getBoundingClientRect().height ?? 0;
    opts.onDrop("free", {
      left: Math.round(ended.left),
      bottom: Math.round((column?.height ?? 0) - ended.top - height),
    });
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}
