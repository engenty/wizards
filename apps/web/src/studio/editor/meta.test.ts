import type { Step } from "@engenty/wizards-shared/definition";
import { afterAll, describe, expect, it, vi } from "vitest";
import { lang, setLang } from "../../lib/i18n";
import { callSummary, isFixedStep, stepSummary, typeLabel } from "./meta";

// Switching the language marks the page and keeps a cookie: here there is neither.
vi.stubGlobal("window", { location: { hostname: "localhost", protocol: "http:" } });
vi.stubGlobal("document", { documentElement: { lang: "" }, cookie: "" });
const before = lang;
afterAll(() => {
  setLang(before);
  vi.unstubAllGlobals();
});

/**
 * A fixed step is an agent step with a `call`: one action, once, with no model. The editor names
 * it so, in the flow and in the step's panel, and never as an AI step with an empty task.
 */
const agent = { id: "a", type: "agent", title: "A", instructions: "", tools: [] };
const ai = { ...agent, instructions: "Fasse zusammen.", output: { format: "markdown" } } as Step;
const onConnection = {
  ...agent,
  call: { connection: "crm", action: "create_contact", input: { email: "{{email}}" } },
  output: { format: "json" },
} as Step;
const onTool = {
  ...agent,
  call: { tool: "appointments.free_slots", input: {} },
  output: { format: "json" },
} as Step;

describe("a fixed step in the editor", () => {
  it("is told apart from an AI step by its call", () => {
    expect(isFixedStep(ai)).toBe(false);
    expect(isFixedStep(onConnection)).toBe(true);
    expect(isFixedStep(onTool)).toBe(true);
  });

  it("has its own name in both languages", () => {
    setLang("de");
    expect(typeLabel(ai)).toBe("KI-Schritt");
    expect(typeLabel(onConnection)).toBe("Fester Schritt");
    setLang("en");
    expect(typeLabel(ai)).toBe("AI step");
    expect(typeLabel(onTool)).toBe("Fixed step");
  });

  it("says under its title what it calls", () => {
    expect(stepSummary(onConnection)).toBe("crm · create_contact");
    expect(stepSummary(onTool)).toBe("appointments.free_slots");
    expect(callSummary({ tool: "appointments.free_slots", input: {} })).toBe(
      "appointments.free_slots",
    );
    expect(stepSummary(ai)).toBe("Fasse zusammen.");
  });
});
