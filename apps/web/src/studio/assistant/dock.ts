import { useSyncExternalStore } from "react";

/**
 * Where Goose's chat stands at the bottom of the page, per browser: in the middle or at the right;
 * how high its thread is; whether the developer mode is on. And moving it: dragged by its grip it
 * follows the pointer and, let go, docks in the middle or at the right, whichever is nearer, or –
 * near the right side, above the bottom – in the sidebar. It is never left over the page.
 */

export type DockPlace = "center" | "right";

export interface DockPrefs {
  place: DockPlace;
  /** The thread's height in px, set with the handle on top; null: as high as it needs. */
  height: number | null;
  /** The developer mode, where it is offered. */
  dev: boolean;
}

const KEY = "wizards.assistant";
const DEFAULT: DockPrefs = { place: "center", height: null, dev: false };

function read(): DockPrefs {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<DockPrefs> | null;
    return {
      place: stored?.place === "right" ? "right" : "center",
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
  /** Where it docks if dropped now. */
  zone: DockZone;
  /** That zone's place, for the outline. */
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
    onDrop: (zone: DockZone) => void;
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
    let zone: DockZone;
    if (at.sidebar && nearSide && (!nearBottom || window.innerWidth - ev.clientX < SNAP)) {
      zone = "sidebar";
    } else {
      // Anywhere else it docks at the bottom, in the middle or at the right, whichever is nearer.
      const mid = left + width / 2;
      zone =
        at.right &&
        Math.abs(mid - (at.right.left + width / 2)) < Math.abs(mid - (at.center.left + width / 2))
          ? "right"
          : "center";
    }
    last = { left, top, width, zone, spot: at[zone] ?? last?.spot ?? null };
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
    if (ended?.zone) {
      opts.onDrop(ended.zone);
    }
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}

// --- the place at the top of a page ------------------------------------------------------------

let slot: HTMLElement | null = null;
const slotListeners = new Set<() => void>();

/**
 * Where a page wants the chat at its top (the space page's parts); null when it wants none. A
 * ref callback: the page's slot registers itself while it is drawn.
 */
export function setAssistantSlot(el: HTMLElement | null) {
  slot = el;
  for (const listener of slotListeners) {
    listener();
  }
}

export function useAssistantSlot(): HTMLElement | null {
  return useSyncExternalStore(
    (listener) => {
      slotListeners.add(listener);
      return () => slotListeners.delete(listener);
    },
    () => slot,
  );
}

// --- the place in the top bar ------------------------------------------------------------------

let hintSlot: HTMLElement | null = null;
const hintListeners = new Set<() => void>();

/**
 * Where the help hint stands once a page's introduction is closed: the right end of the top bar,
 * so the page loses no row to it. A ref callback of the top bar.
 */
export function setHintSlot(el: HTMLElement | null) {
  hintSlot = el;
  for (const listener of hintListeners) {
    listener();
  }
}

export function useHintSlot(): HTMLElement | null {
  return useSyncExternalStore(
    (listener) => {
      hintListeners.add(listener);
      return () => hintListeners.delete(listener);
    },
    () => hintSlot,
  );
}

// --- the sidebar --------------------------------------------------------------------------------

let sidebarMount: HTMLElement | null = null;
const sidebarListeners = new Set<() => void>();

/** The sidebar's pane, beside the page: a ref callback, set while it is drawn. */
export function setSidebarMount(el: HTMLElement | null) {
  sidebarMount = el;
  for (const listener of sidebarListeners) {
    listener();
  }
}

export function useSidebarMount(): HTMLElement | null {
  return useSyncExternalStore(
    (listener) => {
      sidebarListeners.add(listener);
      return () => sidebarListeners.delete(listener);
    },
    () => sidebarMount,
  );
}
