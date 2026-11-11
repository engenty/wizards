/**
 * The run's services (docs/plans/runs-on-their-own.md, "The run's services"): everything a run
 * asks for outside itself, as one typed object. The runtime serves it as functions
 * (apps/runtime/src/run-services/); another host will reach it over HTTP with the run's token.
 * What crosses HTTP has a zod schema here.
 *
 * Every acting call carries an effect id (`EffectId`), a failure comes back with its class
 * (`ServiceError`), and a long call answers `Pending`. Whoever spends books: the run books no cost.
 */
import { z } from "zod";
import type { Decision, DecisionQuestion } from "./decision.js";
import {
  DATA_SCOPES,
  type DataScope,
  EFFORTS,
  type Effort,
  type GenerateStep,
  type MotionGraphicsStep,
  TEXT_CLASSES,
  type TextClass,
  type WidgetStep,
} from "./definition.js";
import {
  type AssetRef,
  RUN_NOTES,
  type RunNote,
  type RunState,
  type RunStatus,
  type Said,
  type StepOutput,
} from "./run.js";
import type {
  AssetSection,
  BrandColor,
  BrandFont,
  BrandGradient,
  BrandLink,
  BrandPattern,
  BrandRule,
  ColorSection,
  LogoSection,
  SpaceFact,
  SpaceFileView,
  TextStyle,
  VoiceBlock,
} from "./spaces.js";
import type { ListDef, ListRow } from "./store.js";
import type { FlowFailure } from "./transition.js";

// --- what every service shares -----------------------------------------------------------------

/** A JSON Schema, as a tool's input or a structured answer is described. */
export type JsonSchema = Record<string, unknown>;

const jsonSchema = z.record(z.string(), z.unknown());

/**
 * Which acting call this is, so a call repeated after a restart finds its row and does not act
 * twice (apps/runtime/src/broker/effect.ts): `<turn>:<toolCallId>` in an agent turn,
 * `<run>:<step>:<visit>` for a fixed step. Null: the call has no lasting identity.
 */
export type EffectId = string;

export const effectIdSchema = z.string().min(1).max(400);

/**
 * A long call's answer: a film or a long sandbox command does not hold a request open. The
 * service tells the run when it is done, by `id`; the run sleeps until then.
 */
export interface Pending {
  pending: true;
  /** What the service tells the run with when the work is done. */
  id: string;
  /** When the run looks again by itself if nothing came, in ms; null: it waits for the service. */
  wakeAt: number | null;
}

export const pendingSchema = z.object({
  pending: z.literal(true),
  id: z.string().min(1),
  wakeAt: z.number().nullable(),
});

export function isPending(value: unknown): value is Pending {
  return (
    typeof value === "object" && value !== null && (value as { pending?: unknown }).pending === true
  );
}

export const flowFailureSchema: z.ZodType<FlowFailure> = z.discriminatedUnion("class", [
  z.object({ class: z.literal("retry"), retryAfterMs: z.number().nullable() }),
  z.object({ class: z.literal("credits") }),
  z.object({ class: z.literal("sign_in"), service: z.string() }),
  z.object({ class: z.literal("final") }),
]);

/**
 * A service's failure, with the class `transition()` takes it as (`stepFailed`). `said`: what the
 * run's log says of it, as the process that met the error put it; left out, the message counts.
 */
export class ServiceError extends Error {
  constructor(
    readonly failure: FlowFailure,
    message: string,
    readonly said?: Said,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

/** Plain words, or a note by its code. */
const saidSchema = z.custom<Said>(
  (value) =>
    typeof value === "string" ||
    (typeof value === "object" &&
      value !== null &&
      typeof (value as { code?: unknown }).code === "string"),
);

/** A failure as it crosses HTTP. */
export const serviceErrorSchema = z.object({
  error: z.object({
    failure: flowFailureSchema,
    message: z.string(),
    said: saidSchema.optional(),
  }),
});

export type ServiceErrorBody = z.infer<typeof serviceErrorSchema>;

// --- models ------------------------------------------------------------------------------------

/** One part of a message a model reads or wrote. Files go by address, never as bytes. */
export type TurnContentPart =
  | { type: "text"; text: string }
  | { type: "file"; url: string; mediaType: string; name?: string }
  | { type: "tool-call"; toolCallId: string; name: string; input: unknown }
  | { type: "tool-result"; toolCallId: string; name: string; output: unknown };

export const turnContentPartSchema: z.ZodType<TurnContentPart> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("file"),
    url: z.string().min(1),
    mediaType: z.string().min(1),
    name: z.string().optional(),
  }),
  z.object({
    type: z.literal("tool-call"),
    toolCallId: z.string().min(1),
    name: z.string().min(1),
    input: z.unknown(),
  }),
  z.object({
    type: z.literal("tool-result"),
    toolCallId: z.string().min(1),
    name: z.string().min(1),
    output: z.unknown(),
  }),
]);

