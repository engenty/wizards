import { useCallback, useSyncExternalStore } from "react";

/**
 * Whether a media query matches, kept up to date: `useMediaQuery("(max-width: 767px)")`. Each
 * caller names its own breakpoint; `fallback` counts where there is no window to ask.
 */
export function useMediaQuery(query: string, fallback = false): boolean {
  const subscribe = useCallback(
    (listener: () => void) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", listener);
      return () => media.removeEventListener("change", listener);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => fallback,
  );
}
