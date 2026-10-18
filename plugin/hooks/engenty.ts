// SPDX-License-Identifier: CC-BY-4.0
/**
 * The flat engenties of the studio (apps/web/src/engenty/engenty.tsx) at rest, as one SVG
 * string per kind: the same bodies, the one eye, no animation. The fills are the studio's
 * defaults (ENGENTY_FILL in apps/web/src/engenty/colors.ts).
 */

const FILL = {
  cobalt: "oklch(60% 0.23 262)",
  amber: "oklch(82% 0.17 78)",
  moss: "oklch(72% 0.22 145)",
  rose: "oklch(64% 0.25 18)",
  ember: "oklch(70% 0.21 42)",
  teal: "oklch(74% 0.16 192)",
  violet: "oklch(60% 0.25 300)",
  magenta: "oklch(65% 0.28 345)",
  citron: "oklch(89% 0.2 118)",
  slate: "oklch(66% 0.13 235)",
} as const;

type Eye = { ex: number; ey: number; r: number; ink: string };

type Kind = {
  fill: string;
  body: string;
  eye: Eye;
  shadow: { cy: number; rx: number };
  /** Marks drawn before the body (a sprout's leaves). */
  under?: string;
  /** Marks drawn over the body, before the eye. */
  over?: string;
  /** Marks drawn after the eye (a mouth, a dot). */
  after?: string;
};

const stroke = (d: string, color: string, width: number, opacity: number) =>
  `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" opacity="${opacity}"/>`;

