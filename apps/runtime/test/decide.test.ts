import {
  type DecisionQuestion,
  decisionSchema,
  marginOf,
  pOf,
  readObject,
  readSystemOne,
} from "@engenty/wizards-shared/decision";
import {
  branchValues,
  DEFAULT_LOOP_MAX,
  followRules,
  type PageStep,
  parseWizard,
  type WizardDefinition,
} from "@engenty/wizards-shared/definition";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const access = vi.hoisted(() => ({ value: null as null | { url: string; headers: Record<string, string>; model: string | null } }));
const llm = vi.hoisted(() => ({ output: undefined as unknown, calls: 0, fail: false }));

vi.mock("../src/models.js", () => ({
  systemOneAccess: async () => access.value,
  textModel: async () => ({ model: "test-model", vendor: "test" }),
  costOf: () => 0.001,
}));
vi.mock("ai", () => ({
  generateText: async () => {
    llm.calls++;
    if (llm.fail) {
      throw new Error("model down");
    }
    return { output: llm.output, usage: {} };
  },
  Output: { object: (o: unknown) => o },
}));

const { decide } = await import("../src/engine/decide");
const { readPageInput } = await import("../src/engine/input");
const { stepClasses } = await import("../src/engine/requirements");

const questions: Record<string, DecisionQuestion> = {
  refund: { type: "noul", instructions: "Does the person want money back?" },
  topic: { type: "choice", instructions: "What is it about?", criteria: { delivery: null, billing: "Invoices" } },
  urgency: { type: "score", instructions: "How urgent?", criteria: ["low", "medium", "high"] },
};

function valid(input: unknown): WizardDefinition {
  const parsed = parseWizard(input);
  if (!parsed.ok) {
    throw new Error(parsed.issues.map((i) => i.message).join("; "));
  }
  expect(parsed.issues.map((i) => i.message)).toEqual([]);
  return parsed.wizard;
}

const issuesOf = (input: unknown) =>
  parseWizard(input)
    .issues.map((i) => i.message)
    .join(" | ");

describe("decision answers", () => {
  it("from a decision model count only when they fit their question", () => {
    const answers = readSystemOne(questions, {
      answers: {
        refund: { type: "noul", noul: 0.81 },
        topic: { type: "choice", choice: "billing", probabilities: { delivery: 0.3, billing: 0.7 }, confidence: 0.6 },
        urgency: { type: "score", score: 1.8, probabilities: { "0": 0.1, "1": 0.2, "2": 0.7 } },
      },
    });
    expect(answers.refund).toEqual({ type: "noul", noul: 0.81 });
    expect(answers.topic).toMatchObject({ choice: "billing" });
    expect(answers.urgency).toMatchObject({ level: 2, label: "high" });
    expect(marginOf(answers.topic)).toBeCloseTo(0.4);
    expect(pOf(answers.urgency)).toBe(0.7);

    // Not the top pick, an unknown option, a broken sum: left open.
    const broken = readSystemOne(questions, {
      answers: {
        topic: { type: "choice", choice: "delivery", probabilities: { delivery: 0.3, billing: 0.7 } },
        urgency: { type: "score", probabilities: { "0": 0.5, "1": 0.2, "2": 0.1 } },
        refund: { type: "noul", noul: 1.4 },
      },
    });
    expect(broken).toEqual({});
  });

  it("from a language model have the same shapes, without probabilities", () => {
    const schema = decisionSchema(questions);
    const object = { refund: true, topic: "delivery", urgency: "medium" };
    expect(schema.safeParse(object).success).toBe(true);
    const answers = readObject(questions, object);
    expect(answers).toEqual({
      refund: { type: "noul", noul: 1 },
      topic: { type: "choice", choice: "delivery" },
      urgency: { type: "score", level: 1, label: "medium" },
    });
    expect(marginOf(answers?.topic as never)).toBeNull();
    expect(readObject(questions, { refund: true, topic: "nope", urgency: "low" })).toBeNull();
  });
});

