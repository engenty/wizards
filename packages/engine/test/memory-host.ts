/**
 * A host in memory: a run with no database, no runtime and no network. The run's row is a
 * variable, the clock is the test's, models answer from a script, tools from a table, files and
 * stored lists are kept in memory. Everything the run asks of its host is kept for the test.
 */
import { type Decision, readObject } from "@engenty/wizards-shared/decision";
import type { WizardDefinition } from "@engenty/wizards-shared/definition";
import type { AssetRef, RunEventType, RunState, Said } from "@engenty/wizards-shared/run";
import type {
  FileRead,
  Notice,
  ToolDescriptor,
  TurnPart,
} from "@engenty/wizards-shared/run-services";
import type { ListDef, ListRow } from "@engenty/wizards-shared/store";
import type {
  FlowEvent,
  FlowFailure,
  FlowResult,
  FlowRun,
} from "@engenty/wizards-shared/transition";
import type { WorkspaceFile } from "@engenty/wizards-shared/workspace";
import { advance } from "../src/advance.js";
import { NOTE_CLASS } from "../src/failures.js";
import { type Move, type RunHost, RunMoved, type SignalCame } from "../src/host.js";
import { surfaceData } from "../src/surface.js";
import { type AgentModel, type StepContext, StepError, type StepServices } from "../src/types.js";

/** A model call as a script reads it. */
export interface ModelCall {
  /** The step that asks. */
  step: string;
  /** A decision (`models.decide`), or a call of the classifier class. */
  decides: boolean;
  /** What the model is given, as text. */
  prompt: string;
  /** How often this step asked so far in the run, this call included. */
  n: number;
}

/** A tool of the table: what it answers for an input, with the run and step that call it. */
export type MemoryTool = (input: unknown, call: { runId: string; stepId: string }) => unknown;

export interface MemoryOptions {
  runId?: string;
  /** Where the clock starts, in ms. */
  now?: number;
  /** What the model answers; a decision answers JSON, `{ <question>: <answer> }`. */
  script?: (call: ModelCall) => string;
  /** Tools by their name as a step calls them (`<plugin>.<tool>`). */
  tools?: Record<string, MemoryTool>;
  /** The workspace the run starts with, by path. */
  workspace?: Record<string, Uint8Array>;
  /** Stored lists, by id. */
  lists?: Record<string, { def: ListDef; rows: ListRow[] }>;
  durable?: boolean;
  effects?: boolean;
}

/** A line of the run's log: [step, type, what it said]; a note by its code and params, else its text. */
export type Line = [string | null, RunEventType, string];

/** A run on a host in memory, and what it was asked. */
export interface MemoryRun {
  host: RunHost;
  /** The run as stored. */
  readonly row: { run: FlowRun; rev: number };
  saves: Move[];
  lines: Line[];
  /** What the model was asked: "<step>", or "<step>?" for a decision. */
  calls: string[];
  /** The wakes the run set, in order; null: none. */
  wakes: (number | null)[];
  /** The person's steps the run stood at. */
  asked: string[];
  notices: Notice[];
  clock: { now: number };
  /** Starts the run, with the host's line. */
  start(): Promise<FlowResult>;
  /** A person answered the page: the door's line and note, then the run goes on. */
  answer(stepId: string, values: Record<string, unknown>): Promise<FlowResult>;
  /** A person accepted the review. */
  review(stepId: string, approved: boolean): Promise<FlowResult>;
  /** A signal comes; true when the run waits for it, and then the clock wakes it. */
  signal(name: string, key: string, data: Record<string, unknown>): Promise<boolean>;
  /** The clock reaches the run's wake and wakes it. */
  wake(): Promise<FlowResult>;
  advance(event: FlowEvent): Promise<FlowResult>;
}

const saidOf = (said: Said): string =>
  typeof said === "string"
    ? said
    : `${said.code}${said.params ? ` ${JSON.stringify(said.params)}` : ""}`;

