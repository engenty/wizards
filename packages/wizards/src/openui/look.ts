import type { RunTheme } from "@engenty/wizards-shared/run";
import { fontStack, lookColours } from "@engenty/wizards-shared/theme";

/**
 * A wizard's theme in a host's own page (OpenUI, an own UI): values on the element with
 * `.engenty-runner`, never CSS in the page around it. runner.css derives every token from them.
 */

/** The effects the wizard's card draws itself, when the host turns them on: CSS inside the card. */
export const CARD_EFFECTS = ["glow", "pattern"] as const;

export interface WizardLookOptions {
  /** Light or dark, as the host shows; else what the theme prefers. A theme with only one keeps it. */
  mode?: "light" | "dark";
  /** The effects the host turns on (`CARD_EFFECTS`); none unless given. */
  effects?: readonly string[];
}

/** What goes on the element with `.engenty-runner`: CSS variables and data attributes. */
export interface WizardLookProps {
  style: Record<string, string>;
  "data-cards"?: string;
  "data-headings"?: string;
  "data-effects"?: string;
}

const RADIUS = { sharp: "0.25rem", soft: "0.5rem", round: "0.8rem" } as const;

/**
 * A theme's values as props for the runner's element: colours, fonts by family and the corner
 * radius as `--wizard-*` variables, how cards and headings look as data attributes, and of the
 * effects only those the host turns on and the card can draw. A brand font with a source names
 * the shipped font of its kind next, which shows where it does not load (`loadLookFonts`).
 */
export function wizardLook(look: RunTheme, options: WizardLookOptions = {}): WizardLookProps {
  const own = look.dark ? "dark" : "light";
  const mode = look.pinned ? own : (options.mode ?? look.prefer ?? own);
  const colours = lookColours(look, mode);
  const style: Record<string, string> = {};
  const set = (name: string, value: string | null | undefined) => {
    if (value) {
      style[name] = value;
    }
  };
  set("--wizard-accent", colours.accent);
  set("--wizard-background", colours.background);
  set("--wizard-text", colours.text);
  set("--wizard-font-heading", look.display ? fontStack(look.display, look.faces) : null);
  set("--wizard-font-text", look.body ? fontStack(look.body, look.faces) : null);
  set("--wizard-radius", look.shape?.radius ? RADIUS[look.shape.radius] : null);
  // runner.css styles what is inside the element; the ground of the element itself is set here.
  set("backgroundColor", colours.background ? "var(--paper)" : null);

  const on = new Set(options.effects ?? []);
  const effects = look.effects.flatMap((e) =>
    !on.has(e.id)
      ? []
      : e.id === "glow"
        ? ["glow"]
        : e.id === "pattern"
          ? [`pattern-${e.kind === "grid" ? "grid" : "dots"}`]
          : [],
  );
  return {
    style,
    ...(look.shape?.cards ? { "data-cards": look.shape.cards } : {}),
    ...(look.shape?.headings ? { "data-headings": look.shape.headings } : {}),
    ...(effects.length ? { "data-effects": effects.join(" ") } : {}),
  };
}
