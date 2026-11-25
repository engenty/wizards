import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { fits } from "../servers/index.js";
import {
  installedModels,
  ollamaAddress,
  ollamaMessages,
  ollamaModel,
  ollamaRoot,
  ollamaState,
  pullModel,
} from "./index.js";

const held = [
  { name: "embeddinggemma-2:740m", size: 1_280_000_000, digest: "a" },
  { name: "qwen3.8:27b-mlx", size: 18_170_000_000, digest: "b" },
];
const shows: Record<string, unknown> = {
  "embeddinggemma-2:740m": {
    capabilities: ["embedding"],
    details: { runner: "mlx", quantization_level: "nvfp4" },
  },
  "qwen3.8:27b-mlx": { capabilities: ["completion", "vision", "tools", "thinking"], details: {} },
};
let showsAsked = 0;

const server: Server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
  }
  const json = (value: unknown, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };
  switch (req.url) {
    case "/api/version":
      return json({ version: "0.40.12" });
    case "/api/tags":
      return json({ models: held });
    case "/api/ps":
      return json({ models: [{ name: "qwen3.8:27b-mlx" }] });
    case "/api/show":
      showsAsked++;
      return json(shows[(JSON.parse(body) as { model: string }).model] ?? {});
    case "/api/pull": {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      // Two parts of the model, each reporting on its own.
      for (const line of [
        { status: "pulling manifest" },
        { status: "pulling a", digest: "a", total: 100, completed: 50 },
        { status: "pulling b", digest: "b", total: 300, completed: 100 },
        { status: "pulling a", digest: "a", total: 100, completed: 100 },
        { status: "success" },
      ]) {
        res.write(`${JSON.stringify(line)}\n`);
      }
      return res.end();
    }
    default:
      return json({ error: "not found" }, 404);
  }
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

afterAll(() => {
  server.close();
});

describe("Ollama's address", () => {
  it("takes a root as OLLAMA_HOST names it and the /v1 address as OLLAMA_URL names it", () => {
    expect(ollamaRoot("http://127.0.0.1:11434")).toBe("http://127.0.0.1:11434");
    expect(ollamaRoot("http://127.0.0.1:11434/v1")).toBe("http://127.0.0.1:11434");
    expect(ollamaRoot(" http://gpu.local:11434/v1/ ")).toBe("http://gpu.local:11434");
    expect(ollamaRoot("https://ollama.example.com")).toBe("https://ollama.example.com");
    // OLLAMA_HOST without a scheme, with or without its port.
    expect(ollamaRoot("127.0.0.1:11434")).toBe("http://127.0.0.1:11434");
    expect(ollamaRoot("localhost")).toBe("http://localhost:11434");
    expect(ollamaRoot("gpu.local:8080")).toBe("http://gpu.local:8080");
    expect(ollamaRoot("")).toBe("");
  });

  it("is OLLAMA_URL, else Ollama's default", () => {
    expect(ollamaAddress({})).toBe("http://127.0.0.1:11434");
    expect(ollamaAddress({ OLLAMA_URL: "http://127.0.0.1:9/v1" })).toBe("http://127.0.0.1:9");
  });
});

