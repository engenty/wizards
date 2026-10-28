import { toAISdkMessages } from "@mastra/ai-sdk/ui";
import { describe, expect, it } from "vitest";
import { ClientSteps, stepChunk, stepParts } from "../src/services/client-steps";

// A client as the model runs the space's tools itself: the wrapped tools record each call, which
// becomes the stream's tool chunks and, stored, the chat's tool parts.

const tool = (execute: (input: unknown) => Promise<unknown>) => ({ id: "t", description: "", execute });

describe("a client's tool steps", () => {
  it("records a call and its result, as the stream's chunks", async () => {
    const steps = new ClientSteps();
    const told: Record<string, unknown>[] = [];
    steps.on((step) => told.push(stepChunk(step)));
    const tools = steps.wrap({
      search_space: tool(async () => ({ hits: 2 })),
      web_search: { type: "provider-defined" },
    }) as Record<string, { execute?: (input: unknown) => Promise<unknown> }>;
    expect(tools.web_search).toEqual({ type: "provider-defined" });
    expect(await tools.search_space.execute?.({ query: "Maier" })).toEqual({ hits: 2 });
    expect(told).toEqual([
      expect.objectContaining({ type: "tool-input-available", toolName: "search_space", input: { query: "Maier" } }),
      expect.objectContaining({ type: "tool-output-available", output: { hits: 2 } }),
    ]);
  });

  it("records a failed call, and the error still reaches the client", async () => {
    const steps = new ClientSteps();
    const tools = steps.wrap({
      search_space: tool(async () => {
        throw new Error("Index not ready");
      }),
    }) as Record<string, { execute: (input: unknown) => Promise<unknown> }>;
    await expect(tools.search_space.execute({})).rejects.toThrow("Index not ready");
    expect(stepChunk(steps.list[0])).toMatchObject({ type: "tool-output-error", errorText: "Index not ready" });
  });

  it("stores the steps so that the chat shows them as tool parts", async () => {
    const steps = new ClientSteps();
    const tools = steps.wrap({ search_space: tool(async () => ({ hits: [] })) }) as Record<
      string,
      { execute: (input: unknown) => Promise<unknown> }
    >;
    await tools.search_space.execute({ query: "Frist" });
    const [converted] = toAISdkMessages(
      [
        {
          id: "m1",
          role: "assistant",
          createdAt: new Date(),
          content: { format: 2, parts: stepParts(steps.list) },
        },
      ] as never,
      { version: "v7" } as never,
    ) as { parts: { type: string; state?: string }[] }[];
    expect(converted.parts).toEqual([
      expect.objectContaining({ type: "tool-search_space", state: "output-available" }),
    ]);
  });
});
