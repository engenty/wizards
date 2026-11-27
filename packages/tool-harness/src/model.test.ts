import { describe, expect, it } from "vitest";
import { throughHarness } from "./model.js";

const parts = [
  { type: "tool-input-start", toolName: "schedule_set" },
  { type: "tool-call", toolName: "schedule_set", input: '{"when":"fri"}' },
  { type: "tool-call", toolName: "ask", input: "{}" },
  { type: "text-delta", delta: "hi" },
];
class Model {
  private readonly made = parts;
  readonly modelId = "m";
  async doGenerate() {
    return { content: this.made };
  }
  async doStream() {
    const made = this.made;
    return {
      stream: new ReadableStream({
        start(controller) {
          for (const part of made) {
            controller.enqueue(part);
          }
          controller.close();
        },
      }),
    };
  }
}
const model = throughHarness(new Model()) as unknown as {
  modelId: string;
  doGenerate(o: object): Promise<{ content: unknown[] }>;
  doStream(o: object): Promise<{ stream: ReadableStream }>;
};
const tools = [{ name: "ask" }, { name: "tool_call" }];

describe("a model through the harness", () => {
  it("has its direct call of a hidden tool run as tool_call, and others untouched", async () => {
    const through = [
      { type: "tool-input-start", toolName: "tool_call" },
      {
        type: "tool-call",
        toolName: "tool_call",
        input: '{"name":"schedule_set","input":{"when":"fri"}}',
      },
      parts[2],
      parts[3],
    ];
    expect((await model.doGenerate({ tools })).content).toEqual(through);
    const streamed: unknown[] = [];
    for await (const part of (await model.doStream({ tools })).stream) {
      streamed.push(part);
    }
    expect(streamed).toEqual(through);
    expect(model.modelId).toBe("m");
  });

  it("leaves everything where there is no harness", async () => {
    expect((await model.doGenerate({ tools: [{ name: "ask" }] })).content).toEqual(parts);
    expect((await model.doGenerate({})).content).toEqual(parts);
  });
});
