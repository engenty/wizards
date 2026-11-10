import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type WizardDefinition, wizardSchema } from "@engenty/wizards-shared/definition";
import type { FlowEvent, FlowResult } from "@engenty/wizards-shared/transition";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Six runs end to end through the real runner, pinned: the moves `transition()` made, the run's
 * log (`run_event`) and where the run ends. The model is scripted per step, the tool step calls a
 * plugin of the test's own (fixtures/pinned-runs/plugins), nothing reaches the network.
 *
 * The code that runs a run moves out of engine/runner.ts and engine/steps.ts in steps that change
 * no behaviour. Such a move changes nothing here: an expectation that fails after one is a change
 * of behaviour, not of the test.
 */
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-pinned-runs-"));
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.RUNTIME_ROLE = "runner";
process.env.FEATURES = "durableRuns=on";
process.env.RUNNER_CLOCK_MS = "100";
process.env.PLUGINS_DIR = fileURLToPath(new URL("./fixtures/pinned-runs/plugins", import.meta.url));
process.env.PLUGINS_WATCH = "0";
process.env.PLUGIN_JOBS = "0";

/** Every move of every run as `transition()` took it and answered, with its wizard's title. */
const moves = vi.hoisted(() => [] as { wizard: string; move: string }[]);
vi.mock("@engenty/wizards-shared/transition", async (original) => {
  const mod = await original<typeof import("@engenty/wizards-shared/transition")>();
  const eventOf = (e: FlowEvent) => `${e.kind}${"stepId" in e ? ` ${e.stepId}` : ""}`;
  const commandOf = ({ command, run }: FlowResult) => {
    switch (command.kind) {
      case "run":
      case "ask":
        return `${command.kind} ${command.step.id}`;
      case "decide":
        return `decide ${command.stepId} [${command.rules.join(",")}]`;
      case "fail":
        return `fail ${command.stepId}`;
      case "waitSignal":
        return `waitSignal ${command.name}:${command.key}`;
      case "sleep":
        return `sleep ${run.cursor}${run.state.pause ? ` (${run.state.pause.kind})` : ""}`;
      default:
        return `${command.kind} ${run.cursor}`;
    }
  };
  return {
    ...mod,
    transition: (...args: Parameters<typeof mod.transition>) => {
      const [def, , event] = args;
      const result = mod.transition(...args);
      moves.push({
        wizard: def.title,
        move: `${eventOf(event)} ⇒ ${commandOf(result)} → ${result.run.status}`,
      });
      return result;
    },
  };
});

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const say = (text: string) => [
  { type: "stream-start", warnings: [] },
  ...(text
    ? [
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: text },
        { type: "text-end", id: "t" },
      ]
    : []),
  { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
];

/**
 * What the model answers, per test: by the step that asks, whether it decides (the classifier
 * class), the prompt as text and how often this step asked. Each call is kept as "<step>", or
 * "<step>?" for a decision.
 */
interface ModelCall {
  step: string;
  decides: boolean;
  prompt: string;
  n: number;
}
const scripted = vi.hoisted(() => ({
  script: (_call: ModelCall): string => "",
  calls: [] as { run: string; name: string }[],
}));
const modelFor = (run: string, step: string, decides: boolean) => {
  const answer = (options: { prompt: unknown }) => {
    const name = `${step}${decides ? "?" : ""}`;
    scripted.calls.push({ run, name });
    const n = scripted.calls.filter((c) => c.run === run && c.name === name).length;
    return scripted.script({ step, decides, prompt: JSON.stringify(options.prompt), n });
  };
  return new MockLanguageModelV3({
    doGenerate: async (options) => {
      const text = answer(options);
      return {
        content: text ? [{ type: "text", text }] : [],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        warnings: [],
      } as never;
    },
    doStream: async (options) => ({
      stream: convertArrayToReadableStream(say(answer(options)) as never[]),
    }),
  });
};
vi.mock("../src/models.js", async (original) => ({
  ...(await original<typeof import("../src/models.js")>()),
  textModel: async (cls: string, meta: { runId?: string; stepId?: string } = {}) => ({
    model: modelFor(meta.runId ?? "-", meta.stepId ?? "-", cls === "classifier"),
    ref: "test/scripted",
    vendor: "test",
    gateway: false,
    metered: false,
  }),
  // No decision model: every decision goes to the classifier's language model, the script.
  systemOneAccess: async () => null,
}));
vi.mock("../src/safety.js", async (original) => ({
  ...(await original<typeof import("../src/safety.js")>()),
  guestChecksOn: async () => false,
}));
vi.mock("../src/engine/requirements.js", async (original) => ({
  ...(await original<typeof import("../src/engine/requirements.js")>()),
  missingModelsSaid: async () => [],
}));
vi.mock("../src/credits/credits.js", async (original) => ({
  ...(await original<typeof import("../src/credits/credits.js")>()),
  canSpend: async () => true,
  reserveForRun: async () => true,
  releaseRun: async () => undefined,
}));

