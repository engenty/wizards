import { z } from "zod";
import { luminance } from "./projects.js";
import type { RunTheme } from "./run.js";

// --- a wizard's own look ----------------------------------------------------------
// What a wizard sets about how its pages look, over its space's brand: colours, typefaces, effects
// drawn around the pages, and CSS of its own.

/**
 * The typefaces a wizard can use. The runner ships them (OFL), so a run page loads no font from
 * another site.
 */
export const WIZARD_FONTS = [
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
export type WizardFont = (typeof WIZARD_FONTS)[number];

/**
 * Effects drawn around a wizard's pages: `glow` lights headings and buttons in the accent, `webs`
 * hangs spider webs in the corners, `bats` sends engenties with bat wings across, `fog` drifts
 * along the bottom.
 */
export const WIZARD_EFFECTS = ["glow", "webs", "bats", "fog"] as const;
export type WizardEffect = (typeof WIZARD_EFFECTS)[number];

/** The longest CSS a wizard may carry. */
export const MAX_WIZARD_CSS = 8000;

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "a colour as #rrggbb");

export const wizardStyleSchema = z.object({
  /** Buttons and marks. */
  accent: hex.optional(),
  /** The ground the pages stand on. */
  background: hex.optional(),
  /** Dark pages (true) or light ones (false), whatever the person's own setting; else as the background says. */
  dark: z.boolean().optional(),
  /** The typeface of headings. */
  displayFont: z.enum(WIZARD_FONTS).optional(),
  /** The typeface of text, fields and buttons. */
  bodyFont: z.enum(WIZARD_FONTS).optional(),
  effects: z.array(z.enum(WIZARD_EFFECTS)).max(WIZARD_EFFECTS.length).optional(),
  /** CSS added to the run page. It may not load anything: no url(), no @import. */
  css: z.string().max(MAX_WIZARD_CSS).optional(),
});
export type WizardStyle = z.infer<typeof wizardStyleSchema>;

// What CSS may not do on a run page: load from anywhere (url(), image-set(), @import), hide such a
// call behind an escape, or run script in old engines.
const BLOCKED = [
  { re: /url\s*\(/i, what: "url()" },
  { re: /image-set\s*\(/i, what: "image-set()" },
  { re: /@import/i, what: "@import" },
  { re: /\\/, what: "backslash escapes" },
  { re: /expression\s*\(|behavior\s*:|-moz-binding/i, what: "script in CSS" },
  { re: /<\/?\s*style/i, what: "<style> tags" },
];

/** What a wizard's CSS uses that a run page refuses, as words for an issue; empty when it is fine. */
export function cssProblems(css: string): string[] {
  return BLOCKED.filter((b) => b.re.test(css)).map((b) => b.what);
}

/** The CSS a run page applies: none at all when it uses anything refused. */
export function safeCss(css: string | null | undefined): string | null {
  const text = css?.trim();
  return text && cssProblems(text).length === 0 ? text : null;
}

/** The look of a wizard's pages: its space's brand, with what the wizard sets on top. */
export function wizardTheme(base: RunTheme, style: WizardStyle | undefined): RunTheme {
  if (!style) {
    return base;
  }
  const background = style.background ?? base.background;
  return {
    ...base,
    accent: style.accent ?? base.accent,
    background,
    display: style.displayFont ?? base.display,
    body: style.bodyFont ?? base.body,
    dark: style.dark ?? (style.background ? luminance(style.background) < 0.18 : base.dark),
    pinned: style.dark !== undefined,
    effects: [...new Set(style.effects ?? [])],
    css: safeCss(style.css),
  };
}
