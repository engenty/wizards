import { createAnthropic } from "@ai-sdk/anthropic";
import { createGateway } from "@ai-sdk/gateway";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { PROVIDERS, type ProviderId } from "./provider.js";

export interface ModelOptions {
  /** Another fetch, such as a test's, or one that counts what a call cost. */
  fetch?: typeof fetch;
}

/** Where OpenRouter answers as OpenAI's API does. */
const OPENROUTER_URL = "https://openrouter.ai/api/v1";

/**
 * A model that writes text, on a key the person brought. A provider with an AI SDK package of
 * its own is asked through it, so what only its API has (thinking, caching, its own tools)
 * reaches the model; OpenRouter is asked as OpenAI's API is. `model` is the provider's own name
 * for the model. Throws for a provider that has no models which write text.
 */
export function providerModel(
  provider: ProviderId,
  key: string,
  model: string,
  options: ModelOptions = {},
): LanguageModel {
  const extra = options.fetch ? { fetch: options.fetch } : {};
  switch (provider) {
    case "openai":
      return createOpenAI({ apiKey: key, ...extra })(model);
    case "anthropic":
      return createAnthropic({ apiKey: key, ...extra })(model);
    case "google":
      return createGoogle({ apiKey: key, ...extra })(model);
    case "gateway":
      return createGateway({ apiKey: key, ...extra })(model);
    case "openrouter":
      return compatibleModel({ name: provider, baseUrl: OPENROUTER_URL, key, model, ...extra });
    default:
      throw new Error(`${PROVIDERS[provider].name} has no models that write text.`);
  }
}

/** A model at an address that answers as OpenAI's API does: a gateway of the person's own choice. */
export function compatibleModel(source: {
  /** What the AI SDK calls the provider in its errors and its metadata. */
  name: string;
  /** The address, ending in `/v1` where the API has that. */
  baseUrl: string;
  key?: string;
  model: string;
  fetch?: typeof fetch;
}): LanguageModel {
  return createOpenAICompatible({
    name: source.name,
    baseURL: source.baseUrl,
    ...(source.key ? { apiKey: source.key } : {}),
    ...(source.fetch ? { fetch: source.fetch } : {}),
  })(source.model);
}
