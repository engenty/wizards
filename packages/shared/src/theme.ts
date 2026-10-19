import { z } from "zod";
import { ENGENTY_COSTUMES, THEME_ID } from "./definition.js";
import { luminance } from "./projects.js";
import type { RunFontFace, RunTheme } from "./run.js";

// --- themes ------------------------------------------------------------------------
// How a wizard's pages look, as a document of its own: values only (colours for light and dark,
// fonts, shape, effects from the runner's library), kept in the space and shipped in a wizard
// file. No CSS, no files, no addresses: a theme is data a schema checks completely, and every
// place a wizard runs draws as much of it as it can. docs/plans/themes.md

/** The themes every space has. Nobody defines or publishes them. */
export const BUILT_IN_THEMES = ["brand", "host", "default"] as const;
export type BuiltInTheme = (typeof BUILT_IN_THEMES)[number];

/** Ids no theme of a space may take, and scopes only engenty wizards publishes under. */
export const RESERVED_THEME_IDS: readonly string[] = [
  ...BUILT_IN_THEMES,
  "engenty",
  "wizard",
  "wizards",
];
export const RESERVED_THEME_SCOPES: readonly string[] = ["@wizards", "@engenty", "@wizard"];

export { THEME_ID };

/** A wizard names at most this many themes; a space keeps at most this many. */
export const MAX_WIZARD_THEMES = 8;
export const MAX_SPACE_THEMES = 40;

/**
 * The fonts the runner ships (OFL): a run page loads them from its own address. A theme names
 * one of them by family, or the space's brand by role (`"brand"`).
 */
export const SHIPPED_FONTS = [
  "Inter",
  "Figtree",
  "DM Sans",
  "Nunito",
  "Fredoka",
  "Bricolage Grotesque",
  "Fraunces",
  "Playfair Display",
  "Lora",
  "Young Serif",
  "Caveat",
  "Creepster",
  "Nosifer",
] as const;
export type ShippedFont = (typeof SHIPPED_FONTS)[number];

/**
 * The runner's effects and their options. Names stay open in the schema: a theme that names an
 * effect this runner does not know is drawn without it.
 */
export const THEME_EFFECTS = {
  glow: {},
  corners: { kind: ["webs", "frost"] },
  particles: { kind: ["embers", "snow", "confetti", "stars"] },
  figures: { costume: ENGENTY_COSTUMES, motion: ["fly", "peek"] },
  fog: {},
  pattern: { kind: ["dots", "grid"] },
} as const satisfies Record<string, Record<string, readonly string[]>>;
export type ThemeEffectId = keyof typeof THEME_EFFECTS;

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "a colour as #rrggbb");

export const themeColoursSchema = z.object({
  /** Buttons and marks. */
  accent: hex.optional(),
  /** The ground the pages stand on. */
  background: hex.optional(),
  /** Text. Left out: taken from the ground. */
  text: hex.optional(),
});
export type ThemeColours = z.infer<typeof themeColoursSchema>;

export const COLOR_SCHEMES = ["light", "dark"] as const;
export type ColorScheme = (typeof COLOR_SCHEMES)[number];

/** The colours of light or of dark pages (`scheme`, as CSS's `color-scheme` names them). */
export const themeColorsSchema = themeColoursSchema.extend({ scheme: z.enum(COLOR_SCHEMES) });
export type ThemeColors = z.infer<typeof themeColorsSchema>;

export const themeShapeSchema = z.object({
  radius: z.enum(["sharp", "soft", "round"]).optional(),
  cards: z.enum(["solid", "outline", "glass"]).optional(),
  headings: z.enum(["normal", "uppercase"]).optional(),
});
export type ThemeShape = z.infer<typeof themeShapeSchema>;

export const themeEffectSchema = z
  .object({ id: z.string().min(1).max(40) })
  .catchall(z.union([z.string().max(40), z.number(), z.boolean()]));
export type ThemeEffect = z.infer<typeof themeEffectSchema>;

/** A shipped family by name, or `brand`: never an address. */
const fontName = z
  .string()
  .min(1)
  .max(60)
  .regex(/^[A-Za-z0-9 -]+$/, "a font by its family name, or brand");

export const themeSchema = z.object({
  id: z.string().regex(THEME_ID, "a theme id: lowercase letters, digits and dashes"),
  name: z.string().min(1).max(80),
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/)
    .default("1.0.0"),
  /** What the theme builds on: what it leaves out comes from there. */
  base: z.enum(BUILT_IN_THEMES).default("brand"),
  /**
   * The colours of light and of dark pages, in order: the first shows until the person picks.
   * One entry: the pages are always that.
   */
  colors: z
    .array(themeColorsSchema)
    .min(1)
    .max(2)
    .refine((list) => new Set(list.map((c) => c.scheme)).size === list.length, {
      message: "Each scheme once: light, dark.",
    })
    .optional(),
  fonts: z
    .object({
      heading: fontName.optional(),
      text: fontName.optional(),
    })
    .optional(),
  shape: themeShapeSchema.optional(),
  effects: z.array(themeEffectSchema).max(8).optional(),
});
export type Theme = z.infer<typeof themeSchema>;

/** Why an id cannot be a theme of a space; null when it can. */
export function themeIdProblem(id: string): string | null {
  if (!THEME_ID.test(id)) {
    return `"${id}" is no theme id: lowercase letters, digits and dashes, optionally after @owner/.`;
  }
  const scope = id.startsWith("@") ? id.slice(0, id.indexOf("/")) : null;
  if (scope && RESERVED_THEME_SCOPES.includes(scope) && scope !== "@wizards") {
    return `The scope ${scope} is reserved.`;
  }
  if (!scope && RESERVED_THEME_IDS.includes(id)) {
    return `"${id}" is reserved for engenty wizards.`;
  }
  return null;
}

/** A theme's content as one string: the same content gives the same key, whatever the order of keys. */
export function themeContentKey(theme: Theme): string {
  const sorted = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sorted)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .filter(([, x]) => x !== undefined)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, sorted(x)]),
          )
        : v;
  const { id: _, ...content } = theme;
  return JSON.stringify(sorted(content));
}

/** An id like `id` that `taken` does not hold yet: `halloween`, `halloween-2`, … */
export function freeThemeId(id: string, taken: ReadonlySet<string>): string {
  if (!taken.has(id)) {
    return id;
  }
  for (let n = 2; ; n++) {
    const next = `${id.slice(0, 44)}-${n}`;
    if (!taken.has(next)) {
      return next;
    }
  }
}

/** A theme id from a wizard's title: "Spukhaus-Exposé" → `spukhaus-expose`. */
export function themeIdFrom(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug && !RESERVED_THEME_IDS.includes(slug) ? slug : "look";
}

/**
 * Whether the place that shows a wizard may pick `asked`: a built-in name, or a theme of the
 * wizard's own chain. The host always wins, but only among what the wizard offers.
 */
export function themeOffered(asked: string, chain: readonly string[] | undefined): boolean {
  return (BUILT_IN_THEMES as readonly string[]).includes(asked) || Boolean(chain?.includes(asked));
}

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

/** A theme's colours for light or dark pages, without the scheme's name; undefined: it has none. */
export function themeColors(
  theme: Pick<Theme, "colors"> | undefined,
  scheme: ColorScheme,
): ThemeColours | undefined {
  const found = theme?.colors?.find((c) => c.scheme === scheme);
  if (!found) {
    return undefined;
  }
  const { scheme: _, ...colours } = found;
  return colours;
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
