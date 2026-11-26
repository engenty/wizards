import type { KernelFile } from "@engenty/wizards-shared/kernel-file";
import { withLimit, withoutStep, withWays } from "@engenty/wizards-shared/kernel-file";
import { describe, expect, it } from "vitest";

const file = (over: Partial<KernelFile>): KernelFile =>
  ({ version: "0.3.0", title: "T", start: "a", edges: {}, ...over }) as KernelFile;

describe("withoutStep", () => {
  it("leads a way to the removed step where that step led", () => {
    const next = withoutStep(
      file({ edges: { a: ["b"], b: ["c"], c: ["end"] }, limits: { b: 3, c: 2 } }),
      "b",
    );
    expect(next.edges).toEqual({ a: ["c"], c: ["end"] });
    expect(next.limits).toEqual({ c: 2 });
    expect(next.start).toBe("a");
  });

  it("starts where the removed first step led", () => {
    const next = withoutStep(file({ edges: { a: ["b", "end"], b: ["end"] } }), "a");
    expect(next.start).toBe("b");
    expect(next.edges).toEqual({ b: ["end"] });
  });

  it("ends the run where the removed step was the only way and led nowhere", () => {
    const next = withoutStep(file({ edges: { a: ["b"] } }), "b");
    expect(next.edges).toEqual({ a: ["end"] });
  });

  it("leaves a file that does not name the step as it is", () => {
    const given = file({ edges: { a: ["end"] } });
    expect(withoutStep(given, "x")).toBe(given);
  });
});

describe("withWays", () => {
  const given = file({ edges: { a: ["b", "end"], b: ["end"] } });

  it("writes a step's ways in the order given, none twice", () => {
    expect(withWays(given, "a", ["end", "b", "end"]).edges).toEqual({
      a: ["end", "b"],
      b: ["end"],
    });
  });

  it("ends the run where no way is left", () => {
    expect(withWays(given, "a", []).edges.a).toEqual(["end"]);
  });

  it("ends the run after a step a way now leads to that had no ways", () => {
    expect(withWays(given, "a", ["b", "c"]).edges).toEqual({
      a: ["b", "c"],
      b: ["end"],
      c: ["end"],
    });
  });

  it("leaves the file it was given as it is", () => {
    withWays(given, "a", ["b"]);
    expect(given.edges.a).toEqual(["b", "end"]);
  });
});

describe("withLimit", () => {
  it("sets a step's limit within what the file allows", () => {
    expect(withLimit(file({}), "a", 3).limits).toEqual({ a: 3 });
    expect(withLimit(file({ limits: { b: 2 } }), "a", 5000).limits).toEqual({ b: 2, a: 1000 });
  });

  it("takes the limit away, and the entry with the last of them", () => {
    expect(withLimit(file({ limits: { a: 3, b: 2 } }), "a", undefined).limits).toEqual({ b: 2 });
    expect("limits" in withLimit(file({ limits: { a: 3 } }), "a", undefined)).toBe(false);
  });
});
