import { afterEach, describe, expect, it, vi } from "vitest";
import { probe } from "../probe.js";
import {
  lmStudio,
  lmStudioAddress,
  lmStudioDownload,
  lmStudioFetch,
  lmStudioModels,
  lmStudioRoot,
  lmStudioState,
} from "./index.js";

const URL_ = "http://lm.test:1234";

/** An LM Studio that holds two models and remembers what it was asked. */
function studio(loaded: { id: string; context: number }[] = []) {
  const instances = [...loaded];
  const asked: { path: string; body?: Record<string, unknown>; token: string | null }[] = [];
  const doFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    asked.push({ path, body, token: new Headers(init?.headers).get("authorization") });
    switch (path) {
      case "/api/v1/models":
        return Response.json({
          models: [
            {
              type: "llm",
              key: "google/gemma-4-26b-a4b",
              quantization: { name: "4bit" },
              size_bytes: 15_600_000_000,
              max_context_length: 262_144,
              format: "mlx",
              capabilities: {
                vision: true,
                trained_for_tool_use: true,
                reasoning: { allowed_options: ["off", "on"] },
              },
              loaded_instances: instances.map((i) => ({
                id: i.id,
                config: { context_length: i.context },
              })),
            },
            { type: "embedding", key: "nomic", size_bytes: 80_000_000, format: "gguf" },
          ],
        });
      case "/api/v1/models/load":
        instances.push({ id: String(body.model), context: Number(body.context_length) });
        return Response.json({ instance_id: body.model, status: "loaded" });
      case "/api/v1/models/unload":
        instances.splice(
          instances.findIndex((i) => i.id === body.instance_id),
          1,
        );
        return Response.json({ instance_id: body.instance_id });
      case "/v1/chat/completions":
        return Response.json({ choices: [{ message: { content: " ok " } }] });
      default:
        return new Response("", { status: 404 });
    }
  }) as unknown as typeof fetch;
  return { doFetch, asked, instances };
}

const loads = (asked: { path: string; body?: Record<string, unknown> }[]) =>
  asked.filter((a) => a.path === "/api/v1/models/load").map((a) => a.body);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("LM Studio's address", () => {
  it("is a root or the /v1 address, LMSTUDIO_URL or LM Studio's default", () => {
    expect(lmStudioRoot(" http://127.0.0.1:1234/v1/ ")).toBe("http://127.0.0.1:1234");
    expect(lmStudioAddress({})).toBe("http://127.0.0.1:1234");
    expect(lmStudioAddress({ LMSTUDIO_URL: "http://gpu:99/v1" })).toBe("http://gpu:99");
  });
});