export interface TurnMessage {
  role: "user" | "assistant" | "tool";
  content: string | TurnContentPart[];
}

export const turnMessageSchema: z.ZodType<TurnMessage> = z.object({
  role: z.enum(["user", "assistant", "tool"]),
  content: z.union([z.string(), z.array(turnContentPartSchema)]),
});

/** One model call for a class: the engine keeps the loop, the model answers once. */
export interface TurnRequest {
  /** The step the call is made for; the gateway books it on the run and step. */
  stepId: string;
  class: TextClass;
  effort?: Effort;
  /** The maker class a step names (`anthropic/high`): asked for on the credits instead. */
  maker?: string;
  system?: string;
  messages: TurnMessage[];
  /** The tools the model may call; it only names the calls, the engine makes them. */
  tools?: ToolDescriptor[];
  /** A structured answer in this shape instead of text. */
  output?: JsonSchema;
  /** At most this many tokens in the answer; left out, the model's own limit. */
  maxOutputTokens?: number;
}

/** What a turn streams. The last part is `finish`. */
export type TurnPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; toolCallId: string; name: string; input: unknown }
  | { type: "finish"; reason: string; usage: TurnUsage; model: string };

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface DecideRequest {
  stepId: string;
  /** What the decision is about: text or JSON. */
  state: unknown;
  questions: Record<string, DecisionQuestion>;
  /** A person waits: give up after this long. */
  deadlineMs?: number;
}

/** Vectors for passages or a question, from the model the space's index uses. */
export interface Embedded {
  /** The model the vectors come from. */
  model: string;
  vectors: number[][];
}

export interface ModelsService {
  /** One model call for a class, streamed. */
  turn(request: TurnRequest, signal?: AbortSignal): AsyncIterable<TurnPart>;
  /** Typed questions over a state (class `classifier`), as the decision model or a language model answers them. */
  decide(request: DecideRequest, signal?: AbortSignal): Promise<Decision>;
  /** Null: no embedding model is set up, and search works on words alone. */
  embed(values: string[], signal?: AbortSignal): Promise<Embedded | null>;
}

export const turnUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
});

export const turnPartSchema: z.ZodType<TurnPart> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("reasoning"), text: z.string() }),
  z.object({
    type: z.literal("tool-call"),
    toolCallId: z.string().min(1),
    name: z.string().min(1),
    input: z.unknown(),
  }),
  z.object({
    type: z.literal("finish"),
    reason: z.string(),
    usage: turnUsageSchema,
    model: z.string(),
  }),
]);

const decisionQuestionSchema: z.ZodType<DecisionQuestion> = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("noul"),
    instructions: z.string(),
    criteria: z.object({ true: z.string(), false: z.string() }).optional(),
  }),
  z.object({
    type: z.literal("choice"),
    instructions: z.string(),
    criteria: z.record(z.string(), z.string().nullable()),
  }),
  z.object({ type: z.literal("score"), instructions: z.string(), criteria: z.array(z.string()) }),
]);

export const decideRequestSchema: z.ZodType<DecideRequest> = z.object({
  stepId: z.string().min(1),
  state: z.unknown(),
  questions: z.record(z.string(), decisionQuestionSchema),
  deadlineMs: z.number().int().positive().optional(),
});

export const embedRequestSchema = z.object({ values: z.array(z.string()).min(1) });

// --- tools -------------------------------------------------------------------------------------

/** A tool a step may use, as a model is told of it. */
export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /**
   * The model's provider runs it itself (a provider's web search): the model is told of it, and
   * `tools.call` never sees it.
   */
  provider?: boolean;
  /** The tool only looks: a step whose model called only such tools may be tried again. */
  onlyReads?: boolean;
}

export const toolDescriptorSchema: z.ZodType<ToolDescriptor> = z.object({
  name: z.string().min(1),
  description: z.string(),
  inputSchema: jsonSchema,
  provider: z.boolean().optional(),
  onlyReads: z.boolean().optional(),
});