const KINDS: Record<string, Kind> = {
  round: {
    fill: FILL.cobalt,
    body: "M60 22 C65.2 22 71.2 24 75.8 26 C80.2 28 84 30.7 87 34 C90 37.3 92.2 41.3 93.8 46 C95.2 50.7 96 56.8 96 62 C96 67.2 95.2 72.7 93.8 77.1 C92.2 81.5 90 85.3 87 88.5 C84 91.7 80.2 94.2 75.8 96.1 C71.2 98 65.2 100 60 100 C54.8 100 48.8 98 44.2 96.1 C39.8 94.2 36 91.7 33 88.5 C30 85.3 27.8 81.5 26.2 77.1 C24.8 72.7 24 67.2 24 62 C24 56.8 24.8 50.7 26.2 46 C27.8 41.3 30 37.3 33 34 C36 30.7 39.8 28 44.2 26 C48.8 24 54.8 22 60 22 Z",
    over: `<circle cx="97" cy="34" r="6" fill="${FILL.cobalt}" opacity="0.5"/><circle cx="106" cy="24" r="3.5" fill="${FILL.cobalt}" opacity="0.35"/>`,
    eye: { ex: 68, ey: 58, r: 8, ink: "oklch(18% 0.08 260)" },
    shadow: { cy: 108, rx: 26 },
  },
  drop: {
    fill: FILL.amber,
    body: "M60 16 Q90 34 90 66 Q90 96 60 98 Q30 96 30 66 Q30 34 60 16 Z",
    eye: { ex: 60, ey: 56, r: 8, ink: "oklch(30% 0.10 60)" },
    after: stroke("M49 75 C54 78 64 78.5 71 71.4", "oklch(30% 0.10 55)", 2.6, 1),
    shadow: { cy: 106, rx: 24 },
  },
  dome: {
    fill: FILL.moss,
    body: "M60 20 Q92 30 92 70 Q92 96 60 96 Q28 96 28 70 Q28 30 60 20 Z",
    over: `${stroke("M46 90 L46 80 M60 92 L60 82 M74 90 L74 80", "oklch(28% 0.10 155)", 2.4, 0.5)}<circle cx="60" cy="6" r="3" fill="${FILL.moss}"/>`,
    eye: { ex: 60, ey: 54, r: 8.5, ink: "oklch(16% 0.08 160)" },
    shadow: { cy: 104, rx: 27 },
  },
  flame: {
    fill: FILL.rose,
    body: "M60 14 Q84 44 80 76 Q78 98 60 98 Q42 98 40 76 Q36 44 60 14 Z",
    over: stroke("M40 20 Q60 6 80 20", FILL.rose, 3, 0.55),
    eye: { ex: 60, ey: 62, r: 8, ink: "oklch(22% 0.10 18)" },
    after: '<circle cx="60" cy="82" r="2.6" fill="oklch(22% 0.10 18)"/>',
    shadow: { cy: 106, rx: 22 },
  },
  oval: {
    fill: FILL.ember,
    body: "M60 34 Q100 38 100 64 Q100 92 60 94 Q20 92 20 64 Q20 38 60 34 Z",
    over:
      stroke("M28 54 Q60 48 92 54", "oklch(40% 0.16 30)", 2.2, 0.45) +
      stroke("M26 70 Q60 64 94 70", "oklch(40% 0.16 30)", 2.2, 0.45),
    eye: { ex: 66, ey: 58, r: 8, ink: "oklch(24% 0.10 30)" },
    shadow: { cy: 102, rx: 32 },
  },
  bean: {
    fill: FILL.teal,
    body: "M48 96 Q24 92 26 68 Q28 44 52 38 Q78 32 88 50 Q98 66 84 84 Q70 100 48 96 Z",
    over: `<circle cx="32" cy="94" r="4" fill="${FILL.teal}" opacity="0.4"/>`,
    eye: { ex: 70, ey: 58, r: 8, ink: "oklch(18% 0.08 200)" },
    shadow: { cy: 102, rx: 26 },
  },
  pebble: {
    fill: FILL.slate,
    body: "M60 96 Q20 96 18 78 Q16 60 46 56 Q78 52 98 62 Q110 72 104 86 Q98 96 60 96 Z",
    over: '<g fill="oklch(30% 0.05 244)" opacity="0.32"><circle cx="42" cy="76" r="3"/><circle cx="56" cy="86" r="2.2"/><circle cx="86" cy="80" r="2.6"/></g>',
    eye: { ex: 68, ey: 72, r: 7.5, ink: "oklch(20% 0.06 244)" },
    shadow: { cy: 102, rx: 34 },
  },
  sprout: {
    fill: FILL.citron,
    under: `<g fill="${FILL.citron}"><ellipse cx="48" cy="34" rx="6" ry="10"/><ellipse cx="72" cy="32" rx="5.5" ry="9"/></g>`,
    body: "M60 100 Q28 98 28 72 Q28 46 60 44 Q92 46 92 72 Q92 98 60 100 Z",
    eye: { ex: 60, ey: 68, r: 8.5, ink: "oklch(24% 0.09 108)" },
    shadow: { cy: 106, rx: 26 },
  },
  tower: {
    fill: FILL.violet,
    body: "M60 102 Q36 100 38 78 Q40 58 42 44 Q44 26 60 24 Q76 26 78 44 Q80 58 82 78 Q84 100 60 102 Z",
    over:
      stroke("M42 74 Q60 70 78 74", "oklch(28% 0.10 308)", 2.2, 0.4) +
      stroke("M40 88 Q60 84 80 88", "oklch(28% 0.10 308)", 2.2, 0.4),
    eye: { ex: 60, ey: 52, r: 8, ink: "oklch(20% 0.09 308)" },
    shadow: { cy: 108, rx: 20 },
  },
  wedge: {
    fill: FILL.magenta,
    body: "M60 30 Q74 40 86 70 Q96 92 78 98 Q60 102 42 98 Q24 92 34 70 Q46 40 60 30 Z",
    over: stroke("M52 22 Q60 14 68 22", FILL.magenta, 3, 0.5),
    eye: { ex: 60, ey: 70, r: 8, ink: "oklch(22% 0.10 345)" },
    shadow: { cy: 106, rx: 28 },
  },
};

const kindOf = (kind: string | undefined): Kind => KINDS[kind ?? "round"] ?? KINDS.round!;

/** The one eye: white, a pupil, a glint. */
const eye = ({ ex, ey, r, ink }: Eye) =>
  `<ellipse cx="${ex}" cy="${ey}" rx="${r}" ry="${r * 1.15}" fill="#fff"/>` +
  `<circle cx="${ex}" cy="${ey + 1}" r="${r * 0.48}" fill="${ink}"/>` +
  `<circle cx="${ex - r * 0.25}" cy="${ey - r * 0.3}" r="${r * 0.18}" fill="#fff"/>`;

/** The engenty of a kind at rest, `size` pixels square. */
export function engentySvg(kind: string | undefined, size: number): string {
  const k = kindOf(kind);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="${size}" height="${size}" overflow="visible">` +
    `<ellipse cx="60" cy="${k.shadow.cy}" rx="${k.shadow.rx}" ry="4.5" fill="#000" opacity="0.14"/>` +
    (k.under ?? "") +
    `<path d="${k.body}" fill="${k.fill}"/>` +
    (k.over ?? "") +
    eye(k.eye) +
    (k.after ?? "") +
    "</svg>"
  );
}

/** The body colour of a kind, for a surface that draws no SVG. */
export const engentyColor = (kind: string | undefined) => kindOf(kind).fill;
