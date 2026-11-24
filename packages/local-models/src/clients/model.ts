import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageModel, LanguageModel } from "ai";
import { ClientFailure, type ClientMeta } from "./failure.js";
import {
  DEFAULT_WORDS,
  extensionOf,
  jsonInstruction,
  type PromptWords,
  parseJsonAnswer,
  renderPrompt,
} from "./prompt.js";

/**
 * An installed AI client as a model: every call runs the client once, headless, on the person's
 * own sign-in. A call with tools hands them to the client over MCP (the host's `bridge`) and lets
 * it work through them itself; a call that wants structured output has the client validate it
 * against the schema where it can, else asks for JSON and parses it. A client that makes images
 * on the sign-in is an image model as well (ClientImageModel).
 */

type V3 = Extract<LanguageModel, { specificationVersion: "v3" }>;
type ImageV3 = Extract<ImageModel, { specificationVersion: "v3" }>;
type ImageCallOptions = Parameters<ImageV3["doGenerate"]>[0];
type ImageResult = Awaited<ReturnType<ImageV3["doGenerate"]>>;
type CallOptions = Parameters<V3["doGenerate"]>[0];
type GenerateResult = Awaited<ReturnType<V3["doGenerate"]>>;
type StreamResult = Awaited<ReturnType<V3["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer P> ? P : never;

/** How hard the client works on a call, where it takes a hint. */
export type Effort = "low" | "medium" | "high";

/** A tool of the call, served to the client over MCP while it answers. */
export interface BridgeTool {
  name: string;
  description?: string;
  /** JSON Schema of the input, as the model call declares it. */
  inputSchema: Record<string, unknown>;
  /** `signal`: aborted when the bridge closes or the client gives the call up. */
  execute(input: unknown, options?: { signal?: AbortSignal }): Promise<unknown>;
  /** What the model gets to see of a result where a tool shapes it (a screenshot, say). */
  toModelOutput?: (output: unknown) => unknown;
}

/** Serves a call's tools over MCP at `url` until `close`. */
export type Bridge = (tools: BridgeTool[]) => { url: string; close(): void };

export interface ClientModelOptions {
  effort?: Effort;
  /** Where each call gets a folder of its own, deleted afterwards. Default: the system's temp folder. */
  workDir?: string;
  /** Serves a call's tools to the client; without it a call's tools are left out, with a warning. */
  bridge?: Bridge;
  /** The sentences the client reads besides the call's messages. */
  words?: PromptWords;
  /** What a client's failure becomes for the host, such as an error that names it in the person's language. */
  error?: (failure: ClientFailure) => Error;
}

/** A tool the call's caller built, as Mastra makes them: it runs on its own, with the input it declares. */
interface Executor {
  id?: string;
  description?: string;
  execute?: (input: unknown, context?: unknown) => Promise<unknown>;
  toModelOutput?: (output: unknown) => unknown;
}

/** One call, as the client is asked for it. */
export interface ClientCall {
  /** A folder of this call alone: attachments, config files; deleted afterwards. */
  dir: string;
  system: string;
  prompt: string;
  files: string[];
  /** The MCP server holding this call's tools, when it has any. */
  bridgeUrl: string | null;
  /** The schema the answer must match — only for a client that validates it itself. */
  schema: unknown | null;
  webSearch: boolean;
  effort?: Effort;
  signal?: AbortSignal;
}

export interface ClientAnswer {
  text: string;
  usage?: { input?: number; cacheRead?: number; cacheWrite?: number; output?: number };
  meta?: Record<string, string | number | boolean | null>;
  sessionId?: string;
  stopReason?: string;
}

const callDir = (workDir: string | undefined) =>
  join(workDir ?? join(tmpdir(), "engenty-local-models"), randomBytes(8).toString("hex"));

/** A failure as the host wants it: ENOENT is a client that is not installed. */
function hostError(
  err: unknown,
  client: ClientMeta,
  error: ((failure: ClientFailure) => Error) | undefined,
): unknown {
  const failure =
    (err as NodeJS.ErrnoException)?.code === "ENOENT" && !(err instanceof ClientFailure)
      ? new ClientFailure("not_installed", client, (err as Error).message)
      : err;
  return failure instanceof ClientFailure && error ? error(failure) : failure;
}

export abstract class ClientModel implements V3 {
  readonly specificationVersion = "v3" as const;
  abstract readonly provider: string;
  readonly modelId: string;
  readonly supportedUrls = {};
  /** Whether the client validates structured output against the schema itself. */
  protected readonly nativeSchema: boolean = false;
  /** Whether the client runs a call's tools (over the bridge); else they are left out, with a warning. */
  protected readonly usesTools: boolean = true;
  /** The same, for whoever builds the call: a caller tells such a client no tools exist. */
  get takesTools(): boolean {
    return this.usesTools;
  }
  /** Whether the client searches the web with a tool of its own, tools of the call or not. */
  protected readonly searchesWeb: boolean = true;
  protected readonly effort?: Effort;
  protected readonly client: ClientMeta;
  protected readonly options: ClientModelOptions;
  private readonly executors = new Map<string, Executor>();

  constructor(client: ClientMeta, alias: string, options: ClientModelOptions = {}) {
    this.client = client;
    this.modelId = alias;
    this.effort = options.effort;
    this.options = options;
  }

  /** The tools a call may name, by the names the agent gives them: the client runs them over the bridge. */
  attach(tools: Record<string, unknown>) {
    for (const [name, tool] of Object.entries(tools)) {
      const t = tool as Executor;
      if (typeof t?.execute === "function") {
        this.executors.set(name, t);
        if (t.id) {
          this.executors.set(t.id, t);
        }
      }
    }
  }

  /** Runs the client once for this call. */
  protected abstract invoke(call: ClientCall): Promise<ClientAnswer>;

  async doGenerate(options: CallOptions): Promise<GenerateResult> {
    const dir = callDir(this.options.workDir);
    mkdirSync(dir, { recursive: true });
    const words = this.options.words ?? DEFAULT_WORDS;
    const { system, prompt, files, warnings } = renderPrompt(options.prompt, dir, words);
    const bridged: BridgeTool[] = [];
    let webSearch = false;
    for (const tool of options.tools ?? []) {
      // The client searches with its own tool; naming `web_search` is what switches it on.
      if (tool.type === "function" && tool.name === "web_search" && this.searchesWeb) {
        webSearch = true;
        continue;
      }
      if (tool.type !== "function" || !this.usesTools || !this.options.bridge) {
        warnings.push({ type: "unsupported", feature: `tool ${tool.name}` });
        continue;
      }
      const executor = this.executors.get(tool.name);
      if (!executor?.execute) {
        warnings.push({
          type: "unsupported",
          feature: `tool ${tool.name}`,
          details: "no executor",
        });
        continue;
      }
      bridged.push({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as Record<string, unknown>,
        execute: (input) => executor.execute!(input),
        toModelOutput: executor.toModelOutput,
      });
    }
    for (const key of ["temperature", "topP", "topK", "seed", "stopSequences"] as const) {
      if (options[key] !== undefined) {
        warnings.push({ type: "unsupported", feature: key });
      }
    }
    const structured = options.responseFormat?.type === "json";
    const schema =
      structured && options.responseFormat?.type === "json"
        ? (options.responseFormat.schema ?? null)
        : null;
    const bridge = bridged.length && this.options.bridge ? this.options.bridge(bridged) : null;
    try {
      const answer = await this.invoke({
        dir,
        system:
          structured && !this.nativeSchema
            ? [system, jsonInstruction(schema, words)].filter(Boolean).join("\n\n")
            : system,
        prompt,
        files,
        bridgeUrl: bridge?.url ?? null,
        schema: this.nativeSchema ? schema : null,
        webSearch,
        effort: this.effort,
        signal: options.abortSignal,
      });
      const u = answer.usage ?? {};
      const cacheRead = u.cacheRead ?? 0;
      const cacheWrite = u.cacheWrite ?? 0;
      const input = u.input ?? 0;
      return {
        content: [
          {
            type: "text",
            text: structured ? JSON.stringify(parseJsonAnswer(answer.text)) : answer.text,
          },
        ],
        finishReason: { unified: "stop", raw: answer.stopReason },
        usage: {
          inputTokens: {
            total: input,
            noCache: Math.max(0, input - cacheRead - cacheWrite),
            cacheRead,
            cacheWrite,
          },
          outputTokens: { total: u.output ?? 0, text: u.output ?? 0, reasoning: undefined },
          raw: u as Record<string, number>,
        },
        providerMetadata: { [this.provider]: answer.meta ?? {} },
        response: { id: answer.sessionId, modelId: this.modelId },
        warnings,
      };
    } catch (err) {
      throw hostError(err, this.client, this.options.error);
    } finally {
      bridge?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** The answer as one piece: the client prints it when it is done. */
  async doStream(options: CallOptions): Promise<StreamResult> {
    const result = await this.doGenerate(options);
    const text = result.content.find((c) => c.type === "text");
    const parts: StreamPart[] = [
      { type: "stream-start", warnings: result.warnings },
      { type: "response-metadata", ...result.response },
      { type: "text-start", id: "0" },
      { type: "text-delta", id: "0", delta: text?.type === "text" ? text.text : "" },
      { type: "text-end", id: "0" },
      {
        type: "finish",
        usage: result.usage,
        finishReason: result.finishReason,
        providerMetadata: result.providerMetadata,
      },
    ];
    return {
      stream: new ReadableStream<StreamPart>({
        start(controller) {
          for (const part of parts) {
            controller.enqueue(part);
          }
          controller.close();
        },
      }),
    };
  }
}

/** One image call, as the client is asked for it. */
export interface ClientImageCall {
  /** A folder of this call alone, with the reference images in it; deleted afterwards. */
  dir: string;
  prompt: string;
  /** The reference images, as paths in `dir`. */
  files: string[];
  aspectRatio?: string;
  signal?: AbortSignal;
}

/** A client that makes images on the person's sign-in: one client run per image. */
export abstract class ClientImageModel implements ImageV3 {
  readonly specificationVersion = "v3" as const;
  abstract readonly provider: string;
  readonly modelId: string;
  readonly maxImagesPerCall = 1;
  protected readonly client: ClientMeta;
  protected readonly options: ClientModelOptions;

  constructor(client: ClientMeta, alias: string, options: ClientModelOptions = {}) {
    this.client = client;
    this.modelId = alias;
    this.options = options;
  }

  /** Runs the client once and hands back the image it made. */
  protected abstract invoke(call: ClientImageCall): Promise<Uint8Array>;

  async doGenerate(options: ImageCallOptions): Promise<ImageResult> {
    const dir = callDir(this.options.workDir);
    mkdirSync(dir, { recursive: true });
    const warnings: ImageResult["warnings"] = [];
    const files: string[] = [];
    for (const file of options.files ?? []) {
      if (file.type !== "file") {
        warnings.push({ type: "unsupported", feature: "image url" });
        continue;
      }
      const path = join(dir, `ref-${files.length + 1}.${extensionOf(file.mediaType)}`);
      writeFileSync(
        path,
        typeof file.data === "string" ? Buffer.from(file.data, "base64") : file.data,
      );
      files.push(path);
    }
    for (const key of ["size", "seed", "mask"] as const) {
      if (options[key] !== undefined) {
        warnings.push({ type: "unsupported", feature: key });
      }
    }
    try {
      const image = await this.invoke({
        dir,
        prompt: options.prompt ?? "",
        files,
        aspectRatio: options.aspectRatio,
        signal: options.abortSignal,
      });
      return {
        images: [image],
        warnings,
        response: { timestamp: new Date(), modelId: this.modelId, headers: undefined },
      };
    } catch (err) {
      throw hostError(err, this.client, this.options.error);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
