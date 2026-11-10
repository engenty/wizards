import { runAgentStep } from "@engenty/wizards-engine/steps/agent";
import {
  type AgentModel,
  type AgentTurn,
  type StepContext,
  StepError,
  type StepToolSet,
  TurnAsks,
  type TurnStore,
} from "@engenty/wizards-engine/types";
import { type AgentStep, parseWizard } from "@engenty/wizards-shared/definition";
import type { RunState } from "@engenty/wizards-shared/run";
import type {
  ToolCallRequest,
  TurnMessage,
  TurnPart,
  TurnRequest,
} from "@engenty/wizards-shared/run-services";
import { describe, expect, it } from "vitest";

// The engine's agent loop (packages/engine/src/steps/agent-turn.ts) on a host in memory: the turns
// in a map, the model a script, the tools a list that records each call.

const finish: TurnPart = {
  type: "finish",
  reason: "stop",
  usage: { inputTokens: 1, outputTokens: 1 },
  model: "test/scripted",
};
const call = (toolCallId: string, name: string, input: unknown = {}): TurnPart[] => [
  { type: "tool-call", toolCallId, name, input },
  finish,
];
const say = (text: string): TurnPart[] => [{ type: "text", text }, finish];

/** The tool results a model call is shown, by tool name. */
const results = (messages: TurnMessage[], name?: string) =>
  messages.flatMap((m) =>
    typeof m.content === "string"
      ? []
      : m.content.filter((p) => p.type === "tool-result" && (!name || p.name === name)),
  );

function stepOf(more: Partial<AgentStep> = {}): AgentStep {
  const parsed = parseWizard({
    version: 1,
    title: "Turn",
    description: "",
    avatar: "round",
    steps: [
      {
        id: "work",
        type: "agent",
        title: "Work",
        instructions: "Send the mails.",
        tools: [],
        output: { format: "text" },
        ...more,
      },
      { id: "done", type: "result", title: "Done", deliverables: [] },
    ],
  });
  if (!parsed.ok) {
    throw new Error(parsed.issues.map((i) => i.message).join("; "));
  }
  return parsed.wizard.steps[0] as AgentStep;
}

/** What outlives a process: the run's state and its turns. */
function memoryHost() {
  const turns = new Map<string, AgentTurn>();
  const saves: AgentTurn[] = [];
  const store: TurnStore = {
    load: async (id) => structuredClone(turns.get(id) ?? null),
    save: async (turn) => {
      saves.push(structuredClone(turn));
      turns.set(turn.id, structuredClone(turn));
    },
    drop: async (stepId) => {
      for (const [id, turn] of turns) {
        if (turn.stepId === stepId) {
          turns.delete(id);
        }
      }
    },
  };
  const state: RunState = { values: {}, outputs: {}, history: [], notes: {} };
  return { turns, saves, store, state, stored: structuredClone(state) };
}

type Host = ReturnType<typeof memoryHost>;

