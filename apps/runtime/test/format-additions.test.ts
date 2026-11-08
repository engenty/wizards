import { calcNames, calcScope, calcValue, parseCalc } from "@engenty/wizards-shared/calc";
import {
  type PageStep,
  ruleMatches,
  whenHolds,
  sectionOf,
  sectionsOf,
  validateWizard,
  type WizardDefinition,
  wizardSchema,
} from "@engenty/wizards-shared/definition";
import { needs } from "@engenty/wizards-shared/fit";
import { bound, validateSurface, worded } from "@engenty/wizards-shared/surface";
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

describe("1b: sections", () => {
  const page = (id: string, section?: string) => ({
    id,
    type: "page",
    title: id,
    ...(section ? { section } : {}),
    fields: [{ id: `f${id}`, label: "F", kind: "text" }],
  });

  it("each once, in the order of the steps; a step without one belongs to the part before it", () => {
    const def = wizard([page("a"), page("b", "Eins"), page("c"), page("d", "Zwei"), end]);
    expect(sectionsOf(def)).toEqual(["Eins", "Zwei"]);
    expect(sectionOf(def, "a")).toBeNull();
    expect(sectionOf(def, "c")).toBe("Eins");
    expect(sectionOf(def, "done")).toBe("Zwei");
    expect(said(def)).toEqual([]);
  });

  it("steps standing together may repeat the name", () => {
    expect(said(wizard([page("a", "Eins"), page("b", "Eins"), end]))).toEqual([]);
  });

  it("a name that comes back after another is an issue", () => {
    const def = wizard([page("a", "A"), page("b", "B"), page("c", "A"), end]);
    expect(validateWizard(def)).toEqual([
      expect.objectContaining({ stepId: "c", message: expect.stringContaining('"A" comes back') }),
    ]);
  });

  it("a wizard without sections has none", () => {
    expect(sectionsOf(wizard([page("a"), end]))).toEqual([]);
  });
});

