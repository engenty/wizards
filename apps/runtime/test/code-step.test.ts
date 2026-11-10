import {
  type CodeStep,
  isFixedStep,
  parseWizard,
  validateWizard,
  type WizardDefinition,
  wizardSchema,
} from "@engenty/wizards-shared/definition";
import { describe, expect, it } from "vitest";
import { CODE_STEP_LIMITS, codeOutput, runCode } from "@engenty/wizards-engine/code-step";

const end = { id: "done", type: "result", title: "Done", deliverables: [] };
const ask = {
  id: "ask",
  type: "form",
  title: "Ask",
  fields: [
    { id: "budget", label: "Budget", kind: "number" },
    { id: "name", label: "Name", kind: "text" },
  ],
};
const score = (more: object = {}) => ({
  id: "score",
  type: "code",
  title: "Score",
  code: { entry: "code/score.ts", input: { budget: "budget", note: "{{name}} pays {{budget}}" } },
  output: { fields: [{ id: "total", kind: "number" }] },
  ...more,
});
const wizard = (steps: unknown[]) =>
  wizardSchema.parse({ title: "Test", description: "", avatar: "round", steps }) as WizardDefinition;
const said = (def: WizardDefinition, files = ["code/score.ts"]) =>
  validateWizard(def, files).map((i) => i.message);
const stepOf = (def: WizardDefinition) => def.steps.find((s) => s.id === "score") as CodeStep;

describe("a code step in the format", () => {
  it("is valid with an entry in the workspace and inputs asked before", () => {
    expect(said(wizard([ask, score(), end]))).toEqual([]);
  });

  it("is a fixed step: no model, never a decision", () => {
    const step = stepOf(
      wizard([
        ask,
        score({
          model: "classifier",
          output: { fields: [{ id: "ok", kind: "yesno" }] },
        }),
        end,
      ]),
    );
    expect(isFixedStep(step)).toBe(true);
    expect(step.type).toBe("code");
    expect("model" in step).toBe(false);
  });

  it("needs its entry in the workspace, as a .ts or .js file", () => {
    expect(said(wizard([ask, score(), end]), [])).toEqual([
      'Code entry "code/score.ts" is not in the workspace.',
    ]);
    expect(
      said(wizard([ask, score({ code: { entry: "code/score.py", input: {} } }), end])),
    ).toEqual(['Code entry "code/score.py" is a .ts or .js file.']);
  });

  it("reads only what came before it", () => {
    expect(said(wizard([score(), ask, end]))).toEqual([
      '"{{budget}}" refers to a field that is not asked before "score".',
      '"{{name}}" refers to a field that is not asked before "score".',
      '"{{budget}}" refers to a field that is not asked before "score".',
    ]);
    expect(
      said(
        wizard([ask, score({ code: { entry: "code/score.ts", input: { rows: "lists.x" } } }), end]),
      ),
    ).toEqual(['"{{lists.x}}" refers to an unknown list.']);
  });

  it("returns json of a declared shape and takes nothing of an AI step", () => {
    const parsed = parseWizard({
      title: "Test",
      description: "",
      avatar: "round",
      steps: [
        ask,
        score({
          tools: ["web_search"],
          foreach: "lists.x",
          output: { format: "markdown", fields: [{ id: "total", kind: "number" }] },
        }),
        end,
      ],
    });
    expect(parsed.ok).toBe(true);
    const step = parsed.ok ? (parsed.wizard.steps[1] as CodeStep) : undefined;
    expect(step && "tools" in step).toBe(false);
    expect(step && "foreach" in step).toBe(false);
    expect(step && "format" in step.output).toBe(false);
    expect(said(wizard([ask, score({ output: {} }), end]))).toEqual([
      'A code step declares what it returns: output "fields" or "schema".',
    ]);
    expect(
      parseWizard({
        title: "Test",
        description: "",
        avatar: "round",
        steps: [ask, score({ code: undefined }), end],
      }).ok,
    ).toBe(false);
  });
});

describe("running a code step", () => {
  it("runs TypeScript with its input and returns what run returns", async () => {
    const source = `
      type Offer = { name: string; price: number };
      export function run(input: { budget: number; offers: Offer[] }) {
        const fit = input.offers.filter((o) => o.price <= input.budget);
        return { total: fit.reduce((sum, o) => sum + o.price, 0), names: fit.map((o) => o.name) };
      }`;
    const result = await runCode(source, {
      budget: 100,
      offers: [
        { name: "a", price: 40 },
        { name: "b", price: 150 },
        { name: "c", price: 30 },
      ],
    });
    expect(result).toEqual({ total: 70, names: ["a", "c"] });
  });

  it("gives the same answer every run: a seeded random, no clock", async () => {
    const random = "function run() { return { n: [Math.random(), Math.random()] }; }";
    expect(await runCode(random, {})).toEqual(await runCode(random, {}));
    await expect(runCode("function run() { return { at: Date.now() }; }", {})).rejects.toThrow();
    await expect(runCode("function run() { return { at: new Date() }; }", {})).rejects.toThrow();
    expect(
      await runCode("function run(i) { return { y: new Date(i.today).getUTCFullYear() }; }", {
        today: "2026-11-09",
      }),
    ).toEqual({ y: 2026 });
  });

  it("has no modules, no network and no run of its own", async () => {
    await expect(runCode('import x from "fs";\nfunction run() {}', {})).rejects.toThrow();
    await expect(runCode("function run() { return { f: typeof fetch }; }", {})).resolves.toEqual({
      f: "undefined",
    });
    await expect(runCode("const x = 1;", {})).rejects.toThrow();
  });

  it("stops at its time limit", async () => {
    const before = CODE_STEP_LIMITS.timeoutMs;
    CODE_STEP_LIMITS.timeoutMs = 300;
    try {
      await expect(runCode("function run() { for (;;) {} }", {})).rejects.toThrow();
    } finally {
      CODE_STEP_LIMITS.timeoutMs = before;
    }
  });

  it("fits the result to the declared output and refuses what does not fit", () => {
    const step = stepOf(
      wizard([
        ask,
        score({
          output: {
            fields: [
              { id: "total", kind: "number" },
              { id: "rows", kind: "table" },
              { id: "ranked", kind: "table", columns: ["name", "score"] },
            ],
          },
        }),
        end,
      ]),
    );
    expect(
      codeOutput(step, {
        total: "12",
        rows: [{ a: 1, b: true }, { a: 2 }],
        ranked: [{ name: "x", score: 3, extra: 1 }],
      }),
    ).toEqual({
      total: 12,
      rows: [
        { a: 1, b: "true" },
        { a: 2, b: null },
      ],
      ranked: [{ name: "x", score: 3 }],
    });
    expect(() => codeOutput(step, { total: "many", rows: [], ranked: [] })).toThrow();
    expect(() => codeOutput(step, ["not", "an", "object"])).toThrow();
  });
});
