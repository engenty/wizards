import { defineEmbedder, type SearchEmbedder } from "../embedder.js";
import { failure, unit } from "./shared.js";

export interface OpenAiCompatibleEmbedderOptions {
  apiKey: string;
  // OpenAI by default; the Vercel AI Gateway is https://ai-gateway.vercel.sh/v1.
  baseUrl?: string;
  // Sent as `dimensions` where the model can shorten its vectors (text-embedding-3).
  dimensions: number;
  // The model's name at that endpoint.
  model: string;
  // How the index records the model. Default: `model`. Give the gateway's name
  // when the same model is also reached directly, so switching keeps the vectors.
  modelId?: string;
  sendDimensions?: boolean;
  timeoutMs?: number;
}

// Text embeddings from any OpenAI-style /embeddings endpoint: OpenAI, the AI
// Gateway. Questions and passages are embedded alike.
export function createOpenAiCompatibleEmbedder(
  options: OpenAiCompatibleEmbedderOptions,
): SearchEmbedder {
  const base = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  return defineEmbedder(
    async (texts) => {
      const res = await fetch(`${base}/embeddings`, {
        body: JSON.stringify({
          input: texts,
          model: options.model,
          ...(options.sendDimensions ? { dimensions: options.dimensions } : {}),
        }),
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
        },
        method: "POST",
        signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
      });
      if (!res.ok) {
        throw await failure(options.modelId ?? options.model, res);
      }
      const body = (await res.json()) as {
        data?: { embedding: number[]; index: number }[];
      };
      const data = body.data ?? [];
      if (data.length !== texts.length) {
        throw new Error("Embeddings endpoint gave no vector for every input");
      }
      return data.toSorted((a, b) => a.index - b.index).map((d) => unit(d.embedding));
    },
    {
      batch: true,
      dimensions: options.dimensions,
      maxBatchSize: 256,
      modelId: options.modelId ?? options.model,
    },
  );
}
