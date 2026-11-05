import type { RunTheme } from "./data.js";

/**
 * How a page looks: the run page's theme where the space has a brand (the band in the accent,
 * the brand's fonts), else the engenty look (the gallery's blue on paper, Space Grotesk and
 * Geist). Everything the stylesheet uses is a custom property on the page's root.
 */

const ENGENTY = {
  band: "oklch(50% 0.2 262)",
  bandInk: "oklch(32% 0.15 262)",
  ground: "#faf8f5",
  display: "Space Grotesk",
  body: "Geist",
  second: "oklch(80% 0.14 80)",
};

function rgb(hex: string): [number, number, number] | null {
  const m = hex.trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) {
    return null;
  }
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance(hex: string): number {
  const c = rgb(hex);
  if (!c) {
    return 0.2;
  }
  const lin = c.map((v) => {
    const s = v / 255;
    return s <= 0.039_28 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/** Text on a colour: white where it reads, else near-black. */
const inkOn = (colour: string) => (luminance(colour) > 0.36 ? "#14110f" : "#ffffff");

export interface Look {
  /** CSS custom properties for the page's root. */
  vars: string;
  /** The Google Fonts stylesheet for the page's typefaces. */
  fontsHref: string;
  /** Whether the space has a brand of its own. */
  branded: boolean;
}

const family = (name: string) =>
  `family=${encodeURIComponent(name).replace(/%20/g, "+")}:wght@400;500;600;700`;

export function lookOf(theme: RunTheme | null): Look {
  const branded = Boolean(theme?.accent);
  const dark = Boolean(theme?.dark);
  const band = theme?.accent ?? ENGENTY.band;
  const onBand = theme?.accent ? inkOn(theme.accent) : "#ffffff";
  const ground = theme?.background ?? (dark ? "#141a24" : ENGENTY.ground);
  const ink = dark ? "#eef1f6" : "#1d1a17";
  const display = theme?.display ?? ENGENTY.display;
  const body = theme?.body ?? (theme?.display ? theme.display : ENGENTY.body);
  const second = theme?.second ?? (branded ? band : ENGENTY.second);
  const props: Record<string, string> = {
    "--band": band,
    "--on-band": onBand,
    "--band-ink": theme?.accent ? theme.accent : ENGENTY.bandInk,
    "--ground": ground,
    "--ink": ink,
    "--ink-2": dark ? "rgba(238,241,246,.82)" : "rgba(29,26,23,.82)",
    "--muted": dark ? "rgba(238,241,246,.62)" : "rgba(29,26,23,.62)",
    "--line": dark ? "rgba(238,241,246,.14)" : "rgba(29,26,23,.12)",
    "--card": dark ? "rgba(255,255,255,.07)" : "#ffffff",
    "--side": dark ? "rgba(255,255,255,.06)" : `color-mix(in oklab, ${band} 10%, #ffffff)`,
    "--accent": band,
    "--on-accent": onBand,
    "--second": second,
    "--on-second": inkOn(second.startsWith("#") ? second : "#888888"),
    "--f-display": `'${display}', 'Space Grotesk', system-ui, sans-serif`,
    "--f-body": `'${body}', 'Geist', system-ui, sans-serif`,
  };
  const families = [...new Set([display, body])].map(family).join("&");
  return {
    vars: Object.entries(props)
      .map(([k, v]) => `${k}:${v}`)
      .join(";"),
    fontsHref: `https://fonts.googleapis.com/css2?${families}&display=swap`,
    branded,
  };
}

/** The kind chips' colours: what a result is, told apart by lightness as well as hue. */
export const KIND_COLOUR: Record<string, string> = {
  text: "#4a443d",
  document: "#b4351f",
  table: "#1d7a45",
  image: "#6a3fd1",
  video: "#a3218a",
  audio: "#0e7490",
  dashboard: "#2b579a",
};
export const kindColour = (k: string) => KIND_COLOUR[k] ?? "#4a443d";

/** The file-type chips' colours, as people know them from their apps. */
export const FORMAT_COLOUR: Record<string, string> = {
  pdf: "#b4351f",
  xlsx: "#1d7a45",
  csv: "#1d7a45",
  docx: "#2b579a",
  pptx: "#c5461e",
  png: "#6a3fd1",
  jpg: "#6a3fd1",
  mp4: "#a3218a",
  mp3: "#0e7490",
};
export const formatColour = (f: string) => FORMAT_COLOUR[f.toLowerCase()] ?? "#4a443d";

/** The formats a visitor opens first; data formats only where nothing else comes. */
const FORMAT_ORDER = [
  "pdf",
  "docx",
  "xlsx",
  "pptx",
  "mp4",
  "png",
  "jpg",
  "mp3",
  "csv",
  "html",
  "txt",
  "md",
  "zip",
  "json",
];
const rank = (f: string) => {
  const i = FORMAT_ORDER.indexOf(f.toLowerCase());
  return i < 0 ? FORMAT_ORDER.length : i;
};
export const shownFormats = (formats: string[]) =>
  [...formats].sort((a, b) => rank(a) - rank(b)).slice(0, 2);
