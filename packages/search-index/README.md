# @engenty/search-index

MIT. The contracts every engenty search backend meets, plus the pieces that need no database.

- **Contracts:** `SearchIndexProvider`, `SearchDocument`, `SearchChunk`, strategies (`hybrid`, `lexical`, `semantic`), `ReRanker`, `Verifier`.
- **Chunks, scoring, catalog ranking:** `createSearchChunks`, `createWeightedScoreReranker`, `createMinimumSignalVerifier`, `rankRecordsLexically`, `blendCatalogScores`.
- **Embedders:** `SearchEmbedder` and `defineEmbedder`; ready-made ones under `@engenty/search-index/embedders`.

## Embedders

`SearchEmbedder` is a function `(texts, { title }?) => number[][]` that embeds passages (what the index holds). Models that tell a question from a passage also set `embedQuery`; models that read pictures set `embedImage` and `images: true`.

| Embedder | Model | Reads images |
|---|---|---|
| `createOllamaEmbedder` | EmbeddingGemma 2 in Ollama (`/api/embed`) | with a vision model |
| `createGeminiEmbedder` | `gemini-embedding-2`, Gemini API with `GEMINI_API_KEY`, 768 dims by default | yes (PNG, JPEG) |
| `createOpenAiCompatibleEmbedder` | any OpenAI-style `/embeddings` (OpenAI, the Vercel AI Gateway) | no |

```ts
import { embedQueries, embedTexts } from "@engenty/search-index";
import { createGeminiEmbedder } from "@engenty/search-index/embedders";

const embedder = createGeminiEmbedder({ apiKey: process.env.GEMINI_API_KEY! });
const passages = await embedTexts(embedder, ["text of a page"], { title: "Guide" });
const [question] = await embedQueries(embedder, ["how do I start?"]);
```

**Vectors of two models never mix.** `modelId` (with `dimensions`) names the vector space. Record it with the index and re-embed when `sameVectorSpace(recorded, embedder)` is false.
