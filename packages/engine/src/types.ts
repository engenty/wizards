import type { AgentStep, WizardDefinition } from "@engenty/wizards-shared/definition";
import {
  type AskAnswer,
  type AskInput,
  type AssetRef,
  noteText,
  type RunNote,
  type RunState,
  type StepOutput,
} from "@engenty/wizards-shared/run";
import type {
  ModelsService,
  Pending,
  RunServices,
  ServiceStep,
  ToolCallRequest,
  ToolDescriptor,
  ToolResult,
  ToolsService,
  TurnMessage,
  TurnPart,
  TurnRequest,
  UploadRef,
} from "@engenty/wizards-shared/run-services";
import type { WorkspaceFile } from "@engenty/wizards-shared/workspace";
import type { TemplateScope } from "./template.js";

/**
 * Who a run belongs to, as the broker asks it (the runtime's broker/rwx.ts): a guest on a shared
 * link (the visitor, else the run itself), or a signed-in person with their role in the
 * organization.
 */
export type RunHolder =
  | { kind: "guest"; id: string }
  | { kind: "person"; id: string; role: "owner" | "admin" | "member" | "client" };

/** What asking the person gives: their answer, or nothing within the time a step waits. */
export type AskResult = AskAnswer | { type: "timeout" };

export interface StepContext {
  runId: string;
  tenantId: string;
  /** Who holds the run; with the wizard, who a step reads as. */
  holder: RunHolder;
  /** A test run from the studio: it writes the wizard's memory into a copy of its own. */
  test: boolean;
  /** The current step's id. */
  stepId: string;
  /**
   * The agent turn this step's code runs in: its tool calls' effect ids are `<turn>:<toolCallId>`
   * (broker/effect.ts). The agent step sets it; none outside an agent step.
   */
  turn?: string;
  def: WizardDefinition;
  /** The language the viewer reads the wizard in, translated on request; null: its own. */
  lang: string | null;
  /** The workspace the run started with. */
  files: WorkspaceFile[];
  state: RunState;
  scope: TemplateScope;
  /**
   * Where the run's data is (docs/plans/client-portal.md): the client space a run was started
   * in, whose Knowledge reaches through to the parent as the rules allow; else the wizard's space.
   */
  dataSpace: { id: string; name: string };
  signal: AbortSignal;
  /** Tells the person what the step is doing; `asset` is a picture of the run it is about. */
  emit(type: "tool" | "info", message: string | RunNote, asset?: string): Promise<void>;
  /**
   * Asks the person and waits for the answer. `null` when nobody is there to answer (a run an
   * MCP client drives).
   */
  ask(ask: AskInput): Promise<AskResult | null>;
  /** A share job's step: the run is done and the person sends its result on (broker/over.ts). */
  share?: boolean;
  /** Writes `state` to the run's row, for what must outlive this process in the middle of a step. */
  saveState(): Promise<void>;
  /** The run's agent turns, saved after every model call (RunHost.turns). */
  turns: TurnStore;
  /** Durable runs are on: a `durable` step's turn may stop to ask the person. */
  durable: boolean;
  /** Everything outside the run, as the run's services (docs/plans/runs-on-their-own.md). */
  services: StepServices;
}

/**
 * A step failure the person can read: a note of `RUN_NOTES`, shown in the wizard's language, or
 * free text. The message keeps the English line for the log.
 */
export class StepError extends Error {
  readonly note: RunNote | null;

  constructor(said: string | RunNote) {
    super(typeof said === "string" ? said : noteText(said, "en"));
    this.note = typeof said === "string" ? null : said;
  }
}

// --- the services step code calls -------------------------------------------------------------

/**
 * The run's services as step code calls them: `RunServices`, and what an agent step needs of the
 * runtime while a step's tools and its model's own tools are built there (docs/plans/runs-on-their-own.md).
 * The runtime implements them (apps/runtime/src/run-services).
 */
