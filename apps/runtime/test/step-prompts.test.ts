import { STEP_PROMPTS } from "@engenty/wizards-engine/step-prompts";
import { describe, expect, it } from "vitest";
import { stepPrompts } from "../scripts/step-prompts.js";

describe("the engine's step prompts", () => {
  it("are the sections of the prompt files as they are now (pnpm prompts:engine)", () => {
    expect(STEP_PROMPTS).toEqual(stepPrompts());
  });
});
