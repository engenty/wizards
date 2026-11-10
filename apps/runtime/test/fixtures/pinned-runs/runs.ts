import { type WizardDefinition, wizardSchema } from "@engenty/wizards-shared/definition";
import { expect } from "vitest";

/**
 * The six pinned runs: each wizard, what the model answers in it, and what the run did by its
 * end: the moves `transition()` made, what the model was asked, the run's log and its state.
 * pinned-runs.test.ts runs them through the runtime's runner, packages/engine/test/pinned.test.ts
 * through the engine alone on a host in memory.
 */

/** A model call as the script reads it: the step that asks, whether it decides, the prompt, how often this step asked. */
export interface ModelCall {
  step: string;
  /** A decision: the classifier class, or a decision of the models service. */
  decides: boolean;
  /** The prompt as text. */
  prompt: string;
  n: number;
}

export interface PinnedRun {
  title: string;
  wizard: WizardDefinition;
  /** What the model answers; a decision answers JSON, `{ <question>: <answer> }`. */
  script(call: ModelCall): string;
  /** "event ⇒ command → status", in order. */
  moves: string[];
  /** What the model was asked: "<step>", or "<step>?" for a decision. */
  calls: string[];
  /** [step, type, what it said]: a note by its code and params, else its text. */
  log: [string | null, string, string][];
  /** The run's state where it ends. */
  state: unknown;
}

const end = { id: "done", type: "result", title: "Done", deliverables: [] };
const wizard = (title: string, steps: unknown[]) =>
  wizardSchema.parse({ version: 1, title, description: "", avatar: "round", steps });
const text = (id: string, title: string, instructions: string, more: object = {}) => ({
  id,
  type: "agent",
  title,
  instructions,
  output: { format: "text" },
  ...more,
});
const page = (field: string) => ({
  id: "ask",
  type: "form",
  title: "Ask",
  fields: [{ id: field, kind: "text", label: field }],
});

/** What a step left: these fields, and a time. */
const output = (fields: object) => ({ ...fields, at: expect.any(String) });

/** 1: a page, an agent that writes, an approval, the result. */
export const pageAgentReview: PinnedRun = {
  title: "Pinned: page, agent, review",
  wizard: wizard("Pinned: page, agent, review", [
    page("topic"),
    text("write", "Write", "Write about {{topic}}."),
    { id: "check", type: "review", title: "Check", show: ["write"], approve: true },
    end,
  ]),
  script: ({ step, prompt }) =>
    step === "write" && prompt.includes("otters") ? "Two lines on otters." : "",
  moves: [
    "start ⇒ ask ask → waiting_input",
    "answered ask ⇒ run write → running",
    "stepDone write ⇒ ask check → waiting_input",
    "resume ⇒ ask check → waiting_input",
    "reviewed check ⇒ end done → done",
    "resume ⇒ end done → done",
  ],
  calls: ["write"],
  log: [
    [null, "run_started", "runStarted"],
    ["ask", "step_done", "Ask"],
    ["write", "step_started", "Write"],
    ["write", "step_done", "Write"],
    ["check", "step_done", "Check"],
  ],
  state: {
    values: { topic: "otters" },
    outputs: {
      write: output({ text: "Two lines on otters." }),
      check: output({ json: { approved: true } }),
    },
    history: ["ask", "check"],
    notes: {},
    answered: { at: expect.any(Number), next: "done" },
  },
};

