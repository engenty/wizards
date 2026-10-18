import type { RunTheme } from "@engenty/wizards-shared/run";
import { safeCss } from "@engenty/wizards-shared/style";
import { useEffect } from "react";
import { usePinnedTheme } from "../lib/theme";
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
 * (accent, second colour, ground) and the two typefaces. A dark brand turns the page dark; a
 * wizard that sets dark or light keeps the page so. Effects are marked on the root as `fx-<name>`
 * classes, the wizard's own CSS goes into a style element after the app's. All is taken back when
 * the page goes.
 */
export function useRunTheme(theme: Partial<RunTheme> | null | undefined) {
  const key = JSON.stringify(theme ?? {});
  usePinnedTheme(theme?.pinned ? (theme.dark ? "dark" : "light") : null);
  useEffect(() => {
    const t = JSON.parse(key) as Partial<RunTheme>;
    const root = document.documentElement;
    loadWizardFont(t.display);
    loadWizardFont(t.body);
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
      // A face that comes in one weight shows in it, not in a bold the browser makes up.
      ["font-synthesis-weight", t.display || t.body ? "none" : null],
    ];
    const props = seeds.filter((p): p is [string, string] => Boolean(p[1]));
    for (const [name, value] of props) {
      root.style.setProperty(name, value);
    }
    const effects = (t.effects ?? []).map((e) => `fx-${e}`);
    root.classList.add(...effects);
    const wasDark = root.classList.contains("dark");
    if (t.dark && !t.pinned) {
      root.classList.add("dark");
    }
    let css: HTMLStyleElement | null = null;
    const text = safeCss(t.css);
    if (text) {
      css = document.createElement("style");
      css.dataset.wizardCss = "";
      css.textContent = text;
      document.head.append(css);
    }
    return () => {
      for (const [name] of props) {
        root.style.removeProperty(name);
      }
      root.classList.remove(...effects);
      if (t.dark && !t.pinned && !wasDark) {
        root.classList.remove("dark");
      }
      css?.remove();
    };
  }, [key]);
}
