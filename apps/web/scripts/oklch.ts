/**
 * The web's palette is written in oklch; the mobile app takes no oklch, so engenty-shapes.tsx
 * turns each colour into hex for it. Out-of-gamut colours (the engenties' high chroma) are clipped
 * to sRGB. The same file is in the mobile app (engenty-wizards-apps, mobile/src/theme/oklch.ts).
 */

/** `oklch(L C h)` with L as 0..1 or a percentage, as the web's CSS writes it. */
export function parseOklch(css: string): [number, number, number] | null {
  const m = css.match(/oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*\)/);
  if (!m) {
    return null;
  }
  const l = Number(m[1]) / (m[2] ? 100 : 1);
  return [l, Number(m[3]), Number(m[4])];
}

const gamma = (x: number) => (x <= 0.003_130_8 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
const byte = (x: number) =>
  Math.round(Math.min(1, Math.max(0, gamma(x))) * 255)
    .toString(16)
    .padStart(2, "0");

export function oklchToHex(l: number, c: number, h: number): string {
  const rad = (h * Math.PI) / 180;
  const a = c * Math.cos(rad);
  const b = c * Math.sin(rad);
  const l_ = (l + 0.396_337_777_4 * a + 0.215_803_757_3 * b) ** 3;
  const m_ = (l - 0.105_561_345_8 * a - 0.063_854_172_8 * b) ** 3;
  const s_ = (l - 0.089_484_177_5 * a - 1.291_485_548 * b) ** 3;
  const r = 4.076_741_662_1 * l_ - 3.307_711_591_3 * m_ + 0.230_969_929_2 * s_;
  const g = -1.268_438_004_6 * l_ + 2.609_757_401_1 * m_ - 0.341_319_396_5 * s_;
  const bl = -0.004_196_086_3 * l_ - 0.703_418_614_7 * m_ + 1.707_614_701 * s_;
  return `#${byte(r)}${byte(g)}${byte(bl)}`;
}

/** Any oklch() in a CSS colour as hex; other colours as they are. */
export function cssToHex(css: string): string {
  const parsed = parseOklch(css);
  return parsed ? oklchToHex(...parsed) : css;
}