export interface StepServices extends RunServices {
  models: ModelsService & {
    /** The model of an agent step, with what its loop needs. */
    agentModel(
      request: Pick<TurnRequest, "stepId" | "class" | "effort" | "maker">,
    ): Promise<AgentModel>;
  };
  /**
   * A whole step answers with its output, or with `pending`: a service works on it (a film, a
   * video) and the run sleeps until it is done. Asked again for the same step (`RunState.job`),
   * the service answers the job's output, `pending` while it works, or throws its failure.
   */
  steps: { run(step: ServiceStep, signal?: AbortSignal): Promise<StepOutput | Pending> };
  tools: ToolsService & {
    /**
     * The tools of an agent step: `ctx` is its own (a foreach entry's, a wizard's agent's), which
     * a step id alone does not name.
     */
    forStep(step: AgentStep, ctx: StepContext, options: StepToolsOptions): Promise<StepToolSet>;
    /** The step as the wizard's agent it names runs it: the agent's file gives model and tools. */
    ofAgent(
      step: AgentStep & { agent: string },
      ctx: StepContext,
    ): Promise<{ step: AgentStep; instructions: string }>;
  };
}

/** The model of an agent step, and what the step's loop asks of it. */
export interface AgentModel {
  /** Its tool loop runs in a process of its own: an installed client, the run's device. */
  readonly ownLoop: boolean;
  /** It can call tools: an installed client that runs none cannot. */
  readonly takesTools: boolean;
  /** It takes pictures in a message: the installed clients and the large vendors' models. */
  readonly seesImages: boolean;
  /**
   * Hands the step's tools to the model: one that runs them itself calls them, a provider's own
   * tool goes with each call. `ignorable`: the device may answer alone.
   */
  attach(tools: Record<string, unknown>, ignorable: boolean): void;
  /** One model call, as `models.turn`, with this model and what was attached to it. */
  turn(request: TurnRequest, signal?: AbortSignal): AsyncIterable<TurnPart>;
}

/** A tool call the model asked for in a turn. */
export interface TurnToolCall {
  toolCallId: string;
  name: string;
  input: unknown;
}

/**
 * An agent turn as its host keeps it, saved after every model call and every tool call: a process
 * that goes on with the step finds the conversation where it stopped.
 */
export interface AgentTurn {
  /** `<run>.<random>`; a foreach entry's and a wizard's agent's add to the step's. */
  id: string;
  stepId: string;
  /** The conversation from the step's request on. The system part is built again each time. */
  messages: TurnMessage[];
  /** The tool calls of the model's last answer that have no result yet, in order. */
  pending: TurnToolCall[];
  /** Model calls made. */
  calls: number;
  /** What the model wrote across its calls. */
  text: string;
  /** The files the turn's tools made. */
  assets: AssetRef[];
  /** How the turn ended, kept until the step's output is saved. */
  end?: { text: string; closing: string };
}

/** Where a host keeps the run's agent turns. */
export interface TurnStore {
  load(id: string): Promise<AgentTurn | null>;
  save(turn: AgentTurn): Promise<void>;
  /** The step's output is saved: its turns (an entry's, a wizard's agent's too) are let go. */
  drop(stepId: string): Promise<void>;
}

/** A turn stopped to ask the person: the run waits with the question, and no process holds it. */
export class TurnAsks extends Error {
  constructor(readonly question: string) {
    super(question);
    this.name = "TurnAsks";
  }
}

/** A tool of an agent step, as the step's model is told of it. */
export interface StepToolDescriptor extends ToolDescriptor {
  /**
   * The tool as the runtime built it, without its code: what `AgentModel.attach` hands a model
   * that runs its tools itself; a provider's own tool whole.
   */
  mastra: Record<string, unknown>;
}

/** The tools of one agent step as it runs: built once, over the step's own context. */
export interface StepToolSet {
  list(): StepToolDescriptor[];
  /** `context`: what a model that runs its tools itself hands the tool, passed on as it is. */
  call(request: Omit<ToolCallRequest, "stepId">, context?: unknown): Promise<ToolResult>;
  /** The array the tools add the files they make to (screenshots, images, exported files). */
  assets: AssetRef[];
  /** How to write a program over the tools, with the `code` tool. */
  instructions?: string;
  /** The run has a sandbox for a step that lists the sandbox tool. */
  readonly sandbox: boolean;
}

export interface StepToolsOptions {
  model: AgentModel;
  uploads: UploadRef[];
  /** The turn the step runs in: its tools work in the turn's context. */
  turn: string;
}
