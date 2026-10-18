import {
  branchValues,
  conditionMatches,
  nextStepId,
  cardsFromData,
  optionsFromData,
  type PageStep,
  pageNeeds,
  parseWizard,
  shownFields,
  slotDayText,
  slotText,
  type WizardDefinition,
} from "@engenty/wizards-shared/definition";
import { describe, expect, it } from "vitest";
import { readPageInput } from "../src/engine/input";
import { unavoidableSteps } from "../src/engine/requirements";

function valid(input: unknown): WizardDefinition {
  const parsed = parseWizard(input);
  if (!parsed.ok) {
    throw new Error(parsed.issues.map((i) => i.message).join("; "));
  }
  expect(parsed.issues).toEqual([]);
  return parsed.wizard;
}

function issuesOf(input: unknown): string {
  const parsed = parseWizard(input);
  return parsed.issues.map((i) => i.message).join(" | ");
}

const result = { id: "r", type: "result", title: "R", deliverables: [] };

describe("conditions", () => {
  it("compare numbers, typed the German way too", () => {
    expect(conditionMatches({ field: "a", op: "gt", value: 500 }, { a: "612,50" })).toBe(true);
    expect(conditionMatches({ field: "a", op: "gt", value: 500 }, { a: 500 })).toBe(false);
    expect(conditionMatches({ field: "a", op: "lt", value: 3 }, { a: 2 })).toBe(true);
    expect(conditionMatches({ field: "a", op: "lt", value: 3 }, { a: "" })).toBe(false);
  });

  it("look into multiselects, lists and texts", () => {
    const c = { field: "a", op: "contains" as const, value: "Nuts" };
    expect(conditionMatches(c, { a: ["Gluten", "Nuts"] })).toBe(true);
    expect(conditionMatches(c, { a: ["Gluten"] })).toBe(false);
    expect(conditionMatches(c, { a: "no nuts please" })).toBe(true);
    expect(conditionMatches(c, {})).toBe(false);
  });

  it("in a list must all hold", () => {
    const def = valid({
      title: "x",
      steps: [
        {
          id: "p",
          type: "page",
          title: "P",
          fields: [
            { id: "kind", label: "K", kind: "select", options: ["ship", "pickup"] },
            { id: "amount", label: "A", kind: "number" },
          ],
          next: [
            {
              when: [
                { field: "kind", op: "equals", value: "ship" },
                { field: "amount", op: "gt", value: 500 },
              ],
              goto: "approve",
            },
          ],
        },
        { id: "plain", type: "page", title: "Plain", fields: [{ id: "x", label: "X", kind: "text" }] },
        { id: "approve", type: "page", title: "Approve", fields: [{ id: "y", label: "Y", kind: "text" }] },
        result,
      ],
    });
    expect(nextStepId(def, "p", { kind: "ship", amount: 900 })).toBe("approve");
    expect(nextStepId(def, "p", { kind: "ship", amount: 100 })).toBe("plain");
    expect(nextStepId(def, "p", { kind: "pickup", amount: 900 })).toBe("plain");
  });

  it("read how many rows a stored list has", () => {
    const def = valid({
      title: "x",
      lists: [{ id: "seen", title: "Seen", columns: [{ id: "name", name: "Name", type: "text" }] }],
      steps: [
        {
          id: "p",
          type: "page",
          title: "P",
          fields: [{ id: "x", label: "X", kind: "text" }],
          next: [{ when: { field: "lists.seen.count", op: "gt", value: 0 }, goto: "r" }],
        },
        { id: "first", type: "page", title: "First", fields: [{ id: "y", label: "Y", kind: "text" }] },
        result,
      ],
    });
    expect(nextStepId(def, "p", branchValues({}, {}, { seen: 2 }))).toBe("r");
    expect(nextStepId(def, "p", branchValues({}, {}, { seen: 0 }))).toBe("first");
  });

  it("are checked by the validator", () => {
    const text = issuesOf({
      title: "x",
      steps: [
        {
          id: "p",
          type: "page",
          title: "P",
          fields: [{ id: "a", label: "A", kind: "number" }],
          next: [
            { when: { field: "a", op: "gt", value: "500" }, goto: "r" },
            { when: { field: "lists.nope.count", op: "gt", value: 1 }, goto: "r" },
            { when: { field: "a", op: "in", value: "1" }, goto: "r" },
          ],
        },
        result,
      ],
    });
    expect(text).toContain('"gt" on "a" compares with a number value');
    expect(text).toContain('Branch reads unknown field "lists.nope.count"');
    expect(text).toContain('"in" on "a" needs a list of values');
  });

  it("keep old definitions readable", () => {
    valid({
      title: "x",
      steps: [
        {
          id: "p",
          type: "page",
          title: "P",
          fields: [{ id: "k", label: "K", kind: "toggle" }],
          next: [{ when: { field: "k", op: "equals", value: true }, goto: "r" }],
        },
        result,
      ],
    });
  });
});