describe("Ollama's models", () => {
  it("says whether Ollama answers and what it holds", async () => {
    expect(await ollamaState(`${origin}/v1`)).toEqual({
      version: "0.40.12",
      models: ["embeddinggemma-2:740m", "qwen3.8:27b-mlx"],
    });
    expect(await ollamaState("http://127.0.0.1:9")).toEqual({ version: null, models: [] });
  });

  it("lists each model with what it can do and whether it runs, asking once per digest", async () => {
    const models = await installedModels(origin);
    expect(models).toEqual([
      {
        name: "embeddinggemma-2:740m",
        size: 1_280_000_000,
        digest: "a",
        capabilities: ["embedding"],
        completion: false,
        tools: false,
        vision: false,
        thinking: false,
        runner: "mlx",
        quantization: "nvfp4",
        running: false,
      },
      {
        name: "qwen3.8:27b-mlx",
        size: 18_170_000_000,
        digest: "b",
        capabilities: ["completion", "vision", "tools", "thinking"],
        completion: true,
        tools: true,
        vision: true,
        thinking: true,
        runner: null,
        quantization: null,
        running: true,
      },
    ]);
    const asked = showsAsked;
    await installedModels(origin);
    expect(showsAsked).toBe(asked);
    expect(await installedModels("http://127.0.0.1:9")).toEqual([]);
  });

  it("fits a model into a share of the memory the caller names", () => {
    const memory = 32e9;
    expect(fits(18e9, memory, 0.7)).toBe(true);
    expect(fits({ size: 18e9 }, memory, 0.55)).toBe(false);
    expect(fits({ size: 17.6e9 }, memory, 0.55)).toBe(true);
    // Any unit, as long as both are in it.
    expect(fits(20, 32, 0.7)).toBe(true);
  });

  it("pulls a model and reports the bytes summed over its parts", async () => {
    const seen: [number, number][] = [];
    await pullModel(`${origin}/v1`, "qwen3.8", (done, total) => seen.push([done, total]));
    expect(seen).toEqual([
      [50, 100],
      [150, 400],
      [200, 400],
    ]);
  });
});

describe("a model of Ollama on its own chat API", () => {
  const stream = (lines: unknown[]) =>
    new Response(lines.map((l) => `${JSON.stringify(l)}\n`).join(""), { status: 200 });

  it("sets the context length and streams text, tool calls and the usage", async () => {
    let sent: Record<string, unknown> = {};
    const model = ollamaModel({
      url: "http://ollama.test:11434/v1",
      model: "qwen3:8b",
      context: 32_768,
      thinking: false,
      fetch: async (url, init) => {
        expect(String(url)).toBe("http://ollama.test:11434/api/chat");
        sent = JSON.parse(String(init?.body));
        return stream([
          { message: { content: "Hel" } },
          { message: { content: "lo" } },
          { message: { tool_calls: [{ function: { name: "add", arguments: { a: 1 } } }] } },
          { done: true, done_reason: "stop", prompt_eval_count: 12, eval_count: 3 },
        ]);
      },
    });
    const result = await model.doGenerate({
      prompt: [
        { role: "system", content: "Be brief." },
        { role: "user", content: [{ type: "text", text: "Hi" }] },
      ],
      tools: [{ type: "function", name: "add", inputSchema: { type: "object" } }],
    });
    expect(sent).toMatchObject({
      model: "qwen3:8b",
      stream: true,
      think: false,
      options: { num_ctx: 32_768 },
      tools: [{ type: "function", function: { name: "add", parameters: { type: "object" } } }],
    });
    expect(result.content[0]).toEqual({ type: "text", text: "Hello" });
    expect(result.content[1]).toMatchObject({
      type: "tool-call",
      toolName: "add",
      input: '{"a":1}',
    });
    expect(result.finishReason.unified).toBe("tool-calls");
    expect(result.usage.inputTokens.total).toBe(12);
    expect(result.usage.outputTokens.total).toBe(3);
  });

  it("sends pictures with the newest message only, and names older ones", () => {
    const picture = { type: "file" as const, mediaType: "image/png", data: "AAAA" };
    const messages = ollamaMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "Look" },
          { ...picture, filename: "a.png" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "A cat." }] },
      { role: "user", content: [{ type: "text", text: "And this?" }, picture] },
    ]);
    expect(messages[0]).toEqual({ role: "user", content: "Look\n[picture: a.png]" });
    expect(messages[2]).toEqual({ role: "user", content: "And this?", images: ["AAAA"] });
  });

  it("throws what Ollama said", async () => {
    const model = ollamaModel({
      url: "http://ollama.test",
      model: "missing",
      fetch: async () => new Response('{"error":"model not found"}', { status: 404 }),
    });
    await expect(model.doGenerate({ prompt: [{ role: "user", content: [] }] })).rejects.toThrow(
      /404.*model not found/,
    );
  });
});