describe("LM Studio's models", () => {
  it("lists what each can do and loads none", async () => {
    const { doFetch, asked } = studio([{ id: "a", context: 4096 }]);
    expect(await lmStudioModels(URL_, { fetch: doFetch })).toEqual([
      {
        name: "google/gemma-4-26b-a4b",
        size: 15_600_000_000,
        digest: "google/gemma-4-26b-a4b",
        capabilities: ["completion", "tools", "vision", "thinking"],
        completion: true,
        tools: true,
        vision: true,
        thinking: true,
        runner: "mlx",
        quantization: "4bit",
        running: true,
      },
      expect.objectContaining({
        name: "nomic",
        capabilities: ["embedding"],
        completion: false,
        runner: "llamacpp",
        running: false,
      }),
    ]);
    expect(loads(asked)).toEqual([]);
  });

  it("says whether it answers, wants a token or is too old", async () => {
    const answering = (status: number) =>
      (async () => new Response("{}", { status })) as unknown as typeof fetch;
    expect(await lmStudioState(URL_, { fetch: studio().doFetch })).toEqual({
      running: true,
      version: null,
      models: ["google/gemma-4-26b-a4b", "nomic"],
      trouble: null,
    });
    expect(await lmStudioState(URL_, { fetch: answering(401) })).toMatchObject({
      running: true,
      trouble: "locked",
    });
    expect(await lmStudioState(URL_, { fetch: answering(404) })).toMatchObject({
      running: true,
      trouble: "old",
    });
    const gone = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await lmStudioState(URL_, { fetch: gone })).toMatchObject({ running: false });
  });

  it("downloads a model and reports how far it is", async () => {
    const answers = [
      { job_id: "j", status: "downloading", total_size_bytes: 100 },
      { job_id: "j", status: "downloading", total_size_bytes: 100, downloaded_bytes: 40 },
      { job_id: "j", status: "completed" },
    ];
    const paths: string[] = [];
    const doFetch = (async (input: RequestInfo | URL) => {
      paths.push(new URL(String(input)).pathname);
      return Response.json(answers.shift());
    }) as unknown as typeof fetch;
    const seen: [number, number][] = [];
    await lmStudioDownload(URL_, "google/gemma-4-12b", (a, b) => seen.push([a, b]), {
      fetch: doFetch,
      every: 1,
    });
    expect(seen).toEqual([
      [0, 100],
      [40, 100],
    ]);
    expect(paths).toEqual([
      "/api/v1/models/download",
      "/api/v1/models/download/status/j",
      "/api/v1/models/download/status/j",
    ]);
  });

  it("says why a download was refused", async () => {
    const doFetch = (async () =>
      Response.json({ error: { message: "no such model" } }, { status: 404 })) as typeof fetch;
    await expect(lmStudioDownload(URL_, "x", () => undefined, { fetch: doFetch })).rejects.toThrow(
      "no such model",
    );
  });
});

describe("a call to a model of LM Studio", () => {
  const call = (doFetch: typeof fetch, context?: number) =>
    lmStudioFetch(URL_, { fetch: doFetch, context })(`${URL_}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "google/gemma-4-26b-a4b", messages: [] }),
    });

  it("loads the model with the context length first, once for calls at the same time", async () => {
    const { doFetch, asked } = studio();
    await Promise.all([call(doFetch), call(doFetch)]);
    expect(loads(asked)).toEqual([{ model: "google/gemma-4-26b-a4b", context_length: 16_384 }]);
    await call(doFetch);
    expect(loads(asked)).toHaveLength(1);
  });

  it("leaves a model alone that is loaded long enough", async () => {
    const { doFetch, asked } = studio([{ id: "mine", context: 32_768 }]);
    await call(doFetch);
    expect(asked.map((a) => a.path)).toEqual(["/api/v1/models", "/v1/chat/completions"]);
  });

  it("loads one anew that is loaded too short for the call", async () => {
    const { doFetch, asked, instances } = studio([{ id: "short", context: 4096 }]);
    await call(doFetch, 20_000);
    expect(asked.map((a) => a.path)).toContain("/api/v1/models/unload");
    expect(instances).toEqual([{ id: "google/gemma-4-26b-a4b", context: 20_000 }]);
  });

  it("unloads what it loaded once nobody asked for a while", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { doFetch, instances } = studio();
    await call(doFetch);
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    expect(instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(instances).toHaveLength(0);
  });

  it("sends the token where there is one", async () => {
    vi.stubEnv("LM_API_TOKEN", "t");
    const { doFetch, asked } = studio([{ id: "mine", context: 32_768 }]);
    await call(doFetch);
    expect(asked.map((a) => a.token)).toEqual(["Bearer t", "Bearer t"]);
  });

  it("answers the short test call", async () => {
    const { doFetch } = studio();
    expect(await probe({ kind: "server", server: "lmstudio", url: URL_, fetch: doFetch })).toEqual({
      state: "ok",
      model: "google/gemma-4-26b-a4b",
      detail: "ok",
    });
    expect(
      await probe({
        kind: "server",
        server: "lmstudio",
        url: URL_,
        memory: 16e9,
        share: 0.55,
        fetch: doFetch,
      }),
    ).toEqual({ state: "too_big", model: "google/gemma-4-26b-a4b" });
  });

  it("removes nothing: LM Studio's API does not", () => {
    expect(lmStudio.remove).toBeUndefined();
  });
});