/** One process of the run: a context over the host, the script as the model. */
function process(
  host: Host,
  step: AgentStep,
  script: (request: TurnRequest, n: number) => TurnPart[] | Promise<TurnPart[]>,
  options: { ownLoop?: boolean } = {},
) {
  const abort = new AbortController();
  const asked: TurnRequest[] = [];
  const toolCalls: Omit<ToolCallRequest, "stepId">[] = [];
  const said: string[] = [];
  const model: AgentModel = {
    ownLoop: options.ownLoop ?? false,
    takesTools: true,
    seesImages: false,
    attach: () => {},
    async *turn(request) {
      asked.push(structuredClone(request));
      yield* await script(request, asked.length);
    },
  };
  const tools: StepToolSet = {
    list: () => [
      { name: "send", description: "Sends a mail.", inputSchema: { type: "object" }, mastra: {} },
      {
        name: "look",
        description: "Looks.",
        inputSchema: { type: "object" },
        onlyReads: true,
        mastra: {},
      },
    ],
    call: async (request) => {
      toolCalls.push(request);
      tools.assets.push({ id: request.effect ?? "", kind: "file", mime: "text/plain", name: "mail.txt" });
      return { output: { sent: request.input } };
    },
    assets: [],
    sandbox: false,
  };
  // The state as the run's row has it: each process reads it anew.
  const state = structuredClone(host.stored);
  const def = { steps: [step] } as never;
  const ctx = {
    runId: "run1",
    tenantId: "t",
    stepId: step.id,
    def,
    lang: null,
    files: [],
    state,
    scope: { def, state },
    signal: abort.signal,
    emit: async (_type: string, message: unknown) => {
      said.push(typeof message === "string" ? message : (message as { code: string }).code);
    },
    saveState: async () => {
      host.stored = structuredClone(state);
    },
    turns: host.store,
    durable: true,
    services: {
      models: { agentModel: async () => model },
      files: { uploads: async () => [] },
      tools: { forStep: async () => tools },
      context: {
        forStep: async () => ({
          date: "10. November 2026",
          lang: "en",
          brand: {},
          files: [],
          knowledge: "",
          skills: "",
          plugins: { blocks: [], html: [] },
        }),
      },
    },
  } as unknown as StepContext;
  return { ctx, abort, asked, toolCalls, said, run: () => runAgentStep(step, ctx) };
}

