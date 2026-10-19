import type { RunTheme } from "@engenty/wizards-shared/run";
import { fontStack, lookColours } from "@engenty/wizards-shared/theme";
import { type CSSProperties, useEffect } from "react";
import { usePinnedTheme, usePreferredLook, useTheme } from "../lib/theme";
import { loadBrandFace, loadWizardFont } from "./fonts";

/**
 * A look as what goes on an element: the seeds every Ember token derives from (accent, second
 * colour, ground, for the light or dark pages shown) and the two typefaces as CSS variables, shape
 * and the effects drawn by CSS as classes (`shape-…`, `fx-…`), and whether the pages are dark.
 */
export function lookSeeds(t: Partial<RunTheme>, mode: "light" | "dark") {
  const faces = t.faces ?? [];
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
    ["--f-display", t.display ? fontStack(t.display, faces) : null],
    ["--f-ui", t.body ? fontStack(t.body, faces) : null],
    // A face that comes in one weight shows in it, not in a bold the browser makes up.
    ["font-synthesis-weight", t.display || t.body ? "none" : null],
  ];
  const marks = [
    ...Object.entries(t.shape ?? {})
      .filter(([, v]) => v)
      .map(([k, v]) => `shape-${k}-${v}`),
    ...(t.effects ?? []).flatMap((e) =>
      e.id === "glow" ? ["fx-glow"] : e.id === "pattern" ? [`fx-pattern-${e.kind ?? "dots"}`] : [],
    ),
  ];
  return {
    props: seeds.filter((p): p is [string, string] => Boolean(p[1])),
    marks,
    dark,
    themed,
  };
}

/** Whether a look has light and dark pages, so the person may pick between them. */
export function bothModes(t: Partial<RunTheme> | null | undefined): boolean {
  return Boolean(t && !t.pinned && t.modes?.light && t.modes.dark);
}

/** Loads the fonts a look names: shipped ones by family, the brand's from their source. */
function loadFonts(t: Partial<RunTheme>) {
  for (const face of t.faces ?? []) {
    loadBrandFace(face);
  }
  loadWizardFont(t.display);
  loadWizardFont(t.body);
}

/**
 * A wizard's look on the page while it is shown, on the root: every token of the page derives
 * from it. A look with only dark or only light pages keeps them so; one that prefers one shows it
 * until the person picks. The effects drawn as elements are `WizardEffects`. All is taken back
 * when the page goes.
 */
export function useRunTheme(theme: Partial<RunTheme> | null | undefined) {
  usePinnedTheme(theme?.pinned ? (theme.dark ? "dark" : "light") : null);
  usePreferredLook(theme?.prefer ?? null);
  const mode = useTheme();
  const key = JSON.stringify(theme ?? {});
  useEffect(() => {
    const t = JSON.parse(key) as Partial<RunTheme>;
    const root = document.documentElement;
    loadFonts(t);
    const { props, marks, themed } = lookSeeds(t, mode);
    for (const [name, value] of props) {
      root.style.setProperty(name, value);
    }
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

/**
 * A wizard's look on one element of a page that has its own (the studio's test run): the element
 * takes the seeds and marks, `.wizard-themed` derives every token again from them inside it, and
 * nothing outside changes. It shows the pages the look shows first, or `picked` where the look
 * has both light and dark ones.
 */
export function useScopedLook(
  theme: Partial<RunTheme> | null | undefined,
  picked?: "light" | "dark" | null,
) {
  const key = JSON.stringify(theme ?? {});
  useEffect(() => {
    loadFonts(JSON.parse(key) as Partial<RunTheme>);
  }, [key]);
  if (!theme) {
    return null;
  }
  const first = theme.pinned || !theme.prefer ? (theme.dark ? "dark" : "light") : theme.prefer;
  const mode = picked && bothModes(theme) ? picked : first;
  const { props, marks, dark } = lookSeeds(theme, mode);
  return {
    className: ["wizard-themed", ...marks, dark ? "dark" : ""].filter(Boolean).join(" "),
    style: Object.fromEntries(props) as CSSProperties,
  };
}
