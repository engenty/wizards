import { useEffect, useSyncExternalStore } from "react";
import { useMediaQuery } from "../lib/media";

// The space sidebar's state, apart from the frame that draws it: a plugin page reaches it
// through `MenuPage` without pulling the studio along.

const SPACE_SIDEBAR_KEY = "wizards.spaceSidebar";
const spaceSidebarListeners = new Set<() => void>();

function spaceSidebarOpen(): boolean {
  try {
    return localStorage.getItem(SPACE_SIDEBAR_KEY) === "1";
  } catch {
    return false;
  }
}

export function setSpaceSidebar(open: boolean) {
  try {
    localStorage.setItem(SPACE_SIDEBAR_KEY, open ? "1" : "0");
  } catch {
    // the choice only lasts until the page is left
  }
  for (const listener of spaceSidebarListeners) {
    listener();
  }
}

/** Whether the space's sidebar stands beside the page: kept per browser. */
export function useSpaceSidebarPick(): boolean {
  return useSyncExternalStore(
    (listener) => {
      spaceSidebarListeners.add(listener);
      return () => spaceSidebarListeners.delete(listener);
    },
    spaceSidebarOpen,
    () => false,
  );
}

/** Whether the sidebar stands beside the page: picked, and not in an area. */
export function useSpaceSidebar(): boolean {
  return useSpaceSidebarPick();
}

/** Wide enough for the sidebar beside the page (`lg`): below it, it stays closed. */
function useWide(): boolean {
  return useMediaQuery("(min-width: 1024px)", true);
}

/** Whether the sidebar is there to see: picked, and the window wide enough. */
export function useSpaceSidebarShown(): boolean {
  const picked = useSpaceSidebarPick();
  const wide = useWide();
  return picked && wide;
}

// In an area of the space page the sidebar holds the area's own menu: the page draws it into
// this slot, so one menu stands at the left, whichever page is open.
let areaSlot: HTMLElement | null = null;
const areaSlotListeners = new Set<() => void>();

export function setAreaSlot(el: HTMLElement | null) {
  if (areaSlot !== el) {
    areaSlot = el;
    for (const listener of areaSlotListeners) {
      listener();
    }
  }
}

// The pages with a menu of their own that stand now: while one does, the sidebar holds its menu.
let sideMenus = 0;
const sideMenuListeners = new Set<() => void>();

export function useHasSideMenu(): boolean {
  return useSyncExternalStore(
    (listener) => {
      sideMenuListeners.add(listener);
      return () => sideMenuListeners.delete(listener);
    },
    () => sideMenus > 0,
    () => false,
  );
}

/**
 * For a page with a menu of its own (the space's areas, the settings, a plugin's page): where to
 * draw that menu – the sidebar's slot while the sidebar is open, else `null`, and the page draws
 * it at its own left as before. One menu stands at the left, never two.
 */
export function useSideMenuSlot(): HTMLElement | null {
  useEffect(() => {
    sideMenus += 1;
    for (const listener of sideMenuListeners) {
      listener();
    }
    return () => {
      sideMenus -= 1;
      for (const listener of sideMenuListeners) {
        listener();
      }
    };
  }, []);
  const slot = useAreaSlot();
  const shown = useSpaceSidebarShown();
  return shown ? slot : null;
}

/** Where an area's menu goes while the sidebar is open; `null` while there is none. */
export function useAreaSlot(): HTMLElement | null {
  return useSyncExternalStore(
    (listener) => {
      areaSlotListeners.add(listener);
      return () => areaSlotListeners.delete(listener);
    },
    () => areaSlot,
    () => null,
  );
}