describe("an agent turn in the engine", () => {
  it("runs a model call's tool calls one by one, each under its effect id, and saves after each", async () => {
    const host = memoryHost();
    const p = process(host, stepOf(), (request, n) =>
      n === 1
        ? [
            { type: "tool-call", toolCallId: "c1", name: "send", input: { to: "anna" } },
            { type: "tool-call", toolCallId: "c2", name: "look", input: {} },
            { type: "tool-call", toolCallId: "c3", name: "send", input: { to: "ben" } },
            finish,
          ]
        : say(`sent ${results(request.messages, "send").length} mails`),
    );
    const out = await p.run();
    const turn = host.stored.turn;
    expect(turn).toMatchObject({ stepId: "work", id: expect.stringMatching(/^run1\.[\w-]{12}$/) });
    expect(out.text).toBe("sent 2 mails");
    expect(p.toolCalls.map((c) => [c.name, c.effect])).toEqual([
      ["send", `${turn?.id}:c1`],
      ["look", `${turn?.id}:c2`],
      ["send", `${turn?.id}:c3`],
    ]);
    // Saved after the model call, after each tool call, and at the end.
    expect(host.saves.map((t) => [t.calls, t.pending.length, Boolean(t.end)])).toEqual([
      [1, 3, false],
      [1, 2, false],
      [1, 1, false],
      [1, 0, false],
      [2, 0, true],
    ]);
    expect(p.asked).toHaveLength(2);
    expect(results(p.asked[1].messages).map((r) => r.type === "tool-result" && r.toolCallId)).toEqual([
      "c1",
      "c2",
      "c3",
    ]);
    // A tool that acts is noted on the run before it is called.
    expect(host.stored.turn?.acted).toBe(true);
    // The model is told of the step's tools, not of asking the person: the step is not durable.
    expect(p.asked[0].tools?.map((t) => t.name)).toEqual(["send", "look"]);
  });

  it("tells a model that runs its tools itself (an installed client, the device) of the step's tools", async () => {
    const host = memoryHost();
    const p = process(host, stepOf(), () => say("done"), { ownLoop: true });
    const out = await p.run();
    expect(out.text).toBe("done");
    // It runs them over its bridge with what was attached; the call names the ones it may use.
    expect(p.asked[0].tools?.map((t) => t.name)).toEqual(["send", "look"]);
    expect(p.toolCalls).toEqual([]);
  });

  it("goes on at the second model call after a kill between the two", async () => {
    const host = memoryHost();
    const step = stepOf();
    const first = process(host, step, (_request, n) => {
      if (n === 2) {
        // The process dies: its signal ends with it, and nothing after this is written.
        first.abort.abort("killed");
        throw new Error("killed");
      }
      return call("c1", "send", { to: "anna" });
    });
    await expect(first.run()).rejects.toThrow("killed");
    expect(first.toolCalls).toHaveLength(1);

    const second = process(host, step, (request) =>
      say(`went on with ${results(request.messages, "send").length}`),
    );
    const out = await second.run();
    expect(out.text).toBe("went on with 1");
    // The file of the first process's call is the step's too.
    expect(out.assets?.map((a) => a.id)).toEqual([first.toolCalls[0].effect]);
    // The second process makes no first call again and does not send again.
    expect(second.asked).toHaveLength(1);
    expect(second.toolCalls).toHaveLength(0);
    expect(second.said).toContain("turnWentOn");
    expect(host.turns.get(host.stored.turn?.id ?? "")?.calls).toBe(2);
  });

  it("makes a call again under its id after a kill in the middle of it", async () => {
    const host = memoryHost();
    const step = stepOf();
    const first = process(host, step, () => call("c1", "send", { to: "anna" }));
    const kill = host.store.save;
    host.store.save = async (turn) => {
      // Dies before the call's result is saved.
      if (turn.pending.length === 0 && turn.calls === 1) {
        first.abort.abort("killed");
        throw new Error("killed");
      }
      await kill(turn);
    };
    await expect(first.run()).rejects.toThrow("killed");
    host.store.save = kill;
    const second = process(host, step, (_request, n) =>
      n === 1 ? say("done") : call("c9", "send"),
    );
    await second.run();
    // The broker finds what the first try did by the same effect id.
    expect(first.toolCalls.map((c) => c.effect)).toEqual(second.toolCalls.map((c) => c.effect));
    expect(second.asked).toHaveLength(1);
  });

  it("asks the person: the run waits with the question, the answer goes on in another process", async () => {
    const host = memoryHost();
    const step = stepOf({ durable: true });
    const script = (request: TurnRequest) => {
      const answered = results(request.messages, "ask_person");
      return answered.length
        ? say(`for ${JSON.stringify(answered[0].type === "tool-result" && answered[0].output)}`)
        : call("q1", "ask_person", { question: "Which offer?" });
    };
    const first = process(host, step, script);
    await expect(first.run()).rejects.toBeInstanceOf(TurnAsks);
    expect(first.asked[0].tools?.map((t) => t.name)).toContain("ask_person");
    expect(host.stored.turn?.question).toBe("Which offer?");
    // The question is no action.
    expect(host.stored.turn?.acted).toBeUndefined();

    // The person answers, as the run's door writes it on the row.
    host.stored.turn = { ...(host.stored.turn as NonNullable<RunState["turn"]>), answer: "the big one" };
    const second = process(host, step, script);
    const out = await second.run();
    expect(out.text).toBe('for {"answer":"the big one"}');
    expect(second.asked).toHaveLength(1);
    expect(second.said).not.toContain("turnWentOn");
    expect(host.stored.turn?.question).toBeUndefined();
    expect(host.stored.turn?.answer).toBeUndefined();
  });

  it("stops before acting when a model repeats a tool call id", async () => {
    const host = memoryHost();
    const p = process(host, stepOf(), () => call("call_0", "send"));
    await expect(p.run()).rejects.toBeInstanceOf(StepError);
    expect(p.toolCalls).toHaveLength(1);
    // A failure starts the turn over on its next try.
    expect(host.turns.get(host.stored.turn?.id ?? "")).toMatchObject({ calls: 0, pending: [] });
  });

  it("gives each entry of a foreach step a turn of its own under the step's", async () => {
    const host = memoryHost();
    const step: AgentStep = { ...stepOf(), foreach: "lists.people" };
    const p = process(host, step, (request) =>
      results(request.messages).length ? say("ok") : call("c1", "send"),
    );
    p.ctx.scope = {
      ...p.ctx.scope,
      lists: { people: { rows: [{ cells: { name: "anna" } }, { cells: { name: "ben" } }] } },
    } as never;
    await p.run();
    const id = host.stored.turn?.id;
    expect(p.toolCalls.map((c) => c.effect)).toEqual([`${id}.0:c1`, `${id}.1:c1`]);
  });
});
