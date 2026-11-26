import type { KernelFile } from "@engenty/wizards-shared/definition";
import { describe, expect, it } from "vitest";
import { kernelFlow, stepWays, typedOver } from "./kernel-flow";

const file = (edges: Record<string, string[]>, start: string, limits?: Record<string, number>) =>
  ({
    version: "0.3.0",
    title: "T",
    description: "",
    avatar: "round",
    start,
    edges,
    limits,
  }) as KernelFile;

describe("the map of a wizard in version 0.3.0", () => {
  it("puts the steps in one column along a path of the map, the other ways beside it", () => {
    const flow = kernelFlow(
      file(
        {
          offer: ["check", "legal", "offer"],
          legal: ["check", "offer"],
          check: ["accept", "offer"],
          accept: ["signed", "end"],
          signed: ["end", "chase"],
          chase: ["end"],
        },
        "offer",
        { legal: 3 },
      ),
    );
    expect(flow.map((s) => s.id)).toEqual(["offer", "legal", "check", "accept", "signed", "chase"]);
    expect(flow.every((s, i) => s.flowsOn === i < flow.length - 1)).toBe(true);
    expect(flow[0].branches.map((b) => b.to)).toEqual(["check", "offer"]);
    expect(flow[1]).toMatchObject({ limit: 3, branches: [{ to: "offer" }] });
    expect(flow[5].branches.map((b) => b.to)).toEqual(["end"]);
  });

  it("joins no line where the step below is not a way, and keeps a step no way leads to", () => {
    const flow = kernelFlow(file({ a: ["end"], lost: ["a"] }, "a"));
    expect(flow.map((s) => [s.id, s.flowsOn])).toEqual([
      ["a", false],
      ["lost", false],
    ]);
  });

  it("draws a line of forms as a line", () => {
    const flow = kernelFlow(file({ a: ["b"], b: ["c"], c: ["end"] }, "a"));
    expect(flow.map((s) => [s.id, s.flowsOn, s.branches.length])).toEqual([
      ["a", true, 0],
      ["b", true, 0],
      ["c", false, 1],
    ]);
  });
});

describe("what a person types over in a step's panel", () => {
  it("is a page's short texts and a step's Auftrag", () => {
    for (const path of [
      "title",
      "description",
      "working",
      "fields.0.label",
      "fields.2.placeholder",
      "fields.1.options.0",
    ]) {
      expect(typedOver(path), path).toBe(true);
    }
    // What an agent is told, a document is made from, a film is briefed with.
    for (const path of ["instructions", "prompt", "brief"]) {
      expect(typedOver(path), path).toBe(true);
    }
  });

  it("is no setting: those are changed with the assistant or in the code", () => {
    for (const path of [
      "model",
      "type",
      "tools.0",
      "signal",
      "key",
      "fields.0.id",
      "fields.0.kind",
      "data.total",
    ]) {
      expect(typedOver(path), path).toBe(false);
    }
  });
});

describe("the ways of a step in its panel", () => {
  it("lists the file's ways where the code is not read", () => {
    expect(stepWays([], ["b", "end"])).toEqual([{ to: "b" }, { to: "end" }]);
  });

  it("takes the file's first way for a return that names none", () => {
    expect(stepWays([{}], ["b"])).toEqual([{ to: "b" }]);
  });

  it("marks a way of the file the code names nowhere", () => {
    expect(stepWays([{ to: "b", when: "ok" }], ["b", "c"])).toEqual([
      { to: "b", when: "ok" },
      { to: "c", unnamed: true },
    ]);
  });

  it("marks a way the code takes and the file does not have", () => {
    expect(stepWays([{ to: "x" }, { to: "b" }], ["b"])).toEqual([
      { to: "x", missing: true },
      { to: "b" },
    ]);
  });

  it("does not judge the file's ways where the code works one out", () => {
    expect(stepWays([{ code: "next(run)" }], ["b", "c"])).toEqual([
      { code: "next(run)", to: "b" },
      { to: "b" },
      { to: "c" },
    ]);
  });
});
