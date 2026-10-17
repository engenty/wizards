import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "wizards-setup-keys-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
// Alone, with keys in a file of the data folder, and none from the shell or an env file.
process.env.MANAGE_URL = "";
process.env.SECRETS = "file";
for (const name of [
  "AI_GATEWAY_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "FAL_KEY",
  "ELEVENLABS_API_KEY",
  "REPLICATE_API_TOKEN",
]) {
  process.env[name] = "";
}

/** What the providers and Ollama answer, as each test sets it. */
const net = vi.hoisted(() => ({
  status: 200,
  ollama: [] as string[] | null,
}));

let models: typeof import("../src/models");
let settings: typeof import("../src/settings");

beforeAll(async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).startsWith("http://127.0.0.1:11434")) {
        if (!net.ollama) {
          throw new Error("ECONNREFUSED");
        }
        return new Response(JSON.stringify({ data: net.ollama.map((id) => ({ id })) }));
      }
      return new Response("{}", { status: net.status });
    }),
  );
  const client = await import("../src/db/client");
  await client.migrateControlDb();
  models = await import("../src/models");
  settings = await import("../src/settings");
}, 60_000);

beforeEach(async () => {
  net.status = 200;
  net.ollama = [];
  // Own keys picked in the setup, nothing stored yet.
  await settings.writeSetting("models", { source: "own", bindings: {} });
  await models.loadLocalModels();
  await models.saveLocalModels({ keys: { openai: "", anthropic: "", gateway: "" } });
});

const bindings = () => models.localModelSettings().bindings;

describe("the setup's test of a key", () => {
  it("stores an OpenAI key and gives OpenAI what it can do, video aside", async () => {
    const result = await models.setUpKey("openai", "sk-test");
    expect(result).toEqual({ ok: true, message: null, text: "openai:gpt-5.4-mini" });
    expect(models.localModelSettings().keys.openai).toBe(true);
    expect(bindings()).toMatchObject({
      classifier: "openai:gpt-5.4-mini",
      standard: "openai:gpt-5.4-mini",
      high: "openai:gpt-5.5",
      highest: "openai:gpt-5.5",
      image: "openai:gpt-image-2",
      speech: "openai:gpt-4o-mini-tts",
      audio: "openai:gpt-4o-mini-transcribe",
      video: "",
    });
  });

  it("leaves the classes another key already covers", async () => {
    await models.setUpKey("openai", "sk-test");
    const result = await models.setUpKey("anthropic", "sk-ant-test");
    expect(result.text).toBe("openai:gpt-5.4-mini");
    expect(bindings().highest).toBe("openai:gpt-5.5");
  });

  it("tests a stored key again when none is given", async () => {
    await models.setUpKey("openai", "sk-test");
    expect((await models.setUpKey("openai", undefined)).ok).toBe(true);
  });

  it("stores no key the provider refuses", async () => {
    net.status = 401;
    const result = await models.setUpKey("openai", "sk-wrong");
    expect(result.ok).toBe(false);
    expect(models.localModelSettings().keys.openai).toBe(false);
    expect(bindings().standard).toBe("");
  });
});

describe("the setup's test of Ollama", () => {
  it("binds the text classes to the first model Ollama has", async () => {
    net.ollama = ["llama3.2", "qwen3"];
    const result = await models.setUpOllama("http://127.0.0.1:11434/v1/");
    expect(result).toEqual({ ok: true, message: null, text: "ollama:llama3.2" });
    expect(bindings().highest).toBe("ollama:llama3.2");
    expect(models.localModelSettings().ollamaUrl).toBe("http://127.0.0.1:11434/v1");
  });

  it("says so when Ollama has no model or does not answer", async () => {
    net.ollama = [];
    expect((await models.setUpOllama("http://127.0.0.1:11434/v1")).ok).toBe(false);
    net.ollama = null;
    expect((await models.setUpOllama("http://127.0.0.1:11434/v1")).ok).toBe(false);
    expect(bindings().standard).toBe("");
  });
});
