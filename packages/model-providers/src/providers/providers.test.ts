import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { accountGateway } from "../account.js";
import { probe } from "../probe.js";
import { checkKey } from "./check.js";
import { compatibleModel, providerModel } from "./model.js";
import { PROVIDER_IDS, PROVIDERS, type ProviderId, TEXT_PROVIDERS } from "./provider.js";

interface Seen {
  url: string;
  headers: Headers;
}

/** A stand-in for the network: it keeps what was asked and answers every request the same way. */
function standIn(status: number, body: unknown = {}) {
  const seen: Seen[] = [];
  const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    seen.push({
      url: request ? request.url : String(input),
      headers: new Headers(init?.headers ?? request?.headers),
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { seen, fetch: doFetch };
}

/** What OpenAI's chat API answers with, as OpenRouter and any compatible address do. */
const chatAnswer = (text: string) => ({
  id: "1",
  object: "chat.completion",
  created: 1,
  model: "m",
  choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});

/** Where each provider is asked, and the header that carries the key. */
const ASKED: Record<ProviderId, { host: string; header: string; value: string }> = {
  openai: { host: "api.openai.com", header: "authorization", value: "Bearer k" },
  anthropic: { host: "api.anthropic.com", header: "x-api-key", value: "k" },
  google: { host: "generativelanguage.googleapis.com", header: "x-goog-api-key", value: "k" },
  openrouter: { host: "openrouter.ai", header: "authorization", value: "Bearer k" },
  gateway: { host: "ai-gateway.vercel.sh", header: "authorization", value: "Bearer k" },
  fal: { host: "api.fal.ai", header: "authorization", value: "Key k" },
  elevenlabs: { host: "api.elevenlabs.io", header: "xi-api-key", value: "k" },
  replicate: { host: "api.replicate.com", header: "authorization", value: "Bearer k" },
};

describe("the list of providers", () => {
  it("has an entry under each id, with a place to make a key and a variable to read it from", () => {
    for (const id of PROVIDER_IDS) {
      const provider = PROVIDERS[id];
      expect(provider.id).toBe(id);
      expect(provider.keyUrl).toMatch(/^https:\/\//);
      expect(provider.env).toMatch(/^[A-Z_]+$/);
    }
    expect(new Set(PROVIDER_IDS.map((id) => PROVIDERS[id].env)).size).toBe(PROVIDER_IDS.length);
  });

  it("names the providers that write text", () => {
    expect(TEXT_PROVIDERS).toEqual(["openai", "anthropic", "google", "openrouter", "gateway"]);
  });
});

describe("the test of a key", () => {
  it.each(PROVIDER_IDS)("asks %s itself, with the key in its own header", async (id) => {
    const net = standIn(200);
    expect(await checkKey(id, "k", { fetch: net.fetch })).toEqual({ state: "ok" });
    expect(net.seen).toHaveLength(1);
    expect(new URL(net.seen[0]?.url ?? "").host).toBe(ASKED[id].host);
    expect(net.seen[0]?.headers.get(ASKED[id].header)).toBe(ASKED[id].value);
  });

  it("says a key the provider does not know is unknown", async () => {
    expect(await checkKey("openai", "k", { fetch: standIn(401).fetch })).toEqual({
      state: "unknown",
    });
  });

  it("takes a key that may do only some things as a key", async () => {
    expect(await checkKey("openai", "k", { fetch: standIn(403).fetch })).toEqual({ state: "ok" });
    const limited = standIn(400, { error: { code: "missing_permissions" } });
    expect(await checkKey("elevenlabs", "k", { fetch: limited.fetch })).toEqual({ state: "ok" });
  });

  it("passes on any other answer with its status", async () => {
    expect(await checkKey("google", "k", { fetch: standIn(500).fetch })).toEqual({
      state: "error",
      status: 500,
    });
  });

  it("says so when the provider does not answer", async () => {
    const down = (async () => {
      throw new Error("no route");
    }) as unknown as typeof fetch;
    expect(await checkKey("anthropic", "k", { fetch: down })).toEqual({ state: "unreachable" });
  });
});

describe("a model on a key", () => {
  it.each(TEXT_PROVIDERS)("asks %s itself, with the key in its own header", async (id) => {
    const net = standIn(401, { error: { message: "no" } });
    const model = providerModel(id, "k", "some-model", { fetch: net.fetch });
    await expect(generateText({ model, prompt: "hi", maxRetries: 0 })).rejects.toThrow();
    expect(new URL(net.seen[0]?.url ?? "").host).toBe(ASKED[id].host);
    expect(net.seen[0]?.headers.get(ASKED[id].header)).toBe(ASKED[id].value);
  });

  it("answers through OpenRouter as through OpenAI's API", async () => {
    const net = standIn(200, chatAnswer("hello"));
    const model = providerModel("openrouter", "k", "openrouter/auto", { fetch: net.fetch });
    expect((await generateText({ model, prompt: "hi" })).text).toBe("hello");
    expect(net.seen[0]?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
  });

  it("refuses a provider that writes no text", () => {
    expect(() => providerModel("fal", "k", "fal-ai/flux/schnell")).toThrow(/fal\.ai/);
  });

  it("asks an address of the person's own choice, with a key or without", async () => {
    const net = standIn(200, chatAnswer("hello"));
    const model = compatibleModel({
      name: "custom",
      baseUrl: "http://127.0.0.1:9/v1",
      model: "m",
      fetch: net.fetch,
    });
    expect((await generateText({ model, prompt: "hi" })).text).toBe("hello");
    expect(net.seen[0]?.url).toBe("http://127.0.0.1:9/v1/chat/completions");
    expect(net.seen[0]?.headers.get("authorization")).toBeNull();
  });
});

describe("the wizards account", () => {
  it("is asked at the Manage-App's gateway with the account's key", async () => {
    const net = standIn(401, { error: { message: "no" } });
    const gateway = accountGateway({ url: "https://manage.test/", key: "k", fetch: net.fetch });
    await expect(
      generateText({ model: gateway("wizards/standard"), prompt: "hi", maxRetries: 0 }),
    ).rejects.toThrow();
    expect(net.seen[0]?.url.startsWith("https://manage.test/v4/ai/")).toBe(true);
    expect(net.seen[0]?.headers.get("authorization")).toBe("Bearer k");
  });
});

describe("a short real call on a key", () => {
  it("is ok when the provider's model answers", async () => {
    const net = standIn(200, chatAnswer("ok"));
    expect(
      await probe({ kind: "provider", provider: "openrouter", key: "k", fetch: net.fetch }),
    ).toEqual({ state: "ok", model: "openrouter/auto", detail: "ok" });
  });

  it("fails with the provider's status when it refuses the key", async () => {
    const net = standIn(401, { error: { message: "No auth credentials found" } });
    const result = await probe({
      kind: "provider",
      provider: "openrouter",
      key: "k",
      model: "m",
      fetch: net.fetch,
    });
    expect(result).toMatchObject({ state: "failed", model: "m", status: 401 });
    expect(result.detail).toContain("No auth credentials found");
  });

  it("has no model to ask at a provider that writes no text", async () => {
    expect(await probe({ kind: "provider", provider: "replicate", key: "k" })).toEqual({
      state: "no_model",
    });
  });

  it("asks the account's gateway for the class it is given", async () => {
    const net = standIn(403, { error: { message: "no credits" } });
    const result = await probe({
      kind: "account",
      url: "https://manage.test",
      key: "k",
      model: "wizards/standard",
      fetch: net.fetch,
    });
    expect(result).toMatchObject({ state: "failed", model: "wizards/standard", status: 403 });
    expect(net.seen[0]?.url.startsWith("https://manage.test/v4/ai/")).toBe(true);
  });
});
