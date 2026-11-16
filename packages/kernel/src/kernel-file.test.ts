import type { KernelFile } from "@engenty/wizards-shared/kernel-file";
import { withoutStep } from "@engenty/wizards-shared/kernel-file";
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
