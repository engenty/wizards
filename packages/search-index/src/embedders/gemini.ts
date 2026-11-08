import { defineEmbedder, type SearchEmbedder } from "../embedder.js";
import { failure, passagePrompt, queryPrompt, toBase64, unit } from "./shared.js";

// Gemini's multimodal embedding model: text, images and PDF pages in one space.
// It takes no task type; the query and passage prompts go in the text.
export const GEMINI_EMBEDDING_MODEL = "gemini-embedding-2";
// 128–3072 are allowed. 768 is EmbeddingGemma's size, but the vectors differ.
export const GEMINI_EMBEDDING_DIMENSIONS = 768;

export interface GeminiEmbedderOptions {
  apiKey: string;
  baseUrl?: string;
  dimensions?: number;
  model?: string;
  timeoutMs?: number;
}

interface EmbedContentResponse {
  embedding?: { values?: number[] };
}

// The Gemini API called directly (`GEMINI_API_KEY`): the only way that reaches images.
export function createGeminiEmbedder(options: GeminiEmbedderOptions): SearchEmbedder {
  const model = options.model ?? GEMINI_EMBEDDING_MODEL;
  const dimensions = options.dimensions ?? GEMINI_EMBEDDING_DIMENSIONS;
  const base = (options.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta").replace(
    /\/+$/,
    "",
  );
  // One request, one embedding: parts of a single content are aggregated, so
  // each text goes in its own request.
  const embedParts = async (parts: Record<string, unknown>[]): Promise<number[]> => {
    const res = await fetch(`${base}/models/${model}:embedContent`, {
      body: JSON.stringify({
        content: { parts },
        model: `models/${model}`,
        outputDimensionality: dimensions,
      }),
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": options.apiKey,
      },
      method: "POST",
      signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
    });
    if (!res.ok) {
      throw await failure("Gemini", res);
    }
    const values = ((await res.json()) as EmbedContentResponse).embedding?.values;
    if (!values?.length) {
      throw new Error("Gemini gave no vector");
    }
    return unit(values);
  };
  const texts = (prompts: string[]) => Promise.all(prompts.map((text) => embedParts([{ text }])));
  return defineEmbedder((list, opts) => texts(list.map((t) => passagePrompt(t, opts?.title))), {
    batch: true,
    dimensions,
    image: (image) =>
      embedParts([
        {
          inline_data: {
            data: toBase64(image.data),
            mime_type: image.mimeType,
          },
        },
      ]),
    maxBatchSize: 8,
    modelId: `gemini:${model}@${dimensions}`,
    query: (list) => texts(list.map(queryPrompt)),
  });
}
