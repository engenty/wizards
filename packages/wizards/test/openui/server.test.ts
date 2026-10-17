import { createLibrary, defineComponent } from "@openuidev/react-lang";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { addWizard, type WizardInfo, wizardRules } from "../../src/openui/server";

const damage: WizardInfo = {
  token: "tok123",
  title: "Damage report",
  description: "Reports damage to a company car.",
  fields: [
    { id: "plate", label: "Number plate", kind: "text", required: true },
    { id: "kind", label: "Kind of damage", kind: "select", options: ["Scratch", "Dent"] },
  ],
};

const Text = defineComponent({
  name: "Text",
  description: "A line of text",
  props: z.object({ text: z.string() }),
  component: () => null,
});
const Card = defineComponent({
  name: "Card",
  description: "Holds the answer",
  props: z.object({ children: z.array(z.union([Text.ref])) }),
  component: () => null,
});
const base = createLibrary({ root: "Card", components: [Card, Text] });

describe("the prompt's half of the Wizard component", () => {
  it("lists each wizard with its token and the fields the chat may fill in", () => {
    const rules = wizardRules([damage]).join("\n");
    expect(rules).toContain('"Damage report" token: tok123');
    expect(rules).toContain("plate (text, required): Number plate");
    expect(rules).toContain('kind (select one of "Scratch" | "Dent"): Kind of damage');
  });

  it("adds no rules where no wizard is available", () => {
    expect(wizardRules([])).toEqual([]);
  });

  it("puts Wizard among a Card's children, with its token, note and prefill", () => {
    const prompt = addWizard(base).prompt();
    expect(prompt).toMatch(/Card\(children: \(Text \| Wizard\)\[\]\)/);
    expect(prompt).toContain("Wizard(wizard: string, note?: string, prefill?:");
  });
});