describe("fields shown under a condition", () => {
  const page: PageStep = {
    id: "p",
    type: "page",
    title: "P",
    fields: [
      { id: "delivery", label: "Delivery", kind: "select", options: ["ship", "pickup"], required: true },
      {
        id: "street",
        label: "Street",
        kind: "text",
        required: true,
        when: { field: "delivery", op: "equals", value: "ship" },
      },
      {
        id: "door",
        label: "Door code",
        kind: "text",
        when: { field: "street", op: "notEmpty" },
      },
    ],
  };

  it("show and hide as the page is filled, and a hidden field hides what depends on it", () => {
    const ids = (values: Record<string, unknown>) =>
      shownFields(page.fields, {}, values).map((f) => f.id);
    expect(ids({ delivery: "ship" })).toEqual(["delivery", "street"]);
    expect(ids({ delivery: "ship", street: "Herrengasse 16" })).toEqual(["delivery", "street", "door"]);
    expect(ids({ delivery: "pickup", street: "Herrengasse 16" })).toEqual(["delivery"]);
  });

  it("are not required and not kept while hidden", () => {
    const hidden = readPageInput(page, { delivery: "pickup", street: "left over", door: "12" });
    expect(hidden.errors).toEqual([]);
    expect(hidden.values).toEqual({ delivery: "pickup" });

    const missing = readPageInput(page, { delivery: "ship" });
    expect(missing.errors.map((e) => e.field)).toEqual(["street"]);
  });

  it("read what is known before the page", () => {
    const later: PageStep = {
      ...page,
      fields: [{ id: "note", label: "Note", kind: "text", required: true, when: { field: "steps.check.urgent", op: "equals", value: true } }],
    };
    expect(pageNeeds(later.fields)).toEqual(["steps.check.urgent"]);
    expect(readPageInput(later, {}, { known: { "steps.check.urgent": false } }).errors).toEqual([]);
    expect(readPageInput(later, {}, { known: { "steps.check.urgent": true } }).errors).toHaveLength(1);
  });

  it("are checked by the validator", () => {
    const text = issuesOf({
      title: "x",
      steps: [
        {
          id: "p",
          type: "page",
          title: "P",
          fields: [
            { id: "a", label: "A", kind: "text", when: { field: "later", op: "notEmpty" } },
          ],
        },
        { id: "q", type: "page", title: "Q", fields: [{ id: "later", label: "L", kind: "text" }] },
        result,
      ],
    });
    expect(text).toContain('Field "a": "when" reads "later"');
  });
});

