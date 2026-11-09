import { describe, expect, it } from "vitest";
import {
  type AgentStep,
  branchValues,
  DEFINITION_VERSION,
  isDecisionStep,
  itemsTotals,
  nextStepId,
  parseWizard,
  waitDurationMs,
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

describe("onFail", () => {
  const wizard = (onFail: string) => ({
    version: 1,
    title: "On fail",
    description: "",
    avatar: "round",
    steps: [
      { id: "work", type: "agent", title: "W", instructions: "x", tools: [], output: { format: "text" }, onFail },
      { id: "done", type: "result", title: "Fertig", deliverables: [] },
    ],
  });

  it("goes to a step of the wizard", () => {
    expect(parseWizard(wizard("done")).issues).toEqual([]);
  });

  it("refuses a step that isn't there, and the step itself", () => {
    expect(parseWizard(wizard("nowhere")).issues.map((i) => i.message)).toEqual([
      'onFail goes to unknown step "nowhere".',
    ]);
    expect(parseWizard(wizard("work")).issues.map((i) => i.message)).toEqual([
      "A step can't go to itself when it fails.",
    ]);
  });

  it("a wizard without it stays as it was", () => {
    const { onFail: _, ...plain } = wizard("done").steps[0];
    const parsed = parseWizard({ ...wizard("done"), steps: [plain, wizard("done").steps[1]] });
    expect(parsed.ok && parsed.wizard.steps[0]).not.toHaveProperty("onFail");
    expect(parsed.issues).toEqual([]);
  });
});

describe("a wait step", () => {
  const wizard = (wait: object, more: object[] = []) => ({
    version: 1,
    title: "Wait",
    description: "",
    avatar: "round",
    steps: [
      { id: "ask", type: "page", title: "Ask", fields: [{ id: "due", kind: "text", label: "D" }] },
      { id: "pause", type: "wait", title: "Pause", ...wait },
      ...more,
      { id: "done", type: "result", title: "Fertig", deliverables: [] },
    ],
  });
  const messages = (raw: unknown) => parseWizard(raw).issues.map((i) => i.message);

  it("takes a time or a date, and the version stays", () => {
    expect(parseWizard(wizard({ for: "2d" })).issues).toEqual([]);
    expect(parseWizard(wizard({ until: "2026-11-10T08:00:00.000Z" })).issues).toEqual([]);
    expect(parseWizard(wizard({ until: "{{due}}" })).issues).toEqual([]);
    expect(DEFINITION_VERSION).toBe(1);
  });

  it("has one of them", () => {
    expect(messages(wizard({})).join()).toContain('"for", "until" or "signal"');
    expect(messages(wizard({ for: "2d", until: "{{due}}" })).join()).toContain("one of them");
  });

  it("refuses what it cannot wait for", () => {
    for (const bad of ["0d", "2w", "1.5h", "99999d", "soon"]) {
      expect(parseWizard(wizard({ for: bad })).ok, bad).toBe(false);
    }
    expect(messages(wizard({ until: "next tuesday" })).join()).toContain("ISO date");
    expect(messages(wizard({ until: "{{nobody}}" })).length).toBeGreaterThan(0);
  });

  it("a duration lasts what it says", () => {
    expect(waitDurationMs("90m")).toBe(90 * 60_000);
    expect(waitDurationMs("6h")).toBe(6 * 3_600_000);
    expect(waitDurationMs("2d")).toBe(2 * 86_400_000);
  });

  it("hands on what branches read, and nothing else", () => {
    const branch = (field: string) => ({
      id: "after",
      type: "agent",
      title: "After",
      instructions: "x",
      tools: [],
      output: { format: "text" },
      next: [{ when: { field, op: "equals", value: true }, goto: "done" }],
    });
    expect(parseWizard(wizard({ for: "1d" }, [branch("steps.pause.waited")])).issues).toEqual([]);
    expect(messages(wizard({ for: "1d" }, [branch("steps.pause.nope")])).length).toBeGreaterThan(0);
    expect(
      branchValues({}, { pause: { json: { waited: true } } })["steps.pause.waited"],
    ).toBe(true);
  });

  describe("for a signal", () => {
    const signal = (more: object = {}) => ({ signal: { name: "paid", key: "{{due}}", ...more } });
    const branch = (field: string) => ({
      id: "after",
      type: "agent",
      title: "After",
      instructions: "x",
      tools: [],
      output: { format: "text" },
      next: [{ when: { field, op: "equals", value: true }, goto: "done" }],
    });

    it("takes a name, a key, a timeout and fields, and the version stays", () => {
      expect(parseWizard(wizard(signal())).issues).toEqual([]);
      expect(parseWizard(wizard(signal({ timeout: "3d", fields: ["amount"] }))).issues).toEqual([]);
      expect(DEFINITION_VERSION).toBe(1);
    });

    it("is one of the three, with a known key and a readable timeout", () => {
      expect(messages(wizard({ for: "1d", ...signal() })).join()).toContain("one of them");
      expect(messages(wizard(signal({ key: "{{nope}}" }))).length).toBeGreaterThan(0);
      expect(messages(wizard(signal({ timeout: "soon" }))).length).toBeGreaterThan(0);
      expect(messages(wizard(signal({ name: "has space" }))).length).toBeGreaterThan(0);
    });

    it("hands on came, timedOut and its data, and a list decides which data", () => {
      const reads = (field: string, more: object = {}) =>
        parseWizard(wizard(signal(more), [branch(field)])).issues;
      expect(reads("steps.pause.came")).toEqual([]);
      expect(reads("steps.pause.timedOut")).toEqual([]);
      expect(reads("steps.pause.data.subject")).toEqual([]);
      expect(reads("steps.pause.data.amount", { fields: ["amount"] })).toEqual([]);
      expect(reads("steps.pause.data.subject", { fields: ["amount"] }).length).toBeGreaterThan(0);
      expect(reads("steps.pause.waited").length).toBeGreaterThan(0);
      expect(reads("steps.pause.subject").length).toBeGreaterThan(0);
      expect(reads("steps.pause.data").length).toBeGreaterThan(0);
      expect(reads("steps.pause.came.p").length).toBeGreaterThan(0);
    });

    it("reads a sender's data only below `data`", () => {
      const values = branchValues(
        {},
        {
          pause: {
            json: {
              came: true,
              timedOut: false,
              data: { came: false, timedOut: true, subject: "Ja" },
            },
          },
        },
      );
      expect(values["steps.pause.came"]).toBe(true);
      expect(values["steps.pause.timedOut"]).toBe(false);
      expect(values["steps.pause.data.came"]).toBe(false);
      expect(values["steps.pause.data.subject"]).toBe("Ja");
    });
  });

  it("has nothing to show or hand over", () => {
    const review = { id: "look", type: "review", title: "Look", show: ["pause"] };
    expect(messages(wizard({ for: "1d" }, [review])).join()).toContain("nothing to show");
    const raw = wizard({ for: "1d" });
    (raw.steps.at(-1) as { deliverables: object[] }).deliverables = [
      { from: "pause", formats: ["md"] },
    ];
    expect(messages(raw).join()).toContain("nothing to hand over");
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
    expect(isDecisionStep(checkStep({ model: "low" }))).toBe(false);
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

describe("a wizard's themes", () => {
  const steps = [
    { id: "p", type: "page", title: "P", fields: [{ id: "topic", label: "T", kind: "text" }] },
    { id: "r", type: "result", title: "R", deliverables: [] },
  ];

  it("names themes of the space and the built-in ones", () => {
    const parsed = parseWizard({ title: "x", themes: ["halloween", "@wizards/winter", "brand"], steps });
    expect(parsed.ok).toBe(true);
    expect(parsed.issues).toEqual([]);
  });

  it("refuses an id that is no theme id, and names a theme named twice", () => {
    expect(parseWizard({ title: "x", themes: ["Halloween"], steps }).ok).toBe(false);
    const twice = parseWizard({ title: "x", themes: ["a", "a"], steps });
    expect(twice.issues.map((i) => i.message).join(" ")).toMatch(/twice/);
  });

  it("has no style any more", () => {
    expect(parseWizard({ title: "x", style: { accent: "#ff7a1a" }, steps } as never).issues).toEqual([]);
  });
});

describe("a person's step: timeout, remind, approve", () => {
  const page = (more: object) => ({
    id: "ask",
    type: "page",
    title: "A",
    fields: [{ id: "x", kind: "text", label: "X" }],
    ...more,
  });
  const made = { id: "made", type: "agent", title: "M", instructions: "x", tools: [], output: { format: "text" } };
  const end = { id: "done", type: "result", title: "E", deliverables: [] };
  const issues = (...steps: object[]) =>
    parseWizard({ version: 1, title: "T", description: "", avatar: "round", steps }).issues.map(
      (i) => i.message,
    );

  it("takes 1 minute to 31 days", () => {
    expect(issues(page({ timeout: "1m", }), end)).toEqual([]);
    expect(issues(page({ timeout: "31d", remind: "30d" }), end)).toEqual([]);
    expect(issues(page({ timeout: "32d" }), end).join()).toMatch(/"timeout" is at most 31 days/);
    expect(issues(page({ remind: "745h" }), end).join()).toMatch(/"remind" is at most 31 days/);
    expect(issues(page({ timeout: "0m" }), end).join()).toMatch(/A duration like/);
    expect(issues(page({ timeout: "30s" }), end).join()).toMatch(/A duration like/);
  });

  it("reminds before the timeout", () => {
    expect(issues(page({ timeout: "1d", remind: "1d" }), end).join()).toMatch(/not shorter/);
    expect(issues(page({ timeout: "1h", remind: "2h" }), end).join()).toMatch(/not shorter/);
    expect(issues(page({ remind: "2d" }), end)).toEqual([]);
  });

  it("a branch reads timedOut only of a step with a timeout", () => {
    const next = [{ when: { field: "steps.ask.timedOut", op: "equals", value: true }, goto: "done" }];
    expect(issues(page({ timeout: "1d", next }), end)).toEqual([]);
    expect(issues(page({ next }), end).length).toBeGreaterThan(0);
  });

  it("approve needs a branch on the decision", () => {
    const review = { id: "check", type: "review", title: "C", show: ["made"], approve: true };
    expect(issues(made, review, end).join()).toMatch(/needs a branch on steps\.check\.approved/);
    const next = [{ when: { field: "steps.check.approved", op: "equals", value: false }, goto: "done" }];
    expect(issues(made, { ...review, next }, end)).toEqual([]);
    const reads = [{ when: { field: "steps.check.note", op: "contains", value: "x" }, goto: "done" }];
    expect(issues(made, { ...review, next: [...next, ...reads] }, end)).toEqual([]);
  });
});
