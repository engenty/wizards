import type { RunTheme } from "@engenty/wizards-shared/run";
import { lookColours } from "@engenty/wizards-shared/theme";
import { useEffect } from "react";
import { usePinnedTheme, usePreferredLook, useTheme } from "../lib/theme";
import { loadWizardFont } from "./fonts";

const SANS = "ui-sans-serif, system-ui, sans-serif";
const SERIF = "ui-serif, Georgia, serif";
const SERIFS = /serif|fraunces|playfair|lora|young serif/i;

/** A family as CSS takes it, with a fallback of its kind while it loads or where it is missing. */
function stack(family: string): string {
  return `"${family.replace(/"/g, "")}", ${SERIFS.test(family) && !/sans/i.test(family) ? SERIF : SANS}`;
}

/**
 * A wizard's look on the page while it is shown: every Ember token derives from the seeds set here
 * (accent, second colour, ground, for the light or dark pages shown) and the two typefaces. A look
 * with only dark or only light pages keeps them so; one that prefers one shows it until the person
 * picks. Shape and the effects drawn by CSS are marked on the root as classes (`shape-…`, `fx-…`);
 * the other effects are `WizardEffects`. All is taken back when the page goes.
 */
export function useRunTheme(theme: Partial<RunTheme> | null | undefined) {
  usePinnedTheme(theme?.pinned ? (theme.dark ? "dark" : "light") : null);
  usePreferredLook(theme?.prefer ?? null);
  const mode = useTheme();
  const key = JSON.stringify(theme ?? {});
  useEffect(() => {
    const t = JSON.parse(key) as Partial<RunTheme>;
    const root = document.documentElement;
    loadWizardFont(t.display);
    loadWizardFont(t.body);
    const themed = Boolean(t.modes);
    const colours = lookColours(
      { accent: t.accent ?? null, background: t.background ?? null, modes: t.modes ?? null },
      themed ? mode : t.dark ? "dark" : "light",
    );
    const dark = themed ? mode === "dark" : Boolean(t.dark);
    const seeds: [string, string | null | undefined][] = [
      ["--raw-primary", colours.accent],
      ["--raw-second", t.second],
      ["--raw-background", colours.background],
      // Dark pages stand on a stage: a dark look's own ground, else a deep tone of its ground's hue.
      [
        "--brand-stage",
        colours.background
          ? dark
            ? colours.background
            : `oklch(from ${colours.background} 0.3 clamp(0.02, calc(c * 3), 0.1) h)`
          : null,
      ],
      ["--ink", colours.text],
      ["--f-display", t.display ? stack(t.display) : null],
      ["--f-ui", t.body ? stack(t.body) : null],
      // A face that comes in one weight shows in it, not in a bold the browser makes up.
      ["font-synthesis-weight", t.display || t.body ? "none" : null],
    ];
    const props = seeds.filter((p): p is [string, string] => Boolean(p[1]));
    for (const [name, value] of props) {
      root.style.setProperty(name, value);
    }
    const marks = [
      ...Object.entries(t.shape ?? {})
        .filter(([, v]) => v)
        .map(([k, v]) => `shape-${k}-${v}`),
      ...(t.effects ?? []).flatMap((e) =>
        e.id === "glow"
          ? ["fx-glow"]
          : e.id === "pattern"
            ? [`fx-pattern-${e.kind ?? "dots"}`]
            : [],
      ),
    ];
    root.classList.add(...marks);
    // A brand on a dark ground turns the pages dark, as long as no look decides.
    const wasDark = root.classList.contains("dark");
    if (!themed && t.dark && !t.pinned) {
      root.classList.add("dark");
    }
    return () => {
      for (const [name] of props) {
        root.style.removeProperty(name);
      }
      root.classList.remove(...marks);
      if (!themed && t.dark && !t.pinned && !wasDark) {
        root.classList.remove("dark");
      }
    };
  }, [key, mode]);
}
