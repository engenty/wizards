import { describe, expect, it } from "vitest";
import { levelOf, reaches } from "./levels.js";

describe("the level of a model", () => {
  it.each([
    ["anthropic/claude-opus-5-5", "high"],
    ["claude:sonnet", "high"],
    ["openai/gpt-5.6", "high"],
    ["moonshotai/kimi-k3", "high"],
    ["claude:haiku", "standard"],
    ["openai/gpt-5.4-mini", "standard"],
    ["google/gemini-3-flash", "standard"],
    ["meta/llama-4-8b", "basic"],
    ["someone/their-model", "basic"],
  ])("of a service's %s is %s", (model, level) => {
    expect(levelOf({ model })).toBe(level);
  });

  it.each([
    ["mlx-community/Qwen3-4B-4bit", undefined, "basic"],
    ["qwen3.8:27b-mlx", undefined, "standard"],
    ["qwen3.8:30b-a3b", undefined, "basic"],
    ["inkling-2-mini:latest", 20e9, "standard"],
    ["gemma4:e4b", 3e9, "basic"],
    ["claude-like:latest", undefined, "basic"],
    ["big:120b", undefined, "high"],
  ])("of a local %s is %s", (model, size, level) => {
    expect(levelOf({ model, local: true, size })).toBe(level);
  });

  it("reaches what needs as much or less", () => {
    expect(reaches("standard", "basic")).toBe(true);
    expect(reaches("basic", "standard")).toBe(false);
  });
});
