// Written by apps/web/scripts/engenty-shapes.tsx from apps/web/src/engenty — do not edit by hand.

export type EngentyKind = "round" | "drop" | "dome" | "flame" | "oval" | "bean" | "pebble" | "sprout" | "tower" | "wedge";

export const ENGENTY_KINDS: EngentyKind[] = ["round","drop","dome","flame","oval","bean","pebble","sprout","tower","wedge"];

/** Each kind's fill in oklch, as the web writes it: the stage of a wizard takes its hue. */
export const ENGENTY_FILL_OKLCH: Record<EngentyKind, string> = {
  "round": "oklch(60% 0.23 262)",
  "drop": "oklch(82% 0.17 78)",
  "dome": "oklch(72% 0.22 145)",
  "flame": "oklch(64% 0.25 18)",
  "oval": "oklch(70% 0.21 42)",
  "bean": "oklch(74% 0.16 192)",
  "pebble": "oklch(66% 0.13 235)",
  "sprout": "oklch(89% 0.2 118)",
  "tower": "oklch(60% 0.25 300)",
  "wedge": "oklch(65% 0.28 345)"
};

/** Still SVG, 120 × 120. */
export const ENGENTY_SVG: Record<EngentyKind, string> = {
  "round": "<svg viewBox=\"0 0 120 120\"><g><path fill=\"#2873ff\" d=\"M60 22 Q96 26 96 62 Q96 96 60 100 Q24 96 24 62 Q24 26 60 22 Z\"></path><circle cx=\"97\" cy=\"34\" fill=\"#2873ff\" opacity=\"0.5\" r=\"6\"></circle><circle cx=\"106\" cy=\"24\" fill=\"#2873ff\" opacity=\"0.35\" r=\"3.5\"></circle><g><ellipse cx=\"68\" cy=\"58\" fill=\"#fff\" rx=\"8\" ry=\"9.2\"></ellipse><circle cx=\"68\" cy=\"59\" fill=\"#000e34\" r=\"3.84\"></circle><circle cx=\"66\" cy=\"55.6\" fill=\"#fff\" r=\"1.44\"></circle></g></g></svg>",
  "drop": "<svg viewBox=\"0 0 120 120\"><g><path fill=\"#ffb407\" d=\"M60 16 Q90 34 90 66 Q90 96 60 98 Q30 96 30 66 Q30 34 60 16 Z\"></path><g><ellipse cx=\"60\" cy=\"56\" fill=\"#fff\" rx=\"8\" ry=\"9.2\"></ellipse><circle cx=\"60\" cy=\"57\" fill=\"#501c00\" r=\"3.84\"></circle><circle cx=\"58\" cy=\"53.6\" fill=\"#fff\" r=\"1.44\"></circle></g><path d=\"M48 76 Q54 72 60 76 Q66 80 72 76\" fill=\"none\" stroke=\"#511a00\" stroke-linecap=\"round\" stroke-width=\"2.6\"></path></g></svg>",
  "dome": "<svg viewBox=\"0 0 120 120\"><g><path fill=\"#19c63c\" d=\"M60 20 Q92 30 92 70 Q92 96 60 96 Q28 96 28 70 Q28 30 60 20 Z\"></path><path d=\"M46 90 L46 80 M60 92 L60 82 M74 90 L74 80\" opacity=\"0.5\" stroke=\"#003610\" stroke-linecap=\"round\" stroke-width=\"2.4\"></path><circle cx=\"60\" cy=\"6\" fill=\"#19c63c\" r=\"3\"></circle><g><ellipse cx=\"60\" cy=\"54\" fill=\"#fff\" rx=\"8.5\" ry=\"9.774999999999999\"></ellipse><circle cx=\"60\" cy=\"55\" fill=\"#001602\" r=\"4.08\"></circle><circle cx=\"57.875\" cy=\"51.45\" fill=\"#fff\" r=\"1.53\"></circle></g></g></svg>",
  "flame": "<svg viewBox=\"0 0 120 120\"><g><path fill=\"#ff154f\" d=\"M60 14 Q84 44 80 76 Q78 98 60 98 Q42 98 40 76 Q36 44 60 14 Z\"></path><path d=\"M40 20 Q60 6 80 20\" fill=\"none\" opacity=\"0.55\" stroke=\"#ff154f\" stroke-linecap=\"round\" stroke-width=\"3\"></path><g><ellipse cx=\"60\" cy=\"62\" fill=\"#fff\" rx=\"8\" ry=\"9.2\"></ellipse><circle cx=\"60\" cy=\"63\" fill=\"#3d0007\" r=\"3.84\"></circle><circle cx=\"58\" cy=\"59.6\" fill=\"#fff\" r=\"1.44\"></circle></g><circle cx=\"60\" cy=\"82\" fill=\"#3d0007\" r=\"2.6\"></circle></g></svg>",
  "oval": "<svg viewBox=\"0 0 120 120\"><g><path fill=\"#ff6404\" d=\"M60 34 Q100 38 100 64 Q100 92 60 94 Q20 92 20 64 Q20 38 60 34 Z\"></path><g fill=\"none\" opacity=\"0.45\" stroke=\"#8a0700\" stroke-width=\"2.2\"><path d=\"M28 54 Q60 48 92 54\"></path><path d=\"M26 70 Q60 64 94 70\"></path></g><g><ellipse cx=\"66\" cy=\"58\" fill=\"#fff\" rx=\"8\" ry=\"9.2\"></ellipse><circle cx=\"66\" cy=\"59\" fill=\"#430000\" r=\"3.84\"></circle><circle cx=\"64\" cy=\"55.6\" fill=\"#fff\" r=\"1.44\"></circle></g></g></svg>",
  "bean": "<svg viewBox=\"0 0 120 120\"><g><path fill=\"#00c9c5\" d=\"M48 96 Q24 92 26 68 Q28 44 52 38 Q78 32 88 50 Q98 66 84 84 Q70 100 48 96 Z\"></path><circle cx=\"32\" cy=\"94\" fill=\"#00c9c5\" opacity=\"0.4\" r=\"4\"></circle><g><ellipse cx=\"70\" cy=\"58\" fill=\"#fff\" rx=\"8\" ry=\"9.2\"></ellipse><circle cx=\"70\" cy=\"59\" fill=\"#001a1f\" r=\"3.84\"></circle><circle cx=\"68\" cy=\"55.6\" fill=\"#fff\" r=\"1.44\"></circle></g></g></svg>",
  "pebble": "<svg viewBox=\"0 0 120 120\"><g><path fill=\"#259ed6\" d=\"M60 96 Q20 96 18 78 Q16 60 46 56 Q78 52 98 62 Q110 72 104 86 Q98 96 60 96 Z\"></path><g fill=\"#163045\" opacity=\"0.32\"><circle cx=\"42\" cy=\"76\" r=\"3\"></circle><circle cx=\"56\" cy=\"86\" r=\"2.2\"></circle><circle cx=\"86\" cy=\"80\" r=\"2.6\"></circle></g><g><ellipse cx=\"68\" cy=\"72\" fill=\"#fff\" rx=\"7.5\" ry=\"8.625\"></ellipse><circle cx=\"68\" cy=\"73\" fill=\"#00182f\" r=\"3.5999999999999996\"></circle><circle cx=\"66.125\" cy=\"69.75\" fill=\"#fff\" r=\"1.3499999999999999\"></circle></g></g></svg>",
  "sprout": "<svg viewBox=\"0 0 120 120\"><g><g fill=\"#d0eb24\"><ellipse cx=\"48\" cy=\"34\" rx=\"6\" ry=\"10\"></ellipse><ellipse cx=\"72\" cy=\"32\" rx=\"5.5\" ry=\"9\"></ellipse></g><path fill=\"#d0eb24\" d=\"M60 100 Q28 98 28 72 Q28 46 60 44 Q92 46 92 72 Q92 98 60 100 Z\"></path><g><ellipse cx=\"60\" cy=\"68\" fill=\"#fff\" rx=\"8.5\" ry=\"9.774999999999999\"></ellipse><circle cx=\"60\" cy=\"69\" fill=\"#242100\" r=\"4.08\"></circle><circle cx=\"57.875\" cy=\"65.45\" fill=\"#fff\" r=\"1.53\"></circle></g></g></svg>",
  "tower": "<svg viewBox=\"0 0 120 120\"><g><path fill=\"#9b48fb\" d=\"M60 102 Q36 100 38 78 Q40 58 42 44 Q44 26 60 24 Q76 26 78 44 Q80 58 82 78 Q84 100 60 102 Z\"></path><g fill=\"none\" opacity=\"0.4\" stroke=\"#37164e\" stroke-linecap=\"round\" stroke-width=\"2.2\"><path d=\"M42 74 Q60 70 78 74\"></path><path d=\"M40 88 Q60 84 80 88\"></path></g><g><ellipse cx=\"60\" cy=\"52\" fill=\"#fff\" rx=\"8\" ry=\"9.2\"></ellipse><circle cx=\"60\" cy=\"53\" fill=\"#210434\" r=\"3.84\"></circle><circle cx=\"58\" cy=\"49.6\" fill=\"#fff\" r=\"1.44\"></circle></g></g></svg>",
  "wedge": "<svg viewBox=\"0 0 120 120\"><g><path fill=\"#f800b5\" d=\"M60 30 Q74 40 86 70 Q96 92 78 98 Q60 102 42 98 Q24 92 34 70 Q46 40 60 30 Z\"></path><path d=\"M52 22 Q60 14 68 22\" fill=\"none\" opacity=\"0.5\" stroke=\"#f800b5\" stroke-linecap=\"round\" stroke-width=\"3\"></path><g><ellipse cx=\"60\" cy=\"70\" fill=\"#fff\" rx=\"8\" ry=\"9.2\"></ellipse><circle cx=\"60\" cy=\"71\" fill=\"#370025\" r=\"3.84\"></circle><circle cx=\"58\" cy=\"67.6\" fill=\"#fff\" r=\"1.44\"></circle></g></g></svg>"
};

/** The line each kind stands on (`cy`) and its shadow's half width, in the same 120 × 120. */
export const ENGENTY_SHADOW: Record<EngentyKind, { cy: number; rx: number }> = {
  "round": {
    "cy": 108,
    "rx": 26
  },
  "drop": {
    "cy": 106,
    "rx": 24
  },
  "dome": {
    "cy": 104,
    "rx": 27
  },
  "flame": {
    "cy": 106,
    "rx": 22
  },
  "oval": {
    "cy": 102,
    "rx": 32
  },
  "bean": {
    "cy": 102,
    "rx": 26
  },
  "pebble": {
    "cy": 102,
    "rx": 34
  },
  "sprout": {
    "cy": 106,
    "rx": 26
  },
  "tower": {
    "cy": 108,
    "rx": 20
  },
  "wedge": {
    "cy": 106,
    "rx": 28
  }
};