export interface ToolCallRequest {
  stepId: string;
  name: string;
  input: unknown;
  effect: EffectId | null;
}

export const toolCallRequestSchema: z.ZodType<ToolCallRequest> = z.object({
  stepId: z.string().min(1),
  name: z.string().min(1),
  input: z.unknown(),
  effect: effectIdSchema.nullable(),
});

export interface ToolResult {
  /** What the model reads back. */
  output: unknown;
  /** Files the call made (screenshots, images, exported files). */
  assets?: AssetRef[];
}

export const assetRefSchema: z.ZodType<AssetRef> = z.object({
  id: z.string().min(1),
  kind: z.string(),
  mime: z.string(),
  name: z.string(),
  ai: z.enum(["generated", "edited"]).optional(),
});

export const toolResultSchema: z.ZodType<ToolResult> = z.object({
  output: z.unknown(),
  assets: z.array(assetRefSchema).optional(),
});

export interface ToolsService {
  /** Every tool the step may use. */
  list(stepId: string): Promise<ToolDescriptor[]>;
  call(request: ToolCallRequest, signal?: AbortSignal): Promise<ToolResult | Pending>;
}

// --- context -----------------------------------------------------------------------------------

/** The space the wizard belongs to, as a model is told of it. */
export interface RunBrand {
  name?: string;
  about?: string;
  brandName?: string;
  tagline?: string;
  voice?: VoiceBlock[];
  voiceRules?: BrandRule[];
  links?: BrandLink[];
  colors?: BrandColor[];
  colorSections?: ColorSection[];
  gradients?: BrandGradient[];
  patterns?: BrandPattern[];
  colorRules?: BrandRule[];
  logoSections?: LogoSection[];
  assetSections?: AssetSection[];
  fonts?: BrandFont[];
  textStyles?: TextStyle[];
  typeRules?: BrandRule[];
  logoRules?: BrandRule[];
  facts?: SpaceFact[];
}

/** A file of the space that is ready to use: a logo, a pattern, an asset, a document. */
export type RunSpaceFile = Pick<SpaceFileView, "id" | "kind" | "name" | "mime" | "description">;

/** What the model is told beside a step's task. */
export interface StepSetting {
  /** Today's date as the wizard's people write it. */
  date: string;
  /** The wizard's language code. */
  lang: string;
  brand: RunBrand;
  /** The space's files, the logos and images a document may place among them. */
  files: RunSpaceFile[];
  /** What the space's Knowledge holds for the run, and how to read it; empty: nothing. */
  knowledge: string;
  /** The skills that count in the step, as its instructions name them; empty: none. */
  skills: string;
  /**
   * What the space's plugins hold for its wizards: `blocks` for an agent step's instructions,
   * `html` for a step that writes HTML.
   */
  plugins: { blocks: string[]; html: string[] };
}

export interface ContextService {
  /**
   * `tools`: the step's model can call tools; without, only the skills always on are named.
   * `sandbox`: the step lists the sandbox tool; skills' scripts are named where the run has one.
   */
  forStep(stepId: string, options?: { tools?: boolean; sandbox?: boolean }): Promise<StepSetting>;
  /**
   * Gets the person's answers ready for a step that works on its own: a voice note is listened
   * to once and kept as text with the answer, a recording or signature that is not the run's own
   * upload is dropped. Changes the run's values; what is already done costs nothing.
   */
  prepareInputs(stepId: string): Promise<void>;
}

/** A call that names only the step it is made for: `tools.list`, `context.prepareInputs`, `steps.run`. */
export const stepRequestSchema = z.object({ stepId: z.string().min(1) });

export const forStepRequestSchema = stepRequestSchema.extend({
  options: z.object({ tools: z.boolean().optional(), sandbox: z.boolean().optional() }).optional(),
});

// --- files -------------------------------------------------------------------------------------

/** A file a step saves: its bytes, or an address the service fetches them from. */
export type FileSave = {
  stepId?: string | null;
  /** image | video | audio | html | text | json … */
  kind: string;
  name: string;
  /** Media a model made or changed; travels with the reference. */
  ai?: AssetRef["ai"];
  /** The call that saves it, when a tool or a step saves it as what it does: saved once. */
  effect?: EffectId | null;
} & ({ mime: string; data: Uint8Array | string } | { url: string; mime?: string });

export interface FileRead {
  ref: AssetRef;
  data: Uint8Array;
}

/** A file the person gave on an earlier page: `upload:<id>` is how tools address it. */
export interface UploadRef {
  ref: string;
  name: string;
  mime: string;
  /** The label of the field it was given in. */
  field: string;
}

