// SPDX-License-Identifier: CC-BY-4.0
/**
 * Fills, one per engenty kind: the vibrant engenty cast. Fixed, high-chroma
 * colours rather than the semantic accents (`--moss` is the success green,
 * `--rose` the danger red), which sit muted on purpose and turned the jelly
 * coat into a dull gummy. A theme can still repaint any of them through its
 * `--engenty-<fill>` property.
 */
export const ENGENTY_FILL = {
  cobalt: "var(--engenty-cobalt, oklch(60% 0.23 262))",
  amber: "var(--engenty-amber, oklch(82% 0.17 78))",
  moss: "var(--engenty-moss, oklch(72% 0.22 145))",
  rose: "var(--engenty-rose, oklch(64% 0.25 18))",
  ember: "var(--engenty-ember, oklch(70% 0.21 42))",
  teal: "var(--engenty-teal, oklch(74% 0.16 192))",
  violet: "var(--engenty-violet, oklch(60% 0.25 300))",
  magenta: "var(--engenty-magenta, oklch(65% 0.28 345))",
  citron: "var(--engenty-citron, oklch(89% 0.2 118))",
  slate: "var(--engenty-slate, oklch(66% 0.13 235))",
} as const;

export type EngentyKind =
  | "round"
  | "drop"
  | "dome"
  | "flame"
  | "oval"
  | "bean"
  | "pebble"
  | "sprout"
  | "tower"
  | "wedge";

/** The founding five. The brand mark cycles these so it stays recognisable. */
export const ENGENTY_CORE_KINDS: EngentyKind[] = ["round", "drop", "dome", "flame", "oval"];

export const ENGENTY_KINDS: EngentyKind[] = [
  ...ENGENTY_CORE_KINDS,
  "bean",
  "pebble",
  "sprout",
  "tower",
  "wedge",
];

/** Which landing fill each silhouette wears. Keep in sync with the SVG bodies. */
export const ENGENTY_KIND_FILL: Record<EngentyKind, keyof typeof ENGENTY_FILL> = {
  bean: "teal",
  dome: "moss",
  drop: "amber",
  flame: "rose",
  oval: "ember",
  pebble: "slate",
  round: "cobalt",
  sprout: "citron",
  tower: "violet",
  wedge: "magenta",
};
