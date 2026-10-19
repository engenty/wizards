import type { RunTheme } from "@engenty/wizards-shared/run";
import { describe, expect, it } from "vitest";
import { wizardLook } from "../../src/openui/look";

const halloween: RunTheme = {
  accent: "#2f5d50",
  second: null,
  background: "#eff2ec",
  display: "Creepster",
  body: "Instrument Sans",
  faces: [],
  dark: true,
  pinned: true,
  modes: { light: null, dark: { accent: "#ff7a1a", background: "#140b1f" } },
  prefer: null,
  shape: { radius: "round", cards: "glass", headings: "uppercase" },
  effects: [{ id: "glow" }, { id: "corners", kind: "webs" }, { id: "pattern", kind: "grid" }],
};

describe("wizardLook", () => {
  it("names the shipped font of its kind after a brand font with a source", () => {
    const look: RunTheme = {
      ...halloween,
      faces: [{ family: "Instrument Sans", url: "https://acme.example/sans.css", stylesheet: true }],
    };
    expect(wizardLook(look).style["--wizard-font-text"]).toBe(
      '"Instrument Sans", "Inter", ui-sans-serif, system-ui, sans-serif',
    );
  });

  it("puts colours, fonts by family and the radius in variables, shape in attributes", () => {
    expect(wizardLook(halloween)).toEqual({
      style: {
        "--wizard-accent": "#ff7a1a",
        "--wizard-background": "#140b1f",
        "--wizard-font-heading": '"Creepster", ui-sans-serif, system-ui, sans-serif',
        "--wizard-font-text": '"Instrument Sans", ui-sans-serif, system-ui, sans-serif',
        "--wizard-radius": "0.8rem",
        backgroundColor: "var(--paper)",
      },
      "data-cards": "glass",
      "data-headings": "uppercase",
    });
  });

  it("draws only the effects the host turns on and the card can draw", () => {
    expect(wizardLook(halloween, { effects: ["glow", "corners", "pattern"] })["data-effects"]).toBe(
      "glow pattern-grid",
    );
    expect(wizardLook(halloween, { effects: ["corners"] })["data-effects"]).toBeUndefined();
  });

  it("keeps a theme with only dark pages dark, and follows the host otherwise", () => {
    expect(wizardLook(halloween, { mode: "light" }).style["--wizard-background"]).toBe("#140b1f");
    const both: RunTheme = {
      ...halloween,
      pinned: false,
      modes: { light: { accent: "#e8630a" }, dark: halloween.modes?.dark ?? null },
    };
    expect(wizardLook(both, { mode: "light" }).style).toMatchObject({
      "--wizard-accent": "#e8630a",
      "--wizard-background": "#eff2ec",
    });
  });
});