export interface FilesService {
  /** Null: no such file in the run's tenant. */
  read(ref: string): Promise<FileRead | null>;
  save(file: FileSave): Promise<AssetRef>;
  /** A signed address that opens the file for a while, without a session. */
  link(ref: string): Promise<string>;
  /** Files the person gave on earlier pages. */
  uploads(): Promise<UploadRef[]>;
  /** A file of the workspace the run started with, by path; null: no such file. */
  workspace(path: string): Promise<Uint8Array | null>;
}

/** A save by address, as it crosses HTTP; bytes go to the service's own upload. */
export const fileSaveByUrlSchema = z.object({
  stepId: z.string().nullable().optional(),
  kind: z.string().min(1),
  name: z.string().min(1),
  ai: z.enum(["generated", "edited"]).optional(),
  url: z.string().url(),
  mime: z.string().optional(),
  effect: effectIdSchema.nullable().optional(),
});

/**
 * A save of bytes, as it crosses HTTP: base64 in the JSON. Simple over fast; a file the size of a
 * film goes by address.
 */
export const fileSaveByDataSchema = z.object({
  stepId: z.string().nullable().optional(),
  kind: z.string().min(1),
  name: z.string().min(1),
  ai: z.enum(["generated", "edited"]).optional(),
  mime: z.string().min(1),
  base64: z.string(),
  effect: effectIdSchema.nullable().optional(),
});

export const fileSaveRequestSchema = z.union([fileSaveByUrlSchema, fileSaveByDataSchema]);

/** `files.read` and `files.link`: a file of the run's tenant. */
export const fileRefRequestSchema = z.object({ ref: z.string().min(1).max(200) });

/** `files.workspace`: a file of the workspace the run started with. */
export const workspaceRequestSchema = z.object({ path: z.string().min(1).max(1000) });

/** The header `files.read` answers the file's `AssetRef` in, as JSON; the body is the bytes. */
export const ASSET_REF_HEADER = "x-asset-ref";

/**
 * The header of an answer whose call did something that may not be repeated (a write, a send):
 * the step's try acted, and a failure of it is not tried again by itself. A turn's stream says
 * so in its `TurnToolsLine`s instead.
 */
export const RUN_ACTED_HEADER = "x-run-acted";

// --- data --------------------------------------------------------------------------------------

/** One statement on the wizard's own database. */
export interface DataStatementRequest {
  stepId: string;
  scope: DataScope;
  sql: string;
  params?: Record<string, string | number | boolean | null>;
  /** `model`: SQL a model wrote or the wizard's code it calls; `wizard`: a fixed step's SQL. */
  by: "model" | "wizard";
  effect?: EffectId | null;
}

export interface DataAnswer {
  columns: string[];
  rows: Record<string, unknown>[];
  truncated: boolean;
  changes: number;
  lastId: number | null;
}

export interface DataService {
  /** Reads, with writing switched off. */
  query(request: DataStatementRequest): Promise<DataAnswer>;
  exec(request: DataStatementRequest): Promise<DataAnswer>;
  /** A stored list's rows, as the run's holder may read them. */
  rows(listId: string): Promise<{ def: ListDef; rows: ListRow[] }>;
  /** Rows per stored list, for rules that read `lists.<list>.count`. */
  counts(): Promise<Record<string, number>>;
}

export const dataStatementRequestSchema: z.ZodType<DataStatementRequest> = z.object({
  stepId: z.string().min(1),
  scope: z.enum(DATA_SCOPES),
  sql: z.string().min(1).max(20_000),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  by: z.enum(["model", "wizard"]),
  effect: effectIdSchema.nullable().optional(),
});

export const listRowsRequestSchema = z.object({ listId: z.string().min(1) });

export const dataAnswerSchema: z.ZodType<DataAnswer> = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.record(z.string(), z.unknown())),
  truncated: z.boolean(),
  changes: z.number(),
  lastId: z.number().nullable(),
});

// --- steps -------------------------------------------------------------------------------------

/** The steps a service does whole: they need software the engine has not (models for media, a bundler, a browser, the film tools). */
export type ServiceStep = GenerateStep | WidgetStep | MotionGraphicsStep;

export const SERVICE_STEP_TYPES = ["generate", "widget", "motion-graphics"] as const;

export function isServiceStep(step: { type: string }): step is ServiceStep {
  return (SERVICE_STEP_TYPES as readonly string[]).includes(step.type);
}

