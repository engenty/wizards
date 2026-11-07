import {
  type FinishReason,
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
  streamText,
  type ToolSet,
  tool,
} from "ai";
import type { ChatStart, GooseChat, GooseConversation, Step } from "../chat.js";

// Goose on the Vercel AI SDK, for hosts that run their models through it (wizards, the
// framework). Each step is one `streamText` call without `execute`: the SDK returns the tool
// calls, Goose runs them.

export interface AiSdkOptions {
  /** Provider and model, for the log. */
  label?: string;
  /** Most tokens one step may write. */
  maxOutputTokens?: number;
  /** Passed to each call, e.g. `{ anthropic: { thinking: … } }`. */
  providerOptions?: Parameters<typeof streamText>[0]["providerOptions"];
}

const stopOf = (reason: FinishReason, calls: number): Step["stop"] => {
  if (reason === "length") {
    return "max_tokens";
  }
  if (reason === "content-filter") {
    return "refusal";
  }
  return calls ? "tools" : "end";
};

function conversation(model: LanguageModel, o: AiSdkOptions, start: ChatStart): GooseConversation {
  const tools: ToolSet = Object.fromEntries(
    start.tools.map((t) => [
      t.name,
      tool({
        description: t.description,
        inputSchema: jsonSchema(t.input_schema as Parameters<typeof jsonSchema>[0]),
      }),
    ]),
  );
  const messages: ModelMessage[] = [
    ...start.history.map((m): ModelMessage => ({ role: m.role, content: m.text })),
    {
      role: "user",
      content: start.user.map((p) =>
        p.type === "pdf"
          ? {
              type: "file" as const,
              data: p.data,
              mediaType: "application/pdf",
              filename: p.title,
            }
          : { type: "text" as const, text: p.text },
      ),
    },
  ];
  /** The tool's name by call, which a result names again. */
  const names = new Map<string, string>();
  return {
    async step(onText) {
      const result = streamText({
        model,
        system: start.system,
        messages,
        tools,
        abortSignal: start.signal,
        ...(o.maxOutputTokens ? { maxOutputTokens: o.maxOutputTokens } : {}),
        ...(o.providerOptions ? { providerOptions: o.providerOptions } : {}),
      });
      for await (const part of result.fullStream) {
        if (part.type === "text-delta") {
          onText(part.text);
        } else if (part.type === "error") {
          throw part.error;
        }
      }
      const [calls, finish, response, usage] = await Promise.all([
        result.toolCalls,
        result.finishReason,
        result.response,
        result.usage,
      ]);
      messages.push(...response.messages);
      for (const c of calls) {
        names.set(c.toolCallId, c.toolName);
      }
      return {
        calls: calls.map((c) => ({
          id: c.toolCallId,
          name: c.toolName,
          // A call the SDK found invalid goes to Goose as no input; its zod check says why.
          input: "invalid" in c && c.invalid ? undefined : c.input,
        })),
        stop: stopOf(finish, calls.length),
        usage: `in ${usage.inputTokens ?? "?"} (cached ${usage.inputTokenDetails?.cacheReadTokens ?? 0}) out ${usage.outputTokens ?? "?"} (${finish})`,
      };
    },
    answer(results) {
      messages.push({
        role: "tool",
        content: results.map((r) => ({
          type: "tool-result" as const,
          toolCallId: r.id,
          toolName: names.get(r.id) ?? "",
          output: r.error
            ? { type: "error-text" as const, value: r.content }
            : { type: "text" as const, value: r.content },
        })),
      });
    },
  };
}

/** Goose on an AI SDK model, e.g. `chatOfAiSdk(anthropic("claude-opus-5-5"))`. */
export function chatOfAiSdk(model: LanguageModel, o: AiSdkOptions = {}): GooseChat {
  const label =
    o.label ?? (typeof model === "string" ? model : `${model.provider}/${model.modelId}`);
  return {
    label,
    start: (start) => conversation(model, o, start),
  };
}