/** 2: a decision step branches, and the other branch never runs. */
export const decision: PinnedRun = {
  title: "Pinned: decision",
  wizard: wizard("Pinned: decision", [
    page("message"),
    {
      id: "triage",
      type: "decision",
      title: "Triage",
      instructions: "The customer wrote: {{message}}",
      output: {
        fields: [
          {
            id: "kind",
            kind: "choice",
            description: "What does the customer want?",
            options: ["refund", "question"],
          },
        ],
      },
      next: [{ when: { field: "steps.triage.kind", op: "eq", value: "refund" }, goto: "refund" }],
    },
    text("question", "Question", "Answer the question.", { next: [{ goto: "done" }] }),
    text("refund", "Refund", "Start the refund.", {
      next: [{ ask: "The customer is angry.", goto: "soothe" }, { goto: "done" }],
    }),
    text("soothe", "Soothe", "Apologise."),
    end,
  ]),
  script: ({ step, decides }) => {
    if (decides) {
      // The decision step's question, then the branch rule of "refund": its first `ask`.
      return JSON.stringify(step === "triage" ? { kind: "refund" } : { next: "r0" });
    }
    return step === "refund" ? "Refund started." : step === "soothe" ? "We are sorry." : "?";
  },
  moves: [
    "start ⇒ ask ask → waiting_input",
    "answered ask ⇒ run triage → running",
    "stepDone triage ⇒ run refund → running",
    "stepDone refund ⇒ decide refund [0] → running",
    "decided refund ⇒ run soothe → running",
    "stepDone soothe ⇒ end done → done",
    "resume ⇒ end done → done",
  ],
  // "question" is asked nothing and leaves nothing.
  calls: ["triage?", "refund", "refund?", "soothe"],
  log: [
    [null, "run_started", "runStarted"],
    ["ask", "step_done", "Ask"],
    ["triage", "step_started", "Triage"],
    ["triage", "step_done", "Triage"],
    ["refund", "step_started", "Refund"],
    ["refund", "step_done", "Refund"],
    ["refund", "info", "deciding"],
    ["soothe", "step_started", "Soothe"],
    ["soothe", "step_done", "Soothe"],
  ],
  state: {
    values: { message: "Broken on arrival, I want my money back!" },
    outputs: {
      triage: output({
        text: "What does the customer want?: refund",
        json: { kind: "refund" },
        decided: { kind: 1 },
      }),
      refund: output({ text: "Refund started." }),
      soothe: output({ text: "We are sorry." }),
    },
    history: ["ask"],
    notes: {},
    answered: { at: expect.any(Number), next: "triage" },
    loops: { "triage→refund": 1, "refund→soothe": 1 },
    decisions: { refund: { rule: 0, source: "llm", at: expect.any(String) } },
  },
};

/** 3: a tool step calls a plugin's tool once (plugins/pinned.ts), with no model. */
export const tool: PinnedRun = {
  title: "Pinned: tool",
  wizard: wizard("Pinned: tool", [
    {
      id: "stamp",
      type: "tool",
      title: "Stamp",
      call: { tool: "pinned.stamp", input: { word: "ab", times: "3" } },
      output: {
        fields: [
          { id: "stamped", kind: "text" },
          { id: "letters", kind: "number" },
        ],
      },
    },
    { ...end, data: { stamped: "steps.stamp.stamped", letters: "steps.stamp.letters" } },
  ]),
  script: () => "",
  moves: [
    "start ⇒ run stamp → running",
    "stepDone stamp ⇒ end done → done",
    "resume ⇒ end done → done",
  ],
  calls: [],
  log: [
    [null, "run_started", "runStarted"],
    ["stamp", "step_started", "Stamp"],
    ["stamp", "step_done", "Stamp"],
  ],
  state: {
    values: {},
    outputs: { stamp: output({ json: { stamped: "ABABAB", letters: 6 } }) },
    history: [],
    notes: {},
    data: { stamped: "ABABAB", letters: 6 },
  },
};

const FRUITS = ["apple", "banana", "cherry"];