describe("1c: calculated values", () => {
  const work = (source: string, values: object = {}) => calcValue(source, calcScope(values));

  it("works out numbers and texts, answers as typed included", () => {
    expect(work("demo / budget", { demo: 9000, budget: "18000" })).toBe(0.5);
    expect(work("1 + 2 * 3")).toBe(7);
    expect(work("(1 + 2) * 3")).toBe(9);
    expect(work("-2 + 5")).toBe(3);
    expect(work("7 % 3")).toBe(1);
    expect(work("0.1 + 0.2")).toBe(0.3);
    expect(work('size == "Groß"', { size: "Groß" })).toBe(true);
    expect(work('"2" == 2')).toBe(true);
  });

  it("the functions, and nothing else", () => {
    expect(work("round(2.345, 2)")).toBe(2.35);
    expect(work("round(2.5)")).toBe(3);
    expect(work("min(3, 1, 2)")).toBe(1);
    expect(work("max(a)", { a: [1, 5] })).toBe(5);
    expect(work("count(items)", { items: [1, 2] })).toBe(2);
    expect(work("sum(items, price)", { items: [{ price: 2 }, { price: "3" }, {}] })).toBe(5);
    expect(work("sum(items)", { items: [1, 2] })).toBe(3);
    expect(work('if(a > 1, "viel", "wenig")', { a: 2 })).toBe("viel");
    expect(parseCalc("eval(1)")).toHaveProperty("error");
    expect(parseCalc("constructor(1)")).toHaveProperty("error");
    expect(parseCalc("if(1, 2)")).toHaveProperty("error");
  });

  it("what is not its language does not read", () => {
    for (const source of ["a = 1", "a[0]", "a;b", "`x`", "1 +", "(1", '"x', "a b", "a.b()"]) {
      expect(parseCalc(source), source).toHaveProperty("error");
    }
  });

  it("what cannot be worked out is empty", () => {
    expect(work("1 / 0")).toBeUndefined();
    expect(work("a + 1")).toBeUndefined();
    expect(work("a > 1")).toBeUndefined();
    expect(work('a + 1', { a: "nichts" })).toBeUndefined();
    expect(work("a == 1")).toBe(false);
    expect(work('a == ""')).toBe(true);
    expect(work("not a")).toBe(true);
  });

  it("names read own values only, as a key or key by key", () => {
    expect(work("steps.a.b", { "steps.a.b": 3 })).toBe(3);
    expect(work("row.x", { row: { x: 4 } })).toBe(4);
    expect(work("a.__proto__", { a: {} })).toBeUndefined();
    expect(work("constructor.name", {})).toBeUndefined();
  });

  it("lists the names it reads, without what a function names", () => {
    const node = parseCalc("sum(items, price) + if(a, b, lists.x.count)");
    expect("error" in node ? [] : calcNames(node).sort()).toEqual(["a", "b", "items", "lists.x.count"]);
  });

  it("is a third form of when, the same for fields and branches", () => {
    const when = { calc: "budget > demo * 2" };
    expect(whenHolds(when, { budget: 100, demo: 10 })).toBe(true);
    expect(whenHolds(when, { budget: 10, demo: 10 })).toBe(false);
    expect(whenHolds(when, {})).toBe(false);
    expect(ruleMatches({ when, goto: "x" } as never, { budget: 100, demo: 10 })).toBe(true);
    expect(whenHolds({ field: "a", op: "equals", value: "1" }, { a: "1" })).toBe(true);
  });

  const page = (extra: object = {}) => ({
    id: "ask",
    type: "page",
    title: "Frage",
    fields: [
      { id: "budget", label: "B", kind: "number" },
      { id: "note", label: "N", kind: "text", ...extra },
    ],
  });

  it("the validator reads a when's calculation like its conditions", () => {
    expect(said(wizard([page({ when: { calc: "budget > 2" } }), end]))).toEqual([]);
    expect(said(wizard([page({ when: { calc: "nope > 2" } }), end])).join()).toContain(
      '"when" reads "nope"',
    );
    expect(said(wizard([page({ when: { calc: "budget >" } }), end])).join()).toContain(
      "cannot be worked out",
    );
    const branch = (calc: string) =>
      wizard([{ ...page(), next: [{ when: { calc }, goto: "done" }] }, end]);
    expect(said(branch("budget > 2"))).toEqual([]);
    expect(said(branch("nope > 2")).join()).toContain('Branch reads unknown field "nope"');
  });

  it("a prop may be a calculation, written as the wizard writes numbers", () => {
    const data = { demo: 9000, budget: 18000 };
    expect(bound({ calc: "demo / budget", as: "percent" }, data, undefined, "de")).toMatch(/^50\s%$/);
    expect(bound({ calc: "demo", as: "number" }, data, undefined, "de")).toBe("9.000");
    expect(bound({ calc: "demo * 0" }, data)).toBe(0);
    expect(bound({ calc: "1 / 0" }, data)).toBe("–");
    expect(bound({ calc: "if(demo <= budget, 1, 2)", map: { "1": "im Rahmen" } }, data)).toBe(
      "im Rahmen",
    );
    expect(bound({ calc: "amount * 2" }, data, { amount: 3 })).toBe(6);
    expect(bound({ path: "/demo", as: "number" }, data, undefined, "de")).toBe("9.000");
    expect(bound({ path: "/demo" }, data)).toBe(9000);
  });

  it("format takes the columns of its row", () => {
    expect(worded(200, { format: "{} {unit}" }, { row: { unit: "g" } })).toBe("200 g");
    expect(worded(200, { format: "{} {other}" }, { row: {} })).toBe("200 {other}");
  });

  it("a view's calculations are checked at their place", () => {
    const view = (value: object) => [
      { id: "root", component: "Column", children: ["m"] },
      { id: "m", component: "Metric", label: "L", value },
    ];
    expect(validateSurface(view({ calc: "a + 1" }), ["a"])).toEqual([]);
    expect(validateSurface(view({ calc: "b + 1" }), ["a"])[0].message).toContain("reads \"b\"");
    expect(validateSurface(view({ calc: "a +" }), ["a"])[0].message).toContain("cannot be worked out");
    expect(validateSurface(view({ calc: "a", as: "money" }), ["a"])[0].message).toContain('"as"');
  });

  it("inside a repeat, a calculation reads the row", () => {
    const components = [
      { id: "root", component: "List", children: { path: "/rows", componentId: "row" } },
      { id: "row", component: "Metric", label: "L", value: { calc: "amount * 2" } },
    ];
    expect(validateSurface(components, ["rows"])).toEqual([]);
    const shape = {
      kind: "object",
      fields: {
        rows: { kind: "list", of: { kind: "object", fields: { amount: { kind: "number" } } } },
      },
    } as never;
    expect(validateSurface(components, shape)).toEqual([]);
    components[1].value = { calc: "nope * 2" };
    expect(validateSurface(components, shape)[0].message).toContain('reads "nope"');
  });
});

