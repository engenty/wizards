import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "wizards-harness-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";

describe("an installed AI client as a model", () => {
  it("words a thread for the client from the runtime's prompts", async () => {
    const { renderPrompt } = await import("@engenty/model-sources/clients");
    const { CLIENT_WORDS } = await import("../src/harness/prompt");
    const r = renderPrompt(
      [
      { role: "user", content: [{ type: "text", text: "Hi" }] },
      { role: "assistant", content: [{ type: "text", text: "Hello!" }] },
      { role: "user", content: [{ type: "text", text: "Again?" }] },
      ],
      undefined,
      CLIENT_WORDS,
    );
    expect(r.prompt).toBe("User:\nHi\n\nAssistant:\nHello!\n\nUser:\nAgain?");
    expect(r.system).toContain("Answer the last message as the assistant");
  });

  it("reads the result Antigravity prints after its step events", async () => {
    const { antigravityAnswer } = await import("@engenty/model-sources/clients");
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
    const { antigravityMessage, withEffort } = await import("@engenty/model-sources/clients");
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
    const h = { id: "codex", name: "Codex" };
    expect(failureOf(h, "Not logged in")).toBeInstanceOf(ModelUnavailableError);
    expect(failureOf(h, "Not logged in").message).toContain("isn’t signed in");
    expect(failureOf(h, "usage limit reached").message).toContain("no credit or quota left");
    const { errorText } = await import("../src/model-errors");
    expect(errorText(failureOf(h, "Not logged in"), "de")).toContain("nicht angemeldet");
    expect(failureOf(h, "boom")).not.toBeInstanceOf(ModelUnavailableError);
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

  it("serves a call's tools on the runtime's bridge route and closes them with the call", async () => {
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
});
