import type { KernelFile, KernelOutline } from "@engenty/wizards-shared/kernel-file";
import { describe, expect, it } from "vitest";
import { kernelStill } from "../src/kernel/still.js";

const file = {
  input: { fields: [{ id: "name", label: "Name", kind: "text" }] },
} as unknown as KernelFile;
const outline: KernelOutline = {
  pitch: {
    asks: [{ spec: { type: "agent", title: "The pitch", working: "Writes …" } }],
    ways: [],
  },
  check: {
    asks: [{ spec: { type: "review", title: "Fine?", show: ["pitch"], edit: true } }],
    ways: [],
  },
  form: {
    asks: [
      {
        spec: {
          type: "form",
          title: { $text: ["For ", { $code: "run.input.name" }] },
          fields: [{ id: "a", label: "A", kind: "text" }, { $code: "extra" }],
        },
      },
    ],
    ways: [],
  },
};

describe("a step of version 0.3.0 shown without a run", () => {
  it("shows a page as its code asks for it, without what code works out", () => {
    const still = kernelStill(file, outline, "form", {}, false);
    expect(still?.status).toBe("waiting_input");
    expect(still?.waiting[0]).toMatchObject({
      step: "form",
      type: "form",
      title: "For …",
      fields: [{ id: "a", label: "A", kind: "text" }],
    });
    expect(kernelStill(file, outline, "input", {}, false)?.waiting[0].fields).toHaveLength(1);
  });

  it("shows a review with what the latest test run made, else with a sample", () => {
    const made = kernelStill(file, outline, "check", { pitch: "Dear Ms Huber" }, false);
    expect(made?.rows[0]).toMatchObject({ step: "pitch", left: true, value: "Dear Ms Huber" });
    expect(made?.titles).toEqual({ check: "Fine?", pitch: "The pitch" });
    const sample = kernelStill(file, outline, "check", {}, false);
    expect(String((sample?.rows[0] as { value?: unknown }).value)).toContain("*Sample.*");
  });

  it("shows a step that works as at work, and nothing for a step the wizard has not", () => {
    expect(kernelStill(file, outline, "pitch", {}, false)).toMatchObject({
      status: "running",
      waiting: [],
      working: "Writes …",
    });
    expect(kernelStill(file, outline, "nope", {}, false)).toBeNull();
  });
});
