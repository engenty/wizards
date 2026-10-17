import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Effort } from "@engenty-wizards/shared/definition";
import type { RunNote } from "@engenty-wizards/shared/run";
import { note } from "@engenty-wizards/shared/run";
import type { ImageModel, LanguageModel } from "ai";
import { nanoid } from "nanoid";
import { env } from "../env.js";
import { type BridgeTool, openBridge } from "../mcp/bridge.js";
import { ModelUnavailableError } from "../model-errors.js";
import { extensionOf, jsonInstruction, parseJsonAnswer, renderPrompt } from "./prompt.js";

/**
 * An installed AI client as a model: every call runs the client once, headless, on the person's
 * own sign-in. A call with tools hands them to the client over MCP (../mcp/bridge.ts) and lets
 * it work through them itself; a call that wants structured output has the client validate it
 * against the schema where it can, else asks for JSON and parses it. A client that makes images
 * on the sign-in (Codex) is an image model as well (HarnessImageModel); video and audio stay
 * with keys.
 */

type V3 = Extract<LanguageModel, { specificationVersion: "v3" }>;
type ImageV3 = Extract<ImageModel, { specificationVersion: "v3" }>;
type ImageCallOptions = Parameters<ImageV3["doGenerate"]>[0];
type ImageResult = Awaited<ReturnType<ImageV3["doGenerate"]>>;
type CallOptions = Parameters<V3["doGenerate"]>[0];
type GenerateResult = Awaited<ReturnType<V3["doGenerate"]>>;
type StreamResult = Awaited<ReturnType<V3["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer P> ? P : never;

/** A tool the step built, as Mastra makes them: it runs on its own, with the input it declares. */
interface Executor {
  id?: string;
  description?: string;
  execute?: (input: unknown, context?: unknown) => Promise<unknown>;
  toModelOutput?: (output: unknown) => unknown;
}

/** One call, as the client is asked for it. */
export interface HarnessCall {
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

export interface HarnessAnswer {
  text: string;
  usage?: { input?: number; cacheRead?: number; cacheWrite?: number; output?: number };
  meta?: Record<string, string | number | boolean | null>;
  sessionId?: string;
  stopReason?: string;
}

/** Who answers, as a failure names it: an installed client, or Apple Intelligence (./apple.ts). */
export interface HarnessMeta {
  id: string;
  name: string;
  exhausted?: RunNote;
}

const workDir = join(env.dataDir, "harness");

export const signedOut = (h: HarnessMeta) => note("clientNotSignedIn", { name: h.name });
export const notInstalled = (h: HarnessMeta) => note("clientNotInstalled", { name: h.name });
export const notServed = (h: HarnessMeta) => note("clientAccountNotServed", { name: h.name });
export const exhausted = (h: HarnessMeta) =>
  h.exhausted ?? note("clientNoCredit", { name: h.name });

/** The failure a client reports, as the person should read it. */
export function failureOf(h: HarnessMeta, detail: string): Error {
  // The client's own words stay in the log: the sentence below sums them up for the person.
  console.warn(`[${h.id}] ${detail.replace(/\s+/g, " ").trim().slice(0, 1500)}`);
  if (
    /credit balance|billing|too low|usage limit|quota|insufficient|rate.?limit|\b429\b/i.test(
      detail,
    )
  ) {
    return new ModelUnavailableError(exhausted(h));
  }
  // Signed in, but the vendor no longer serves that account with this client: signing in again
  // with the same account changes nothing.
  if (/IneligibleTier|no longer supported|UNSUPPORTED_CLIENT|not eligible/i.test(detail)) {
    return new ModelUnavailableError(notServed(h));
  }
  if (
    /authenticat|log ?in|logged in|oauth|credential|unauthori[sz]ed|\b401\b|api key/i.test(detail)
  ) {
    return new ModelUnavailableError(signedOut(h));
  }
  return new Error(`${h.name}: ${detail}`.slice(0, 500));
}

export interface ClientRun {
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Runs a client once with the prompt on stdin; a client that is not there raises ENOENT. */
export function runClient(
  bin: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; stdin?: string },
): Promise<ClientRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      signal: opts.signal,
      env: opts.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-4000);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
    child.stdin.on("error", () => {
      // The client went away before reading the prompt; `close` reports it.
    });
    child.stdin.end(opts.stdin ?? "");
  });
}

/** The last line of an output that is a JSON object. */
export function lastJson<T>(stdout: string): T | null {
  for (const line of stdout.trim().split("\n").reverse()) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object") {
        return value as T;
      }
    } catch {
      // not it
    }
  }
  return null;
}

export abstract class HarnessModel implements V3 {
  readonly specificationVersion = "v3" as const;
  abstract readonly provider: string;
  readonly modelId: string;
  readonly supportedUrls = {};
  /** Whether the client validates structured output against the schema itself. */
  protected readonly nativeSchema: boolean = false;
  /** Whether the client runs a call's tools (over the bridge); else they are left out, with a warning. */
  protected readonly usesTools: boolean = true;
  /** Whether the client searches the web with a tool of its own, tools of the call or not. */
  protected readonly searchesWeb: boolean = true;
  protected readonly effort?: Effort;
  protected readonly harness: HarnessMeta;
  private readonly executors = new Map<string, Executor>();

  constructor(harness: HarnessMeta, alias: string, effort?: Effort) {
    this.harness = harness;
    this.modelId = alias;
    this.effort = effort;
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
  protected abstract invoke(call: HarnessCall): Promise<HarnessAnswer>;

  async doGenerate(options: CallOptions): Promise<GenerateResult> {
    const dir = join(workDir, nanoid(10));
    mkdirSync(dir, { recursive: true });
    const { system, prompt, files, warnings } = renderPrompt(options.prompt, dir);
    const bridged: BridgeTool[] = [];
    let webSearch = false;
    for (const tool of options.tools ?? []) {
      // The client searches with its own tool; naming `web_search` is what switches it on.
      if (tool.type === "function" && tool.name === "web_search" && this.searchesWeb) {
        webSearch = true;
        continue;
      }
      if (tool.type !== "function" || !this.usesTools) {
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
    const bridge = bridged.length ? openBridge(bridged) : null;
    try {
      const answer = await this.invoke({
        dir,
        system:
          structured && !this.nativeSchema
            ? [system, jsonInstruction(schema)].filter(Boolean).join("\n\n")
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
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ModelUnavailableError(notInstalled(this.harness));
      }
      throw err;
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
export interface HarnessImageCall {
  /** A folder of this call alone, with the reference images in it; deleted afterwards. */
  dir: string;
  prompt: string;
  /** The reference images, as paths in `dir`. */
  files: string[];
  aspectRatio?: string;
  signal?: AbortSignal;
}

/** A client that makes images on the person's sign-in: one client run per image. */
export abstract class HarnessImageModel implements ImageV3 {
  readonly specificationVersion = "v3" as const;
  abstract readonly provider: string;
  readonly modelId: string;
  readonly maxImagesPerCall = 1;
  protected readonly harness: HarnessMeta;

  constructor(harness: HarnessMeta, alias: string) {
    this.harness = harness;
    this.modelId = alias;
  }

  /** Runs the client once and hands back the image it made. */
  protected abstract invoke(call: HarnessImageCall): Promise<Uint8Array>;

  async doGenerate(options: ImageCallOptions): Promise<ImageResult> {
    const dir = join(workDir, nanoid(10));
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
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ModelUnavailableError(notInstalled(this.harness));
      }
      throw err;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
