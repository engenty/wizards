import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// One stand-in for Ollama (/api/…) and the account's Manage-App (/v1/local-models).
const held = [
  { name: "embeddinggemma-2:740m", size: 1_280_000_000, digest: "a" },
  { name: "qwen3.8:27b-mlx", size: 18_170_000_000, digest: "b" },
  { name: "clef-flash:latest", size: 12_390_000_000, digest: "c" },
];
const shows: Record<string, unknown> = {
  "embeddinggemma-2:740m": {
    capabilities: ["embedding", "vision", "audio"],
    details: { runner: "mlx", quantization_level: "nvfp4" },
  },
  "qwen3.8:27b-mlx": { capabilities: ["completion", "vision", "tools", "thinking"], details: {} },
  "clef-flash:latest": { capabilities: ["decision", "vision"], details: { runner: "mlx" } },
};
const deleted: string[] = [];

const server: Server = createServer(async (req, res) => {
  const json = (body: unknown, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  let body = "";
  for await (const chunk of req) {
    body += chunk;
  }
  switch (req.url) {
    case "/api/version":
      return json({ version: "0.40.12" });
    case "/api/tags":
      return json({ models: held });
    case "/api/ps":
      return json({ models: [{ name: "clef-flash:latest" }] });
    case "/api/show":
      return json(shows[(JSON.parse(body) as { model: string }).model] ?? {});
    case "/api/delete": {
      const { model } = JSON.parse(body) as { model: string };
      if (!held.some((m) => m.name === model)) {
        return json({ error: `model '${model}' not found` }, 404);
      }
      deleted.push(model);
      return json({});
    }
    case "/v1/local-models":
      return json({
        models: [
          { name: "qwen3.8:27b", job: "text", size: 17.7, memory: 1e6, note: { en: "", de: "" } },
          { name: "gemma4:e4b", job: "text", size: 6.6, memory: 0.1, note: { en: "", de: "" } },
          {
            name: "embeddinggemma-2:740m",
            job: "search",
            size: 1.3,
            memory: 0.1,
            note: { en: "", de: "" },
          },
          { name: "clef-flash", job: "decision", size: 10.6, memory: 0.1, note: { en: "", de: "" } },
          { name: "other", job: "video", size: 1, memory: 0.1, note: { en: "", de: "" } },
        ],
      });
    default:
      return json({ error: "not found" }, 404);
  }
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-local-models-"));
process.env.OLLAMA_URL = `${origin}/v1`;
process.env.ACCOUNT_URL = origin;
delete process.env.MANAGE_URL;

let local: typeof import("../src/local-models");

beforeAll(async () => {
  local = await import("../src/local-models");
});

afterAll(() => server.close());

describe("the models in Ollama on this computer", () => {
  it("sorts them by job from what Ollama says each can do", async () => {
    const state = await local.localModels();
    expect(state.ollama.version).toBe("0.40.12");
    const byName = Object.fromEntries(state.installed.map((m) => [m.name, m]));
    expect(byName["embeddinggemma-2:740m"]).toMatchObject({
      jobs: ["search"],
      runner: "mlx",
      quantization: "nvfp4",
      size: 1.3,
      loaded: false,
    });
    expect(byName["qwen3.8:27b-mlx"]).toMatchObject({ jobs: ["text"], runner: null });
    expect(byName["clef-flash:latest"]).toMatchObject({ jobs: ["decision"], loaded: true });
  });

  it("offers the Manage-App's models, marked as there and as fitting this computer", async () => {
    const { offered } = await local.localModels();
    const byName = Object.fromEntries((offered ?? []).map((m) => [m.name, m]));
    expect(Object.keys(byName)).toEqual([
      "qwen3.8:27b",
      "gemma4:e4b",
      "embeddinggemma-2:740m",
      "clef-flash",
    ]);
    expect(byName["qwen3.8:27b"]).toMatchObject({ installed: false, fits: false });
    expect(byName["gemma4:e4b"]).toMatchObject({ installed: false, fits: true });
    expect(byName["embeddinggemma-2:740m"].installed).toBe(true);
    // Ollama names a model without a tag `name:latest`.
    expect(byName["clef-flash"].installed).toBe(true);
  });

  it("removes a model, and says Ollama's reason where it refuses", async () => {
    await local.removeLocalModel("qwen3.8:27b-mlx");
    expect(deleted).toEqual(["qwen3.8:27b-mlx"]);
    await expect(local.removeLocalModel("nothing:here")).rejects.toThrow(
      "model 'nothing:here' not found",
    );
  });
});
