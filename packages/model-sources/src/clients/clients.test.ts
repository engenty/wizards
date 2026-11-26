import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./env.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./env.js")>();
  return {
    ...real,
    // A login shell is slow to start on a loaded machine; the tests that need one call it themselves.
    resolveEnv: vi.fn(async (spec: Parameters<typeof real.resolveEnv>[0]) =>
      spec.id === "real" ? real.resolveEnv(spec) : { env: {}, auth: "subscription" as const },
    ),
  };
});

const {
  claudeAnswer,
  clientEnv,
  ClientFailure,
  ClientModel,
  clientFailure,
  codexAnswer,
  detectClient,
  parseJsonAnswer,
  ProbeUndecided,
  probeVersion,
  renderPrompt,
  resolveEnv,
  run,
  stripKeys,
} = await import("./index.js");

afterEach(() => {
  vi.useRealTimers();
});

describe("a client's environment", () => {
  it("gives the client the shell's sign-in and PATH, nothing of this process", () => {
    const picked = clientEnv(
      { PATH: "/opt/homebrew/bin:/usr/bin", ANTHROPIC_API_KEY: "sk-shell", HOME: "/Users/x" },
      {
        PATH: "/usr/bin:/bin",
        ANTHROPIC_API_KEY: "sk-own",
        CLAUDECODE: "1",
        ANTHROPIC_BASE_URL: "http://gw",
        AI_GATEWAY_API_KEY: "vck",
        HOME: "/Users/x",
        USER: "x",
      },
      /^ANTHROPIC_/,
    );
    expect(picked.ANTHROPIC_API_KEY).toBe("sk-shell");
    expect(picked.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(picked.CLAUDECODE).toBeUndefined();
    expect(picked.AI_GATEWAY_API_KEY).toBeUndefined();
    expect(picked.PATH).toBe("/opt/homebrew/bin:/usr/bin:/bin");
    expect(picked.HOME).toBe("/Users/x");
    // Without a shell environment, this process's own sign-in serves.
    expect(
      clientEnv({}, { ANTHROPIC_API_KEY: "sk-own", PATH: "/bin" }, /^ANTHROPIC_/).ANTHROPIC_API_KEY,
    ).toBe("sk-own");
    expect(stripKeys(picked, ["ANTHROPIC_API_KEY"]).ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("keeps on Windows what a Windows program needs, and its PATH whole", () => {
    const picked = clientEnv(
      {},
      {
        Path: "C:\\Windows\\system32;C:\\Program Files\\nodejs",
        SystemRoot: "C:\\Windows",
        ComSpec: "C:\\Windows\\system32\\cmd.exe",
        APPDATA: "C:\\Users\\x\\AppData\\Roaming",
        AI_GATEWAY_API_KEY: "vck",
      },
      /^OPENAI_/,
      ["C:\\h\\clients"],
      "win32",
    );
    expect(picked.PATH).toBe("C:\\h\\clients;C:\\Windows\\system32;C:\\Program Files\\nodejs");
    expect(picked.SystemRoot).toBe("C:\\Windows");
    expect(picked.ComSpec).toBe("C:\\Windows\\system32\\cmd.exe");
    expect(picked.APPDATA).toBe("C:\\Users\\x\\AppData\\Roaming");
    expect(picked.AI_GATEWAY_API_KEY).toBeUndefined();
  });

  it("puts the subscription first: a shell key is held back while the client is signed in without it", async () => {
    const seen: NodeJS.ProcessEnv[] = [];
    const resolved = await resolveEnv({
      id: "real",
      passThrough: /^X_KEY$/,
      keyVars: ["X_KEY"],
      auth: async (env) => {
        seen.push(env);
        return env.X_KEY ? "api_key" : "none";
      },
    });
    // The shell has no X_KEY here, so the only way in is none; the client was asked once, bare.
    expect(resolved.auth).toBe("none");
    expect(seen[0]?.X_KEY).toBeUndefined();
    // A login shell is spawned for the environment: slow on a loaded machine.
  }, 20_000);
});

describe("what the clients print", () => {
  it("reads Claude Code: text or structured output, and the usage", () => {
    const a = claudeAnswer({
      result: "Hello",
      session_id: "s1",
      total_cost_usd: 0.01,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 },
    });
    expect(a.text).toBe("Hello");
    expect(a.usage).toEqual({ input: 110, cacheRead: 100, cacheWrite: 0, output: 5 });
    expect(a.sessionId).toBe("s1");
    const b = claudeAnswer({ structured_output: { answer: "yes" }, result: "ignored" });
    expect(JSON.parse(b.text)).toEqual({ answer: "yes" });
  });

  it("reads Codex: the last agent message, the usage, a failure", () => {
    const ok = codexAnswer(
      [
        '{"type":"thread.started","thread_id":"t1"}',
        '{"type":"turn.started"}',
        '{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"…"}}',
        '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"OK"}}',
        '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":60,"output_tokens":5}}',
      ].join("\n"),
    );
    expect(ok.answer?.text).toBe("OK");
    expect(ok.answer?.usage).toEqual({ input: 100, cacheRead: 60, cacheWrite: 0, output: 5 });
    expect(ok.answer?.sessionId).toBe("t1");
    expect(ok.failure).toBeNull();
    const failed = codexAnswer(
      '{"type":"turn.failed","error":{"message":"usage limit reached"}}\nnot json',
    );
    expect(failed.answer).toBeNull();
    expect(failed.failure).toBe("usage limit reached");
  });

  it("tells a signed-out client from one whose account cannot pay or is not served", () => {
    const codex = { id: "codex", name: "Codex" };
    expect(clientFailure(codex, "Not logged in").code).toBe("signed_out");
    expect(clientFailure(codex, "usage limit reached").code).toBe("exhausted");
    expect(clientFailure(codex, "IneligibleTier: free").code).toBe("not_served");
    const boom = clientFailure(codex, "boom");
    expect(boom.code).toBe("failed");
    expect(boom.message).toBe("Codex: boom");
  });
});

describe("the conversation as a client reads it", () => {
  it("renders one user message as the prompt and system messages as the system prompt", () => {
    const r = renderPrompt([
      { role: "system", content: "Be brief." },
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ]);
    expect(r.system).toBe("Be brief.");
    expect(r.prompt).toBe("Hello");
    expect(r.warnings).toEqual([]);
  });

  it("writes a thread out with its speakers and asks for the last answer, in the host's words", () => {
    const thread = [
      { role: "user" as const, content: [{ type: "text" as const, text: "Hi" }] },
      { role: "assistant" as const, content: [{ type: "text" as const, text: "Hello!" }] },
      { role: "user" as const, content: [{ type: "text" as const, text: "Again?" }] },
    ];
    const r = renderPrompt(thread);
    expect(r.prompt).toBe("User:\nHi\n\nAssistant:\nHello!\n\nUser:\nAgain?");
    expect(r.system).toContain("Answer the last message as the assistant");
    const own = renderPrompt(thread, undefined, {
      attachedFile: (path) => path,
      conversationNote: () => "Answer the last one.",
      jsonInstruction: (schema) => schema,
    });
    expect(own.system).toBe("Answer the last one.");
  });

  it("parses JSON answers with fences or prose around them", () => {
    expect(parseJsonAnswer('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonAnswer('Here you go: {"a":[1,2]} — done.')).toEqual({ a: [1, 2] });
    expect(() => parseJsonAnswer("no json here")).toThrow();
  });
});

describe("a client as a model", () => {
  const prompt = [{ role: "user" as const, content: [{ type: "text" as const, text: "Hi" }] }];
  const tool = (name: string) => ({
    type: "function" as const,
    name,
    inputSchema: { type: "object" as const, properties: {} },
  });

  it("opens the host's bridge only for a call with tools the client runs", async () => {
    const seen: (string | null)[] = [];
    const opened: string[][] = [];
    class Probe extends ClientModel {
      readonly provider = "probe";
      protected async invoke(call: { bridgeUrl: string | null }) {
        seen.push(call.bridgeUrl);
        return { text: "ok" };
      }
    }
    const model = new Probe({ id: "probe", name: "Probe" }, "default", {
      bridge: (tools) => {
        opened.push(tools.map((t) => t.name));
        return { url: "http://127.0.0.1:1/bridge", close: () => undefined };
      },
    });
    model.attach({ add: { id: "add", execute: async () => 3 } });
    await model.doGenerate({ prompt });
    await model.doGenerate({ prompt, tools: [] });
    // The client searches with its own tool: naming it needs no bridge either.
    await model.doGenerate({ prompt, tools: [tool("web_search")] });
    await model.doGenerate({ prompt, tools: [tool("add")] });
    expect(seen).toEqual([null, null, null, "http://127.0.0.1:1/bridge"]);
    expect(opened).toEqual([["add"]]);
    // Without a bridge the tools are left out, with a warning.
    const alone = new Probe({ id: "probe", name: "Probe" }, "default");
    alone.attach({ add: { id: "add", execute: async () => 3 } });
    const result = await alone.doGenerate({ prompt, tools: [tool("add")] });
    expect(result.warnings).toEqual([{ type: "unsupported", feature: "tool add" }]);
  });

  it("hands a failure to the host, a missing client as not installed", async () => {
    class Missing extends ClientModel {
      readonly provider = "missing";
      protected async invoke(): Promise<never> {
        throw Object.assign(new Error("spawn nope ENOENT"), { code: "ENOENT" });
      }
    }
    class Broke extends ClientModel {
      readonly provider = "broke";
      protected async invoke(): Promise<never> {
        throw clientFailure(this.client, "OAuth token has expired");
      }
    }
    const meta = { id: "x", name: "X" };
    await expect(new Missing(meta, "a").doGenerate({ prompt })).rejects.toMatchObject({
      code: "not_installed",
    });
    const error = (f: InstanceType<typeof ClientFailure>) => new Error(`host: ${f.code}`);
    await expect(new Broke(meta, "a", { error }).doGenerate({ prompt })).rejects.toThrow(
      "host: signed_out",
    );
  });
});

describe("whether a client is installed", () => {
  const client = (version: () => Promise<string | null>) => ({
    id: "fake",
    passThrough: /^$/,
    keyVars: [],
    auth: async () => "subscription" as const,
    version,
  });

  it("keeps an installed client installed while its version probe runs out of time", async () => {
    const version = vi.fn<() => Promise<string | null>>().mockResolvedValueOnce("2.1.0");
    const fake = client(version);
    vi.useFakeTimers({ toFake: ["Date"] });
    expect(await detectClient(fake, true)).toEqual({ version: "2.1.0", auth: "subscription" });
    // Asked again within the minute: the last look holds.
    expect(await detectClient(fake)).toEqual({ version: "2.1.0", auth: "subscription" });
    expect(version).toHaveBeenCalledTimes(1);

    // Another client is busy: `--version` does not answer in time.
    vi.setSystemTime(Date.now() + 61_000);
    version.mockRejectedValueOnce(new ProbeUndecided("--version did not finish"));
    expect(await detectClient(fake)).toMatchObject({ version: "2.1.0" });

    // Uninstalled: the probe finishes and finds nothing.
    vi.setSystemTime(Date.now() + 61_000);
    version.mockResolvedValueOnce(null);
    expect((await detectClient(fake)).version).toBeNull();
  });

  it("does not take a client that never answered for installed", async () => {
    const fake = { ...client(async () => null), id: "never" };
    fake.version = vi.fn().mockRejectedValueOnce(new ProbeUndecided("--version"));
    expect((await detectClient(fake, true)).version).toBeNull();
  });

  it("says a file that ran out of time was killed, as the probe reads it", async () => {
    await expect(
      run(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { timeout: 100 }),
    ).rejects.toMatchObject({ killed: true, signal: "SIGTERM" });
  });

  it("reads a missing binary as not installed", async () => {
    expect(await probeVersion("/nonexistent/claude", {}, (s) => s.trim())).toBeNull();
  });
});