describe("decide()", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    access.value = null;
    llm.output = undefined;
    llm.calls = 0;
    llm.fail = false;
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const jevAnswers = {
    refund: { type: "noul", noul: 0.2 },
    topic: { type: "choice", choice: "delivery", probabilities: { delivery: 0.9, billing: 0.1 } },
    urgency: { type: "score", probabilities: { "0": 0.8, "1": 0.15, "2": 0.05 } },
  };

  it("asks the decision model first and needs nothing else when it answers all", async () => {
    access.value = { url: "https://jev.test/v1/systemone", headers: {}, model: "jev" };
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ answers: jevAnswers })));
    const d = await decide({ state: "mail", questions });
    expect(d.source).toBe("systemone");
    expect(d.answers.topic).toMatchObject({ choice: "delivery" });
    expect(llm.calls).toBe(0);
  });

  it("lets the language model answer what the decision model left open", async () => {
    access.value = { url: "https://jev.test/v1/systemone", headers: {}, model: null };
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ answers: { refund: jevAnswers.refund } })),
    );
    llm.output = { topic: "billing", urgency: "high" };
    const d = await decide({ state: "mail", questions });
    expect(d.answers.refund).toEqual({ type: "noul", noul: 0.2 });
    expect(d.answers.topic).toEqual({ type: "choice", choice: "billing" });
    expect(llm.calls).toBe(1);
  });

  it("falls back to the language model without a decision model, or when it fails", async () => {
    llm.output = { refund: false, topic: "delivery", urgency: "low" };
    const none = await decide({ state: "mail", questions });
    expect(none.source).toBe("llm");
    expect(fetchMock).not.toHaveBeenCalled();

    access.value = { url: "https://jev.test/v1/systemone", headers: {}, model: null };
    fetchMock.mockResolvedValue(new Response("down", { status: 500 }));
    const failed = await decide({ state: "mail", questions });
    expect(failed.source).toBe("llm");
  });

  it("retries a decision model that is busy", async () => {
    access.value = { url: "https://jev.test/v1/systemone", headers: {}, model: null };
    fetchMock
      .mockResolvedValueOnce(new Response("busy", { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ answers: jevAnswers })));
    const d = await decide({ state: "mail", questions });
    expect(d.source).toBe("systemone");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails only when both ways fail", async () => {
    llm.fail = true;
    await expect(decide({ state: "mail", questions })).rejects.toThrow();
  });

  it("gives up when the deadline passed", async () => {
    access.value = { url: "https://jev.test/v1/systemone", headers: {}, model: null };
    fetchMock.mockImplementation(
      (_url, init: RequestInit) =>
        new Promise((_, reject) =>
          init.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
    );
    await expect(decide({ state: "x", questions, deadlineMs: 20 })).rejects.toThrow();
    expect(llm.calls).toBe(0);
  });
});

describe("decided branches and loops", () => {
  const def = valid({
    title: "x",
    steps: [
      { id: "mail", type: "page", title: "Mail", fields: [{ id: "text", label: "Text", kind: "textarea" }, { id: "amount", label: "A", kind: "number" }] },
      {
        id: "write",
        type: "agent",
        title: "Write",
        instructions: "Answer {{text}}",
        tools: [],
        next: [
          { when: { field: "amount", op: "gt", value: 1000 }, goto: "boss" },
          { ask: "The person wants a refund.", goto: "refund" },
          { ask: "The person wants an exchange.", goto: "exchange" },
        ],
      },
      {
        id: "check",
        type: "agent",
        title: "Check",
        model: "classifier",
        instructions: "Is {{steps.write}} polite?",
        tools: [],
        output: { format: "json", fields: [{ id: "ok", kind: "yesno", description: "Polite?" }] },
        next: [{ when: { field: "steps.check.ok", op: "equals", value: false }, goto: "write", max: 2 }],
      },
      { id: "refund", type: "page", title: "Refund", fields: [{ id: "iban", label: "IBAN", kind: "text" }] },
      { id: "exchange", type: "page", title: "Exchange", fields: [{ id: "size", label: "Size", kind: "text" }] },
      { id: "boss", type: "page", title: "Boss", fields: [{ id: "ok", label: "OK", kind: "toggle" }] },
      { id: "r", type: "result", title: "R", deliverables: [] },
    ],
  });

  it("take a matching when rule first, else leave the ask rules to a decision", () => {
    expect(followRules(def, "write", { amount: 5000 })).toEqual({ kind: "go", cursor: "boss", rule: 0 });
    expect(followRules(def, "write", { amount: 10 })).toEqual({ kind: "decide", rules: [1, 2] });
  });

  it("stop a loop at its max", () => {
    const values = branchValues({}, { check: { json: { ok: false } } });
    expect(followRules(def, "check", values, {})).toMatchObject({ cursor: "write" });
    expect(followRules(def, "check", values, { "check→write": 1 })).toMatchObject({ cursor: "write" });
    expect(followRules(def, "check", values, { "check→write": 2 })).toMatchObject({ cursor: "refund", rule: null });
  });

  it("stop a loop without max at the default", () => {
    const loop = valid({
      title: "x",
      steps: [
        { id: "p", type: "page", title: "P", fields: [{ id: "a", label: "A", kind: "toggle" }] },
        { id: "q", type: "page", title: "Q", fields: [{ id: "b", label: "B", kind: "toggle" }], next: [{ when: { field: "b", op: "equals", value: true }, goto: "p" }] },
        { id: "r", type: "result", title: "R", deliverables: [] },
      ],
    });
    const loops = { "q→p": DEFAULT_LOOP_MAX };
    expect(followRules(loop, "q", { b: true }, loops)).toMatchObject({ cursor: "r" });
  });

  it("read how probable a decision step's answer is", () => {
    const values = branchValues({}, { check: { json: { ok: true }, decided: { ok: 0.93 } } });
    expect(values["steps.check.ok.p"]).toBe(0.93);
  });

  it("need the classifier", () => {
    expect(stepClasses(def.steps[1])).toContain("classifier");
  });

  it("are checked by the validator", () => {
    const text = issuesOf({
      title: "x",
      steps: [
        { id: "p", type: "page", title: "P", fields: [{ id: "a", label: "A", kind: "text" }], next: [{ goto: "r" }, { when: { field: "a", op: "notEmpty" }, ask: "both", goto: "r" }] },
        { id: "r", type: "result", title: "R", deliverables: [] },
      ],
    });
    expect(text).toContain('"when" or "ask", not both');
  });

  it("let a branch read .p only of a decision step", () => {
    const text = issuesOf({
      title: "x",
      steps: [
        { id: "w", type: "agent", title: "W", instructions: "x", tools: [], output: { format: "json", fields: [{ id: "n", kind: "number" }] }, next: [{ when: { field: "steps.w.n.p", op: "gt", value: 0.5 }, goto: "r" }] },
        { id: "r", type: "result", title: "R", deliverables: [] },
      ],
    });
    expect(text).toContain('Branch reads unknown field "steps.w.n.p"');
  });
});

