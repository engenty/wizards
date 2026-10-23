import { useMemo, useSyncExternalStore } from "react";
import { useMediaQuery } from "./media";

/**
 * Where the app bar stands and whether it names its places, as in engenty-pro: picked in the
 * bar's own context menu, kept per browser like the theme and the language.
 */

export const APP_BAR_POSITIONS = ["left", "top", "right", "bottom"] as const;
export type AppBarPosition = (typeof APP_BAR_POSITIONS)[number];

export interface AppBarPrefs {
  position: AppBarPosition;
  /** The places with their names beside the glyphs, where the bar stands at a side with room. */
  labels: boolean;
}

const KEY = "wizards.appbar";
const DEFAULT: AppBarPrefs = { position: "left", labels: true };

/** From this window width a bar at a side has room for its places' names. */
export const APP_BAR_LABELS_QUERY = "(min-width: 1400px)";

const isPosition = (value: unknown): value is AppBarPosition =>
  APP_BAR_POSITIONS.includes(value as AppBarPosition);

function read(): AppBarPrefs {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<AppBarPrefs> | null;
    return {
      position: isPosition(stored?.position) ? stored.position : DEFAULT.position,
      labels: typeof stored?.labels === "boolean" ? stored.labels : DEFAULT.labels,
    };
  } catch {
    return DEFAULT;
  }
}

let prefs = read();
const listeners = new Set<() => void>();

export function setAppBar(patch: Partial<AppBarPrefs>) {
  prefs = { ...prefs, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // the pick only lasts this page then
  }
  for (const listener of listeners) {
    listener();
  }
}

function usePhone(): boolean {
  return useMediaQuery("(max-width: 767px)");
}

/** The bar as this screen shows it. A phone has it along the bottom, whatever was picked. */
export function useAppBar(): AppBarPrefs & { phone: boolean } {
  const stored = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => prefs,
  );
  const phone = usePhone();
  return useMemo(
    () => (phone ? { ...stored, position: "bottom" as const, phone } : { ...stored, phone }),
    [stored, phone],
  );
}

export const isHorizontal = (position: AppBarPosition): boolean =>
  position === "top" || position === "bottom";

/**
 * Whether the bar names its places now: asked for, at a side, on a window with room, and with no
 * other sidebar beside the page (`crowded`: the assistant's, or the editor's panels). The pick
 * stays when the bar folds: it names them again once the room is back.
 */
export function useAppBarLabels(crowded: boolean): { shown: boolean; room: boolean } {
  const { position, labels } = useAppBar();
  const wide = useMediaQuery(APP_BAR_LABELS_QUERY);
  const room = wide && !isHorizontal(position) && !crowded;
  return { shown: labels && room, room };
}

/**
 * Where a menu of the bar opens: away from the bar's edge, toward the page. `anchor`: at the
 * bar's start (the space's tile) or its end (the person).
 */
export function besideBar(position: AppBarPosition, anchor: "start" | "end"): string {
  switch (position) {
    case "left":
      return anchor === "start" ? "top-0 left-full ml-3" : "bottom-0 left-full ml-3";
    case "right":
      return anchor === "start" ? "top-0 right-full mr-3" : "bottom-0 right-full mr-3";
    case "top":
      return anchor === "start" ? "top-full left-0 mt-3" : "top-full right-0 mt-3";
    case "bottom":
      return anchor === "start" ? "bottom-full left-0 mb-3" : "bottom-full right-0 mb-3";
  }
}
