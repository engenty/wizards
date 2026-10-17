import type { RunTheme } from "./run.js";

// --- facts ---------------------------------------------------------------------
// What a project knows about itself as label and value: an address, a VAT id, anything. Every
// step of the project's wizards can read them.

export const FACT_TYPES = [
  "text",
  "longtext",
  "number",
  "date",
  "url",
  "email",
  "phone",
  "boolean",
] as const;
export type FactType = (typeof FACT_TYPES)[number];

export interface ProjectFact {
  /** How templates name it: `{{facts.<key>}}`. Made from the label, stable afterwards. */
  key: string;
  label: string;
  value: string;
  /** Only when chosen by hand; otherwise the type is read off the value. */
  type?: FactType;
}

const DATE_RE = /^(\d{4}-\d{2}-\d{2}|\d{1,2}\.\s?\d{1,2}\.\s?\d{4})$/;
const NUMBER_RE = /^[+-]?\d{1,3}([.,\s']?\d{3})*([.,]\d+)?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const URL_RE = /^(https?:\/\/|www\.)\S+$/i;
const PHONE_RE = /^\+?[\d\s()/.-]{7,20}$/;
const BOOLEAN_RE = /^(ja|nein|yes|no|true|false)$/i;

/** The type a value looks like. A value that looks like nothing in particular is text. */
export function detectFactType(value: string): FactType {
  const v = value.trim();
  if (!v) {
    return "text";
  }
  if (v.includes("\n") || v.length > 140) {
    return "longtext";
  }
  if (BOOLEAN_RE.test(v)) {
    return "boolean";
  }
  if (EMAIL_RE.test(v)) {
    return "email";
  }
  if (URL_RE.test(v)) {
    return "url";
  }
  if (DATE_RE.test(v)) {
    return "date";
  }
  // A postcode or a count is a number; a phone number starts with + or 0 and is longer.
  if (NUMBER_RE.test(v) && !/^(\+|0\d)/.test(v)) {
    return "number";
  }
  if (PHONE_RE.test(v) && v.replace(/\D/g, "").length >= 7) {
    return "phone";
  }
  return "text";
}

export function factType(fact: Pick<ProjectFact, "value" | "type">): FactType {
  return fact.type ?? detectFactType(fact.value);
}

/** A fact's key from its label: lower case, a-z 0-9 and _, unique among `taken`. */
export function factKey(label: string, taken: string[] = []): string {
  const base =
    label
      .toLowerCase()
      .replace(/ä/g, "ae")
      .replace(/ö/g, "oe")
      .replace(/ü/g, "ue")
      .replace(/ß/g, "ss")
      .normalize("NFD")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "fakt";
  let key = base;
  for (let i = 2; taken.includes(key); i++) {
    key = `${base}_${i}`;
  }
  return key;
}

/** Facts most projects have, by key; offered as empty rows to fill in (labels: `fact.<key>`). */
export const BASIC_FACTS = [
  "adresse",
  "plz",
  "ort",
  "uid",
  "telefon",
  "e_mail",
  "website",
  "iban",
] as const;
export type BasicFact = (typeof BASIC_FACTS)[number];

// --- brand -----------------------------------------------------------------------

export interface BrandColor {
  /** What the colour is for and how to use it, in the admin's words: "Primär – Buttons und Überschriften". */
  name: string;
  /** #rrggbb */
  value: string;
  /** The `ColorSection` it belongs to; none for the standard colours. */
  section?: string;
}

export const COLOR_SECTION_KINDS = ["colors", "gradients", "patterns"] as const;
export type ColorSectionKind = (typeof COLOR_SECTION_KINDS)[number];

/**
 * Further colours of one use, as a brand guide groups them: "Illustration". Optional. A section
 * holds colours, gradients or patterns (`kind`, colours when none); each of them says itself what
 * it is for. Colours in no section are the standard ones: they come first, and the first of them
 * is the accent.
 */
export interface ColorSection {
  id: string;
  title: string;
  kind?: ColorSectionKind;
}

export const GRADIENT_TYPES = ["linear", "radial", "conic"] as const;
export type GradientType = (typeof GRADIENT_TYPES)[number];

/** A gradient of the brand, as CSS draws it: its type, its angle and its colour stops. */
export interface BrandGradient {
  id: string;
  name: string;
  /** What it is for and how to use it, as a colour's name says it. */
  description?: string;
  /** The gradients section it is in. */
  section: string;
  type: GradientType;
  /** Degrees: the direction of a linear one, where a conic one starts. */
  angle: number;
  stops: { color: string; at: number }[];
}

/** A pattern or a fill of the brand: a picture of the space (`file`), tiled or filling. */
export interface BrandPattern {
  id: string;
  name: string;
  /** What it is for and how to use it. */
  description?: string;
  /** The patterns section it is in. */
  section: string;
  /** The project file (kind `pattern`) with the picture. */
  file: string;
  /** Repeated as a tile; else it fills the area. */
  tile?: boolean;
}

/** The gradient as CSS. */
export function gradientCss(g: Pick<BrandGradient, "type" | "angle" | "stops">): string {
  const stops = [...g.stops]
    .sort((a, b) => a.at - b.at)
    .map((s) => `${s.color} ${Math.round(s.at)}%`)
    .join(", ");
  if (g.type === "radial") {
    return `radial-gradient(circle at center, ${stops})`;
  }
  if (g.type === "conic") {
    return `conic-gradient(from ${Math.round(g.angle)}deg at center, ${stops})`;
  }
  return `linear-gradient(${Math.round(g.angle)}deg, ${stops})`;
}

const SIDES: Record<string, number> = {
  top: 0,
  "top right": 45,
  right: 90,
  "bottom right": 135,
  bottom: 180,
  "bottom left": 225,
  left: 270,
  "top left": 315,
};

/**
 * A CSS gradient read back: linear, radial or conic, with hex stops. Stops without a position
 * are spread evenly. Null where it is not one of these.
 */
export function parseGradient(css: string): Pick<BrandGradient, "type" | "angle" | "stops"> | null {
  const m = css.trim().match(/^(repeating-)?(linear|radial|conic)-gradient\(\s*([\s\S]*)\)\s*;?$/i);
  if (!m) {
    return null;
  }
  const type = m[2].toLowerCase() as GradientType;
  const parts = m[3].split(/,(?![^(]*\))/).map((p) => p.trim());
  let angle = type === "linear" ? 180 : 0;
  const head = parts[0] ?? "";
  if (!/^#|^rgb|^hsl|^oklch/i.test(head)) {
    parts.shift();
    const deg = head.match(/(-?[\d.]+)deg/);
    const side = head.match(/^to\s+(.+)$/i)?.[1].toLowerCase();
    if (deg) {
      angle = Number(deg[1]);
    } else if (side && side in SIDES) {
      angle = SIDES[side];
    }
  }
  const stops = parts
    .map((p) => p.match(/^(#[0-9a-f]{3,8})\b\s*(-?[\d.]+%)?/i))
    .filter((x): x is RegExpMatchArray => Boolean(x))
    .map((x, i, all) => ({
      color: x[1].toLowerCase(),
      at: x[2] ? Number.parseFloat(x[2]) : all.length > 1 ? (i / (all.length - 1)) * 100 : 0,
    }));
  return stops.length >= 2 ? { type, angle: ((angle % 360) + 360) % 360, stops } : null;
}

/**
 * The colours as stored: the standard ones first, then each section's in the sections' order; a
 * section that is not there any more is dropped from its colours.
 */
export function orderColors(colors: BrandColor[], sections: ColorSection[]): BrandColor[] {
  const at = (c: BrandColor) => (c.section ? sections.findIndex((s) => s.id === c.section) : -1);
  return colors
    .map((c) => (c.section && at(c) < 0 ? { name: c.name, value: c.value } : c))
    .map((c, i) => ({ c, i }))
    .sort((a, b) => at(a.c) - at(b.c) || a.i - b.i)
    .map(({ c }) => c);
}

/**
 * Further logos of one use, as a brand guide groups them: "Logomark – small spaces, app icons".
 * Optional. Logos in no section are the standard ones: they come first, without a title, and
 * the first of them is the main logo.
 */
export interface LogoSection {
  id: string;
  title: string;
  /** When to use the logos in it. */
  description: string;
  /** The logo files in it, in order. A file sits in one section at most. */
  logos: string[];
}

/** The main logo: the first standard one (in no section), else the first of all. */
export function mainLogo<T extends { id: string }>(
  logos: T[],
  sections: LogoSection[] | undefined,
): T | undefined {
  const grouped = new Set(sections?.flatMap((s) => s.logos));
  return logos.find((f) => !grouped.has(f.id)) ?? logos[0];
}

/** The sign before a rule: a bullet unless chosen. */
export const RULE_MARKS = ["bullet", "do", "dont", "question", "important", "number"] as const;
export type RuleMark = (typeof RULE_MARKS)[number];

/** A rule of the brand — for its logos, colours or type — in the admin's words. */
export interface BrandRule {
  text: string;
  /** None: a bullet. */
  mark?: RuleMark;
}

/** Rules as a model reads them: the sign said in words, numbered ones counted. */
export function ruleLines(rules: BrandRule[]): string {
  let n = 0;
  return rules
    .map((r) => {
      switch (r.mark) {
        case "do":
          return `- Do: ${r.text}`;
        case "dont":
          return `- Don't: ${r.text}`;
        case "question":
          return `- To check with the person: ${r.text}`;
        case "important":
          return `- Important: ${r.text}`;
        case "number":
          n += 1;
          return `${n}. ${r.text}`;
        default:
          return `- ${r.text}`;
      }
    })
    .join("\n");
}

/** What a font's licence can allow it for, among what the wizards make. */
export const FONT_USES = ["web", "documents", "print", "images", "video"] as const;
export type FontUse = (typeof FONT_USES)[number];

/** How a model reads a use. */
export const FONT_USE_WORDS: Record<FontUse, string> = {
  web: "web pages and widgets",
  documents: "documents (PDF, Word, slides)",
  print: "print",
  images: "images and social graphics",
  video: "video",
};

/** A typeface of the brand and what it is for: "Space Grotesk – headings". */
export interface BrandFont {
  id: string;
  /** The family as CSS names it: "Space Grotesk". */
  family: string;
  /** What it is for, in the admin's words. */
  role: string;
  /** The weights the brand uses: 400, 600, … */
  weights: number[];
  /** Its licence as the admin names it: "SIL Open Font License", "Adobe Fonts". */
  license?: string;
  /**
   * All the licence allows it for; none: not said. What a step makes for another use is set in
   * a system font.
   */
  uses?: FontUse[];
}

const BACKGROUND_WORDS = /hintergrund|background|untergrund|grund|paper|papier|fläche|surface/i;
const TEXT_WORDS = /\btext|schrift|ink|typo/i;
const DISPLAY_ROLES = /head|überschrift|display|titel|title|headline/i;
const BODY_ROLES = /body|fließ|copy|lauf|text|ui|interface/i;

/** The channels of a #rrggbb colour, 0–255; null for anything else. */
function rgbOf(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  return m
    ? [Number.parseInt(m[1], 16), Number.parseInt(m[2], 16), Number.parseInt(m[3], 16)]
    : null;
}

/** How light a colour looks, 0–1 (relative luminance). */
function luminance(hex: string): number {
  const rgb = rgbOf(hex);
  if (!rgb) {
    return 1;
  }
  const [r, g, b] = rgb.map((c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** A colour with a hue of its own, not a grey, white or black. */
function colourful(hex: string): boolean {
  const rgb = rgbOf(hex);
  return rgb ? Math.max(...rgb) - Math.min(...rgb) > 40 : false;
}

/**
 * How a wizard's pages look, from the brand: the first standard colour is the accent, a standard
 * colour named as the ground ("Hintergrund") the background, the next colourful one the second
 * colour; the typeface for headings and the one for text by their roles. What the brand does not
 * say stays the runner's own.
 */
export function runTheme(brand: {
  colors?: BrandColor[];
  fonts?: Pick<BrandFont, "family" | "role">[];
}): RunTheme {
  const standard = (brand.colors ?? []).filter((c) => !c.section && rgbOf(c.value));
  const accent = standard[0]?.value ?? null;
  const background = standard.find((c) => BACKGROUND_WORDS.test(c.name))?.value ?? null;
  const second =
    standard
      .slice(1)
      .find((c) => c.value !== background && !TEXT_WORDS.test(c.name) && colourful(c.value))
      ?.value ?? null;
  const fonts = brand.fonts ?? [];
  const display = fonts.find((f) => DISPLAY_ROLES.test(f.role)) ?? fonts[0];
  const body =
    fonts.find((f) => f !== display && BODY_ROLES.test(f.role)) ?? fonts.find((f) => f !== display);
  return {
    accent,
    second,
    background,
    display: display?.family ?? null,
    body: body?.family ?? null,
    dark: background ? luminance(background) < 0.18 : false,
  };
}

/** The font's licence as a model reads it: ", licence …, may only be used for …". */
export function fontLicenseWords(f: Pick<BrandFont, "license" | "uses">): string {
  return [
    f.license ? `licence ${f.license}` : "",
    f.uses?.length ? `may only be used for ${f.uses.map((u) => FONT_USE_WORDS[u]).join(", ")}` : "",
  ]
    .filter(Boolean)
    .map((x) => `, ${x}`)
    .join("");
}

/** A text style of the type scale: "Headline XL – Space Grotesk 600, 48 px, line 90 %, −4 %". */
export interface TextStyle {
  id: string;
  name: string;
  /** The `BrandFont` it is set in; none for the first font. */
  font?: string;
  /** px */
  size: number;
  weight: number;
  /** Line height in % of the size. */
  lineHeight: number;
  /** Letter spacing in % of the size. */
  tracking: number;
  uppercase?: boolean;
}

export const FONT_WEIGHTS = [300, 400, 500, 600, 700, 800] as const;

/** A text style as a model and a person read it: "Space Grotesk 600, 48 px, line 90 %, tracking −4 %". */
export function textStyleLine(style: TextStyle, fonts: BrandFont[]): string {
  const family = (fonts.find((f) => f.id === style.font) ?? fonts[0])?.family;
  return [
    family ? `${family} ${style.weight}` : `weight ${style.weight}`,
    `${style.size} px`,
    `line ${style.lineHeight} %`,
    `tracking ${style.tracking} %`,
    style.uppercase ? "uppercase" : "",
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * Assets of one kind, shown as a tab of their own, named by its title: "Icons", "Background
 * images". Optional.
 * Assets in no section are the general ones, in the first tab.
 */
export interface AssetSection {
  id: string;
  title: string;
  /** The asset files in it, in order. A file sits in one section at most. */
  assets: string[];
}

/** Each file in its first list only; ids not known to `files` left out. */
function uniqueFiles(lists: string[][], files?: string[]): string[][] {
  const seen = new Set<string>();
  const known = files ? new Set(files) : null;
  return lists.map((ids) =>
    ids.filter((id) => {
      if (seen.has(id) || (known && !known.has(id))) {
        return false;
      }
      seen.add(id);
      return true;
    }),
  );
}

/** The sections as stored: each file in its first section only, ids not known to `files` left out. */
export function cleanLogoSections(sections: LogoSection[], files?: string[]): LogoSection[] {
  const lists = uniqueFiles(
    sections.map((s) => s.logos),
    files,
  );
  return sections.map((s, i) => ({ ...s, logos: lists[i] }));
}

export function cleanAssetSections(sections: AssetSection[], files?: string[]): AssetSection[] {
  const lists = uniqueFiles(
    sections.map((s) => s.assets),
    files,
  );
  return sections.map((s, i) => ({ ...s, assets: lists[i] }));
}

// --- files -----------------------------------------------------------------------

export const PROJECT_FILE_KINDS = ["logo", "asset", "document", "pattern"] as const;
export type ProjectFileKind = (typeof PROJECT_FILE_KINDS)[number];

/** `pending`: being read, described and indexed. */
export type ProjectFileStatus = "pending" | "ready" | "failed";

export interface ProjectFileView {
  id: string;
  kind: ProjectFileKind;
  name: string;
  mime: string;
  size: number;
  description: string;
  /** A web address the file was fetched from, when it was not uploaded. */
  source: string | null;
  status: ProjectFileStatus;
  error: string | null;
  /** Documents: what the index holds of it. `embeddings` includes the keywords. */
  indexed: "embeddings" | "keywords" | null;
  pages: number | null;
  chars: number | null;
  createdAt: string;
}

export const PROJECT_LIMITS = {
  facts: 100,
  colors: 32,
  fonts: 6,
  textStyles: 16,
  /** Sections of logos, and of colours, each. */
  logoSections: 8,
  /** Rows of logo rules. */
  logoRules: 16,
  files: { logo: 24, asset: 100, document: 2000, pattern: 24 },
  gradients: 24,
  bytes: {
    logo: 5_000_000,
    asset: 15_000_000,
    video: 80_000_000,
    document: 30_000_000,
    pattern: 10_000_000,
  },
} as const;

/** The largest file of a kind and type a project takes. */
export function projectFileLimit(kind: ProjectFileKind, mime: string): number {
  if (kind === "asset" && mime.startsWith("video/")) {
    return PROJECT_LIMITS.bytes.video;
  }
  return PROJECT_LIMITS.bytes[kind];
}