let client: typeof import("../src/db/client");
let runner: typeof import("../src/engine/runner");
let wizards: typeof import("../src/services/wizards");
let reports: typeof import("../src/services/runs");

const T = "tenant-pinned-runs";
const USER = "user-pinned";
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

const start = (definition: WizardDefinition) =>
  client.withTenant(T, async () => {
    const created = await wizards.createWizard(USER, { definition: wizard("Seed", [end]) });
    return runner.createRun({
      wizardId: created.id,
      definition,
      files: [],
      version: null,
      mode: "test",
      userId: USER,
    });
  });

const row = (id: string) =>
  client.withTenant(T, () =>
    client.db.query.run.findFirst({ where: eq(client.schema.run.id, id) }),
  );
const line = (id: string) =>
  client.controlDb.query.runIndex.findFirst({ where: eq(client.control.runIndex.runId, id) });

async function until(ok: () => Promise<boolean>, ms: number) {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (await ok()) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/** The run stands at `status` and no runner holds it: its log is written to the end. */
async function rests(id: string, status: string, ms = 30_000) {
  const reached = await until(async () => {
    const l = await line(id);
    return (await row(id))?.status === status && !l?.active && l?.owner == null;
  }, ms);
  const r = await row(id);
  expect({ reached, status: r?.status, error: r?.error }).toEqual({
    reached: true,
    status,
    error: null,
  });
  expect(await seen(r!)).toMatchSnapshot();
  return r!;
}

const brand = { name: "Pinned", accent: null, logoUrl: null, theme: null } as never;

/**
 * What a person and a door see of the run where it rests, as the bytes they get: the run view, the
 * same with every step's output kept in the space, and the report. Run and wizard ids, times and
 * link signatures are placeholders; everything else is pinned.
 */
async function seen(r: NonNullable<Awaited<ReturnType<typeof row>>>) {
  const json = await client.withTenant(T, async () =>
    JSON.stringify({
      view: await runner.runView(r, brand),
      kept: await runner.runView(r, brand, new Set(r.definition.steps.map((s) => s.id))),
      report: await reports.runReportOf(r),
    }),
  );
  return json
    .replaceAll(r.id, "<run>")
    .replaceAll(r.wizardId, "<wizard>")
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, "<time>")
    .replace(/"(at|createdAt|time)":\d{10,}/g, '"$1":"<ms>"')
    .replace(/exp=\d+&sig=[\w-]+/g, "exp=<exp>&sig=<sig>")
    .replace(/sig_\w+/g, "<signal>");
}

/** The run's log as [step, type, what it said]: a note by its code and params, else its text. */
const logOf = async (id: string) =>
  (
    await client.withTenant(T, () =>
      client.db
        .select()
        .from(client.schema.runEvent)
        .where(eq(client.schema.runEvent.runId, id))
        .orderBy(client.schema.runEvent.id),
    )
  ).map((e) => [
    e.stepId,
    e.type,
    e.note
      ? `${e.note.code}${e.note.params ? ` ${JSON.stringify(e.note.params)}` : ""}`
      : e.message,
  ]);

/** The moves of one wizard's runs, as "event ⇒ command → status". */
const movesOf = (title: string) => moves.filter((m) => m.wizard === title).map((m) => m.move);

/** What the model was asked in one run, in order. */
const callsOf = (id: string) => scripted.calls.filter((c) => c.run === id).map((c) => c.name);

/** What a step left: these fields, and a time. */
const output = (fields: object) => ({ ...fields, at: expect.any(String) });

