import type { AskRow, Run } from "@engenty/wizards-kernel";
import { describe, expect, it } from "vitest";
import { motionInputs } from "../src/kernel/batteries";

const run = {
  id: "r",
  wizard: "w",
  input: { photos: ["asset-1", "asset-2"], topic: "Phishing" },
  startedAt: Date.parse("2026-11-16T10:00:00Z"),
  status: "running",
  cursor: "film",
  open: 3,
  rows: [
    { n: 0, step: "script", left: true, value: "Erst nachfragen, dann klicken.", to: "voice" },
    {
      n: 1,
      step: "voice",
      left: true,
      value: { text: "voice", assets: [{ id: "asset-v", kind: "audio" }] },
      to: "film",
    },
  ],
  rev: 0,
} as unknown as Run;

describe("a film of a run in version 0.3.0", () => {
  it("finds what the step passes, by name or as a value, in the state", () => {
    const state = { values: {}, outputs: {}, history: [], notes: {} };
    const row = {
      n: 3,
      step: "film",
      type: "motion-graphics",
      inputs: {
        voice: "steps.voice",
        photos: "photos",
        script: "steps.script",
        facts: { points: ["one", "two"] },
      },
    } as unknown as AskRow;
    const refs = motionInputs(row, run, state);
    expect(refs).toEqual({
      voice: "steps.arg__voice",
      photos: "arg__photos",
      script: "arg__script",
      facts: "steps.arg__facts",
    });
    expect(state.values).toEqual({
      arg__photos: ["asset-1", "asset-2"],
      arg__script: "Erst nachfragen, dann klicken.",
    });
    expect(state.outputs).toMatchObject({
      arg__voice: { text: "voice", assets: [{ id: "asset-v" }] },
      arg__facts: { json: { points: ["one", "two"] } },
    });
  });
});
