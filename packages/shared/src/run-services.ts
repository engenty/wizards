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
import type { AssetRef, StepOutput } from "./run.js";
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

/** A service's failure, with the class `transition()` takes it as (`stepFailed`). */
export class ServiceError extends Error {
  constructor(
    readonly failure: FlowFailure,
    message: string,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

/** A failure as it crosses HTTP. */
export const serviceErrorSchema = z.object({
  error: z.object({ failure: flowFailureSchema, message: z.string() }),
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
}

export const toolDescriptorSchema: z.ZodType<ToolDescriptor> = z.object({
  name: z.string().min(1),
  description: z.string(),
  inputSchema: jsonSchema,
  provider: z.boolean().optional(),
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

/** What the model is told beside a step's task. */
export interface StepSetting {
  /** Today's date as the wizard's people write it. */
  date: string;
  /** The wizard's language code. */
  lang: string;
  brand: RunBrand;
  /** What the space's Knowledge holds for the run, and how to read it; empty: nothing. */
  knowledge: string;
  /** The skills that count in the step, as its instructions name them; empty: none. */
  skills: string;
}

export interface ContextService {
  /** `tools`: the step's model can call tools; without, only the skills always on are named. */
  forStep(stepId: string, options?: { tools?: boolean }): Promise<StepSetting>;
}

// --- files -------------------------------------------------------------------------------------

/** A file a step saves: its bytes, or an address the service fetches them from. */
export type FileSave = {
  stepId?: string | null;
  /** image | video | audio | html | text | json … */
  kind: string;
  name: string;
  /** Media a model made or changed; travels with the reference. */
  ai?: AssetRef["ai"];
} & ({ mime: string; data: Uint8Array | string } | { url: string; mime?: string });

export interface FileRead {
  ref: AssetRef;
  data: Uint8Array;
}

export interface FilesService {
  /** Null: no such file in the run's tenant. */
  read(ref: string): Promise<FileRead | null>;
  save(file: FileSave): Promise<AssetRef>;
  /** A signed address that opens the file for a while, without a session. */
  link(ref: string): Promise<string>;
}

/** A save by address, as it crosses HTTP; bytes go to the service's own upload. */
export const fileSaveByUrlSchema = z.object({
  stepId: z.string().nullable().optional(),
  kind: z.string().min(1),
  name: z.string().min(1),
  ai: z.enum(["generated", "edited"]).optional(),
  url: z.string().url(),
  mime: z.string().optional(),
});

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
  run(step: ServiceStep, signal?: AbortSignal): Promise<StepOutput | Pending>;
}

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
});
