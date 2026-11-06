import {
  type PageStep,
  validateWizard,
  type WizardDefinition,
  wizardSchema,
} from "@engenty/wizards-shared/definition";
import { describe, expect, it } from "vitest";
import { readPageInput } from "../src/engine/input";

const end = { id: "done", type: "result", title: "Fertig", deliverables: [] };
const wizard = (steps: unknown[]) =>
  wizardSchema.parse({
    version: 2,
    title: "Test",
    description: "",
    avatar: "round",
    steps,
  }) as WizardDefinition;
const withField = (field: object) =>
  wizard([
    {
      id: "ask",
      type: "page",
      title: "Frage",
      fields: [{ id: "f", label: "F", kind: "number", ...field }],
    },
    end,
  ]);
const said = (def: WizardDefinition) => validateWizard(def).map((i) => i.message);

describe("1a: numbers with a range, and how a field looks", () => {
  it("a number field takes a range, a unit, an increment and a look", () => {
    expect(
      said(
        withField({
          min: 2000,
          max: 30000,
          increment: 500,
          unit: "€",
          default: 17000,
          look: "slider",
        }),
      ),
    ).toEqual([]);
    expect(said(withField({ look: "stepper" }))).toEqual([]);
  });

  it("a slider needs both ends", () => {
    expect(said(withField({ look: "slider", min: 1 }))).toEqual([
      'Field "f": look "slider" needs "min" and "max".',
    ]);
  });

  it("a look fits its kind", () => {
    expect(said(withField({ kind: "text", look: "slider" })).join()).toContain(
      'look "slider" draws a number field',
    );
    expect(said(withField({ look: "list" })).join()).toContain('look "list" draws a select field');
    expect(
      said(withField({ kind: "select", options: ["a", "b"], look: "list" })),
    ).toEqual([]);
  });

  it("a range is one", () => {
    expect(said(withField({ min: 5, max: 1 })).join()).toContain("min is larger than max");
    expect(said(withField({ min: 1, max: 5, increment: 10 })).join()).toContain(
      "increment is larger",
    );
  });

  it("files stay counted in whole numbers from 1 to 30, now in the validator", () => {
    const file = { kind: "file", multiple: true };
    expect(said(withField({ ...file, min: 1, max: 30 }))).toEqual([]);
    for (const wrong of [{ min: 0 }, { max: 31 }, { max: 2.5 }]) {
      expect(said(withField({ ...file, ...wrong })).join()).toContain("whole numbers from 1 to 30");
    }
    expect(said(withField({ kind: "file", min: 1 })).join()).toContain("bound a number field");
    expect(said(withField({ kind: "text", max: 1 })).join()).toContain("bound a number field");
  });

  it("unit and increment belong to a number", () => {
    expect(said(withField({ kind: "text", unit: "€" })).join()).toContain("belong to a number");
  });

  it("the server refuses a number out of range, and takes one at its ends", () => {
    const def = withField({ min: 2, max: 8 });
    const page = def.steps[0] as PageStep;
    expect(readPageInput(page, { f: 1 }).errors).toHaveLength(1);
    expect(readPageInput(page, { f: "9" }).errors).toHaveLength(1);
    expect(readPageInput(page, { f: 2 }).errors).toEqual([]);
    expect(readPageInput(page, { f: "8" }).values.f).toBe(8);
    expect(readPageInput(page, { f: "" }).errors).toEqual([]);
  });
});