export interface StepsService {
  /** `effect`: the step's visit, `<run>:<step>:<visit>`; a repeat answers with the output made. */
  run(
    step: ServiceStep,
    signal?: AbortSignal,
    effect?: EffectId | null,
  ): Promise<StepOutput | Pending>;
}

/** `steps.run` as it crosses HTTP: the run's own step by its id, and the visit it is made in. */
export const stepRunRequestSchema = z.object({
  stepId: z.string().min(1),
  effect: effectIdSchema.nullable().optional(),
});

// --- people ------------------------------------------------------------------------------------

export const NOTICE_KINDS = ["needs_you", "reminder", "done", "failed", "paused"] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

/** A word to whoever the run concerns: a step waits for someone, a reminder, done, failed. */
export interface Notice {
  kind: NoticeKind;
  /** The step the run waits on, which says who is told. */
  stepId?: string | null;
  detail?: string | null;
  /** What a `needs_you` or `reminder` waits on: `step:<id>`, `ask:<id>`, `pause:<kind>`. */
  waitKey?: string | null;
  /** A reminder is due later, in ms; anything else now. */
  dueAt?: number | null;
}

export const noticeSchema: z.ZodType<Notice> = z.object({
  kind: z.enum(NOTICE_KINDS),
  stepId: z.string().nullable().optional(),
  detail: z.string().max(300).nullable().optional(),
  waitKey: z.string().nullable().optional(),
  dueAt: z.number().nullable().optional(),
});

export interface PeopleService {
  tell(notice: Notice): Promise<void>;
}

// --- all of it ---------------------------------------------------------------------------------

/**
 * Where a host reaches the run's services over HTTP: `POST <runtime>/api/run-services/v1/<service>/<call>`
 * with `Authorization: Bearer <run token>`, the request as JSON.
 */
export const RUN_SERVICES_PATH = "/api/run-services/v1";

/** A call that takes nothing: `files.uploads`, `data.counts`. */
export const emptyRequestSchema = z.object({});

export interface RunServices {
  models: ModelsService;
  tools: ToolsService;
  context: ContextService;
  files: FilesService;
  data: DataService;
  steps: StepsService;
  people: PeopleService;
}

/** `models.turn`'s request; down here because it takes the tools' descriptors. */
export const turnRequestSchema: z.ZodType<TurnRequest> = z.object({
  stepId: z.string().min(1),
  class: z.enum(TEXT_CLASSES),
  effort: z.enum(EFFORTS).optional(),
  maker: z.string().optional(),
  system: z.string().optional(),
  messages: z.array(turnMessageSchema),
  tools: z.array(toolDescriptorSchema).optional(),
  output: jsonSchema.optional(),
  maxOutputTokens: z.number().int().positive().optional(),
});

// --- an agent step's calls ---------------------------------------------------------------------

/*
 * What an agent step asks of the runtime beyond `RunServices` (the engine's `StepServices`), as
 * it crosses HTTP: the step's model, its tools, the wizard's agent that runs it. A request names
 * the step and never carries it: the runtime reads it from the run's definition (an entry's with
 * that entry's item, an agent's as the agent's file has it) and builds its tools again for each
 * call.
 */

/** Where an agent step's tools work: the step, its turn, and the foreach entry it runs for. */
export interface StepToolsAt {
  stepId: string;
  /** The turn the tools work in: their calls' effect ids are `<turn>:<toolCallId>`. */
  turn: string;
  /** The index of the foreach entry the step runs for; none outside an entry. */
  entry?: number;
}

export const stepToolsAtSchema = z.object({
  stepId: z.string().min(1),
  turn: z.string().min(1).max(300),
  entry: z.number().int().min(0).optional(),
});

/** `tools.forStep`'s answer: the step's tools as its model is told of them. */
export interface StepToolsAnswer {
  tools: ToolDescriptor[];
  /** The files the tools made while they were built. */
  assets: AssetRef[];
  /** How to write a program over the tools, with the `code` tool. */
  instructions?: string;
  /** The run has a sandbox for a step that lists the sandbox tool. */
  sandbox: boolean;
}

/** One of an agent step's tools called (`tools.stepCall`); it answers a `ToolResult`. */
export interface StepToolCall extends StepToolsAt {
  name: string;
  input: unknown;
  effect: EffectId | null;
}

export const stepToolCallSchema: z.ZodType<StepToolCall> = stepToolsAtSchema.extend({
  name: z.string().min(1),
  input: z.unknown(),
  effect: effectIdSchema.nullable(),
});