describe("1d: a page laid out with components", () => {
  const fields = [
    { id: "budget", label: "B", kind: "number" },
    { id: "name", label: "N", kind: "text" },
  ];
  const estimate = {
    id: "estimate",
    type: "agent",
    title: "Schätzung",
    instructions: "Schätze.",
    output: {
      format: "json",
      fields: [{ id: "total", kind: "number", description: "Die Summe" }],
    },
  };
  const layout = (more: object[] = [], keep: string[] = ["b", "n"]) => [
    { id: "root", component: "Column", children: [...keep, ...more.map((m: any) => m.id)] },
    { id: "b", component: "Field", name: "budget" },
    { id: "n", component: "Field", name: "name" },
    ...more,
  ];
  const page = (components: unknown, data?: object) =>
    wizard([
      estimate,
      {
        id: "ask",
        type: "page",
        title: "Frage",
        fields,
        ...(components ? { components } : {}),
        ...(data ? { data } : {}),
      },
      end,
    ]);

  it("places its fields, with figures between them that read answers and data", () => {
    const fit = {
      id: "fit",
      component: "Metric",
      label: "Anteil",
      value: { calc: "demo / budget", as: "percent" },
    };
    expect(said(page(layout([fit]), { demo: "steps.estimate.total" }))).toEqual([]);
  });

  it("a page without components is as it was", () => {
    expect(said(page(null))).toEqual([]);
  });

  it("every field has its place, once", () => {
    expect(said(page(layout([], ["b"]).slice(0, 2))).join()).toContain('"name" has no place');
    const twice = layout([{ id: "again", component: "Field", name: "budget" }]);
    expect(said(page(twice)).join()).toContain('"budget" is placed 2 times');
  });

  it("a Field names a field of this page and says nothing else", () => {
    const other = layout([{ id: "x", component: "Field", name: "nope" }]);
    expect(said(page(other)).join()).toContain('names "nope"');
    const words = layout();
    (words[1] as any).label = "Budget";
    expect(said(page(words)).join()).toContain('"name" and nothing else');
  });

  it("what it reads has to be there", () => {
    const fit = { id: "fit", component: "Metric", label: "A", value: { calc: "nope * 2" } };
    expect(said(page(layout([fit]))).join()).toContain('reads "nope"');
    expect(said(page(layout(), { demo: "steps.nope.total" })).length).toBeGreaterThan(0);
    expect(said(page(layout(), { budget: "steps.estimate.total" })).join()).toContain(
      "also a field",
    );
    expect(said(page(null, { demo: "steps.estimate.total" })).join()).toContain(
      'only with "components"',
    );
  });

  it("a page that reads a stored list says it needs one", () => {
    const def = wizard([
      {
        id: "ask",
        type: "page",
        title: "Frage",
        fields,
        components: layout(),
        data: { rows: "lists.kunden" },
      },
      end,
    ]);
    expect(needs(def.steps[0], def)).toContainEqual(
      expect.objectContaining({ stepId: "ask", need: "lists" }),
    );
  });

  it("the usual checks hold: a root, children that exist", () => {
    expect(said(page([{ id: "b", component: "Field", name: "budget" }])).join()).toContain("root");
  });

  it("a Field stays out of a wizard's other views, and asks in full in a chat", () => {
    const view = [
      { id: "root", component: "Column", children: ["f"] },
      { id: "f", component: "Field", name: "x" },
    ];
    expect(validateSurface(view)[0].message).toContain("is for a chat's view");
    const form = [
      { id: "root", component: "Form", submit: "Los", children: ["f"] },
      { id: "f", component: "Field", name: "x" },
    ];
    const chat = validateSurface(form, undefined, { chat: true }).map((i) => i.message);
    expect(chat).toContain('Field "f" needs "kind".');
    expect(chat).toContain('Field "f" needs "label".');
  });
});

