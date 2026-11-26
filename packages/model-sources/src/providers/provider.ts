/**
 * The providers a person brings a key for: a company's own API (OpenAI, Anthropic, Google, fal.ai,
 * ElevenLabs, Replicate) or a gateway to many companies' models (OpenRouter, the Vercel AI
 * Gateway). What is here is the same for every host: who a provider is, where a key is made and
 * what it looks like. Which of its models a host offers, and where the host keeps the key, is
 * the host's.
 */
export const PROVIDER_IDS = [
  "openai",
  "anthropic",
  "google",
  "openrouter",
  "gateway",
  "fal",
  "elevenlabs",
  "replicate",
] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface Provider {
  id: ProviderId;
  /** The product name, as the person knows it. */
  name: string;
  /** Where a person makes a key. */
  keyUrl: string;
  /** How a key looks, for an input's placeholder. */
  keyPlaceholder: string;
  /** The environment variable a host may read the key from. This package reads none. */
  env: string;
  /**
   * The model of its that writes text and that is asked when nothing names another, by the
   * provider's own name for it. Absent: the provider has no models that write text.
   */
  model?: string;
}

export const PROVIDERS: Record<ProviderId, Provider> = {
  openai: {
    id: "openai",
    name: "OpenAI",
    keyUrl: "https://platform.openai.com/api-keys",
    keyPlaceholder: "sk-…",
    env: "OPENAI_API_KEY",
    model: "gpt-5.5",
  },
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyPlaceholder: "sk-ant-…",
    env: "ANTHROPIC_API_KEY",
    model: "claude-sonnet-5-5",
  },
  google: {
    id: "google",
    name: "Google Gemini",
    keyUrl: "https://aistudio.google.com/apikey",
    keyPlaceholder: "AIza…",
    env: "GOOGLE_GENERATIVE_AI_API_KEY",
    model: "gemini-pro-latest",
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    keyUrl: "https://openrouter.ai/settings/keys",
    keyPlaceholder: "sk-or-v1-…",
    env: "OPENROUTER_API_KEY",
    model: "openrouter/auto",
  },
  gateway: {
    id: "gateway",
    name: "Vercel AI Gateway",
    keyUrl: "https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai-gateway%2Fapi-keys",
    keyPlaceholder: "vck_…",
    env: "AI_GATEWAY_API_KEY",
    model: "deepseek/deepseek-v4.1-flash",
  },
  fal: {
    id: "fal",
    name: "fal.ai",
    keyUrl: "https://fal.ai/dashboard/keys",
    keyPlaceholder: "xxxxxxxx-…:…",
    env: "FAL_KEY",
  },
  elevenlabs: {
    id: "elevenlabs",
    name: "ElevenLabs",
    keyUrl: "https://elevenlabs.io/app/settings/api-keys",
    keyPlaceholder: "sk_…",
    env: "ELEVENLABS_API_KEY",
  },
  replicate: {
    id: "replicate",
    name: "Replicate",
    keyUrl: "https://replicate.com/account/api-tokens",
    keyPlaceholder: "r8_…",
    env: "REPLICATE_API_TOKEN",
  },
};

/** Whether a word is a provider's id. */
export function isProvider(id: string): id is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(id);
}

/** The providers that have models which write text, in the list's order. */
export const TEXT_PROVIDERS: readonly ProviderId[] = PROVIDER_IDS.filter(
  (id) => PROVIDERS[id].model !== undefined,
);
