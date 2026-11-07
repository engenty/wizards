// Stable embedder protocol shared across providers.
//
// An `SearchEmbedder` is just a function with metadata properties — modeled
// after Mastra's `Object.assign(fn, { batch: true, maxBatchSize })`. The host
// uses `embedTexts` to dispatch a single call vs. parallel batched calls
// based on the embedder's declared `maxBatchSize`. `dimensions` and
// `modelId` move dimension assertions and telemetry into the package so the
// per-module `embed*ForX` helpers can collapse.
//
// The call embeds *passages* (what the index holds). Models that tell a
// question from a passage also set `embedQuery`; models that read pictures set
// `embedImage`. Vectors of two models never mix: `modelId` (with the
// dimensions) names the vector space, and an index re-embeds when it changes.

export interface EmbedPassageOptions {
  // The document's title; models with a passage prompt use it as context.
  title?: string;
}

export interface SearchImage {
  data: Uint8Array;
  // e.g. `image/jpeg`, `image/png`.
  mimeType: string;
}

export interface SearchEmbedder {
  // Marks the function as a true batched embedder; defaults are sequential.
  batch?: true;
  // Required: vector dimension produced by `modelId`.
  dimensions: number;
  // Embeds a picture into the same space as the texts. Set only with `images`.
  embedImage?(image: SearchImage): Promise<number[]>;
  // Embeds questions. Unset: questions are embedded like passages.
  embedQuery?(texts: string[]): Promise<number[][]>;
  // True where `embedImage` is set: the model reads images (and PDF pages).
  images?: true;
  // Provider's max batch size. When unset, all texts are sent in one call.
  maxBatchSize?: number;
  // Stable model identifier (e.g. `"openai/text-embedding-3-small"`).
  modelId: string;
  (texts: string[], options?: EmbedPassageOptions): Promise<number[][]>;
}

export interface DefineEmbedderOptions {
  batch?: boolean;
  dimensions: number;
  image?: (image: SearchImage) => Promise<number[]>;
  maxBatchSize?: number;
  modelId: string;
  query?: (texts: string[]) => Promise<number[][]>;
}

export function defineEmbedder(
  fn: (texts: string[], options?: EmbedPassageOptions) => Promise<number[][]>,
  options: DefineEmbedderOptions,
): SearchEmbedder {
  if (!Number.isInteger(options.dimensions) || options.dimensions <= 0) {
    throw new Error("SearchEmbedder dimensions must be a positive integer");
  }
  if (!options.modelId.trim()) {
    throw new Error("SearchEmbedder modelId is required");
  }
  if (
    options.maxBatchSize !== undefined &&
    (!Number.isInteger(options.maxBatchSize) || options.maxBatchSize <= 0)
  ) {
    throw new Error("SearchEmbedder maxBatchSize must be a positive integer");
  }
  const embedder = fn as SearchEmbedder;
  embedder.dimensions = options.dimensions;
  embedder.modelId = options.modelId;
  if (options.batch === true) {
    embedder.batch = true;
  }
  if (options.maxBatchSize !== undefined) {
    embedder.maxBatchSize = options.maxBatchSize;
  }
  if (options.query) {
    embedder.embedQuery = options.query;
  }
  if (options.image) {
    embedder.embedImage = options.image;
    embedder.images = true;
  }
  return embedder;
}

async function inBatches(
  embedder: SearchEmbedder,
  texts: string[],
  run: (batch: string[]) => Promise<number[][]>,
): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }
  const max = embedder.maxBatchSize;
  if (!max || texts.length <= max) {
    return run(texts);
  }
  const batches: string[][] = [];
  for (let i = 0; i < texts.length; i += max) {
    batches.push(texts.slice(i, i + max));
  }
  const results = await Promise.all(batches.map(run));
  return results.flat();
}

// Passages: what the index holds.
export function embedTexts(
  embedder: SearchEmbedder,
  texts: string[],
  options?: EmbedPassageOptions,
): Promise<number[][]> {
  return inBatches(embedder, texts, (batch) => embedder(batch, options));
}

// Questions: through `embedQuery` where the model has one.
export function embedQueries(embedder: SearchEmbedder, texts: string[]): Promise<number[][]> {
  const query = embedder.embedQuery;
  return inBatches(embedder, texts, (batch) =>
    query ? query.call(embedder, batch) : embedder(batch),
  );
}

export function embedImage(embedder: SearchEmbedder, image: SearchImage): Promise<number[]> {
  if (!embedder.embedImage) {
    return Promise.reject(new Error(`${embedder.modelId} embeds text only (no embedImage)`));
  }
  return embedder.embedImage(image);
}

export function assertEmbeddingDimensions(embedder: SearchEmbedder, vec: readonly number[]): void {
  if (vec.length !== embedder.dimensions) {
    throw new Error(
      `Embedding dimension mismatch: ${embedder.modelId} expects ${embedder.dimensions}, got ${vec.length}`,
    );
  }
}

// Vectors of two models never mix: an index embedded by one must be re-embedded
// when this is false for the model now configured.
export function sameVectorSpace(
  a: Pick<SearchEmbedder, "dimensions" | "modelId">,
  b: Pick<SearchEmbedder, "dimensions" | "modelId">,
): boolean {
  return a.modelId === b.modelId && a.dimensions === b.dimensions;
}
