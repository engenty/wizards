import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetLocalDecision, REST_MS } from "./local.js";
import { decisionBy, decisionEnvFrom, decisionOf, decisionReady, type Way } from "./ways.js";

const QUESTION = {
  q: { type: "noul", instructions: "Is it?" },
} as const;
const OK = {
  answers: { q: { type: "noul" as const, noul: 0.9 } },
  model: "m",
};

/** An Ollama that holds `models`, and answers /v1/systemone with `answer`. */
function ollama(models: string[], answer: () => Response = () => Response.json(OK)) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/tags")) {
      return Response.json({ models: models.map((name) => ({ name })) });
    }
    return answer();
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

beforeEach(() => {
  forgetLocalDecision();
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("decisionEnvFrom", () => {
  it("reads the three variables", () => {
    const env = decisionEnvFrom(
      (k) =>
        ({
          AI_GATEWAY_API_KEY: "g",
          TYPESAFE_API_KEY: "t",
          OLLAMA_BASE_URL: "http://o:1",
        })[k],
    );
    expect(env).toEqual({
      gatewayKey: "g",
      typesafeKey: "t",
      ollamaUrl: "http://o:1",
    });
  });
});

describe("the keyed ways", () => {
  it("are null without a key and name their model with one", async () => {
    expect(await decisionBy("gateway", {})).toBeNull();
    expect(await decisionBy("typesafe", { typesafeKey: "  " })).toBeNull();
    expect((await decisionBy("gateway", { gatewayKey: "g" }))?.model).toBe("typesafe-ai/jev");
    expect((await decisionBy("typesafe", { typesafeKey: "t" }))?.model).toBe("jev-latest");
  });

  it("send the key to the way's own address", async () => {
    const fetchImpl = vi.fn(async () => Response.json(OK)) as unknown as typeof fetch &
      ReturnType<typeof vi.fn>;
    const model = await decisionBy("gateway", { gatewayKey: "g" }, { fetchImpl });
    await model?.systemOne({ questions: QUESTION, state: "s" });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://ai-gateway.vercel.sh/typesafe/v1/systemone");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer g");
  });
});

describe("the local way", () => {
  it("takes Clef-flash, else Clef, else nothing", async () => {
    expect(
      (await decisionBy("local", {}, { fetchImpl: ollama(["clef:latest", "clef-flash:latest"]) }))
        ?.model,
    ).toBe("clef-flash:latest");
    forgetLocalDecision();
    expect(
      (await decisionBy("local", {}, { fetchImpl: ollama(["llama3", "clef:latest"]) }))?.model,
    ).toBe("clef:latest");
    forgetLocalDecision();
    expect(await decisionBy("local", {}, { fetchImpl: ollama(["llama3"]) })).toBeNull();
  });

  it("is null when Ollama is not running", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await decisionBy("local", {}, { fetchImpl })).toBeNull();
  });

  it("uses the named model only if Ollama holds it", async () => {
    const fetchImpl = ollama(["clef-flash:latest", "mine:latest"]);
    expect((await decisionBy("local", { localModel: "mine" }, { fetchImpl }))?.model).toBe("mine");
    expect(await decisionBy("local", { localModel: "other" }, { fetchImpl })).toBeNull();
  });

  it("asks /v1/systemone at the given Ollama without a key", async () => {
    const fetchImpl = ollama(["clef-flash"]);
    const model = await decisionBy("local", { ollamaUrl: "http://box:11434/v1/" }, { fetchImpl });
    const res = await model?.systemOne({ questions: QUESTION, state: "s" });
    expect(res?.answers.q).toEqual({ type: "noul", noul: 0.9 });
    const [url, init] = fetchImpl.mock.calls.at(-1) as [string, RequestInit];
    expect(url).toBe("http://box:11434/v1/systemone");
    expect(init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(init.body as string).model).toBe("clef-flash");
  });

  it("rests for ten minutes after Ollama cannot run the model", async () => {
    const fetchImpl = ollama(
      ["clef-flash"],
      () => new Response("model not found", { status: 404 }),
    );
    const model = await decisionBy("local", {}, { fetchImpl });
    await expect(model?.systemOne({ questions: QUESTION, state: "s" })).rejects.toThrow(
      /local_decision_http_404/,
    );

    expect(await decisionBy("local", {}, { fetchImpl })).toBeNull();
    expect((await decisionReady({}, [], { fetchImpl })).local).toBe(false);

    vi.setSystemTime(Date.now() + REST_MS + 1);
    expect(await decisionBy("local", {}, { fetchImpl })).not.toBeNull();
  });

  it("does not rest after a refusal of the question itself", async () => {
    const fetchImpl = ollama(["clef-flash"], () => new Response("bad question", { status: 400 }));
    const model = await decisionBy("local", {}, { fetchImpl });
    await expect(model?.systemOne({ questions: QUESTION, state: "s" })).rejects.toThrow(
      /local_decision_http_400/,
    );
    expect(await decisionBy("local", {}, { fetchImpl })).not.toBeNull();
  });
});

describe("decisionOf", () => {
  const credits: Way = {
    way: "credits",
    open: async () => ({
      way: "credits",
      model: "c",
      systemOne: async () => OK,
    }),
  };

  it("auto takes the first way that opens, in order", async () => {
    const fetchImpl = ollama(["clef-flash"]);
    const env = { gatewayKey: "g", typesafeKey: "t" };
    expect((await decisionOf("auto", env, [], { fetchImpl }))?.way).toBe("gateway");
    expect((await decisionOf("auto", { typesafeKey: "t" }, [], { fetchImpl }))?.way).toBe(
      "typesafe",
    );
    expect((await decisionOf("auto", {}, [], { fetchImpl }))?.way).toBe("local");
    forgetLocalDecision();
    expect((await decisionOf("auto", {}, [credits], { fetchImpl: ollama([]) }))?.way).toBe(
      "credits",
    );
  });

  it("a named way does not fall through; off and unknown are null", async () => {
    const env = { gatewayKey: "g" };
    expect(await decisionOf("typesafe", env)).toBeNull();
    expect((await decisionOf("gateway", env))?.way).toBe("gateway");
    expect(await decisionOf("off", env)).toBeNull();
    expect(await decisionOf("nope", env)).toBeNull();
    expect((await decisionOf("credits", env, [credits]))?.way).toBe("credits");
  });
});

describe("decisionReady", () => {
  it("says per way, extras included", async () => {
    const extra: Way = { way: "credits", open: async () => null };
    expect(
      await decisionReady({ typesafeKey: "t" }, [extra], {
        fetchImpl: ollama([]),
      }),
    ).toEqual({ gateway: false, typesafe: true, local: false, credits: false });
  });
});
