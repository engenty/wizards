import { afterEach, describe, expect, it, vi } from "vitest";
import { embedImage, embedQueries, embedTexts, sameVectorSpace } from "../embedder.js";
import { createGeminiEmbedder } from "./gemini.js";
import { createOllamaEmbedder } from "./ollama.js";
import { createOpenAiCompatibleEmbedder } from "./openai.js";

afterEach(() => vi.unstubAllGlobals());

interface Call {
  body: any;
  headers: Record<string, string>;
  url: string;
}

function stubFetch(answer: (body: Call["body"]) => unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      calls.push({
        body,
        headers: init.headers as Record<string, string>,
        url,
      });
      return Promise.resolve(new Response(JSON.stringify(answer(body)), { status: 200 }));
    }),
  );
  return calls;
}

describe("gemini embedder", () => {
  const make = () => createGeminiEmbedder({ apiKey: "k", dimensions: 4 });

  it("prompts questions and passages differently, one request each", async () => {
    const calls = stubFetch(() => ({ embedding: { values: [3, 4, 0, 0] } }));
    const e = make();
    const [q] = await embedQueries(e, ["why"]);
    const [p] = await embedTexts(e, ["because"], { title: "Doc" });
    expect(calls.map((c) => c.body.content.parts[0].text)).toEqual([
      "task: search result | query: why",
      "title: Doc | text: because",
    ]);
    expect(q).toEqual([0.6, 0.8, 0, 0]);
    expect(p).toEqual(q);
    expect(calls[0]?.headers["x-goog-api-key"]).toBe("k");
    expect(calls[0]?.url).toContain("gemini-embedding-2:embedContent");
    expect(calls[0]?.body.outputDimensionality).toBe(4);
  });

  it("sends an image inline and names the vector space by model and size", async () => {
    const calls = stubFetch(() => ({ embedding: { values: [1, 0, 0, 0] } }));
    const e = make();
    expect(e.images).toBe(true);
    await embedImage(e, {
      data: new Uint8Array([1, 2, 3]),
      mimeType: "image/png",
    });
    expect(calls[0]?.body.content.parts[0].inline_data).toEqual({
      data: "AQID",
      mime_type: "image/png",
    });
    expect(e.modelId).toBe("gemini:gemini-embedding-2@4");
  });

  it("reports an API error with its status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("bad key", { status: 403 }))),
    );
    await expect(embedTexts(make(), ["x"])).rejects.toThrow("Gemini answered 403");
  });
});

describe("ollama embedder", () => {
  it("uses the EmbeddingGemma prompts and reads images only where the model can", async () => {
    const calls = stubFetch((body) => ({
      embeddings: body.input.map(() => [0, 2]),
    }));
    const e = createOllamaEmbedder({ dimensions: 2, images: true });
    await embedQueries(e, ["q"]);
    await embedTexts(e, ["p"]);
    await embedImage(e, { data: new Uint8Array([1]), mimeType: "image/jpeg" });
    expect(calls.map((c) => c.body.input[0])).toEqual([
      "task: search result | query: q",
      "title: none | text: p",
      { image: "AQ==" },
    ]);
    expect(calls[0]?.url).toBe("http://localhost:11434/api/embed");
    const textOnly = createOllamaEmbedder({ dimensions: 2 });
    await expect(
      embedImage(textOnly, { data: new Uint8Array(), mimeType: "image/png" }),
    ).rejects.toThrow("text only");
  });
});

describe("openai-compatible embedder", () => {
  it("returns vectors in input order and sends dimensions only when asked", async () => {
    const calls = stubFetch(() => ({
      data: [
        { embedding: [0, 3], index: 1 },
        { embedding: [3, 0], index: 0 },
      ],
    }));
    const e = createOpenAiCompatibleEmbedder({
      apiKey: "k",
      dimensions: 2,
      model: "text-embedding-3-small",
      modelId: "openai/text-embedding-3-small",
    });
    expect(await embedTexts(e, ["a", "b"])).toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(calls[0]?.body.dimensions).toBeUndefined();
    expect(e.modelId).toBe("openai/text-embedding-3-small");
  });
});

describe("sameVectorSpace", () => {
  it("is false when the model or the size differs", () => {
    const a = { dimensions: 768, modelId: "gemini:gemini-embedding-2@768" };
    expect(sameVectorSpace(a, { ...a })).toBe(true);
    expect(sameVectorSpace(a, { ...a, dimensions: 1536 })).toBe(false);
    expect(sameVectorSpace(a, { ...a, modelId: "ollama:embeddinggemma-2:740m" })).toBe(false);
  });
});