/** 4: foreach runs an agent once per entry of a list. */
export const foreach: PinnedRun = {
  title: "Pinned: foreach",
  wizard: wizard("Pinned: foreach", [
    {
      id: "gather",
      type: "agent",
      title: "Gather",
      instructions: "Name three fruits.",
      output: {
        format: "json",
        fields: [{ id: "fruits", kind: "list", description: "Three fruits" }],
      },
    },
    text("each", "Each", "Write a line on {{item}}.", { foreach: "steps.gather.fruits" }),
    end,
  ]),
  script: ({ step, prompt }) => {
    if (step === "gather") {
      return JSON.stringify({ fruits: FRUITS });
    }
    const fruit = FRUITS.find((f) => prompt.includes(`line on ${f}`));
    return `A line on ${fruit}.`;
  },
  moves: [
    "start ⇒ run gather → running",
    "stepDone gather ⇒ run each → running",
    "stepDone each ⇒ end done → done",
    "resume ⇒ end done → done",
  ],
  calls: ["gather", "each", "each", "each"],
  log: [
    [null, "run_started", "runStarted"],
    ["gather", "step_started", "Gather"],
    ["gather", "step_done", "Gather"],
    ["each", "step_started", "Each"],
    ["each", "info", 'entry {"n":1,"total":3}'],
    ["each", "info", 'entry {"n":2,"total":3}'],
    ["each", "info", 'entry {"n":3,"total":3}'],
    ["each", "step_done", "Each"],
  ],
  state: {
    values: {},
    outputs: {
      gather: output({
        text: '{"fruits":["apple","banana","cherry"]}',
        json: { fruits: FRUITS },
      }),
      each: output({
        text: "## apple\n\nA line on apple.\n\n## banana\n\nA line on banana.\n\n## cherry\n\nA line on cherry.",
        json: { rows: [{ item: "apple" }, { item: "banana" }, { item: "cherry" }] },
      }),
    },
    history: [],
    notes: {},
  },
};

/** 5: a wait for a signal, and the signal comes. */
export const signal: PinnedRun = {
  title: "Pinned: signal",
  wizard: wizard("Pinned: signal", [
    {
      id: "paid",
      type: "wait",
      title: "Paid",
      signal: { name: "order.paid", key: "order-7", fields: ["amount"] },
    },
    text("thank", "Thank", "They paid {{steps.paid.data.amount}} euros. Thank them."),
    end,
  ]),
  script: ({ step, prompt }) => (step === "thank" && prompt.includes("42") ? "Thanks for 42." : ""),
  moves: [
    "start ⇒ waitSignal order.paid:order-7 → waiting_signal",
    "resume ⇒ waitSignal order.paid:order-7 → waiting_signal",
    "signal paid ⇒ run thank → running",
    "stepDone thank ⇒ end done → done",
    "resume ⇒ end done → done",
  ],
  calls: ["thank"],
  log: [
    [null, "run_started", "runStarted"],
    ["paid", "step_started", "Paid"],
    ["paid", "wait", "runWaitsSignal"],
    ["paid", "info", "signalCame"],
    ["paid", "step_done", "Paid"],
    ["thank", "step_started", "Thank"],
    ["thank", "step_done", "Thank"],
  ],
  state: {
    values: {},
    outputs: {
      // Only the fields the wait names reach the run.
      paid: output({ json: { came: true, timedOut: false, data: { amount: 42 } } }),
      thank: output({ text: "Thanks for 42." }),
    },
    history: [],
    notes: {},
    signals: [expect.stringMatching(/^sig_/)],
  },
};

/** 6: a step that fails once passes on its retry. */
export const retry: PinnedRun = {
  title: "Pinned: retry",
  wizard: wizard("Pinned: retry", [text("draft", "Draft", "Write a draft.", { retries: 1 }), end]),
  // The first answer is empty: the step fails for its own reason, and `retries` tries it again.
  script: ({ step, n }) => (step === "draft" && n > 1 ? "A draft." : ""),
  moves: [
    "start ⇒ run draft → running",
    "stepFailed draft ⇒ sleep draft (retry) → sleeping",
    "woke ⇒ run draft → running",
    "stepDone draft ⇒ end done → done",
    "resume ⇒ end done → done",
  ],
  calls: ["draft", "draft"],
  log: [
    [null, "run_started", "runStarted"],
    ["draft", "step_started", "Draft"],
    ["draft", "info", 'stepRetries {"minutes":0}'],
    ["draft", "step_started", "Draft"],
    ["draft", "step_done", "Draft"],
  ],
  state: {
    values: {},
    outputs: { draft: output({ text: "A draft." }) },
    history: [],
    notes: {},
  },
};

/** The run asleep for its retry, before the clock wakes it. */
export const retryAsleep = {
  values: {},
  outputs: {},
  history: [],
  notes: {},
  retries: { step: "draft", count: 0, since: expect.any(String), failures: 1 },
  pause: { kind: "retry" },
};
