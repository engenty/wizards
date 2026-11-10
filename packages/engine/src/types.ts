import type { AgentStep, WizardDefinition } from "@engenty/wizards-shared/definition";
import {
  type AskAnswer,
  type AskInput,
  type AssetRef,
  noteText,
  type RunNote,
  type RunState,
  type RunTurn,
  type StepOutput,
} from "@engenty/wizards-shared/run";
import type {
  ModelsService,
  RunServices,
  ServiceStep,
  ToolCallRequest,
  ToolDescriptor,
  ToolResult,
  ToolsService,
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
  /** The durable turn this step runs in; none: its tool calls have no lasting id (broker/effect.ts). */
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
 * The run's services as step code calls them: `RunServices`, and what an agent step needs while
 * its loop runs in Mastra's `Agent` inside the runtime (until package 2.4 of
 * docs/plans/runs-on-their-own.md keeps the loop in the engine). The runtime implements them
 * (apps/runtime/src/run-services).
 */
export interface StepServices extends RunServices {
  models: ModelsService & {
    /** The model of an agent step, with what its loop needs. */
    agentModel(
      request: Pick<TurnRequest, "stepId" | "class" | "effort" | "maker">,
    ): Promise<AgentModel>;
  };
  /** A whole step answers with its output inside the runtime, never `pending` (until package 3.7). */
  steps: { run(step: ServiceStep, signal?: AbortSignal): Promise<StepOutput> };
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

/** The model of an agent step whose loop runs in Mastra's `Agent`, and what the step asks of it. */
export interface AgentModel {
  /** Its tool loop runs in a process of its own: an installed client, the run's device. */
  readonly ownLoop: boolean;
  /** It can call tools: an installed client that runs none cannot. */
  readonly takesTools: boolean;
  /** It takes pictures in a message: the installed clients and the large vendors' models. */
  readonly seesImages: boolean;
  /** Hands the step's tools to a model that runs them itself; `ignorable`: the device may answer alone. */
  attach(tools: Record<string, unknown>, ignorable: boolean): void;
  /** Books what one model step used. */
  charge(usage: unknown): Promise<void>;
  /** Books what an `Agent` call used over all its steps. */
  chargeTotal(result: object): Promise<void>;
  /** One call of Mastra's `Agent` with this model: streamed where `onText` takes the text. */
  generate(call: AgentCall): Promise<AgentAnswer>;
  /** Runs a durable turn with this model or goes on with it, until it ends or stops for a person. */
  durableTurn(turn: RunTurn, ctx: StepContext, input: AgentTurnInput): Promise<AgentTurnEnd>;
}

/** What an `Agent` call takes. */
export interface AgentCall {
  id: string;
  name: string;
  instructions: string;
  /** The tools as Mastra's `Agent` takes them, each with its `execute`. */
  tools: Record<string, unknown>;
  /** The request: text, or messages with pictures. */
  message: unknown;
  maxSteps: number;
  signal: AbortSignal;
  /** Text the model writes as it writes it; given, the call streams. */
  onText?(delta: string): Promise<void>;
}

/** What an `Agent` call gives back: its text, its steps' texts, and the usage `chargeTotal` reads. */
export interface AgentAnswer {
  text?: string;
  steps?: { text?: string }[];
}

/** What a durable turn takes. */
export interface AgentTurnInput {
  instructions: string;
  /** Built over the turn's context. */
  tools: Record<string, unknown>;
  /** The array the tools add to. */
  assets: AssetRef[];
  message: unknown;
  maxSteps: number;
  /** A model step has ended, with what it used. */
  onStepUsage(usage: unknown): Promise<void>;
  /** Text the model writes as it writes it. */
  onText?(delta: string): Promise<void>;
}

/** How a durable turn ended. */
export interface AgentTurnEnd {
  text: string;
  /** The turn's last message: `text` holds what the model said between its tool calls too. */
  closing: string;
  assets: AssetRef[];
}

/** A tool of an agent step, as the step's model is told of it. */
export interface StepToolDescriptor extends ToolDescriptor {
  /**
   * The tool as Mastra's `Agent` takes it, without its code: its id, its schema as built, how its
   * result reaches the model; a provider's own tool whole. The step's model is told of each tool
   * as before, until the engine keeps its own loop (package 2.4) and builds it from the descriptor.
   */
  mastra: Record<string, unknown>;
}

/** The tools of one agent step as it runs: built once, over the step's own context. */
export interface StepToolSet {
  list(): StepToolDescriptor[];
  /** `context`: what Mastra's loop hands the tool, passed on to it as it is. */
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
  /** The durable turn the step runs in: its tools work in the turn's context. */
  turn?: RunTurn;
}
