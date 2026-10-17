import type { AgentStep } from "@engenty-wizards/shared/definition";
import { describe, expect, it } from "vitest";
import { outputSchema, ownJson } from "../src/engine/steps.js";

const step = {
  id: "search",
  title: "Suchen",
  type: "agent",
  instructions: "",
  tools: [],
  output: {
    format: "json",
    fields: [
      { id: "summary", kind: "text" },
      { id: "items", kind: "table", columns: ["rank", "title", "photos"] },
    ],
  },
} as unknown as AgentStep;

describe("an agent step's own JSON", () => {
  const { schema, shape } = outputSchema(step);

  it("is taken from its last fenced block, a list in a cell joined, a missing column empty", () => {
    const text = [
      "Ich habe zwei gefunden.",
      "```json",
      '{"summary": "erst", "items": []}',
      "```",
      "Korrigiert:",
      "```json",
      JSON.stringify({
        summary: "Zwei Konsolen",
        items: [
          { rank: 1, title: "Switch", photos: ["https://a/1.webp", "https://a/2.webp"] },
          { rank: 2, title: "Lite" },
        ],
      }),
      "```",
    ].join("\n");
    expect(ownJson(text, schema, shape)).toEqual({
      summary: "Zwei Konsolen",
      items: [
        { rank: 1, title: "Switch", photos: "https://a/1.webp https://a/2.webp" },
        { rank: 2, title: "Lite", photos: null },
      ],
    });
  });

  it("is null where nothing fits, so a model structures the text", () => {
    expect(ownJson("Nichts gefunden.", schema, shape)).toBeNull();
    expect(ownJson('```json\n{"items": []}\n```', schema, shape)).toBeNull();
  });
});
