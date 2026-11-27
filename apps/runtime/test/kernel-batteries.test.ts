import type { AskRow, Run } from "@engenty/wizards-kernel";
import { kernelShell } from "@engenty/wizards-shared/kernel-file";
import type { RunState } from "@engenty/wizards-shared/run";
import { describe, expect, it, vi } from "vitest";

const worked: { id: string; type: string; note?: unknown; brief?: unknown }[] = [];
vi.mock("../src/engine/steps.js", async (original) => ({
  ...(await original<typeof import("../src/engine/steps.js")>()),
  runAutomaticStep: async (step: { id: string; type: string; note?: unknown; brief?: unknown }) => {
    worked.push({ id: step.id, type: step.type, note: step.note, brief: step.brief });
    return { text: "made", at: new Date().toISOString() };
  },
}));

const { kernelBatteries, motionInputs } = await import("../src/kernel/batteries");

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

  it("is changed by a note beside its brief, as after a review of version 0.2.0", async () => {
    const file = { version: "0.3.0", title: "Film", description: "", start: "film", edges: { film: ["end"] } };
    const states: RunState[] = [];
    const batteries = kernelBatteries(
      { id: "r", wizardId: "w", definition: kernelShell(file as never), files: [], state: {} } as never,
      { id: "s" } as never,
      new AbortController().signal,
      async (_run, _space, state) => {
        states.push(state);
        return { state } as never;
      },
    );
    const film = (note?: string) =>
      ({ n: 3, step: "film", type: "motion-graphics", brief: "A film about phishing.", inputs: {}, ...(note ? { note } : {}) }) as unknown as AskRow;

    worked.length = 0;
    await batteries["motion-graphics"](film(), run);
    await batteries["motion-graphics"](film("  Slower, please.  "), run);
    // The first film has nothing to change; the second gets the note where the film step reads it.
    expect(states[0].notes).toEqual({});
    expect(states[1].notes).toEqual({ film: "Slower, please." });
    // The brief is the same both times, and the note is no part of the step.
    expect(worked.map((w) => w.brief)).toEqual(["A film about phishing.", "A film about phishing."]);
    expect(worked.map((w) => w.note)).toEqual([undefined, undefined]);
  });
});
