import { loadBrandFace } from "@engenty/wizards-runner";
import type { RunTheme } from "@engenty/wizards-shared/run";
import {
  fontStack,
  lookColours,
  shippedFontStylesheet,
  shippedLike,
} from "@engenty/wizards-shared/theme-look";

/**
 * The firm's brand on the portal: its colours and fonts as CSS variables of the page
 * (`--brand-*`, portal.css draws everything from them), and as the runner's `--wizard-*`
 * variables on the element that holds a run, as a wizard's own page shows it.
 */

/**
 * A theme as a page gets it: the runtime gives a run's whole theme, the Manage-App's public page
 * data only its colours and typefaces.
 */
export type Look = Pick<RunTheme, "accent" | "background" | "display" | "body" | "dark"> &
  Partial<Pick<RunTheme, "faces" | "modes">>;

const sheets = new Set<string>();

function loadShipped(family: string | null) {
  const sheet = family ? shippedFontStylesheet(family) : null;
  if (!sheet || sheets.has(sheet)) {
    return;
  }
  sheets.add(sheet);
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `/portal${sheet}`;
  document.head.append(link);
}

/** Loads the theme's fonts: the brand's from their source, the shipped ones through the portal. */
function loadFonts(look: Look) {
  for (const face of look.faces ?? []) {
    const url = face.url.startsWith("/") ? `/portal${face.url}` : face.url;
    loadBrandFace(face, url, () => loadShipped(shippedLike(face.family)));
  }
  loadShipped(look.display);
  loadShipped(look.body);
}

/** The page wears the brand; null puts back the engenty look. */
export function wearBrand(look: Look | null, accent?: string | null) {
  const root = document.documentElement.style;
  for (const name of [
    "--brand-accent",
    "--brand-ground",
    "--brand-text",
    "--brand-display",
    "--brand-body",
  ]) {
    root.removeProperty(name);
  }
  if (!look) {
    return;
  }
  loadFonts(look);
  const colours = lookColours({ ...look, modes: look.modes ?? null }, look.dark ? "dark" : "light");
  const set = (name: string, value: string | null | undefined) => {
    if (value) {
      root.setProperty(name, value);
    }
  };
  set("--brand-accent", colours.accent ?? accent);
  set("--brand-ground", colours.background);
  set("--brand-text", colours.text);
  set("--brand-display", look.display ? fontStack(look.display, look.faces ?? []) : null);
  set("--brand-body", look.body ? fontStack(look.body, look.faces ?? []) : null);
  document.documentElement.dataset.dark = look.dark ? "1" : "";
}

/** What goes on the element with `.engenty-runner`: the theme as the runner reads it. */
export function runnerLook(look: Look | null): { style: Record<string, string> } {
  if (!look) {
    return { style: {} };
  }
  const colours = lookColours({ ...look, modes: look.modes ?? null }, look.dark ? "dark" : "light");
  const style: Record<string, string> = {};
  const set = (name: string, value: string | null | undefined) => {
    if (value) {
      style[name] = value;
    }
  };
  set("--wizard-accent", colours.accent);
  set("--wizard-background", colours.background);
  set("--wizard-text", colours.text);
  set("--wizard-font-heading", look.display ? fontStack(look.display, look.faces ?? []) : null);
  set("--wizard-font-text", look.body ? fontStack(look.body, look.faces ?? []) : null);
  return { style };
}
