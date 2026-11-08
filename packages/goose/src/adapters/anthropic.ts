import Anthropic from "@anthropic-ai/sdk";
import type { ChatStart, GooseChat, GooseConversation } from "../chat.js";
import { clientCache, type SdkSetup } from "./shared.js";

// Goose on Anthropic's own SDK, with what it has there: adaptive thinking, effort, server-side
// refusal fallbacks, PDFs read as documents, prompt caching and tool inputs streamed as written.

export interface AnthropicSetup extends SdkSetup {
  /** A client of the host's; otherwise one is made (and kept) for the key and URL. */
  client?: Anthropic;
  /** Server-side fallbacks when a model refuses (on). */
  fallbacks?: boolean;
}

const clients = clientCache<Anthropic>();

const clientOf = (s: AnthropicSetup) =>
  s.client ??
  clients(
    "anthropic",
    s,
    () =>
      new Anthropic({
        ...(s.apiKey ? { apiKey: s.apiKey } : {}),
        ...(s.baseUrl ? { baseURL: s.baseUrl } : {}),
      }),
  );

function conversation(client: Anthropic, s: AnthropicSetup, start: ChatStart): GooseConversation {
  const tools: Anthropic.Beta.BetaTool[] = start.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
    ...(t.eager ? { eager_input_streaming: true } : {}),
  }));
  const content = start.user.map(
    (p): Anthropic.Beta.BetaContentBlockParam =>
      p.type === "pdf"
        ? {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: p.data,
            },
            title: p.title,
            // Each step sends the document again: from the cache.
            cache_control: { type: "ephemeral" },
          }
        : {
            type: "text",
            text: p.text,
            ...(p.cache ? { cache_control: { type: "ephemeral" } } : {}),
          },
  );
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...start.history.map((m) => ({ role: m.role, content: m.text })),
    { role: "user", content },
  ];
  const fallbacks = s.fallbacks !== false;
  return {
    async step(onText) {
      const stream = client.beta.messages.stream(
        {
          model: s.model,
          max_tokens: s.maxTokens ?? 64_000,
          ...(fallbacks
            ? {
                betas: ["server-side-fallback-2026-07-01"],
                fallbacks: "default" as const,
              }
            : {}),
          thinking: { type: "adaptive" },
          output_config: { effort: s.effort ?? "medium" },
          system: start.system,
          tools,
          messages,
        },
        { signal: start.signal },
      );
      stream.on("text", onText);
      const message = await stream.finalMessage();
      const calls = message.content
        .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use")
        .map((b) => ({ id: b.id, name: b.name, input: b.input }));
      messages.push({ role: "assistant", content: message.content });
      let stop: "refusal" | "max_tokens" | "tools" | "end" = "end";
      if (message.stop_reason === "refusal") {
        stop = "refusal";
      } else if (message.stop_reason === "max_tokens") {
        stop = "max_tokens";
      } else if (calls.length) {
        stop = "tools";
      }
      return {
        calls,
        stop,
        usage: `in ${message.usage.input_tokens} (cached ${message.usage.cache_read_input_tokens ?? 0}) out ${message.usage.output_tokens} (${message.stop_reason})`,
      };
    },
    answer(results) {
      messages.push({
        role: "user",
        content: results.map((r) => ({
          type: "tool_result",
          tool_use_id: r.id,
          content: r.content,
          ...(r.error ? { is_error: true } : {}),
        })),
      });
    },
  };
}

/** A failed call, for the person. */
export function describeAnthropicError(err: unknown, doing: string, s: SdkSetup): string | null {
  const name = s.name ?? "Anthropic";
  if (err instanceof Anthropic.AuthenticationError) {
    return `Goose has no valid API key for ${name}${s.keyEnv ? ` (${s.keyEnv})` : ""}.`;
  }
  if (err instanceof Anthropic.RateLimitError) {
    return "Goose is busy; try again in a minute.";
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return `Goose can't reach ${name}.`;
  }
  if (err instanceof Anthropic.APIError) {
    const message = (err.error as { error?: { message?: string } } | undefined)?.error?.message;
    return `${doing}: ${message ?? err.status}`;
  }
  return null;
}

/** Goose on Anthropic's SDK. */
export function anthropicChat(s: AnthropicSetup): GooseChat {
  return {
    label: `${s.name ?? "anthropic"}/${s.model}`,
    start: (start) => conversation(clientOf(s), s, start),
    // A tool input cut off mid-JSON ends the stream with a parse error; API errors are final.
    retryable: (err) => !(err instanceof Anthropic.APIError),
    describe: (err, doing) =>
      describeAnthropicError(err, doing, s) ?? `${doing}: ${(err as Error)?.message ?? err}`,
  };
}