describe("score fields", () => {
  it("make a decision step and need their levels", () => {
    valid({
      title: "x",
      steps: [
        { id: "p", type: "page", title: "P", fields: [{ id: "mail", label: "M", kind: "textarea" }] },
        { id: "rate", type: "agent", title: "Rate", model: "classifier", instructions: "{{mail}}", tools: [], output: { format: "json", fields: [{ id: "urgency", kind: "score", description: "How urgent?", options: ["low", "medium", "high"] }] }, next: [{ when: { field: "steps.rate.urgency", op: "equals", value: "high" }, goto: "r" }] },
        { id: "r", type: "result", title: "R", deliverables: [] },
      ],
    });
    expect(issuesOf({
      title: "x",
      steps: [
        { id: "rate", type: "agent", title: "Rate", instructions: "x", tools: [], output: { format: "json", fields: [{ id: "u", kind: "score" }] } },
        { id: "r", type: "result", title: "R", deliverables: [] },
      ],
    })).toContain("score field lists its options");
  });
});

describe("each on agent steps", () => {
  const research = {
    id: "research",
    type: "agent",
    title: "R",
    instructions: "find",
    tools: [],
    output: { format: "json", fields: [{ id: "suppliers", kind: "table", columns: ["name", "url"] }] },
  };

  it("read the entry and hand on rows", () => {
    valid({
      title: "x",
      steps: [
        research,
        { id: "visit", type: "agent", title: "V", instructions: "Read {{item.url}} ({{index}} of {{count}})", tools: ["web_fetch"], each: "steps.research.suppliers", output: { format: "json", fields: [{ id: "price", kind: "number" }] } },
        { id: "pick", type: "page", title: "P", fields: [{ id: "s", label: "S", kind: "select", optionsFrom: "steps.visit.rows.name" }] },
        { id: "r", type: "result", title: "R", deliverables: [] },
      ],
    });
  });

  it("name a table, a list output or a stored list", () => {
    expect(issuesOf({
      title: "x",
      steps: [
        { id: "visit", type: "agent", title: "V", instructions: "{{item.url}}", tools: [], each: "nowhere" },
        { id: "r", type: "result", title: "R", deliverables: [] },
      ],
    })).toContain('each "nowhere" is "steps.<id>.<key>"');
  });
});

describe("decided fields", () => {
  const page: PageStep = {
    id: "details",
    type: "page",
    title: "Details",
    groups: [{ id: "contact", instructions: "How should we reach the person?", optional: true }],
    fields: [
      { id: "name", label: "Name", kind: "text", required: true },
      { id: "phone", label: "Phone", kind: "text", group: "contact", required: true },
      { id: "mail", label: "E-mail", kind: "email", group: "contact", required: true },
      { id: "photo", label: "Photo of the damage", kind: "image", ask: "The complaint is about a damaged article." },
    ],
  };

  it("are asked only when a decision kept them", () => {
    const kept = readPageInput(page, { name: "Ada", phone: "0664 123" }, { decided: ["phone"] });
    expect(kept.errors).toEqual([]);
    expect(kept.values).toEqual({ name: "Ada", phone: "0664 123" });
    // E-mail was not kept: not required, not stored.
    expect(readPageInput(page, { name: "Ada", mail: "a@b.c" }, { decided: ["phone"] }).values).toEqual({ name: "Ada" });
    expect(readPageInput(page, { name: "Ada" }, { decided: ["phone"] }).errors.map((e) => e.field)).toEqual(["phone"]);
  });

  it("are checked by the validator", () => {
    valid({ title: "x", steps: [page, { id: "r", type: "result", title: "R", deliverables: [] }] });
    const text = issuesOf({
      title: "x",
      steps: [
        {
          ...page,
          groups: [...(page.groups ?? []), { id: "empty", instructions: "?" }],
          fields: [...page.fields, { id: "x", label: "X", kind: "text", group: "nope" }, { id: "y", label: "Y", kind: "text", ask: "a", group: "contact" }],
        },
        { id: "r", type: "result", title: "R", deliverables: [] },
      ],
    });
    expect(text).toContain('Field group "empty" has no fields');
    expect(text).toContain('unknown group "nope"');
    expect(text).toContain('"ask" or "group", not both');
  });

  it("need the classifier", () => {
    expect(stepClasses(page)).toContain("classifier");
  });
});
