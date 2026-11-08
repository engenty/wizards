import { defineEmbedder, type SearchEmbedder } from "../embedder.js";
import { failure, passagePrompt, queryPrompt, toBase64, unit } from "./shared.js";

// Google's EmbeddingGemma 2 in Ollama: open weights, text and images in one
// 768-dim space, so a question finds screenshots and PDF pages by what they show.
export const OLLAMA_EMBEDDING_MODEL = "embeddinggemma-2:740m";

export interface OllamaEmbedderOptions {
  // Ollama's own address (not the `/v1` OpenAI-style one). Default http://localhost:11434.
  baseUrl?: string;
  dimensions?: number;
  // Whether the model reads images (Ollama reports a `vision` capability).
  images?: boolean;
  model?: string;
  // Only EmbeddingGemma and Gemini want prompts; other models take the text as is.
  prompts?: boolean;
  timeoutMs?: number;
}

// Ollama's own address from the one its OpenAI-style API has (…/v1).
export const ollamaRoot = (url: string): string =>
  url.trim().replace(/\/+$/, "").replace(/\/v1$/, "");

// EmbeddingGemma in Ollama, through its own /api/embed: the OpenAI-style one takes no images.
export function createOllamaEmbedder(options: OllamaEmbedderOptions = {}): SearchEmbedder {
  const model = options.model ?? OLLAMA_EMBEDDING_MODEL;
  const root = ollamaRoot(options.baseUrl ?? "http://localhost:11434");
  const prompts = options.prompts ?? /embeddinggemma/i.test(model);
  const call = async (input: unknown[]): Promise<number[][]> => {
    const res = await fetch(`${root}/api/embed`, {
      body: JSON.stringify({ input, model, truncate: true }),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
    });
    if (!res.ok) {
      throw await failure("Ollama", res);
    }
    const body = (await res.json()) as { embeddings?: number[][] };
    if (body.embeddings?.length !== input.length) {
      throw new Error("Ollama gave no vector for every input");
    }
    return body.embeddings.map(unit);
  };
  return defineEmbedder(
    (texts, opts) => call(prompts ? texts.map((t) => passagePrompt(t, opts?.title)) : texts),
    {
      dimensions: options.dimensions ?? 768,
      image: options.images
        ? async (image) => {
            const [vec] = await call([{ image: toBase64(image.data) }]);
            if (!vec) {
              throw new Error("Ollama gave no vector for the image");
            }
            return vec;
          }
        : undefined,
      modelId: `ollama:${model}`,
      query: prompts ? (texts) => call(texts.map(queryPrompt)) : undefined,
    },
  );
}