/** `models.agentModel`'s request: the class of the step's model. */
export const agentModelRequestSchema = z.object({
  stepId: z.string().min(1),
  class: z.enum(TEXT_CLASSES),
  effort: z.enum(EFFORTS).optional(),
  maker: z.string().optional(),
});

/** `models.agentModel`'s answer: what the step's loop asks of its model. */
export interface AgentModelFlags {
  ownLoop: boolean;
  takesTools: boolean;
  seesImages: boolean;
}

/**
 * The step's tools handed to its model (`AgentModel.attach`), by name: the runtime builds the
 * step's tools again and attaches those.
 */
export interface AttachedTools extends StepToolsAt {
  names: string[];
  /** The run's device may answer alone. */
  ignorable: boolean;
}

/** `models.agentTurn`'s request: a turn, and the tools attached to the step's model. */
export type AgentTurnRequest = TurnRequest & { attached?: AttachedTools };

export const agentTurnRequestSchema: z.ZodType<AgentTurnRequest> = z.intersection(
  turnRequestSchema,
  z.object({
    attached: stepToolsAtSchema
      .extend({ names: z.array(z.string().min(1)), ignorable: z.boolean() })
      .optional(),
  }),
);

/**
 * A line of `models.agentTurn`'s NDJSON beside the turn's parts: what the tools did that a model
 * with its own loop called within the turn. `acted`: one did more than read; `assets`: the files
 * they made.
 */
export interface TurnToolsLine {
  tools: { acted?: true; assets?: AssetRef[] };
}

export const turnToolsLineSchema: z.ZodType<TurnToolsLine> = z.object({
  tools: z.object({
    acted: z.literal(true).optional(),
    assets: z.array(assetRefSchema).optional(),
  }),
});

// --- the run's own record ----------------------------------------------------------------------

/*
 * A run that works on another host keeps its state there; its tenant keeps the record (docs/plans/
 * runs-on-their-own.md, "Record, state, token"). The host posts a copy of its state as each
 * step starts (the services build a step's context from the record), at each person's step and
 * at the end (`run/report`, with the run's token), and the tenant writes the record from it: the
 * status, the cursor, the state, the wake. What a status change sets off (notices, credits,
 * plugins, Manage's copy) happens at the tenant, once.
 */

const REPORTED_STATUSES = [
  "waiting_input",
  "sleeping",
  "waiting_signal",
  "running",
  "done",
  "failed",
  "cancelled",
] as const satisfies readonly RunStatus[];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Why the run failed: words, or one of the run's notes. Stricter than a failure's `said`: the record
 * keeps it, and every reader says it in their language.
 */
const failedSaidSchema: z.ZodType<Said> = z.union([
  z.string().max(2000),
  z.custom<RunNote>(
    (v) => isRecord(v) && typeof v.code === "string" && v.code in RUN_NOTES.en,
    "A note is one of the run's notes.",
  ),
]);

/** A host's copy of its run. */
export interface RunReport {
  status: RunStatus;
  cursor: string | null;
  state: RunState;
  /** When the clock wakes the run, in ms; null: nothing due. */
  wakeAt: number | null;
  /** The host's revision of the state: a copy no newer than the record changes nothing. */
  rev: number;
  /**
   * What the run spent so far, in micro-credits, as the host counted it: for reading only. The
   * services book every call themselves.
   */
  cost?: number;
  /** Why the run failed, when it did. */
  error?: Said | null;
}

export const runReportSchema: z.ZodType<RunReport> = z.object({
  status: z.enum(REPORTED_STATUSES),
  cursor: z.string().nullable(),
  // The engine's own shape, kept as it comes: checked as an object, not field by field.
  state: z.custom<RunState>(isRecord, "A run's state is an object."),
  wakeAt: z.number().nullable(),
  rev: z.number().int().nonnegative(),
  cost: z.number().nonnegative().optional(),
  error: failedSaidSchema.nullable().optional(),
});

/** What the tenant did with a copy: `kept`, or not, since the record was as new or the run is over. */
export interface RunReportAnswer {
  kept: boolean;
  /** The record's status and revision after the call. */
  status: RunStatus;
  rev: number;
}

export const runReportAnswerSchema: z.ZodType<RunReportAnswer> = z.object({
  kept: z.boolean(),
  status: z.enum(REPORTED_STATUSES),
  rev: z.number().int(),
});
