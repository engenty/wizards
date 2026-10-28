import { createTool } from "@mastra/core/tools";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { cacheMarks, sortedTools, spaceAgent } from "../src/agents/space-agent";

const usage = { inputTokens: { total: 50, noCache: 50 }, outputTokens: { total: 5, text: 5 } };
const say = (text: string) => [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: text },
  { type: "text-end", id: "t" },
  { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
];
const callTool = (name: string) => [
  { type: "stream-start", warnings: [] },
  { type: "tool-call", toolCallId: `c-${name}`, toolName: name, input: "{}" },
  { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
];
const mark = { anthropic: { cacheControl: { type: "ephemeral" } } };
const isMarked = (m: { providerOptions?: unknown }) =>
  JSON.stringify(m.providerOptions ?? {}).includes("ephemeral");

describe("the space agent", () => {
  it("orders tools by name", () => {
    expect(Object.keys(sortedTools({ zeta: 1, alpha: 2, mid: 3 }))).toEqual(["alpha", "mid", "zeta"]);
  });

  it("marks the end of what the chat said, never the person's new message", () => {
    const prompt = [
      { role: "system" },
      { role: "user" },
      { role: "assistant" },
      { role: "user" },
    ];
    expect(cacheMarks(prompt).map(isMarked)).toEqual([false, false, true, false]);
    // The first message of a chat has nothing before it to mark.
    expect(cacheMarks([{ role: "system" }, { role: "user" }]).map(isMarked)).toEqual([false, false]);
  });

  it("marks the newest step within a turn, too", () => {
    const prompt = [
      { role: "system" },
      { role: "user" },
      { role: "assistant" },
      { role: "user" },
      { role: "assistant" },
      { role: "tool" },
    ];
    expect(cacheMarks(prompt).map(isMarked)).toEqual([false, false, true, false, false, true]);
  });

  it("keeps what a message's provider options already say", () => {
    const [, kept] = cacheMarks([
      { role: "system" },
      { role: "assistant", providerOptions: { openai: { x: 1 } } },
      { role: "user" },
    ]);
    expect(kept.providerOptions).toEqual({ openai: { x: 1 }, ...mark });
  });

  it("sends sorted tools and the marks to the model", async () => {
    const calls: any[] = [];
    const script = [callTool("beta"), say("Fertig.")];
    const model = new MockLanguageModelV3({
      doStream: async (options: any) => {
        calls.push(options);
        return { stream: convertArrayToReadableStream(script.shift() as never[]) };
      },
    });
    const tool = (id: string) =>
      createTool({ id, description: id, inputSchema: z.object({}), execute: async () => ({ ok: id }) });
    const agent = spaceAgent({
      id: "test",
      name: "Test",
      instructions: "Help.",
      resolved: { model, ref: "test/mock", vendor: "test", gateway: false, metered: false },
      tools: { gamma: tool("gamma"), alpha: tool("alpha"), beta: tool("beta") },
    });
    const stream = await agent.stream(
      [
        { role: "user", content: "Erste Frage" },
        { role: "assistant", content: "Erste Antwort" },
        { role: "user", content: "Seite: …\n\nZweite Frage" },
      ],
      { maxSteps: 3 },
    );
    await stream.text;
    expect(calls).toHaveLength(2);
    expect(calls[0].tools.map((t: { name: string }) => t.name)).toEqual(["alpha", "beta", "gamma"]);
    const [first, second] = calls.map((c) => c.prompt as { role: string }[]);
    expect(isMarked(first[0])).toBe(true);
    expect(first.map(isMarked)).toEqual([true, false, true, false]);
    // After the tool step the newest message, the tool's result, carries a mark as well.
    expect(isMarked(second.at(-1) as never)).toBe(true);
    expect(second[3]).toEqual(first[3]);
  });
});
