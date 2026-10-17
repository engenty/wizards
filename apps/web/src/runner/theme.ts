import type { RunTheme } from "@engenty-wizards/shared/run";
import { useEffect } from "react";

const SANS = "ui-sans-serif, system-ui, sans-serif";
const SERIF = "ui-serif, Georgia, serif";

/** A family as CSS takes it, with a fallback of its kind while it loads or where it is missing. */
function stack(family: string): string {
  return `"${family.replace(/"/g, "")}", ${/serif/i.test(family) && !/sans/i.test(family) ? SERIF : SANS}`;
}

/**
 * A wizard's look on the page while it is shown: every Ember token derives from the seeds set here
 * (accent, second colour, ground) and the two typefaces. A dark brand turns the page dark. All is
 * taken back when the page goes.
 */
export function useRunTheme(theme: Partial<RunTheme> | null | undefined) {
  const key = JSON.stringify(theme ?? {});
  useEffect(() => {
    const t = JSON.parse(key) as Partial<RunTheme>;
    const root = document.documentElement;
    const seeds: [string, string | null | undefined][] = [
      ["--raw-primary", t.accent],
      ["--raw-second", t.second],
      ["--raw-background", t.background],
      // Dark pages stand on a stage: a dark brand's own ground, else a deep tone of its ground's hue.
      [
        "--brand-stage",
        t.background
          ? t.dark
            ? t.background
            : `oklch(from ${t.background} 0.3 clamp(0.02, calc(c * 3), 0.1) h)`
          : null,
      ],
      ["--f-display", t.display ? stack(t.display) : null],
      ["--f-ui", t.body ? stack(t.body) : null],
    ];
    const props = seeds.filter((p): p is [string, string] => Boolean(p[1]));
    for (const [name, value] of props) {
      root.style.setProperty(name, value);
    }
    const wasDark = root.classList.contains("dark");
    if (t.dark) {
      root.classList.add("dark");
    }
    return () => {
      for (const [name] of props) {
        root.style.removeProperty(name);
      }
      if (t.dark && !wasDark) {
        root.classList.remove("dark");
      }
    };
  }, [key]);
}
