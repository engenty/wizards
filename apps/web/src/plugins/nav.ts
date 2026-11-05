import type { Mode } from "../lib/mode";

/**
 * The app bar's plugin icons for the mode shown. An icon stands in the mode it names, Studio
 * unless it says otherwise. Where Work is off, an icon for Work stands in Studio, so its page
 * stays within reach.
 */
export function navIn<T extends { mode?: "studio" | "work" }>(
  nav: readonly T[],
  mode: Mode,
  allowed: readonly Mode[],
): T[] {
  return nav.filter((entry) => {
    const home = entry.mode ?? "studio";
    return home === mode || (home === "work" && mode === "studio" && !allowed.includes("work"));
  });
}
