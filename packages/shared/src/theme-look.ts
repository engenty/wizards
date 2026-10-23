import { luminance } from "./projects.js";
import type { RunFontFace, RunTheme } from "./run.js";
import {
  BUILT_IN_THEMES,
  type BuiltInTheme,
  SHIPPED_FONTS,
  type ShippedFont,
  type Theme,
  themeColors,
  themeOffered,
} from "./theme.js";

// --- the look of a run ---------------------------------------------------------------------
// Which theme a wizard's pages show and how they look with it: the theme over the space's
// brand, font stacks, and the colours of light and dark pages. The theme's values: theme.ts.

/**
 * The theme a wizard's pages show: what the place showing it asks for (`asked`, an embed's
 * `data-theme`), where the wizard offers it and the space has it; else the first of its chain
 * the space has (a built-in name counts). Undefined: none of them, so the brand.
 */
export function chosenTheme(
  chain: readonly string[] | undefined,
  themes: readonly Theme[],
  asked?: string | null,
): Theme | BuiltInTheme | undefined {
  const ask = asked && themeOffered(asked, chain) ? [asked] : [];
  for (const id of [...ask, ...(chain ?? [])]) {
    if ((BUILT_IN_THEMES as readonly string[]).includes(id)) {
      return id as BuiltInTheme;
    }
    const found = themes.find((t) => t.id === id);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/** The engenty wizards look without a brand: what `default` shows and builds on. */
const NEUTRAL: RunTheme = {
  accent: null,
  second: null,
  background: null,
  display: null,
  body: null,
  faces: [],
  dark: false,
  pinned: false,
  modes: null,
  prefer: null,
  shape: null,
  effects: [],
};

/**
 * The look of a wizard's pages: the space's brand (`runTheme`), or the theme the wizard chose
 * built on its base. `host` is drawn as the brand on pages of our own; a host that passes a
 * look of its own puts it over this. The base's colours stay in `accent` and `background`; the
 * theme's colours for light and dark pages go into `modes`, and the page takes those of what it
 * shows.
 */
export function themedLook(brand: RunTheme, theme: Theme | BuiltInTheme | undefined): RunTheme {
  if (theme === undefined || theme === "brand" || theme === "host") {
    return brand;
  }
  if (theme === "default") {
    return NEUTRAL;
  }
  const base = theme.base === "default" ? NEUTRAL : brand;
  // `brand` is the brand's font for the role, whatever the theme builds on.
  const font = (name: string | undefined, role: "display" | "body") =>
    name === "brand" ? brand[role] : (name ?? base[role]);
  const display = font(theme.fonts?.heading, "display");
  const body = font(theme.fonts?.text, "body");
  const schemes = (theme.colors ?? []).map((c) => c.scheme);
  const only = schemes.length === 1 ? schemes[0] : null;
  const shown = schemes[0] ?? (base.dark ? "dark" : "light");
  const background = themeColors(theme, shown)?.background;
  return {
    ...base,
    display,
    body,
    faces: brand.faces.filter((f) => f.family === display || f.family === body),
    dark: background ? luminance(background) < 0.18 : shown === "dark",
    pinned: only !== null,
    modes: schemes.length
      ? { light: themeColors(theme, "light") ?? null, dark: themeColors(theme, "dark") ?? null }
      : null,
    prefer: schemes.length === 2 ? shown : null,
    shape: theme.shape ?? null,
    effects: theme.effects ?? [],
  };
}

const SANS = "ui-sans-serif, system-ui, sans-serif";
const SERIF = "ui-serif, Georgia, serif";
const SERIFS =
  /serif|fraunces|playfair|lora|garamond|antiqua|baskerville|caslon|bodoni|didot|times|georgia|merriweather|tiempos/i;

/** A family looks like a serif by its name: what takes its place is a serif too. */
export const serifFamily = (family: string) => SERIFS.test(family) && !/sans/i.test(family);

/** The shipped font that shows where a brand font does not load: one of its kind. */
export const shippedLike = (family: string): ShippedFont =>
  serifFamily(family) ? "Lora" : "Inter";

/** A shipped font's name in its package and its files: "Bricolage Grotesque" → bricolage-grotesque. */
export const shippedFontSlug = (family: ShippedFont) => family.toLowerCase().replace(/ /g, "-");

/**
 * Where the runtime serves a shipped font's stylesheet, for pages that are not its own (a host's
 * OpenUI chat); null for a family that is not one of ours. Its files sit next to it.
 */
export function shippedFontStylesheet(family: string): string | null {
  return (SHIPPED_FONTS as readonly string[]).includes(family)
    ? `/api/public/fonts/shipped/${shippedFontSlug(family as ShippedFont)}.css`
    : null;
}

/**
 * A family as CSS takes it, with a fallback of its kind while it loads or where it is missing. A
 * brand font with a source (`faces`) names the shipped font of its kind next: it shows if the
 * brand font does not load.
 */
export function fontStack(family: string, faces: readonly RunFontFace[] = []): string {
  const next = faces.some((f) => f.family === family) ? `"${shippedLike(family)}", ` : "";
  return `"${family.replace(/"/g, "")}", ${next}${serifFamily(family) ? SERIF : SANS}`;
}

/** The colours a page shows in light or dark: the theme's for that mode, else the base's. */
export function lookColours(
  look: Pick<RunTheme, "accent" | "background" | "modes">,
  mode: "light" | "dark",
): { accent: string | null; background: string | null; text: string | null } {
  const own = look.modes?.[mode];
  return {
    accent: own?.accent ?? look.accent,
    background: own?.background ?? look.background,
    text: own?.text ?? null,
  };
}
