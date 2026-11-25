import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { embedderOf, forgetOllamaModels } from "./ways.js";

let names: string[] = [];
const server = createServer((_req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ models: names.map((name) => ({ name })) }));
});
let ollamaUrl = "";
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  ollamaUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => server.close());
beforeEach(() => {
  names = [];
  forgetOllamaModels();
});

describe("the ways to an embedder", () => {
  it("takes a model on this computer that reads many languages, before any service", async () => {
    names = ["nomic-embed-text:latest", "bge-m3:latest", "embeddinggemma-2:740m"];
    const found = await embedderOf("auto", { ollamaUrl, gatewayKey: "k" });
    expect(found?.modelId).toBe("ollama:embeddinggemma-2:740m");
    expect(found?.dimensions).toBe(768);
  });

  it("leaves out one that reads English only", async () => {
    names = ["nomic-embed-text:latest"];
    expect(await embedderOf("auto", { ollamaUrl })).toBeNull();
    expect((await embedderOf("auto", { ollamaUrl, openaiKey: "k" }))?.modelId).toBe(
      "openai/text-embedding-3-small",
    );
  });

  it("is none where Ollama is not there, and where it is switched off", async () => {
    expect(await embedderOf("auto", { ollamaUrl: "http://127.0.0.1:9" })).toBeNull();
    expect(await embedderOf("off", { gatewayKey: "k", ollamaUrl: "" })).toBeNull();
  });

  it("takes the host's own way last, and the one a choice names", async () => {
    const own = await embedderOf("openai", { openaiKey: "k", ollamaUrl: "" });
    const extra = [{ way: "credits", open: () => Promise.resolve(own) }];
    expect(await embedderOf("auto", { ollamaUrl: "" }, extra)).toBe(own);
    expect(await embedderOf("gateway", { ollamaUrl: "" }, extra)).toBeNull();
    expect(await embedderOf("credits", { ollamaUrl: "" }, extra)).toBe(own);
  });
});
