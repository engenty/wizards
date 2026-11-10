import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGateway } from "@ai-sdk/gateway";
import { createOpenAI } from "@ai-sdk/openai";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { generateText, Output, jsonSchema, RetryError } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { classifyFailure } from "../src/engine/failures.js";
import { StepError } from "@engenty/wizards-engine/types";
import { SignInNeeded } from "../src/engine/types.js";
import { ModelUnavailableError, NotedError } from "../src/model-errors.js";
import { ContentBlockedError } from "../src/safety.js";
import { watchActions } from "../src/tools/acted.js";

// Against a real server, through the real SDK and providers: what lands in the runner is what they
// throw, and the gateway's shape is what the Manage-App's `refuse` answers.
const json = { "content-type": "application/json" };
const gatewayError = (type: string, message: string) => ({ error: { message, type } });

type Reply = { status: number; headers?: Record<string, string>; body: unknown };
let reply: Reply = { status: 500, body: {} };
let server: Server;
let url: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    res.writeHead(reply.status, { ...json, ...reply.headers });
    res.end(JSON.stringify(reply.body));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const models = () => ({
  gateway: createGateway({ apiKey: "k", baseURL: url })("openai/gpt-5"),
  openai: createOpenAI({ apiKey: "k", baseURL: url })("gpt-5"),
  anthropic: createAnthropic({ apiKey: "k", baseURL: url })("claude-x"),
});
type Provider = keyof ReturnType<typeof models>;
const ALL: Provider[] = ["gateway", "openai", "anthropic"];

async function thrownBy(provider: Provider, r: Reply, maxRetries = 0) {
  reply = r;
  try {
    await generateText({ model: models()[provider], prompt: "x", maxRetries });
  } catch (err) {
    return err;
  }
  throw new Error("It did not fail.");
}
const cloud = { managed: true };
const alone = { managed: false };

describe("a provider's short trouble is retried", () => {
  it.each(ALL)("%s: 429, with its Retry-After from the inner error", async (p) => {
    const f = classifyFailure(
      await thrownBy(p, {
        status: 429,
        headers: { "retry-after": "120" },
        body: gatewayError("rate_limit_exceeded", "Rate limit"),
      }),
      cloud,
    );
    expect(f).toEqual({ class: "retry", retryAfterMs: 120_000, why: "rate_limit" });
  });

  it.each(ALL)("%s: 429 as a date", async (p) => {
    const at = new Date(Date.now() + 600_000).toUTCString();
    const f = classifyFailure(
      await thrownBy(p, {
        status: 429,
        headers: { "retry-after": at },
        body: gatewayError("rate_limit_exceeded", "Rate limit"),
      }),
      cloud,
    );
    expect(f.class).toBe("retry");
    expect(f.retryAfterMs).toBeGreaterThan(590_000);
    expect(f.retryAfterMs).toBeLessThanOrEqual(600_000);
  });

  it.each(ALL)("%s: an unreadable Retry-After is none", async (p) => {
    const f = classifyFailure(
      await thrownBy(p, {
        status: 429,
        headers: { "retry-after": "soon" },
        body: gatewayError("rate_limit_exceeded", "Rate limit"),
      }),
      cloud,
    );
    expect(f).toMatchObject({ class: "retry", retryAfterMs: null });
  });

  it.each(
    ALL.flatMap((p) =>
      [500, 502, 503, 504, 529].map((status) => [p, status] as [Provider, number]),
    ),
  )("%s: %i", async (p, status) => {
    const f = classifyFailure(
      await thrownBy(p, { status, body: gatewayError("internal_server_error", "boom") }),
      cloud,
    );
    expect(f).toMatchObject({ class: "retry", why: "server" });
  });

  it("the Manage-App's masking down is a 503", async () => {
    const f = classifyFailure(
      await thrownBy("gateway", {
        status: 503,
        body: gatewayError("masking_unavailable", "The detector doesn't answer."),
      }),
      cloud,
    );
    expect(f.class).toBe("retry");
  });

  it("the SDK's own retries used up: its last error counts", async () => {
    const err = await thrownBy(
      "openai",
      { status: 503, body: gatewayError("internal_server_error", "boom") },
      1,
    );
    expect(RetryError.isInstance(err)).toBe(true);
    expect(classifyFailure(err, cloud)).toMatchObject({ class: "retry", why: "server" });
  });

  it("a server that is gone: directly, and through the gateway's status 500", async () => {
    const closed = createServer();
    await new Promise<void>((ok) => closed.listen(0, "127.0.0.1", ok));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((ok) => closed.close(() => ok()));
    const base = `http://127.0.0.1:${port}/v1`;
    for (const model of [
      createOpenAI({ apiKey: "k", baseURL: base })("gpt-5"),
      createGateway({ apiKey: "k", baseURL: base })("x/y"),
    ]) {
      const err = await generateText({ model, prompt: "x", maxRetries: 0 }).catch((e) => e);
      expect(classifyFailure(err, cloud)).toMatchObject({ class: "retry", why: "network" });
    }
  });

  it("a provider that doesn't answer: directly, and through the gateway's status 500", async () => {
    const silent = createServer(() => undefined);
    await new Promise<void>((ok) => silent.listen(0, "127.0.0.1", ok));
    const base = `http://127.0.0.1:${(silent.address() as AddressInfo).port}/v1`;
    for (const model of [
      createOpenAI({ apiKey: "k", baseURL: base })("gpt-5"),
      createGateway({ apiKey: "k", baseURL: base })("x/y"),
    ]) {
      const err = await generateText({
        model,
        prompt: "x",
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(200),
      }).catch((e) => e);
      expect(classifyFailure(err, cloud)).toMatchObject({ class: "retry", why: "timeout" });
    }
    silent.closeAllConnections();
    silent.close();
  });

  it("through Mastra, as an agent step meets it", async () => {
    reply = { status: 503, body: gatewayError("internal_server_error", "boom") };
    const agent = new Agent({
      id: "a",
      name: "a",
      instructions: "x",
      model: models().openai,
      maxRetries: 0,
    });
    const err = await agent.generate("x").catch((e) => e);
    expect(classifyFailure(err, cloud)).toMatchObject({ class: "retry", why: "server" });
    const stream = await agent.stream("x");
    let thrown: unknown;
    for await (const chunk of stream.fullStream as AsyncIterable<{
      type: string;
      payload?: { error?: unknown };
    }>) {
      if (chunk.type === "error") {
        thrown = chunk.payload?.error;
      }
    }
    expect(classifyFailure(thrown, cloud)).toMatchObject({ class: "retry", why: "server" });
  });
});

