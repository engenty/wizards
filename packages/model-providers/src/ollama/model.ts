import type { LanguageModel } from "ai";
import { ollamaRoot } from "./api.js";

/**
 * A model of Ollama as an AI SDK language model, on Ollama's own chat API (`/api/chat`). The
 * OpenAI-compatible API cannot set the context length, and Ollama then cuts a long conversation
 * without saying so; here the caller sets it.
 */

/** The AI SDK's language model, version 3. */
export type ChatModel = Extract<LanguageModel, { specificationVersion: "v3" }>;
export type CallOptions = Parameters<ChatModel["doStream"]>[0];
export type StreamResult = Awaited<ReturnType<ChatModel["doStream"]>>;
export type StreamPart = StreamResult["stream"] extends ReadableStream<infer P> ? P : never;
export type GenerateResult = Awaited<ReturnType<ChatModel["doGenerate"]>>;

export interface OllamaSetup {
  /** Who answers, as the AI SDK names it. Default: `ollama`. */
  provider?: string;
  /** Ollama's address: its root, or the OpenAI-compatible `…/v1`. */
  url: string;
  model: string;
  /** Tokens the model reads at most (`num_ctx`); left out, Ollama's default. */
  context?: number;
  /** Whether the model gets the call's tools. Without them it only talks. Default: true. */
  tools?: boolean;
  /**
   * Whether the model thinks before it answers; left out, Ollama decides. What it thinks streams
   * as reasoning, apart from the answer.
   */
  thinking?: boolean;
  fetch?: typeof fetch;
}

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Pictures of the message, base64. */
  images?: string[];
  tool_calls?: { function: { name: string; arguments: unknown } }[];
  tool_name?: string;
}

interface OllamaChunk {
  message?: {
    content?: string;
    /** What a thinking model thinks, beside the answer. */
    thinking?: string;
    tool_calls?: { function: { name: string; arguments: unknown } }[];
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

const asObject = (input: unknown): unknown => {
  if (typeof input !== "string") {
    return input ?? {};
  }
  try {
    return JSON.parse(input);
  } catch {
    return {};
  }
};

/** A file part's bytes as base64, however the AI SDK hands them over. */
export function base64Of(data: unknown): string | undefined {
  if (data instanceof Uint8Array) {
    return Buffer.from(data).toString("base64");
  }
  if (data && typeof data === "object" && (data as { type?: string }).type === "data") {
    return base64Of((data as { data?: unknown }).data);
  }
  if (typeof data !== "string") {
    return undefined;
  }
  return data.startsWith("data:") ? data.slice(data.indexOf(",") + 1) : data;
}

/** One piece of a tool's answer with pictures, in any of the AI SDK's spellings. */
interface ContentPiece {
  type: string;
  text?: string;
  data?: unknown;
  mediaType?: string;
}

/** The base64 of a picture in a tool's answer, when it is one. */
function pictureOf(piece: ContentPiece): string | undefined {
  if (!piece.mediaType?.startsWith("image/")) {
    return undefined;
  }
  return base64Of(piece.data);
}

/**
 * The AI SDK's prompt as Ollama's messages. Pictures go along with the newest message of the
 * person and what tools showed after it; an older message names its pictures instead, so they
 * are not sent again each turn.
 */
export function ollamaMessages(prompt: CallOptions["prompt"]): OllamaMessage[] {
  const messages: OllamaMessage[] = [];
  const newest = prompt.findLastIndex((message) => message.role === "user");
  for (const [at, message] of prompt.entries()) {
    if (message.role === "system") {
      messages.push({ role: "system", content: message.content });
    } else if (message.role === "user") {
      const texts: string[] = [];
      const images: string[] = [];
      for (const part of message.content) {
        if (part.type === "text") {
          texts.push(part.text);
        } else if (part.type === "file" && part.mediaType.startsWith("image/")) {
          const picture = at === newest ? base64Of(part.data) : undefined;
          if (picture) {
            images.push(picture);
          } else {
            texts.push(`[picture: ${part.filename ?? "attached earlier"}]`);
          }
        }
      }
      messages.push({
        role: "user",
        content: texts.join("\n"),
        ...(images.length ? { images } : {}),
      });
    } else if (message.role === "assistant") {
      const text = message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
      const calls = message.content
        .filter((part) => part.type === "tool-call")
        .map((part) => ({ function: { name: part.toolName, arguments: asObject(part.input) } }));
      messages.push({
        role: "assistant",
        content: text,
        ...(calls.length ? { tool_calls: calls } : {}),
      });
    } else {
      const shown: string[] = [];
      for (const part of message.content) {
        if (part.type !== "tool-result") {
          continue;
        }
        const output = part.output;
        let content: string;
        if (output.type === "content") {
          const texts: string[] = [];
          for (const piece of output.value as ContentPiece[]) {
            const picture = piece.type === "text" ? undefined : pictureOf(piece);
            if (piece.type === "text") {
              texts.push(piece.text ?? "");
            } else if (picture && at > newest) {
              shown.push(picture);
            } else if (picture) {
              texts.push("[a picture shown earlier]");
            }
          }
          content = texts.join("\n");
        } else {
          content =
            output.type === "text" || output.type === "error-text"
              ? output.value
              : "value" in output
                ? JSON.stringify(output.value)
                : "The tool call was not allowed.";
        }
        messages.push({ role: "tool", content, tool_name: part.toolName });
      }
      // Ollama takes pictures with a message of the person, not with a tool's answer.
      if (shown.length) {
        messages.push({ role: "user", content: "The pictures the tool showed.", images: shown });
      }
    }
  }
  return messages;
}

async function* lines(body: ReadableStream<Uint8Array>): AsyncGenerator<OllamaChunk> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        yield JSON.parse(line) as OllamaChunk;
      }
      newline = buffer.indexOf("\n");
    }
  }
  if (buffer.trim()) {
    yield JSON.parse(buffer) as OllamaChunk;
  }
}

