import { type ComponentType, useEffect, useRef, useSyncExternalStore } from "react";

/**
 * The page's own main action, for a phone's bar: its round button beside the tabs does what the
 * page in front names here (a new table on Data, the search on Results), else it makes a new
 * wizard. The latest page to name one wins; leaving it gives the button back.
 */
export interface PrimaryAction {
  icon: ComponentType<{ className?: string }>;
  label: string;
  run: () => void;
}

let stack: { id: number; action: PrimaryAction }[] = [];
let serial = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

/** Names the page's main action while it is shown; `null` names none. */
export function usePrimaryAction(action: PrimaryAction | null) {
  // The latest action runs, without naming it anew on every render.
  const latest = useRef(action);
  latest.current = action;
  const shown = action !== null;
  const icon = action?.icon;
  const label = action?.label;
  useEffect(() => {
    if (!shown || !icon || label === undefined) {
      return;
    }
    const id = ++serial;
    stack = [...stack, { id, action: { icon, label, run: () => latest.current?.run() } }];
    emit();
    return () => {
      stack = stack.filter((entry) => entry.id !== id);
      emit();
    };
  }, [shown, icon, label]);
}

/** The action the page in front named, or `null`. */
export function useCurrentPrimaryAction(): PrimaryAction | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => stack.at(-1)?.action ?? null,
    () => null,
  );
}
