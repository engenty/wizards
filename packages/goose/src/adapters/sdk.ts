import type { GooseChat } from "../chat.js";
import { type AnthropicSetup, anthropicChat } from "./anthropic.js";
import { type OpenAiSetup, openaiChat } from "./openai.js";

// Goose on the providers' own SDKs: Anthropic's, and OpenAI's for OpenAI itself and for every
// provider with an OpenAI-compatible API. A host that uses one of them imports
// `@engenty/goose/anthropic` or `@engenty/goose/openai` and needs only that SDK.

export type ChatSetup =
  | ({ provider: "anthropic" } & AnthropicSetup)
  | ({ provider: "openai" } & Omit<OpenAiSetup, "api">)
  | ({ provider: "compatible" } & Omit<OpenAiSetup, "api">);

/** Goose's model from a setup: Anthropic, OpenAI (Responses API) or OpenAI-compatible. */
export function chatOf(setup: ChatSetup): GooseChat {
  if (setup.provider === "anthropic") {
    return anthropicChat(setup);
  }
  return openaiChat({
    ...setup,
    api: setup.provider === "openai" ? "responses" : "chat",
  });
}

export type { AnthropicSetup } from "./anthropic.js";
export { anthropicChat } from "./anthropic.js";
export type { OpenAiSetup } from "./openai.js";
export { openaiChat } from "./openai.js";
export { EFFORTS, type Effort, type SdkSetup } from "./shared.js";