const stamps = () => {
  const g = globalThis as { __pinnedStamps?: { run: string }[] };
  g.__pinnedStamps ??= [];
  return g.__pinnedStamps;
};

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  // Before a tenant's database opens: the test's plugin, with the tool step 3 calls.
  await (await import("../src/plugins/loader")).loadPlugins();
  runner = await import("../src/engine/runner");
  wizards = await import("../src/services/wizards");
  reports = await import("../src/services/runs");
  runner.startRunner();
}, 60_000);

afterAll(() => runner.stopRunner());

beforeEach(() => {
  scripted.script = () => "";
});

vi.setConfig({ testTimeout: 60_000 });

describe("a run, pinned end to end", () => {
  it("1: a page, an agent that writes, an approval, the result", async () => {
    const title = "Pinned: page, agent, review";
    scripted.script = ({ step, prompt }) =>
      step === "write" && prompt.includes("otters") ? "Two lines on otters." : "";
    const id = await start(
      wizard(title, [
        page("topic"),
        text("write", "Write", "Write about {{topic}}."),
        { id: "check", type: "review", title: "Check", show: ["write"], approve: true },
        end,
      ]),
    );
    expect((await rests(id, "waiting_input")).cursor).toBe("ask");
    await client.withTenant(T, () => runner.submitPage(id, "ask", { topic: "otters" }));
    expect((await rests(id, "waiting_input")).cursor).toBe("check");
    await client.withTenant(T, () => runner.reviewStep(id, "check", { type: "accept" }));
    const r = await rests(id, "done");

    expect(movesOf(title)).toEqual([
      "start ⇒ ask ask → waiting_input",
      "answered ask ⇒ run write → running",
      "stepDone write ⇒ ask check → waiting_input",
      "resume ⇒ ask check → waiting_input",
      "reviewed check ⇒ end done → done",
      "resume ⇒ end done → done",
    ]);
    expect(await logOf(id)).toEqual([
      [null, "run_started", "runStarted"],
      ["ask", "step_done", "Ask"],
      ["write", "step_started", "Write"],
      ["write", "step_done", "Write"],
      ["check", "step_done", "Check"],
    ]);
    expect(callsOf(id)).toEqual(["write"]);
    expect({ cursor: r.cursor, wakeAt: r.wakeAt }).toEqual({ cursor: "done", wakeAt: null });
    expect(r.state).toEqual({
      values: { topic: "otters" },
      outputs: {
        write: output({ text: "Two lines on otters." }),
        check: output({ json: { approved: true } }),
      },
      history: ["ask", "check"],
      notes: {},
      answered: { at: expect.any(Number), next: "done" },
    });
  });

  it("2: a decision step branches, and the other branch never runs", async () => {
    const title = "Pinned: decision";
    scripted.script = ({ step, decides }) => {
      if (decides) {
        // The decision step's question, then the branch rule of "refund": its first `ask`.
        return JSON.stringify(step === "triage" ? { kind: "refund" } : { next: "r0" });
      }
      return step === "refund" ? "Refund started." : step === "soothe" ? "We are sorry." : "?";
    };
    const id = await start(
      wizard(title, [
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
          next: [
            { when: { field: "steps.triage.kind", op: "eq", value: "refund" }, goto: "refund" },
          ],
        },
        text("question", "Question", "Answer the question.", { next: [{ goto: "done" }] }),
        text("refund", "Refund", "Start the refund.", {
          next: [{ ask: "The customer is angry.", goto: "soothe" }, { goto: "done" }],
        }),
        text("soothe", "Soothe", "Apologise."),
        end,
      ]),
    );
    await rests(id, "waiting_input");
    await client.withTenant(T, () =>
      runner.submitPage(id, "ask", { message: "Broken on arrival, I want my money back!" }),
    );
    const r = await rests(id, "done");

    expect(movesOf(title)).toEqual([
      "start ⇒ ask ask → waiting_input",
      "answered ask ⇒ run triage → running",
      "stepDone triage ⇒ run refund → running",
      "stepDone refund ⇒ decide refund [0] → running",
      "decided refund ⇒ run soothe → running",
      "stepDone soothe ⇒ end done → done",
      "resume ⇒ end done → done",
    ]);
    expect(await logOf(id)).toEqual([
      [null, "run_started", "runStarted"],
      ["ask", "step_done", "Ask"],
      ["triage", "step_started", "Triage"],
      ["triage", "step_done", "Triage"],
      ["refund", "step_started", "Refund"],
      ["refund", "step_done", "Refund"],
      ["refund", "info", "deciding"],
      ["soothe", "step_started", "Soothe"],
      ["soothe", "step_done", "Soothe"],
    ]);
    // "question" is asked nothing and leaves nothing.
    expect(callsOf(id)).toEqual(["triage?", "refund", "refund?", "soothe"]);
    expect({ cursor: r.cursor, wakeAt: r.wakeAt }).toEqual({ cursor: "done", wakeAt: null });
    expect(r.state).toEqual({
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
    });
  });

  it("3: a tool step calls a plugin's tool once, with no model", async () => {
    const title = "Pinned: tool";
    const id = await start(
      wizard(title, [
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
    );
    const r = await rests(id, "done");

    expect(movesOf(title)).toEqual([
      "start ⇒ run stamp → running",
      "stepDone stamp ⇒ end done → done",
      "resume ⇒ end done → done",
    ]);
    expect(await logOf(id)).toEqual([
      [null, "run_started", "runStarted"],
      ["stamp", "step_started", "Stamp"],
      ["stamp", "step_done", "Stamp"],
    ]);
    expect(callsOf(id)).toEqual([]);
    // The tool's one call, its input filled in: "3" became a number.
    expect(stamps().filter((s) => s.run === id)).toEqual([
      { run: id, step: "stamp", word: "ab", times: 3 },
    ]);
    expect({ cursor: r.cursor, wakeAt: r.wakeAt }).toEqual({ cursor: "done", wakeAt: null });
    expect(r.state).toEqual({
      values: {},
      outputs: { stamp: output({ json: { stamped: "ABABAB", letters: 6 } }) },
      history: [],
      notes: {},
      data: { stamped: "ABABAB", letters: 6 },
    });
  });

  it("4: foreach runs an agent once per entry of a list", async () => {
    const title = "Pinned: foreach";
    scripted.script = ({ step, prompt }) => {
      if (step === "gather") {
        return JSON.stringify({ fruits: ["apple", "banana", "cherry"] });
      }
      const fruit = ["apple", "banana", "cherry"].find((f) => prompt.includes(`line on ${f}`));
      return `A line on ${fruit}.`;
    };
    const id = await start(
      wizard(title, [
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
    );
    const r = await rests(id, "done");

    expect(movesOf(title)).toEqual([
      "start ⇒ run gather → running",
      "stepDone gather ⇒ run each → running",
      "stepDone each ⇒ end done → done",
      "resume ⇒ end done → done",
    ]);
    expect(await logOf(id)).toEqual([
      [null, "run_started", "runStarted"],
      ["gather", "step_started", "Gather"],
      ["gather", "step_done", "Gather"],
      ["each", "step_started", "Each"],
      ["each", "info", 'entry {"n":1,"total":3}'],
      ["each", "info", 'entry {"n":2,"total":3}'],
      ["each", "info", 'entry {"n":3,"total":3}'],
      ["each", "step_done", "Each"],
    ]);
    expect(callsOf(id)).toEqual(["gather", "each", "each", "each"]);
    expect({ cursor: r.cursor, wakeAt: r.wakeAt }).toEqual({ cursor: "done", wakeAt: null });
    expect(r.state).toEqual({
      values: {},
      outputs: {
        gather: output({
          text: '{"fruits":["apple","banana","cherry"]}',
          json: { fruits: ["apple", "banana", "cherry"] },
        }),
        each: output({
          text: "## apple\n\nA line on apple.\n\n## banana\n\nA line on banana.\n\n## cherry\n\nA line on cherry.",
          json: { rows: [{ item: "apple" }, { item: "banana" }, { item: "cherry" }] },
        }),
      },
      history: [],
      notes: {},
    });
  });

  it("5: a wait for a signal, and the signal comes", async () => {
    const title = "Pinned: signal";
    scripted.script = ({ step, prompt }) =>
      step === "thank" && prompt.includes("42") ? "Thanks for 42." : "";
    const id = await start(
      wizard(title, [
        {
          id: "paid",
          type: "wait",
          title: "Paid",
          signal: { name: "order.paid", key: "order-7", fields: ["amount"] },
        },
        text("thank", "Thank", "They paid {{steps.paid.data.amount}} euros. Thank them."),
        end,
      ]),
    );
    const waiting = await rests(id, "waiting_signal");
    expect({ cursor: waiting.cursor, wakeAt: waiting.wakeAt }).toEqual({
      cursor: "paid",
      wakeAt: null,
    });
    const sent = await client.withTenant(T, () =>
      runner.signalRun(id, { data: { amount: 42, extra: "dropped" }, source: "test" }),
    );
    expect(sent?.runs).toBe(1);
    const r = await rests(id, "done");

    expect(movesOf(title)).toEqual([
      "start ⇒ waitSignal order.paid:order-7 → waiting_signal",
      "resume ⇒ waitSignal order.paid:order-7 → waiting_signal",
      "signal paid ⇒ run thank → running",
      "stepDone thank ⇒ end done → done",
      "resume ⇒ end done → done",
    ]);
    expect(await logOf(id)).toEqual([
      [null, "run_started", "runStarted"],
      ["paid", "step_started", "Paid"],
      ["paid", "wait", "runWaitsSignal"],
      ["paid", "info", "signalCame"],
      ["paid", "step_done", "Paid"],
      ["thank", "step_started", "Thank"],
      ["thank", "step_done", "Thank"],
    ]);
    expect(callsOf(id)).toEqual(["thank"]);
    expect({ cursor: r.cursor, wakeAt: r.wakeAt }).toEqual({ cursor: "done", wakeAt: null });
    expect(r.state).toEqual({
      values: {},
      outputs: {
        // Only the fields the wait names reach the run.
        paid: output({ json: { came: true, timedOut: false, data: { amount: 42 } } }),
        thank: output({ text: "Thanks for 42." }),
      },
      history: [],
      notes: {},
      signals: [expect.stringMatching(/^sig_/)],
    });
  });

  it("6: a step that fails once passes on its retry", async () => {
    const title = "Pinned: retry";
    // The first answer is empty: the step fails for its own reason, and `retries` tries it again.
    scripted.script = ({ step, n }) => (step === "draft" && n > 1 ? "A draft." : "");
    const id = await start(
      wizard(title, [text("draft", "Draft", "Write a draft.", { retries: 1 }), end]),
    );
    const asleep = await rests(id, "sleeping");
    expect(asleep.cursor).toBe("draft");
    // The clock wakes it after FLOW_LIMITS.failureRetryMs (10 s), with nobody's help.
    expect(asleep.wakeAt!.getTime() - Date.now()).toBeGreaterThan(5_000);
    expect(asleep.state).toEqual({
      values: {},
      outputs: {},
      history: [],
      notes: {},
      retries: { step: "draft", count: 0, since: expect.any(String), failures: 1 },
      pause: { kind: "retry" },
      // The step's turn stays on the run; its conversation starts over on the retry.
      turn: { stepId: "draft", id: expect.any(String) },
    });
    expect(movesOf(title)).toEqual([
      "start ⇒ run draft → running",
      "stepFailed draft ⇒ sleep draft (retry) → sleeping",
    ]);
    const r = await rests(id, "done", 40_000);

    expect(movesOf(title)).toEqual([
      "start ⇒ run draft → running",
      "stepFailed draft ⇒ sleep draft (retry) → sleeping",
      "woke ⇒ run draft → running",
      "stepDone draft ⇒ end done → done",
      "resume ⇒ end done → done",
    ]);
    expect(await logOf(id)).toEqual([
      [null, "run_started", "runStarted"],
      ["draft", "step_started", "Draft"],
      ["draft", "info", 'stepRetries {"minutes":0}'],
      ["draft", "step_started", "Draft"],
      ["draft", "step_done", "Draft"],
    ]);
    expect(callsOf(id)).toEqual(["draft", "draft"]);
    expect({ cursor: r.cursor, wakeAt: r.wakeAt }).toEqual({ cursor: "done", wakeAt: null });
    expect(r.state).toEqual({
      values: {},
      outputs: { draft: output({ text: "A draft." }) },
      history: [],
      notes: {},
    });
  });
});
