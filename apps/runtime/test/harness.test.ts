import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "wizards-harness-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";

describe("an installed AI client as a model", () => {
  it("renders one user message as the prompt and system messages as the system prompt", async () => {
    const { renderPrompt } = await import("../src/harness/prompt");
    const r = renderPrompt([
      { role: "system", content: "Be brief." },
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ]);
    expect(r.system).toBe("Be brief.");
    expect(r.prompt).toBe("Hello");
    expect(r.warnings).toEqual([]);
  });

  it("writes a thread out with its speakers and asks for the last answer", async () => {
    const { renderPrompt } = await import("../src/harness/prompt");
    const r = renderPrompt([
      { role: "user", content: [{ type: "text", text: "Hi" }] },
      { role: "assistant", content: [{ type: "text", text: "Hello!" }] },
      { role: "user", content: [{ type: "text", text: "Again?" }] },
    ]);
    expect(r.prompt).toBe("User:\nHi\n\nAssistant:\nHello!\n\nUser:\nAgain?");
    expect(r.system).toContain("Answer the last message as the assistant");
  });

  it("parses JSON answers with fences or prose around them", async () => {
    const { parseJsonAnswer } = await import("../src/harness/prompt");
    expect(parseJsonAnswer('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonAnswer('Here you go: {"a":[1,2]} — done.')).toEqual({ a: [1, 2] });
    expect(() => parseJsonAnswer("no json here")).toThrow();
  });

  it("gives the client the shell's sign-in and PATH, nothing of this process", async () => {
    const { pickEnv, stripKeys } = await import("../src/harness/env");
    const picked = pickEnv(
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
    expect(pickEnv({}, { ANTHROPIC_API_KEY: "sk-own", PATH: "/bin" }, /^ANTHROPIC_/).ANTHROPIC_API_KEY).toBe(
      "sk-own",
    );
    expect(stripKeys(picked, ["ANTHROPIC_API_KEY"]).ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("puts the subscription first: a shell key is held back while the client is signed in without it", async () => {
    const { resolveEnv } = await import("../src/harness/env");
    const seen: NodeJS.ProcessEnv[] = [];
    const resolved = await resolveEnv({
      id: "codex",
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

  it("reads what Claude Code prints: text or structured output, and the usage", async () => {
    const { claudeAnswer } = await import("../src/harness/claude");
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

  it("reads what Codex prints: the last agent message, the usage, a failure", async () => {
    const { codexAnswer } = await import("../src/harness/codex");
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

  it("reads the result Antigravity prints after its step events", async () => {
    const { antigravityAnswer } = await import("../src/harness/antigravity");
    const r = antigravityAnswer(
      [
        '{"event":"init","conversation_id":"a1","init":{"tools":[]}}',
        '{"event":"step_update","step_update":{"conversation_id":"a1","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"OK"}}',
        '{"event":"result","result":{"conversation_id":"a1","status":"SUCCESS","response":"OK\\n","structured_output":{"a":1},"usage":{"input_tokens":20,"output_tokens":2}}}',
      ].join("\n"),
    );
    expect(r?.status).toBe("SUCCESS");
    expect(r?.structured_output).toEqual({ a: 1 });
    expect(r?.usage?.input_tokens).toBe(20);
    expect(antigravityAnswer("Authentication required.")).toBeNull();
  });

  it("puts the instructions in front of the one message Antigravity reads", async () => {
    const { antigravityMessage, withEffort } = await import("../src/harness/antigravity");
    const line = antigravityMessage("Be brief.", "Hi");
    expect(JSON.parse(line)).toEqual({
      event: "user",
      message: { content: "<instructions>\nBe brief.\n</instructions>\n\nHi" },
    });
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(antigravityMessage("", "Hi")).message.content).toBe("Hi");
    expect(withEffort("gemini-3.8-flash-medium", "high")).toBe("gemini-3.8-flash-high");
    expect(withEffort("gemini-3.8-flash-medium")).toBe("gemini-3.8-flash-medium");
    expect(withEffort("some-model", "low")).toBe("some-model");
  });

  it("tells a signed-out client from one whose account cannot pay", async () => {
    const { failureOf } = await import("../src/harness/model");
    const { ModelUnavailableError } = await import("../src/model-errors");
    const h = { id: "codex" as const, name: "Codex", install: "npm i -g @openai/codex" };
    expect(failureOf(h, "Not logged in")).toBeInstanceOf(ModelUnavailableError);
    expect(failureOf(h, "Not logged in").message).toContain("isn’t signed in");
    expect(failureOf(h, "usage limit reached").message).toContain("no credit or quota left");
    const { errorText } = await import("../src/model-errors");
    expect(errorText(failureOf(h, "Not logged in"), "de")).toContain("nicht angemeldet");
    expect(failureOf(h, "boom")).not.toBeInstanceOf(ModelUnavailableError);
  });

  it("opens the MCP bridge only for a call with tools the client runs", async () => {
    const { HarnessModel } = await import("../src/harness/model");
    const seen: (string | null)[] = [];
    class Probe extends HarnessModel {
      readonly provider = "probe";
      protected async invoke(call: { bridgeUrl: string | null }) {
        seen.push(call.bridgeUrl);
        return { text: "ok" };
      }
    }
    const model = new Probe({ id: "probe", name: "Probe" }, "default");
    model.attach({ add: { id: "add", execute: async () => 3 } });
    const prompt = [{ role: "user" as const, content: [{ type: "text" as const, text: "Hi" }] }];
    const tool = (name: string) => ({
      type: "function" as const,
      name,
      inputSchema: { type: "object" as const, properties: {} },
    });
    await model.doGenerate({ prompt });
    await model.doGenerate({ prompt, tools: [] });
    // The client searches with its own tool: naming it needs no bridge either.
    await model.doGenerate({ prompt, tools: [tool("web_search")] });
    await model.doGenerate({ prompt, tools: [tool("add")] });
    expect(seen.slice(0, 3)).toEqual([null, null, null]);
    expect(seen[3]).toMatch(/^http/);
  });

  it("leaves the store's tools out of a step that has no use for them", async () => {
    const { storeIdle } = await import("../src/tools/index");
    expect(storeIdle({ tools: [] }, 0, 0)).toBe(true);
    expect(storeIdle({ tools: [], connections: [] }, 0, 0)).toBe(true);
    // Tools of its own, the wizard's lists, uploads or a connection: the store's tools stay.
    expect(storeIdle({ tools: ["web_search"] }, 0, 0)).toBe(false);
    expect(storeIdle({ tools: [] }, 1, 0)).toBe(false);
    expect(storeIdle({ tools: [] }, 0, 1)).toBe(false);
    expect(storeIdle({ tools: [], connections: ["mail"] }, 0, 0)).toBe(false);
  });

  it("serves a call's tools to the client over MCP and closes them with the call", async () => {
    const { openBridge, bridgeRequest } = await import("../src/mcp/bridge");
    const bridge = openBridge([
      {
        name: "add",
        description: "Adds two numbers.",
        inputSchema: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
          required: ["a", "b"],
        },
        execute: async (input) => {
          const { a, b } = input as { a: number; b: number };
          return { sum: a + b };
        },
      },
    ]);
    const token = bridge.url.split("/").pop()!;
    // No server listens in this test: the transport's fetch goes straight to the handler.
    const transport = new StreamableHTTPClientTransport(new URL(bridge.url), {
      fetch: (input, init) => bridgeRequest(token, new Request(input, init)),
    });
    const client = new Client({ name: "test", version: "0" });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(["add"]);
    const result = await client.callTool({ name: "add", arguments: { a: 2, b: 3 } });
    expect(JSON.parse((result.content as { text: string }[])[0].text)).toEqual({ sum: 5 });
    await client.close();
    bridge.close();
    const gone = await bridgeRequest(token, new Request(bridge.url, { method: "POST" }));
    expect(gone.status).toBe(404);
  });

  it("runs a bridged tool in the context of the call that opened the bridge", async () => {
    const { AsyncLocalStorage } = await import("node:async_hooks");
    const { openBridge, bridgeRequest } = await import("../src/mcp/bridge");
    const tenant = new AsyncLocalStorage<string>();
    const bridge = tenant.run("acme", () =>
      openBridge([
        {
          name: "whoami",
          inputSchema: { type: "object", properties: {} },
          execute: async () => ({ tenant: tenant.getStore() ?? null }),
        },
      ]),
    );
    const token = bridge.url.split("/").pop()!;
    // The client's request comes from outside that context.
    const transport = new StreamableHTTPClientTransport(new URL(bridge.url), {
      fetch: (input, init) => bridgeRequest(token, new Request(input, init)),
    });
    const client = new Client({ name: "test", version: "0" });
    await client.connect(transport);
    const result = await client.callTool({ name: "whoami", arguments: {} });
    expect(JSON.parse((result.content as { text: string }[])[0].text)).toEqual({ tenant: "acme" });
    await client.close();
    bridge.close();
  });
});
