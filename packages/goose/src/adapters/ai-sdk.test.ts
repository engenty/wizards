import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createGoose, type GooseEvent } from "../goose.js";
import { defineTool } from "../tool.js";
import { chatOfAiSdk } from "./ai-sdk.js";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

type StreamPart =
  Awaited<ReturnType<MockLanguageModelV4["doStream"]>>["stream"] extends ReadableStream<infer P>
    ? P
    : never;

/** A model that first calls read_file, then answers. */
function model() {
  const streams: StreamPart[][] = [
    [
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "read_file",
        input: JSON.stringify({ path: "a.md" }),
      },
      {
        type: "finish",
        usage,
        finishReason: { unified: "tool-calls", raw: "tool_use" },
      },
    ],
    [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "It holds " },
      { type: "text-delta", id: "t", delta: "a heading." },
      { type: "text-end", id: "t" },
      {
        type: "finish",
        usage,
        finishReason: { unified: "stop", raw: "end_turn" },
      },
    ],
  ];
  return new MockLanguageModelV4({
    doStream: streams.map((parts) => ({
      stream: convertArrayToReadableStream(parts),
    })),
  });
}

describe("chatOfAiSdk", () => {
  it("runs Goose's steps on an AI SDK model", async () => {
    const m = model();
    const goose = createGoose({
      chat: chatOfAiSdk(m),
      system: "You are a test.",
      tools: [
        defineTool({
          name: "read_file",
          description: "Read a file.",
          input: z.object({ path: z.string() }),
          run: ({ path }) => Promise.resolve(`# ${path}`),
        }),
      ],
    });
    const events: GooseEvent[] = [];
    await goose.turn(
      { message: "What is in a.md?" },
      { person: { name: "Ada" }, emit: (e) => void events.push(e) },
    );

    expect(events.map((e) => e.event)).toEqual(["step", "step", "text", "text", "done"]);
    expect(
      events
        .filter((e) => e.event === "text")
        .map((e) => e.data.delta)
        .join(""),
    ).toBe("It holds a heading.");
    // The second call carries the tool call and its result.
    const second = m.doStreamCalls[1]?.prompt ?? [];
    expect(second.map((p) => p.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(second.at(-1)?.content).toEqual([
      expect.objectContaining({
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "read_file",
        output: { type: "text", value: "# a.md" },
      }),
    ]);
    expect(m.doStreamCalls[0]?.tools?.[0]).toMatchObject({
      type: "function",
      name: "read_file",
    });
  });
});
