import { LayoutGrid, List } from "lucide-react";
import { useSyncExternalStore } from "react";
import { t } from "../../lib/i18n";
import { cn } from "../../ui";

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

/** Cards and the list side by side, as two small icons; the one shown stands out. */
export function ItemViewSwitch() {
  const view = useItemView();
  const option = (id: ItemView, Icon: typeof List, label: string) => (
    <button
      type="button"
      aria-pressed={view === id}
      aria-label={label}
      title={label}
      onClick={() => setItemView(id)}
      className={cn(
        "grid size-6 place-items-center rounded-md transition",
        view === id ? "bg-card text-ink shadow-soft" : "text-ink-4 hover:text-ink",
      )}
    >
      <Icon className="size-3.5" />
    </button>
  );
  return (
    <div className="inline-flex items-center gap-0.5 rounded-lg bg-paper-2 p-0.5">
      {option("cards", LayoutGrid, t("know.asCards"))}
      {option("list", List, t("know.asList"))}
    </div>
  );
}