describe("out of credits waits for a person", () => {
  it("the Manage-App's 402, which says neither 402 nor its type in the message", async () => {
    const err = await thrownBy("gateway", {
      status: 402,
      body: gatewayError("insufficient_credits", "This tenant has no credits left."),
    });
    expect((err as Error).message).toBe("This tenant has no credits left.");
    expect(classifyFailure(err, cloud)).toMatchObject({ class: "credits", why: "credits" });
  });

  it("a 429 that means an empty account is no rate limit", async () => {
    for (const p of ALL) {
      const err = await thrownBy(p, {
        status: 429,
        body: {
          error: {
            message: "You exceeded your current quota",
            type: "insufficient_quota",
            code: "insufficient_quota",
          },
        },
      });
      // A runtime alone: its admin tops up. In the cloud it is our account: no use waiting.
      expect(classifyFailure(err, alone)).toMatchObject({
        class: "credits",
        why: "provider_credits",
      });
      expect(classifyFailure(err, cloud)).toMatchObject({
        class: "final",
        why: "provider_credits",
      });
    }
  });

  it("Anthropic's low balance comes as a 400", async () => {
    const err = await thrownBy("anthropic", {
      status: 400,
      body: {
        type: "error",
        error: { type: "invalid_request_error", message: "Your credit balance is too low" },
      },
    });
    expect(classifyFailure(err, alone).class).toBe("credits");
  });

  it("the runtime's own words, and a client's used-up subscription", () => {
    for (const code of [
      "wizardRunOutCredits",
      "guestBudget",
      "clientNoCredit",
      "chatgptAccountCodexSigned",
      "anthropicAccountClaudeCode",
    ]) {
      const err = new ModelUnavailableError({ code } as never);
      expect(classifyFailure(err, cloud).class).toBe("credits");
    }
  });
});

describe("a sign-in that ran out waits for a person", () => {
  it("a fixed step's connection", () => {
    const err = new SignInNeeded("Gmail", { code: "stepCallRefused" } as never);
    expect(classifyFailure(err, cloud).class).toBe("sign_in");
  });

  it("a client or an account on this computer", () => {
    for (const code of ["clientNotSignedIn", "accountNoLongerSigned", "creditsNotSignedIn"]) {
      const err = new ModelUnavailableError({ code } as never);
      expect(classifyFailure(err, cloud).class).toBe("sign_in");
    }
  });
});

