import { LayoutGrid, List } from "lucide-react";
import { useSyncExternalStore } from "react";
import { t } from "../../lib/i18n";
import { IconButton } from "../../ui";

/**
 * How Wissen shows a set of items: as cards with the start of their text, or as a list. One
 * choice for every set, kept in this browser.
 */
export type ItemView = "cards" | "list";

const KEY = "wissen.itemView";
const listeners = new Set<() => void>();

function stored(): ItemView {
  try {
    return localStorage.getItem(KEY) === "list" ? "list" : "cards";
  } catch {
    return "cards";
  }
}

let current: ItemView = stored();

function setItemView(next: ItemView) {
  current = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {}
  for (const listener of listeners) {
    listener();
  }
}

export function useItemView(): ItemView {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}

/** One icon that switches between cards and the list; it shows what a press turns to. */
export function ItemViewSwitch() {
  const view = useItemView();
  const next: ItemView = view === "cards" ? "list" : "cards";
  const Icon = next === "list" ? List : LayoutGrid;
  return (
    <IconButton
      label={next === "list" ? t("know.asList") : t("know.asCards")}
      className="size-8 text-ink-3 hover:text-ink"
      onClick={() => setItemView(next)}
    >
      <Icon className="size-4" />
    </IconButton>
  );
}