/** A model of the Ollama at `setup.url`, streaming its answer, its tool calls and the usage. */
export function ollamaModel(setup: OllamaSetup): ChatModel {
  const doFetch = setup.fetch ?? fetch;
  const root = ollamaRoot(setup.url);
  let calls = 0;

  async function doStream(options: CallOptions): Promise<StreamResult> {
    const tools =
      setup.tools === false
        ? []
        : (options.tools ?? [])
            .filter((tool) => tool.type === "function")
            .map((tool) => ({
              type: "function",
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
              },
            }));
    const format =
      options.responseFormat?.type === "json"
        ? (options.responseFormat.schema ?? "json")
        : undefined;
    const response = await doFetch(`${root}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: options.abortSignal,
      body: JSON.stringify({
        model: setup.model,
        messages: ollamaMessages(options.prompt),
        ...(tools.length ? { tools } : {}),
        ...(format ? { format } : {}),
        stream: true,
        // Thinking arrives beside the answer, as `message.thinking`: it streams as reasoning.
        ...(setup.thinking === undefined ? {} : { think: setup.thinking }),
        options: {
          ...(setup.context ? { num_ctx: setup.context } : {}),
          ...(options.maxOutputTokens ? { num_predict: options.maxOutputTokens } : {}),
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options.topP !== undefined ? { top_p: options.topP } : {}),
          ...(options.topK !== undefined ? { top_k: options.topK } : {}),
          ...(options.seed !== undefined ? { seed: options.seed } : {}),
          ...(options.stopSequences?.length ? { stop: options.stopSequences } : {}),
        },
      }),
    }).catch((error) => {
      throw new Error(`Ollama at ${root} did not answer: ${(error as Error).message}`, {
        cause: error,
      });
    });
    if (!(response.ok && response.body)) {
      throw new Error(
        `Ollama answered ${response.status}: ${(await response.text()).slice(0, 300)}`,
      );
    }
    const body = response.body;
    const stream = new ReadableStream<StreamPart>({
      async start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        let textOpen = false;
        let called = false;
        // What the model thinks, one block before each stretch of answer or tool call.
        let thought: string | undefined;
        let thoughts = 0;
        const endThought = () => {
          if (thought) {
            controller.enqueue({ type: "reasoning-end", id: thought });
          }
          thought = undefined;
        };
        try {
          for await (const chunk of lines(body)) {
            if (chunk.error) {
              throw new Error(chunk.error);
            }
            if (chunk.message?.thinking) {
              if (!thought) {
                thought = `reasoning-${thoughts++}`;
                controller.enqueue({ type: "reasoning-start", id: thought });
              }
              controller.enqueue({
                type: "reasoning-delta",
                id: thought,
                delta: chunk.message.thinking,
              });
            }
            if (chunk.message?.content || chunk.message?.tool_calls?.length || chunk.done) {
              endThought();
            }
            if (chunk.message?.content) {
              if (!textOpen) {
                controller.enqueue({ type: "text-start", id: "0" });
              }
              textOpen = true;
              controller.enqueue({ type: "text-delta", id: "0", delta: chunk.message.content });
            }
            for (const call of chunk.message?.tool_calls ?? []) {
              called = true;
              controller.enqueue({
                type: "tool-call",
                toolCallId: `call_${Date.now().toString(36)}_${++calls}`,
                toolName: call.function.name,
                input: JSON.stringify(call.function.arguments ?? {}),
              });
            }
            if (chunk.done) {
              if (textOpen) {
                controller.enqueue({ type: "text-end", id: "0" });
              }
              textOpen = false;
              const input = chunk.prompt_eval_count;
              const output = chunk.eval_count;
              controller.enqueue({
                type: "finish",
                finishReason: {
                  unified: called
                    ? "tool-calls"
                    : chunk.done_reason === "length"
                      ? "length"
                      : "stop",
                  raw: chunk.done_reason,
                },
                usage: {
                  inputTokens: {
                    total: input,
                    noCache: input,
                    cacheRead: undefined,
                    cacheWrite: undefined,
                  },
                  outputTokens: { total: output, text: output, reasoning: undefined },
                },
              });
            }
          }
        } catch (error) {
          controller.enqueue({ type: "error", error });
        }
        controller.close();
      },
    });
    return { stream };
  }

  return {
    specificationVersion: "v3",
    provider: setup.provider ?? "ollama",
    modelId: setup.model,
    supportedUrls: {},
    doStream,
    doGenerate: (options) => generateFrom(doStream, options),
  };
}

/** A whole answer from a model that streams. */
export async function generateFrom(
  doStream: (options: CallOptions) => Promise<StreamResult>,
  options: CallOptions,
): Promise<GenerateResult> {
  const { stream } = await doStream(options);
  let text = "";
  const content: GenerateResult["content"] = [];
  let finish: Extract<StreamPart, { type: "finish" }> | undefined;
  let reasoning = "";
  for await (const part of stream) {
    if (part.type === "text-delta") {
      text += part.delta;
    } else if (part.type === "reasoning-delta") {
      reasoning += part.delta;
    } else if (part.type === "tool-call") {
      content.push(part);
    } else if (part.type === "finish") {
      finish = part;
    } else if (part.type === "error") {
      throw part.error;
    }
  }
  if (text) {
    content.unshift({ type: "text", text });
  }
  if (reasoning) {
    content.unshift({ type: "reasoning", text: reasoning });
  }
  return {
    content,
    finishReason: finish?.finishReason ?? { unified: "other", raw: undefined },
    usage: finish?.usage ?? {
      inputTokens: {
        total: undefined,
        noCache: undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: { total: undefined, text: undefined, reasoning: undefined },
    },
    warnings: [],
  };
}
