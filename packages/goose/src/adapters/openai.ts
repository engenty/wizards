import OpenAI from "openai";
import type { ChatStart, GooseChat, GooseConversation, Step } from "../chat.js";
import { clientCache, parseArgs, type SdkSetup } from "./shared.js";

// Goose on OpenAI's SDK. OpenAI's own models through its Responses API, which they need for tools
// with reasoning; every other provider through its OpenAI-compatible chat API, which OpenRouter,
// Vercel's AI Gateway, Mistral, Ollama and most others offer.

export interface OpenAiSetup extends SdkSetup {
  /** `responses` for OpenAI itself; `chat` (chat completions) for compatible APIs. */
  api: "responses" | "chat";
  /** A client of the host's; otherwise one is made (and kept) for the key and URL. */
  client?: OpenAI;
  /** Sends effort as `reasoning: { effort }` with chat completions (OpenRouter, AI Gateway). */
  reasoning?: boolean;
}

const clients = clientCache<OpenAI>();

/**
 * Without a key, no Authorization header at all: Ollama ignores it, but some gateways refuse a
 * wrong key where they take none.
 */
const clientOf = (s: OpenAiSetup) =>
  s.client ??
  clients(
    "openai",
    s,
    () =>
      new OpenAI({
        ...(s.apiKey
          ? { apiKey: s.apiKey }
          : {
              apiKey: "none",
              defaultHeaders: { Authorization: null as unknown as string },
            }),
        baseURL: s.baseUrl,
      }),
  );

const stopOf = (reason: string | null | undefined, calls: number): Step["stop"] => {
  if (reason === "max_output_tokens" || reason === "length") {
    return "max_tokens";
  }
  if (reason === "content_filter") {
    return "refusal";
  }
  return calls ? "tools" : "end";
};

/** Nothing is stored at OpenAI; each step sends the whole conversation, reasoning included. */
function responses(client: OpenAI, s: OpenAiSetup, start: ChatStart): GooseConversation {
  const tools: OpenAI.Responses.FunctionTool[] = start.tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.input_schema,
    strict: false,
  }));
  const input: OpenAI.Responses.ResponseInputItem[] = [
    ...start.history.map(
      (m): OpenAI.Responses.ResponseInputItem => ({
        role: m.role,
        content: m.text,
      }),
    ),
    {
      role: "user",
      content: start.user.map(
        (p): OpenAI.Responses.ResponseInputContent =>
          p.type === "pdf"
            ? {
                type: "input_file",
                filename: p.title,
                file_data: `data:application/pdf;base64,${p.data}`,
              }
            : { type: "input_text", text: p.text },
      ),
    },
  ];
  return {
    async step(onText) {
      const stream = await client.responses.create(
        {
          model: s.model,
          instructions: start.system,
          input,
          tools,
          store: false,
          include: ["reasoning.encrypted_content"],
          max_output_tokens: s.maxTokens ?? 64_000,
          ...(s.effort ? { reasoning: { effort: s.effort } } : {}),
          stream: true,
        },
        { signal: start.signal },
      );
      let response: OpenAI.Responses.Response | null = null;
      for await (const event of stream) {
        if (event.type === "response.output_text.delta") {
          onText(event.delta);
        } else if (
          event.type === "response.completed" ||
          event.type === "response.incomplete" ||
          event.type === "response.failed"
        ) {
          response = event.response;
        }
      }
      if (!response) {
        throw new Error("The response ended without an answer.");
      }
      if (response.status === "failed") {
        throw new Error(response.error?.message ?? "The response failed.");
      }
      // The next step sends it all back: reasoning, text and calls.
      input.push(...(response.output as OpenAI.Responses.ResponseInputItem[]));
      const calls = response.output
        .filter((o): o is OpenAI.Responses.ResponseFunctionToolCall => o.type === "function_call")
        .map((c) => ({
          id: c.call_id,
          name: c.name,
          input: parseArgs(c.arguments),
        }));
      const u = response.usage;
      return {
        calls,
        stop: stopOf(response.incomplete_details?.reason, calls.length),
        usage: u
          ? `in ${u.input_tokens} (cached ${u.input_tokens_details?.cached_tokens ?? 0}) out ${u.output_tokens} (${response.status})`
          : `no usage (${response.status})`,
      };
    },
    answer(results) {
      for (const r of results) {
        input.push({
          type: "function_call_output",
          call_id: r.id,
          output: r.error ? `Error: ${r.content}` : r.content,
        });
      }
    },
  };
}

