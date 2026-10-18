import { describe, expect, it } from "vitest";
import {
  type AgentStep,
  branchValues,
  isDecisionStep,
  itemsTotals,
  nextStepId,
  parseWizard,
} from "@engenty/wizards-shared/definition";
import { EXAMPLE_WIZARD } from "../src/authoring/example";

// The marketplace's entries are checked where they live (the marketplace app); the guide's
// example is this repo's own.
describe("the authoring guide's example", () => {
  it("is a valid wizard", () => {
    const parsed = parseWizard(EXAMPLE_WIZARD);
    expect(parsed.ok).toBe(true);
    expect(parsed.issues).toEqual([]);
  });
});

describe("validator", () => {
  it("rejects a template naming a later field", () => {
    const parsed = parseWizard({
      title: "x",
      steps: [
        { id: "a", type: "agent", title: "A", instructions: "use {{topic}}", tools: [] },
        { id: "p", type: "page", title: "P", fields: [{ id: "topic", label: "T", kind: "text" }] },
        { id: "r", type: "result", title: "R", deliverables: [{ from: "a", formats: ["md"] }] },
      ],
    });
    expect(parsed.ok && parsed.issues.map((i) => i.message).join()).toContain("topic");
  });

  it("follows branches", () => {
    const parsed = parseWizard({
      title: "x",
      steps: [
        { id: "p", type: "page", title: "P", fields: [{ id: "kind", label: "K", kind: "select", options: ["a", "b"] }], next: [{ when: { field: "kind", op: "equals", value: "b" }, goto: "r" }] },
        { id: "q", type: "page", title: "Q", fields: [{ id: "x", label: "X", kind: "text" }] },
        { id: "r", type: "result", title: "R", deliverables: [] },
      ],
    });
    if (!parsed.ok) throw new Error("invalid");
    expect(nextStepId(parsed.wizard, "p", { kind: "b" })).toBe("r");
    expect(nextStepId(parsed.wizard, "p", { kind: "a" })).toBe("q");
  });
});

describe("decisions", () => {
  const fields = [
    { id: "refund", kind: "yesno", description: "Does the customer ask for money back?" },
    { id: "topic", kind: "choice", options: ["delivery", "billing"] },
  ];
  /** A wizard whose second step judges a mail; `step` overrides parts of that step. */
  const wizard = (step: Record<string, unknown> = {}) => ({
    title: "x",
    steps: [
      { id: "p", type: "page", title: "P", fields: [{ id: "mail", label: "M", kind: "textarea" }] },
      {
        id: "check",
        type: "agent",
        title: "Check",
        instructions: "Judge {{mail}}",
        model: "classifier",
        output: { format: "json", fields },
        ...step,
      },
      { id: "thanks", type: "agent", title: "Thanks", instructions: "Write a thank-you note." },
      { id: "refund", type: "agent", title: "Refund", instructions: "Write the refund note." },
      { id: "r", type: "result", title: "R", deliverables: [{ from: "check", formats: ["json"] }] },
    ],
  });
  const checkStep = (step: Record<string, unknown> = {}) => {
    const parsed = parseWizard(wizard(step));
    if (!parsed.ok) {
      throw new Error(parsed.issues.map((i) => i.message).join("; "));
    }
    return parsed.wizard.steps[1] as AgentStep;
  };

  it("takes yes/no and choice fields; a choice lists its options", () => {
    expect(isDecisionStep(checkStep())).toBe(true);
    const bare = parseWizard(
      wizard({ output: { format: "json", fields: [{ id: "topic", kind: "choice" }] } }),
    );
    expect(bare.ok).toBe(false);
  });

  it("is a decision only on the classifier class, without tools and other fields", () => {
    expect(isDecisionStep(checkStep({ model: "standard" }))).toBe(false);
    expect(isDecisionStep(checkStep({ tools: ["web_search"] }))).toBe(false);
    expect(
      isDecisionStep(
        checkStep({ output: { format: "json", fields: [...fields, { id: "why", kind: "text" }] } }),
      ),
    ).toBe(false);
  });

  it("branches on a yes/no answer", () => {
    const parsed = parseWizard(
      wizard({
        next: [{ when: { field: "steps.check.refund", op: "equals", value: true }, goto: "refund" }],
      }),
    );
    if (!parsed.ok) {
      throw new Error("invalid");
    }
    const after = (refund: boolean) =>
      nextStepId(
        parsed.wizard,
        "check",
        branchValues({ mail: "…" }, { check: { json: { refund, topic: "delivery" } } }),
      );
    expect(after(true)).toBe("refund");
    expect(after(false)).toBe("thanks");
  });

  it("refuses a branch on an output field the step does not have", () => {
    const parsed = parseWizard(
      wizard({
        next: [{ when: { field: "steps.check.nope", op: "equals", value: true }, goto: "refund" }],
      }),
    );
    expect(parsed.issues.map((i) => i.message)).toEqual([
      'Branch reads unknown field "steps.check.nope".',
    ]);
  });
});

