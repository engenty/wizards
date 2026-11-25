import type { CSSProperties } from "react";

/** The studio's vivid ground and the text on white, as on the landing page. */
export const SETUP_GROUND = "oklch(50% 0.2 262)";
export const SETUP_GROUND_INK = "oklch(32% 0.15 262)";
const CREAM = "oklch(90% 0.1 80)";

/**
 * The setup's own colours, set on an element around it. On the vivid ground: white on it, and
 * secondary text, checks and errors a step brighter than the dark theme's.
 */
export const SETUP_ON_GROUND = {
  "--on": "white",
  "--tile": "rgb(255 255 255 / 0.1)",
  "--tile-hover": "rgb(255 255 255 / 0.15)",
  "--tile-ring": "rgb(255 255 255 / 0.15)",
  "--panel": "rgb(255 255 255 / 0.07)",
  "--panel-ring": "rgb(255 255 255 / 0.12)",
  "--pick": "white",
  "--pick-ink": SETUP_GROUND_INK,
  "--pick-mark": SETUP_GROUND_INK,
  "--badge": CREAM,
  "--badge-ink": SETUP_GROUND_INK,
  "--dot": CREAM,
  "--step-done": "oklch(88% 0.17 150)",
  "--step-now": "oklch(88% 0.14 80)",
  "--ready-ink": "oklch(27% 0.09 150)",
  "--ink-2": "oklch(96% 0.02 262)",
  "--ink-3": "oklch(90% 0.035 262)",
  "--ink-4": "oklch(82% 0.05 262)",
  "--moss": "oklch(90% 0.14 150)",
  "--rose": "oklch(89% 0.09 45)",
} as CSSProperties;

/** On the theme's light paper: the ground's blue marks the pick. */
export const SETUP_ON_PAPER = {
  "--on": "var(--ink)",
  "--tile": "var(--card)",
  "--tile-hover": "var(--paper-2)",
  "--tile-ring": "var(--border-soft)",
  "--panel": "var(--card)",
  "--panel-ring": "var(--border-soft)",
  "--pick": SETUP_GROUND,
  "--pick-ink": "white",
  "--pick-mark": "white",
  "--badge": CREAM,
  "--badge-ink": SETUP_GROUND_INK,
  "--dot": SETUP_GROUND,
  "--step-done": "oklch(52% 0.15 150)",
  "--step-now": "oklch(60% 0.15 65)",
  "--ready-ink": "white",
} as CSSProperties;

/** On whatever ground the theme has: the pick stands in the theme's ink. */
export const SETUP_ON_THEME = {
  "--on": "var(--ink)",
  "--tile": "var(--card)",
  "--tile-hover": "var(--paper-2)",
  "--tile-ring": "transparent",
  "--panel": "var(--card)",
  "--panel-ring": "transparent",
  "--pick": "var(--ink)",
  "--pick-ink": "var(--background)",
  "--pick-mark": "var(--background)",
  "--badge": "var(--primary)",
  "--badge-ink": "var(--primary-foreground)",
  "--dot": "var(--primary)",
  "--step-done": "var(--moss)",
  "--step-now": "var(--primary)",
  "--ready-ink": "var(--background)",
} as CSSProperties;