export function memoryHost(def: WizardDefinition, o: MemoryOptions = {}): MemoryRun {
  const runId = o.runId ?? "run-memory";
  const script = o.script ?? (() => "");
  const tools = o.tools ?? {};
  const lists = o.lists ?? {};
  const stored = new Map<string, FileRead>();
  const signals = new Map<string, SignalCame>();
  let waiting: string | null = null;
  /** A person answered and the door has not written it yet. */
  let answeredAt: number | null = null;
  let signalCount = 0;
  let row: { run: FlowRun; rev: number } = {
    run: {
      cursor: null,
      status: "running",
      state: { values: {}, outputs: {}, history: [], notes: {} },
      wakeAt: null,
    },
    rev: 1,
  };
  const abort = new AbortController();
  const files: WorkspaceFile[] = Object.entries(o.workspace ?? {}).map(([path, data]) => ({
    path,
    hash: "",
    mime: "application/octet-stream",
    size: data.length,
  }));

  const run: MemoryRun = {
    host: undefined as unknown as RunHost,
    get row() {
      return row;
    },
    saves: [],
    lines: [],
    calls: [],
    wakes: [],
    asked: [],
    notices: [],
    clock: { now: o.now ?? Date.parse("2026-11-10T09:00:00Z") },
    async start() {
      await host.event(null, "run_started", { code: "runStarted" });
      return advance(host, { kind: "start" });
    },
    async answer(stepId, values) {
      await host.event(stepId, "step_done", stepOf(stepId).title);
      answeredAt = run.clock.now;
      return advance(host, { kind: "answered", stepId, values });
    },
    async review(stepId, approved) {
      await host.event(stepId, "step_done", stepOf(stepId).title);
      answeredAt = run.clock.now;
      return advance(host, { kind: "reviewed", stepId, approved });
    },
    async signal(name, key, data) {
      signalCount += 1;
      signals.set(`${name}:${key}`, { id: `sig_memory${signalCount}`, data });
      return waiting === `${name}:${key}`;
    },
    async wake() {
      const at = row.run.wakeAt;
      if (at !== null && at > run.clock.now) {
        run.clock.now = at;
      }
      return advance(host, { kind: "woke" });
    },
    advance: (event) => advance(host, event),
  };

  const stepOf = (id: string) => {
    const step = def.steps.find((s) => s.id === id);
    if (!step) {
      throw new Error(`No step ${id}.`);
    }
    return step;
  };

  /** The script's answer, with the call kept. */
  const answer = (step: string, decides: boolean, prompt: unknown) => {
    const name = `${step}${decides ? "?" : ""}`;
    run.calls.push(name);
    const n = run.calls.filter((c) => c === name).length;
    return script({ step, decides, prompt: JSON.stringify(prompt), n });
  };

  const agentModel = (stepId: string): AgentModel => ({
    ownLoop: false,
    takesTools: true,
    seesImages: false,
    attach: () => {},
    charge: async () => {},
    chargeTotal: async () => {},
    async generate(call) {
      const text = answer(stepId, false, {
        instructions: call.instructions,
        message: call.message,
      });
      return { text, steps: [{ text }] };
    },
    durableTurn: async () => {
      throw new Error("A durable turn is not scripted in memory.");
    },
  });

  const callTool = async (name: string, stepId: string, input: unknown) => {
    const tool = tools[name];
    if (!tool) {
      throw new StepError(`No tool ${name}.`);
    }
    return { output: await tool(input, { runId, stepId }) };
  };

  const services: StepServices = {
    models: {
      async *turn(request): AsyncIterable<TurnPart> {
        const text = answer(request.stepId, request.class === "classifier", request.messages);
        yield { type: "text", text };
        yield {
          type: "finish",
          reason: "stop",
          usage: { inputTokens: 1, outputTokens: 1 },
          model: "memory/scripted",
        };
      },
      async decide(request): Promise<Decision> {
        const text = answer(request.stepId, true, request.state);
        const answers = readObject(request.questions, JSON.parse(text));
        if (!answers) {
          throw new Error(`The script's decision for ${request.stepId} does not fit: ${text}`);
        }
        return { answers, source: "llm" };
      },
      embed: async () => null,
      agentModel: async (request) => agentModel(request.stepId),
    },
    tools: {
      list: async () => Object.keys(tools).map(descriptor),
      call: (request) => callTool(request.name, request.stepId, request.input),
      async forStep(_step, ctx) {
        return {
          list: () => [],
          call: (request) => callTool(request.name, ctx.stepId, request.input),
          assets: [],
          sandbox: false,
        };
      },
      ofAgent: async () => {
        throw new Error("A wizard's agent is not kept in memory.");
      },
    },
    context: {
      forStep: async () => ({
        date: new Date(run.clock.now).toISOString().slice(0, 10),
        lang: "en",
        brand: {},
        files: [],
        knowledge: "",
        skills: "",
        plugins: { blocks: [], html: [] },
      }),
      prepareInputs: async () => {},
    },
    files: {
      read: async (ref) => stored.get(ref.replace(/^upload:/, "")) ?? null,
      async save(file) {
        const id = `file-${stored.size + 1}`;
        const ref: AssetRef = { id, kind: file.kind, name: file.name, mime: file.mime ?? "" };
        const data =
          "data" in file
            ? typeof file.data === "string"
              ? new TextEncoder().encode(file.data)
              : file.data
            : new Uint8Array();
        stored.set(id, { ref, data });
        return ref;
      },
      link: async (ref) => `memory:${ref}`,
      uploads: async () => [],
      workspace: async (path) => o.workspace?.[path] ?? null,
    },
    data: {
      query: async () => {
        throw new StepError("A run in memory has no database.");
      },
      exec: async () => {
        throw new StepError("A run in memory has no database.");
      },
      rows: async (listId) => lists[listId] ?? { def: { id: listId } as ListDef, rows: [] },
      counts: async () =>
        Object.fromEntries(Object.entries(lists).map(([id, l]) => [id, l.rows.length])),
    },
    steps: {
      run: async (step) => {
        throw new StepError(`A ${step.type} step is not done in memory.`);
      },
    },
    people: {
      tell: async (notice) => {
        run.notices.push(notice);
      },
    },
  };

  const host: RunHost = {
    runId,
    def,
    files,
    store: {
      load: async () => structuredClone(row),
      async save(move, rev) {
        if (rev !== row.rev) {
          throw new RunMoved();
        }
        const { run: to, command } = move;
        // What the runtime's door writes with an answer's move: when it came and where it led. A
        // person's step it led to straight away takes it off again (the runner's stand, `advance`'s
        // ask), so it is not written there.
        if (answeredAt !== null && command) {
          if (command.kind !== "ask") {
            to.state.answered = { at: answeredAt, next: to.cursor };
          }
          answeredAt = null;
        }
        // The data the result names, kept with a run that reached it.
        const step = def.steps.find((s) => s.id === to.cursor);
        if (to.status === "done" && step?.type === "result" && step.data) {
          to.state.data = surfaceData(step.data, {
            def,
            state: to.state,
            scope: { def, state: to.state, brand: {} },
          });
        } else if (to.status !== "done") {
          delete to.state.data;
        }
        run.saves.push(structuredClone(move));
        row = { run: structuredClone(to), rev: rev + 1 };
        return row.rev;
      },
    },
    clock: {
      now: () => run.clock.now,
      wakeAt: async (at) => {
        run.wakes.push(at);
      },
    },
    event: async (stepId, type, said) => {
      run.lines.push([stepId, type, saidOf(said)]);
    },
    ask: async (step) => {
      run.asked.push(step.id);
    },
    signals: {
      async watch(_stepId, name, key) {
        waiting = `${name}:${key}`;
        const came = signals.get(waiting) ?? null;
        signals.delete(waiting);
        return came;
      },
      drop: async () => {
        waiting = null;
      },
    },
    credits: { hold: async () => "held", canSpend: async () => true },
    start: async () => null,
    async context(step, state: RunState, signal): Promise<StepContext> {
      const ctx: StepContext = {
        runId,
        tenantId: "memory",
        holder: { kind: "person", id: "memory", role: "owner" },
        test: false,
        stepId: step.id,
        ...(state.turn?.stepId === step.id ? { turn: state.turn.id } : {}),
        def,
        lang: null,
        files,
        state,
        scope: { def, state, brand: {} },
        dataSpace: { id: "memory", name: "Memory" },
        signal,
        emit: async (type, message) => {
          await host.event(step.id, type, message);
        },
        ask: async () => null,
        // The state as the step has it, kept where the run stands: the row's revision stays.
        saveState: async () => {
          row = { ...row, run: { ...row.run, state: structuredClone(state) } };
        },
        services,
      };
      return ctx;
    },
    async failure(err, _stepId, acted) {
      if (err instanceof RunMoved) {
        throw err;
      }
      const note = err instanceof StepError ? err.note : null;
      const said: Said = note ?? (err instanceof Error ? err.message : String(err));
      return { kind: "failed", failure: failureOf(note?.code), acted, said };
    },
    within: (_kind, work) => work(abort.signal),
    signal: abort.signal,
    services,
    switches: {
      durable: o.durable ?? true,
      effects: o.effects ?? false,
      lookAgainMs: 5 * 60_000,
    },
  };
  run.host = host;
  return run;
}

/** A failure by its note's class; anything else is final. */
function failureOf(code: string | undefined): FlowFailure {
  switch (NOTE_CLASS[code ?? ""]) {
    case "credits":
      return { class: "credits" };
    case "sign_in":
      return { class: "sign_in", service: "" };
    default:
      return { class: "final" };
  }
}

function descriptor(name: string): ToolDescriptor {
  return { name, description: name, inputSchema: { type: "object" } };
}