describe("line items", () => {
  it("computes net, VAT and total", () => {
    const field = {
      id: "items",
      label: "Items",
      kind: "items" as const,
      columns: [
        { id: "d", label: "D", kind: "text" as const },
        { id: "q", label: "Q", kind: "number" as const },
        { id: "p", label: "P", kind: "money" as const },
      ],
      vat: { field: "tax" },
    };
    const t = itemsTotals(field, [{ d: "a", q: 2, p: 100 }, { d: "b", q: 1.5, p: 80.5 }], { tax: "20" });
    expect(t.net).toBe(320.75);
    expect(t.vat).toBe(64.15);
    expect(t.gross).toBe(384.9);
  });

  it("totals amounts typed with a decimal comma, as a German number pad gives them", () => {
    const field = {
      id: "items",
      label: "Items",
      kind: "items" as const,
      columns: [
        { id: "q", label: "Q", kind: "number" as const },
        { id: "p", label: "P", kind: "money" as const },
      ],
      vat: { rate: 20 },
    };
    const t = itemsTotals(field, [{ q: "42", p: "1,62" }, { q: "1", p: " 89,90 " }, { q: "x", p: "5" }], {});
    expect(t.net).toBe(157.94);
    expect(t.gross).toBe(189.53);
  });
});

describe("a widget's files", () => {
  const film = {
    title: "x",
    steps: [
      { id: "w", type: "widget", title: "W", entry: "film/ad.html", sample: "film/ad.sample.json" },
      { id: "r", type: "result", title: "R", deliverables: [{ from: "w", formats: ["mp4"] }] },
    ],
  };
  it("are all there", () => {
    expect(parseWizard(film, ["film/ad.html", "film/ad.sample.json"]).issues).toEqual([]);
  });
  it("are named where one is missing", () => {
    const { issues } = parseWizard(film, ["film/ad.html"]);
    expect(issues.map((i) => i.stepId)).toEqual(["w"]);
  });
});

describe("one result per entry, prefilled fields, lists gone through row by row", () => {
  const wizard = (steps: unknown[], lists?: unknown[]) =>
    parseWizard({ title: "x", lists, steps: [...steps, { id: "r", type: "result", title: "R", deliverables: [] }] });
  const shots = {
    id: "script",
    type: "agent",
    title: "S",
    instructions: "write",
    tools: [],
    output: { format: "json", fields: [{ id: "shots", kind: "table", columns: ["still"] }] },
  };

  it("takes a table of an earlier step as the entries of an image step", () => {
    const parsed = wizard([
      shots,
      { id: "stills", type: "generate", title: "I", asset: "image", each: "steps.script.shots", prompt: "{{item.still}} {{index}}/{{count}}" },
      { id: "clips", type: "generate", title: "V", asset: "video", each: "steps.script.shots", referenceImage: "stills", prompt: "move" },
    ]);
    expect(parsed.issues).toEqual([]);
  });

  it("refuses {{item}} without each, and each on a document", () => {
    const parsed = wizard([
      shots,
      { id: "a", type: "generate", title: "I", asset: "image", prompt: "{{item.still}}" },
      { id: "b", type: "generate", title: "D", asset: "document", each: "steps.script.shots", prompt: "x" },
    ]);
    expect(parsed.issues.map((i) => i.stepId)).toEqual(["a", "b"]);
  });

  it("refuses a prefill that names no earlier step", () => {
    const parsed = wizard([
      { id: "p", type: "page", title: "P", fields: [{ id: "items", label: "I", kind: "items", columns: [{ id: "d", label: "D", kind: "text" }], prefill: "steps.later.rows" }] },
    ]);
    expect(parsed.issues).toHaveLength(1);
  });

  it("wants a select as the status of a list that is gone through", () => {
    const columns = [
      { id: "file", name: "File", type: "text" },
      { id: "state", name: "State", type: "text" },
    ];
    const parsed = wizard([], [{ id: "docs", title: "Docs", columns, check: { file: "file", status: "state" } }]);
    expect(parsed.issues.map((i) => i.message)).toEqual([
      'List "docs": check.status "state" must be a select.',
    ]);
  });
});

describe("how many files a field takes", () => {
  const photos = (extra: Record<string, unknown>) =>
    parseWizard({
      title: "x",
      steps: [
        {
          id: "p",
          type: "page",
          title: "P",
          fields: [{ id: "photos", label: "Photos", kind: "image", ...extra }],
        },
        { id: "r", type: "result", title: "R", deliverables: [] },
      ],
    });

  it("takes min and max on a field with several files", () => {
    expect(photos({ multiple: true, min: 2, max: 6 }).issues).toEqual([]);
  });

  it("refuses them on a single file, and a min above the max", () => {
    expect(photos({ max: 3 }).issues).toHaveLength(1);
    expect(photos({ multiple: true, min: 5, max: 2 }).issues).toHaveLength(1);
  });
});

describe("a wizard's style", () => {
  const steps = [
    { id: "p", type: "page", title: "P", fields: [{ id: "topic", label: "T", kind: "text" }] },
    { id: "r", type: "result", title: "R", deliverables: [] },
  ];

  it("takes colours, typefaces, effects and CSS", () => {
    const parsed = parseWizard({
      title: "x",
      style: {
        accent: "#ff7a1a",
        background: "#120a1c",
        dark: true,
        displayFont: "Creepster",
        bodyFont: "Nunito",
        effects: ["glow", "webs", "bats", "fog"],
        css: "h1 { letter-spacing: 0.04em; }",
      },
      steps,
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.issues).toEqual([]);
  });

  it("refuses a font it does not ship and a colour it cannot read", () => {
    expect(parseWizard({ title: "x", style: { displayFont: "Comic Sans" }, steps }).ok).toBe(false);
    expect(parseWizard({ title: "x", style: { accent: "orange" }, steps }).ok).toBe(false);
  });

  it("names what its CSS would load", () => {
    const parsed = parseWizard({
      title: "x",
      style: { css: "@import 'a.css'; body { background: url(x.png) }" },
      steps,
    });
    expect(parsed.issues.map((i) => i.message).join(" ")).toMatch(/url\(\).*@import/);
  });
});
