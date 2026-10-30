import type { ModelPolicy, ModelTier, PurposePolicy } from "@engenty/wizards-shared/tiers";
import { describe, expect, it } from "vitest";
import { approvable, preselection, purposeChoice } from "./tiers";

const on = (model: string, name: string) => ({ model, name, route: "AI Gateway", region: "EU" });

const tier: ModelTier = {
  id: "eu-private",
  name: "EU-Datenschutz",
  locked: false,
  rules: { regions: ["eu"], zdr: true, noTraining: true, search: false, decisions: false },
  classes: {
    low: on("anthropic/claude-haiku-5.5", "Claude Haiku 5.5"),
    standard: on("anthropic/claude-sonnet-5.5", "Claude Sonnet 5.5"),
    "anthropic/low": on("anthropic/claude-haiku-5.5", "Claude Haiku 5.5"),
    "anthropic/standard": on("anthropic/claude-sonnet-5.5", "Claude Sonnet 5.5"),
    "openai/standard": on("openai/gpt-6-luna", "GPT-6 Luna"),
    high: { model: null, name: "Claude Opus 5", reason: "unbound" },
  },
  models: [
    {
      id: "anthropic/claude-haiku-5.5",
      name: "Claude Haiku 5.5",
      maker: "anthropic",
      kind: "text",
      classes: ["low", "anthropic/low"],
      efforts: ["low", "medium", "high"],
      chooser: true,
    },
    {
      id: "anthropic/claude-sonnet-5.5",
      name: "Claude Sonnet 5.5",
      maker: "anthropic",
      kind: "text",
      classes: ["standard", "anthropic/standard"],
      efforts: ["low", "medium", "high"],
      chooser: true,
    },
    {
      id: "openai/gpt-6-luna",
      name: "GPT-6 Luna",
      maker: "openai",
      kind: "text",
      classes: ["openai/standard"],
      efforts: ["low", "high"],
      chooser: false,
    },
    {
      id: "google/gemini-3.8-flash-tts",
      name: "Gemini 3.8 Flash TTS",
      maker: "google",
      kind: "speech",
      classes: ["speech"],
      efforts: [],
      chooser: false,
    },
  ],
};

const open: PurposePolicy = { models: null, default: null, effortCap: null, efforts: null };
const policy = (way: ModelPolicy["way"], wizard: Partial<PurposePolicy> = {}): ModelPolicy => ({
  way,
  purposes: { wizard: { ...open, ...wizard }, assistant: open, work: open },
  credits: true,
  ownKeys: false,
  subscriptions: false,
  localModels: false,
  apps: { local: false, subscriptions: false },
  masking: false,
  maskInstructions: "",
  maskLabels: [],
});

describe("the model chooser", () => {
  it("offers the preselection by model, each asking for its maker class", () => {
    expect(preselection(tier).map((i) => [i.id, i.name])).toEqual([
      ["anthropic/low", "Claude Haiku 5.5"],
      ["anthropic/standard", "Claude Sonnet 5.5"],
    ]);
    const choice = purposeChoice(tier, policy("A"), "wizard");
    expect(choice.auto).toBe(true);
    expect(choice.items.map((i) => i.name)).toEqual(["Claude Haiku 5.5", "Claude Sonnet 5.5"]);
  });

  it("lets admins approve text models off the preselection, never speech", () => {
    expect(approvable(tier).map((i) => i.id)).toEqual([
      "anthropic/low",
      "anthropic/standard",
      "openai/standard",
    ]);
  });

  it("offers way C's list without Auto, one line per model", () => {
    const choice = purposeChoice(
      tier,
      policy("C", { models: ["standard", "anthropic/standard", "openai/standard"] }),
      "wizard",
    );
    expect(choice.auto).toBe(false);
    expect(choice.items.map((i) => [i.id, i.name])).toEqual([
      ["standard", "Claude Sonnet 5.5"],
      ["openai/standard", "GPT-6 Luna"],
    ]);
    // A step on the maker class shows as the line running the same model.
    expect(choice.itemFor("anthropic/standard", choice.items)?.id).toBe("standard");
  });

  it("builds the preselection from the classes where Manage names no models", () => {
    const older = { ...tier, models: undefined };
    expect(preselection(older).map((i) => i.model)).toEqual([
      "anthropic/claude-haiku-5.5",
      "anthropic/claude-sonnet-5.5",
      "openai/gpt-6-luna",
    ]);
  });
});