describe("choices from earlier data", () => {
  const research = {
    id: "research",
    type: "agent",
    title: "Research",
    instructions: "find suppliers",
    tools: [],
    output: {
      format: "json",
      fields: [
        { id: "names", kind: "list", description: "Supplier names" },
        { id: "suppliers", kind: "table", columns: ["name", "city"], description: "Suppliers" },
      ],
    },
  };

  it("come from a list output, a table column or a stored list", () => {
    const outputs = {
      research: {
        json: {
          names: ["Holz Huber", "Holz Huber", " ", "Sägewerk Mayr"],
          suppliers: [
            { name: "Holz Huber", city: "Graz" },
            { name: "Sägewerk Mayr", city: "Leoben" },
          ],
        },
      },
    };
    expect(optionsFromData("steps.research.names", outputs)).toEqual(["Holz Huber", "Sägewerk Mayr"]);
    expect(optionsFromData("steps.research.suppliers.city", outputs)).toEqual(["Graz", "Leoben"]);
    expect(
      optionsFromData("lists.customers.name", {}, {
        customers: { rows: [{ cells: { name: "Anna" } }, { cells: { name: "Ben" } }] },
      }),
    ).toEqual(["Anna", "Ben"]);
    expect(optionsFromData("steps.research.missing", outputs)).toEqual([]);
  });

  it("come as cards from a table's rows, the value an id column", () => {
    const outputs = {
      search: {
        json: {
          products: [
            { id: "p1", title: "Sunset Glow", price: "89,00 €", image: "https://x.test/s.jpg", url: "https://x.test/p/s" },
            { id: "p2", title: "Golden Hour", price: 79, image: "nope", url: "ftp://x" },
            { id: "p2", title: "twice" },
            { title: "no id, the label counts" },
            { id: "", title: "" },
          ],
        },
      },
    };
    const cards = { label: "title", value: "id", image: "image", meta: "price", link: "url" };
    expect(cardsFromData("steps.search.products", outputs, cards)).toEqual([
      { value: "p1", label: "Sunset Glow", image: "https://x.test/s.jpg", meta: "89,00 €", link: "https://x.test/p/s" },
      { value: "p2", label: "Golden Hour", meta: "79" },
      { value: "no id, the label counts", label: "no id, the label counts" },
    ]);
    expect(optionsFromData("steps.search.products", outputs, {}, cards)).toEqual(["p1", "p2", "no id, the label counts"]);
    expect(cardsFromData("steps.search.products.id", outputs, cards)).toEqual([]);
  });

  it("are checked by the validator", () => {
    const wizard = (field: Record<string, unknown>, columns?: string[]) =>
      parseWizard({
        title: "x",
        steps: [
          {
            id: "search",
            type: "agent",
            title: "S",
            instructions: "find",
            tools: [],
            output: { format: "json", fields: [{ id: "products", kind: "table", description: "p", ...(columns ? { columns } : {}) }, { id: "names", kind: "list", description: "n" }] },
          },
          { id: "pick", type: "page", title: "P", fields: [{ id: "f", label: "F", kind: "multiselect", optionsFrom: "steps.search.products", ...field }] },
          { id: "r", type: "result", title: "R", deliverables: [] },
        ],
      });
    const issues = (parsed: ReturnType<typeof parseWizard>) =>
      parsed.ok ? parsed.issues.map((i) => i.message).join("\n") : "invalid";
    expect(issues(wizard({ cards: { label: "title", value: "id" } }, ["id", "title"]))).toBe("");
    expect(issues(wizard({ cards: { label: "title", image: "img" } }, ["id", "title"]))).toContain('no column "img"');
    expect(issues(wizard({}))).toContain("a table takes a column");
    expect(issues(wizard({ optionsFrom: "steps.search.names", cards: { label: "x" } }))).toContain("is not a table");
    expect(issues(wizard({ optionsFrom: undefined, cards: { label: "x" } }))).toContain('needs "optionsFrom"');
  });

  it("are what the page accepts", () => {
    const page: PageStep = {
      id: "p",
      type: "page",
      title: "P",
      fields: [{ id: "supplier", label: "S", kind: "select", optionsFrom: "steps.research.names", options: ["Other"] }],
    };
    const options = { supplier: ["Holz Huber"] };
    expect(readPageInput(page, { supplier: "Holz Huber" }, { options }).errors).toEqual([]);
    expect(readPageInput(page, { supplier: "Other" }, { options }).errors).toHaveLength(1);
    // Without data the fixed choices stand in.
    expect(readPageInput(page, { supplier: "Other" }).errors).toEqual([]);
  });

  it("are checked by the validator", () => {
    valid({
      title: "x",
      steps: [
        research,
        {
          id: "p",
          type: "page",
          title: "P",
          fields: [
            { id: "a", label: "A", kind: "select", optionsFrom: "steps.research.names" },
            { id: "b", label: "B", kind: "multiselect", optionsFrom: "steps.research.suppliers.city" },
          ],
        },
        result,
      ],
    });
    const text = issuesOf({
      title: "x",
      steps: [
        research,
        {
          id: "p",
          type: "page",
          title: "P",
          fields: [
            { id: "a", label: "A", kind: "select", optionsFrom: "steps.research.suppliers" },
            { id: "b", label: "B", kind: "select", optionsFrom: "steps.research.suppliers.zip" },
            { id: "c", label: "C", kind: "text", optionsFrom: "steps.research.names" },
          ],
        },
        result,
      ],
    });
    expect(text).toContain('"research.suppliers" is not a list');
    expect(text).toContain('is not a table with the column "zip"');
    expect(text).toContain('"optionsFrom" fills the choices of a select');
  });
});