describe("1e: inputs in a wizard's views", () => {
  const view = (...more: object[]) => [
    { id: "root", component: "Column", children: more.map((m: any) => m.id) },
    ...more,
  ];
  const choice = {
    id: "people",
    component: "Choice",
    state: "servings",
    default: 2,
    options: [
      { label: "2 Personen", value: 2 },
      { label: "4 Personen", value: 4 },
    ],
  };
  const messages = (...args: Parameters<typeof validateSurface>) =>
    validateSurface(...args).map((i) => i.message);

  it("are fine in a view, and read like a data key", () => {
    const figure = { id: "m", component: "Metric", label: "L", value: { calc: "servings * 2" } };
    const path = { id: "t", component: "Text", text: { path: "/servings" } };
    expect(messages(view(choice, figure, path), [])).toEqual([]);
    expect(
      messages(view(choice, figure, path), { kind: "object", fields: {} } as never),
    ).toEqual([]);
    const toggle = { id: "x", component: "Toggle", state: "vegan", label: "Vegan" };
    const slider = { id: "y", component: "Slider", state: "size", min: 1, max: 9, increment: 2 };
    expect(messages(view(toggle, slider), [])).toEqual([]);
  });

  it("the example from the plan, a recipe whose quantities follow the choice", () => {
    const components = view(choice, {
      id: "list",
      component: "Checklist",
      items: { path: "/ingredients" },
      labelKey: "name",
      detail: { calc: "round(amount * servings / 2)", format: "{} {unit}" },
    });
    expect(messages(components, ["ingredients"])).toEqual([]);
    const shape = {
      kind: "object",
      fields: {
        ingredients: {
          kind: "list",
          of: {
            kind: "object",
            fields: {
              name: { kind: "text" },
              amount: { kind: "number" },
              unit: { kind: "text" },
            },
          },
        },
      },
    } as never;
    expect(messages(components, shape)).toEqual([]);
    (components[2] as any).detail = { calc: "nope * servings" };
    expect(messages(components, shape).join()).toContain('reads "nope"');
    expect(
      bound({ calc: "round(amount * servings / 2)", format: "{} {unit}" }, { servings: 4 }, {
        amount: 100,
        unit: "g",
      }),
    ).toBe("200 g");
  });

  it("never on a page, and never in a chat's view", () => {
    const page = wizard([
      {
        id: "ask",
        type: "page",
        title: "Frage",
        fields: [{ id: "f", label: "F", kind: "text" }],
        components: view({ id: "b", component: "Field", name: "f" }, choice),
      },
      end,
    ]);
    expect(said(page).join()).toContain("on a page, a field asks");
    expect(messages(view(choice), [], { chat: true }).join()).toContain("not a chat's");
  });

  it("a state name is its own", () => {
    expect(messages(view(choice, { ...choice, id: "again" }), []).join()).toContain("named twice");
    expect(messages(view(choice), ["servings"]).join()).toContain("also a data key");
    const list = { id: "servings", component: "Checklist", items: [] };
    expect(messages(view(choice, list), []).join()).toContain("id of a Checklist");
  });

  it("each has what it needs", () => {
    expect(messages(view({ id: "c", component: "Choice", state: "a" }), []).join()).toContain(
      'needs "options"',
    );
    expect(
      messages(view({ id: "c", component: "Choice", state: "a", options: [] }), []).join(),
    ).toContain("values, or { label, value }");
    expect(messages(view({ id: "t", component: "Toggle", state: "a" }), []).join()).toContain(
      'needs "label"',
    );
    expect(
      messages(view({ id: "s", component: "Slider", state: "a", min: 5, max: 1 }), []).join(),
    ).toContain("min below max");
  });
});