function chatCompletions(client: OpenAI, s: OpenAiSetup, start: ChatStart): GooseConversation {
  const tools: OpenAI.ChatCompletionTool[] = start.tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
  // Text alone goes as a string: not every compatible API takes a list of parts.
  const content: OpenAI.ChatCompletionUserMessageParam["content"] = start.user.every(
    (p) => p.type === "text",
  )
    ? start.user.map((p) => (p.type === "text" ? p.text : "")).join("\n\n")
    : start.user.map(
        (p): OpenAI.ChatCompletionContentPart =>
          p.type === "pdf"
            ? {
                type: "file",
                file: {
                  filename: p.title,
                  file_data: `data:application/pdf;base64,${p.data}`,
                },
              }
            : { type: "text", text: p.text },
      );
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: start.system },
    ...start.history.map(
      (m): OpenAI.ChatCompletionMessageParam => ({
        role: m.role,
        content: m.text,
      }),
    ),
    { role: "user", content },
  ];
  const effort = s.effort && s.reasoning ? { reasoning: { effort: s.effort } } : {};
  return {
    async step(onText) {
      const stream = await client.chat.completions.create(
        {
          model: s.model,
          messages,
          tools,
          stream: true,
          ...effort,
        } as OpenAI.ChatCompletionCreateParamsStreaming,
        { signal: start.signal },
      );
      let text = "";
      let finish: string | null = null;
      let usage = "";
      const calls: { id: string; name: string; args: string }[] = [];
      for await (const chunk of stream) {
        if (chunk.usage) {
          usage = `in ${chunk.usage.prompt_tokens} out ${chunk.usage.completion_tokens}`;
        }
        const choice = chunk.choices[0];
        if (!choice) {
          continue;
        }
        if (choice.delta?.content) {
          text += choice.delta.content;
          onText(choice.delta.content);
        }
        for (const d of choice.delta?.tool_calls ?? []) {
          // A call comes in pieces by its index; some servers send it whole, without one.
          const at = d.index ?? calls.length;
          const call = calls[at] ?? { id: "", name: "", args: "" };
          calls[at] = call;
          call.id ||= d.id ?? "";
          call.name ||= d.function?.name ?? "";
          call.args += d.function?.arguments ?? "";
        }
        finish = choice.finish_reason ?? finish;
      }
      const made = calls.filter(Boolean).map((c, i) => ({
        ...c,
        id: c.id || `call_${i}`,
        input: parseArgs(c.args),
      }));
      messages.push({
        role: "assistant",
        content: text || null,
        ...(made.length
          ? {
              tool_calls: made.map((c) => ({
                id: c.id,
                type: "function" as const,
                // Invalid JSON goes back as none: some APIs refuse the history otherwise.
                function: {
                  name: c.name,
                  arguments: c.input === undefined ? "{}" : c.args || "{}",
                },
              })),
            }
          : {}),
      });
      return {
        calls: made.map((c) => ({ id: c.id, name: c.name, input: c.input })),
        // Some servers end a turn with tool calls as "stop".
        stop: stopOf(finish, made.length),
        usage: `${usage || "no usage"} (${finish})`,
      };
    },
    answer(results) {
      for (const r of results) {
        messages.push({
          role: "tool",
          tool_call_id: r.id,
          content: r.error ? `Error: ${r.content}` : r.content,
        });
      }
    },
  };
}

/** A failed call, for the person. */
export function describeOpenAiError(err: unknown, doing: string, s: SdkSetup): string | null {
  const name = s.name ?? "the provider";
  if (err instanceof OpenAI.AuthenticationError) {
    return `Goose has no valid API key for ${name}${s.keyEnv ? ` (${s.keyEnv})` : ""}.`;
  }
  if (err instanceof OpenAI.RateLimitError) {
    return "Goose is busy; try again in a minute.";
  }
  if (err instanceof OpenAI.APIConnectionError) {
    return `Goose can't reach ${name}.`;
  }
  if (err instanceof OpenAI.APIError) {
    return `${doing}: ${err.message}`;
  }
  return null;
}

/** Goose on OpenAI's SDK: the Responses API or an OpenAI-compatible chat API. */
export function openaiChat(s: OpenAiSetup): GooseChat {
  const make = s.api === "responses" ? responses : chatCompletions;
  return {
    label: `${s.name ?? "openai"}/${s.model}`,
    start: (start) => make(clientOf(s), s, start),
    retryable: (err) => !(err instanceof OpenAI.APIError),
    describe: (err, doing) =>
      describeOpenAiError(err, doing, s) ?? `${doing}: ${(err as Error)?.message ?? err}`,
  };
}