describe("appointment slots", () => {
  const free = {
    id: "free",
    type: "agent",
    title: "Free times",
    instructions: "find free times",
    tools: [],
    output: {
      format: "json",
      fields: [{ id: "slots", kind: "table", columns: ["start", "label"], description: "Free times" }],
    },
  };
  const page: PageStep = {
    id: "p",
    type: "page",
    title: "P",
    fields: [{ id: "when", label: "When", kind: "slot", required: true, optionsFrom: "steps.free.slots.start" }],
  };
  const options = { when: ["2026-10-12T09:00:00+02:00", "2026-10-13T10:30:00+02:00"] };

  it("need options, and fixed ones must be date-times with their offset", () => {
    valid({ title: "x", steps: [free, page, result] });
    const text = issuesOf({
      title: "x",
      steps: [
        {
          id: "p",
          type: "page",
          title: "P",
          fields: [
            { id: "a", label: "A", kind: "slot" },
            { id: "b", label: "B", kind: "slot", options: ["2026-10-12T09:00:00+02:00", "Monday 9am"] },
            { id: "c", label: "C", kind: "slot", options: ["2026-10-12T09:00:00"] },
          ],
        },
        result,
      ],
    });
    expect(text).toContain('Field "a" needs options.');
    expect(text).toContain('Field "b": "Monday 9am" is not a date and time');
    expect(text).toContain('Field "c": "2026-10-12T09:00:00" is not a date and time');
  });

  it("accept an offered time and refuse another", () => {
    expect(readPageInput(page, { when: "2026-10-13T10:30:00+02:00" }, { options })).toEqual({
      values: { when: "2026-10-13T10:30:00+02:00" },
      errors: [],
    });
    // The same moment in another offset is the offered time.
    expect(readPageInput(page, { when: "2026-10-12T07:00:00Z" }, { options }).values).toEqual({
      when: "2026-10-12T09:00:00+02:00",
    });
    expect(readPageInput(page, { when: "2026-10-12T09:30:00+02:00" }, { options }).errors).toHaveLength(1);
    // Without free times nothing can be picked.
    expect(readPageInput(page, { when: "2026-10-12T09:00:00+02:00" }).errors).toHaveLength(1);
  });

  it("read as day and time on their own clock", () => {
    expect(slotText("2026-10-13T10:30:00+02:00", "de")).toBe("Di 13.10.2026, 10:30");
    expect(slotText("2026-10-13T10:30:00+02:00", "en")).toBe("Tue 13/10/2026, 10:30");
    // Late in the evening in New York is already the next day in Europe; it stays that evening.
    expect(slotDayText("2026-10-12T23:30:00-04:00", "de")).toBe("Montag, 12. Oktober");
    expect(slotDayText("2026-10-12T23:30:00-04:00", "en")).toBe("Monday, 12 October");
  });
});

describe("requirements with condition lists", () => {
  it("treat a step behind a two-condition branch as avoidable", () => {
    const def = valid({
      title: "x",
      steps: [
        {
          id: "p",
          type: "page",
          title: "P",
          fields: [
            { id: "a", label: "A", kind: "toggle" },
            { id: "n", label: "N", kind: "number" },
          ],
          next: [
            {
              when: [
                { field: "a", op: "equals", value: true },
                { field: "n", op: "gt", value: 3 },
              ],
              goto: "r",
            },
          ],
        },
        { id: "extra", type: "page", title: "E", fields: [{ id: "x", label: "X", kind: "text" }] },
        result,
      ],
    });
    expect([...unavoidableSteps(def)].sort()).toEqual(["p", "r"]);
  });
});

describe("an otherwise branch", () => {
  // A step only some runs take sits after the page that branches to it; every other run goes
  // past it through the page's otherwise branch, and the step goes on to the same place.
  const def = () =>
    valid({
      title: "x",
      steps: [
        {
          id: "p",
          type: "page",
          title: "P",
          fields: [{ id: "n", label: "N", kind: "number" }],
          next: [{ when: { field: "n", op: "lt", value: 100 }, goto: "small" }, { goto: "after" }],
        },
        { id: "small", type: "page", title: "S", fields: [{ id: "s", label: "S", kind: "text" }] },
        { id: "after", type: "page", title: "A", fields: [{ id: "a", label: "A", kind: "text" }] },
        result,
      ],
    });

  it("leads every other run past the branch step", () => {
    expect(nextStepId(def(), "p", { n: 50 })).toBe("small");
    expect(nextStepId(def(), "p", { n: 500 })).toBe("after");
    expect(nextStepId(def(), "small", {})).toBe("after");
  });

  it("makes the branch step avoidable", () => {
    expect([...unavoidableSteps(def())].sort()).toEqual(["after", "p", "r"]);
  });

  it("is one per step and never carries a condition and a statement", () => {
    const twice = issuesOf({
      title: "x",
      steps: [
        {
          id: "p",
          type: "page",
          title: "P",
          fields: [{ id: "n", label: "N", kind: "number" }],
          next: [{ goto: "r" }, { goto: "r" }],
        },
        result,
      ],
    });
    expect(twice).toContain("at most one");
    expect(
      parseWizard({
        title: "x",
        steps: [
          {
            id: "p",
            type: "page",
            title: "P",
            fields: [{ id: "n", label: "N", kind: "number" }],
            next: [{ when: { field: "n", op: "notEmpty" }, ask: "Yes", goto: "r" }],
          },
          result,
        ],
      }).ok,
    ).toBe(false);
  });
});
