// The ways to an embedder, as decision-model has them to a decision model: the first that is there.

import type { SearchEmbedder } from "../embedder.js";
import { createGeminiEmbedder } from "./gemini.js";
import { createOllamaEmbedder, ollamaRoot } from "./ollama.js";
import { createOpenAiCompatibleEmbedder } from "./openai.js";

export const EMBEDDER_WAYS = ["local", "gateway", "openai", "gemini"] as const;
export type EmbedderWayId = (typeof EMBEDDER_WAYS)[number];

export interface EmbedderEnv {
  // Vercel AI Gateway.
  gatewayKey?: string;
  openaiKey?: string;
  geminiKey?: string;
  // Ollama's address; default http://localhost:11434. Empty: this computer's is not asked.
  ollamaUrl?: string;
  // Ollama's model to use; else the first it holds that reads many languages.
  localModel?: string;
}

// A way a host adds to the built-in ones (wizards: its credits).
export interface EmbedderWay {
  way: string;
  open(env: EmbedderEnv): Promise<SearchEmbedder | null>;
}

const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1";
const OPENAI_MODEL = "text-embedding-3-small";
const OPENAI_DIMENSIONS = 1536;

// The models in Ollama that find an English text with a question in another language, best first,
// with their dimensions. One that reads English only finds less than the words do.
const MANY_LANGUAGES: [RegExp, number][] = [
  [/^embeddinggemma/i, 768],
  [/^qwen3-embedding(:8b|$)/i, 4096],
  [/^qwen3-embedding:4b/i, 2560],
  [/^qwen3-embedding:0\.6b/i, 1024],
  [/^bge-m3/i, 1024],
  [/^snowflake-arctic-embed2/i, 1024],
];

const ASK_MS = 1500;
const LOOK_MS = 60_000;
const looked = new Map<string, { at: number; names: string[] }>();

async function ollamaModels(root: string): Promise<string[]> {
  const known = looked.get(root);
  if (known && Date.now() - known.at < LOOK_MS) {
    return known.names;
  }
  const names = await fetch(`${root}/api/tags`, { signal: AbortSignal.timeout(ASK_MS) })
    .then(async (res) => {
      const body = res.ok ? ((await res.json()) as { models?: { name: string }[] }) : {};
      return (body.models ?? []).map((model) => model.name);
    })
    .catch(() => []);
  looked.set(root, { at: Date.now(), names });
  return names;
}

// For a host that just installed one, and for tests.
export function forgetOllamaModels(): void {
  looked.clear();
}

async function local(env: EmbedderEnv): Promise<SearchEmbedder | null> {
  if (env.ollamaUrl === "") {
    return null;
  }
  const root = ollamaRoot(env.ollamaUrl ?? "http://localhost:11434");
  const names = await ollamaModels(root);
  const held = (name: string) => names.find((n) => n === name || n === `${name}:latest`);
  for (const [pattern, dimensions] of MANY_LANGUAGES) {
    const model = env.localModel
      ? pattern.test(env.localModel)
        ? held(env.localModel)
        : undefined
      : names.find((name) => pattern.test(name.replace(/:latest$/, "")));
    if (model) {
      return createOllamaEmbedder({ baseUrl: root, dimensions, model });
    }
  }
  return null;
}

const keyed = (
  key: string | undefined,
  make: (apiKey: string) => SearchEmbedder,
): Promise<SearchEmbedder | null> => Promise.resolve(key?.trim() ? make(key.trim()) : null);

const openAi = (baseUrl: string | undefined, model: string) => (apiKey: string) =>
  createOpenAiCompatibleEmbedder({
    apiKey,
    dimensions: OPENAI_DIMENSIONS,
    model,
    modelId: `openai/${OPENAI_MODEL}`,
    ...(baseUrl ? { baseUrl } : {}),
  });

const BUILT_IN: Record<EmbedderWayId, EmbedderWay["open"]> = {
  local,
  gateway: (env) => keyed(env.gatewayKey, openAi(GATEWAY_URL, `openai/${OPENAI_MODEL}`)),
  openai: (env) => keyed(env.openaiKey, openAi(undefined, OPENAI_MODEL)),
  gemini: (env) => keyed(env.geminiKey, (apiKey) => createGeminiEmbedder({ apiKey })),
};

// The embedder a choice names: `auto` is the first way that opens, this computer's first, then
// the host's `extra`; `off` and a way that has none are null.
export async function embedderOf(
  choice: string,
  env: EmbedderEnv,
  extra: EmbedderWay[] = [],
): Promise<SearchEmbedder | null> {
  if (choice === "off") {
    return null;
  }
  const ways: EmbedderWay[] = [
    ...EMBEDDER_WAYS.map((way) => ({ way, open: BUILT_IN[way] })),
    ...extra,
  ];
  for (const way of choice === "auto" ? ways : ways.filter((w) => w.way === choice)) {
    const found = await way.open(env);
    if (found) {
      return found;
    }
  }
  return null;
}