describe("what time doesn't change is not retried", () => {
  it.each(
    ALL.flatMap((p) =>
      [400, 401, 403, 404, 409, 422].map((status) => [p, status] as [Provider, number]),
    ),
  )("%s: %i", async (p, status) => {
    const err = await thrownBy(p, { status, body: gatewayError("invalid_request_error", "No") });
    expect(classifyFailure(err, cloud).class).toBe("final");
  });

  it("the gateway's refusals: tier, policy, its free tier, even with a retryable status", async () => {
    for (const type of ["outside_tier", "not_in_policy"]) {
      const err = await thrownBy("gateway", {
        status: 403,
        body: { error: { message: "No", type, class: "high", tier: { id: "t", name: "T" } } },
      });
      expect(classifyFailure(err, cloud).class).toBe("final");
    }
    const free = await thrownBy("gateway", {
      status: 429,
      body: gatewayError("rate_limit_exceeded", "Free tier users do not have access to this model."),
    });
    expect(classifyFailure(free, cloud).class).toBe("final");
  });

  it("a provider's content rule", async () => {
    const err = await thrownBy("openai", {
      status: 400,
      body: {
        error: { message: "Blocked by the content filter", code: "content_policy_violation" },
      },
    });
    expect(classifyFailure(err, cloud).class).toBe("final");
    expect(classifyFailure(new ContentBlockedError("input" as never), cloud).class).toBe("final");
  });

  it("invalid output", async () => {
    const err = await generateText({
      model: new MockLanguageModelV3({
        doGenerate: async () =>
          ({
            content: [{ type: "text", text: "not json" }],
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
              inputTokens: { total: 1 },
              outputTokens: { total: 1 },
            },
            warnings: [],
          }) as never,
      }),
      prompt: "x",
      output: Output.object({ schema: jsonSchema({ type: "object" }) }),
    })
      .then((r) => r.output)
      .catch((e) => e);
    expect((err as Error).name).toBe("AI_NoObjectGeneratedError");
    expect(classifyFailure(err, cloud).class).toBe("final");
  });

  it("a model refusal: an answer without text is the step's own failure", () => {
    const err = new StepError({ code: "stepNotReturnResult" } as never);
    expect(classifyFailure(err, cloud).class).toBe("final");
  });

  it("a failure the runtime words itself, even when it carries a provider's word", () => {
    expect(classifyFailure(new NotedError("Rate limit 429 at 503"), cloud).class).toBe("final");
    expect(classifyFailure(new StepError("fetch failed"), cloud).class).toBe("final");
  });

  it("an unclear error: this rule is the one to keep", () => {
    for (const err of [
      new Error("Something went wrong"),
      // Only a status or a code counts: a word in a message is no proof.
      new Error("Order 429 could not be read"),
      new Error("HTTP 503"),
      new Error("Claude Code: overloaded"),
      Object.assign(new Error("Page timed out"), { name: "TimeoutError" }),
      Object.assign(new Error("stopped"), { name: "AbortError" }),
      "a string",
      null,
      undefined,
      { statusCode: "503" },
    ]) {
      expect(classifyFailure(err, cloud), String(err)).toMatchObject({ class: "final" });
    }
  });
});

describe("Retry-After on a 503, and a cause that goes round", () => {
  it("a 503 may say it too, in milliseconds", async () => {
    const err = await thrownBy("openai", {
      status: 503,
      headers: { "retry-after-ms": "90000" },
      body: gatewayError("internal_server_error", "busy"),
    });
    expect(classifyFailure(err, cloud).retryAfterMs).toBe(90_000);
  });

  it("does not loop on itself", () => {
    const err = new Error("x") as Error & { cause?: unknown };
    err.cause = err;
    expect(classifyFailure(err, cloud).class).toBe("final");
  });
});

describe("what a try of a step did, as Mastra runs its tools", () => {
  const tool = (id: string, ran: string[]) =>
    createTool({
      id,
      description: id,
      inputSchema: z.object({}),
      execute: async () => {
        ran.push(id);
        return { ok: true };
      },
    });
  const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } };
  /** Calls the tool, and fails on the model call after it. */
  const failsAfter = (name: string) => {
    let calls = 0;
    return new MockLanguageModelV3({
      doGenerate: async () => {
        calls++;
        if (calls > 1) {
          throw new Error("503");
        }
        return {
          content: [{ type: "tool-call", toolCallId: "c1", toolName: name, input: "{}" }],
          finishReason: { unified: "tool-calls", raw: "tool_calls" },
          usage,
          warnings: [],
        } as never;
      },
    });
  };

  it.each([
    // Not known to only read, so it acted, whatever it is.
    ["some_plugin_tool", true],
    ["http_request", true],
    ["run_command", true],
    ["web_fetch", false],
    ["read_document", false],
  ])("%s: acted %s", async (name, acted) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ran: string[] = [];
    const tools = { [name]: tool(name, ran) };
    const resources = { acted: false };
    watchActions(tools, resources);
    const agent = new Agent({
      id: "a",
      name: "a",
      instructions: "x",
      model: failsAfter(name),
      tools,
      maxRetries: 0,
    });
    await agent.generate("x", { maxSteps: 3 }).catch(() => undefined);
    expect(ran).toEqual([name]);
    expect(resources.acted).toBe(acted);
    vi.restoreAllMocks();
  });
});
