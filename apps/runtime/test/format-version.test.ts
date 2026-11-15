import {
  formatVersionOf,
  inCurrentFormat,
  wizardSchema,
} from "@engenty/wizards-shared/definition";
import { kernelShell } from "@engenty/wizards-shared/kernel-file";
import { describe, expect, it } from "vitest";
import { EXAMPLE_WIZARD } from "../src/authoring/example";

describe("the version of a wizard's format", () => {
  const { version: _version, ...written } = EXAMPLE_WIZARD;

  it("is 0.2.0 for steps in a list, also where it is left out or written the earlier way", () => {
    expect(wizardSchema.parse(written).version).toBe("0.2.0");
    expect(wizardSchema.parse({ ...written, version: 1 }).version).toBe("0.2.0");
    expect(wizardSchema.parse({ ...written, version: "0.2.0" }).version).toBe("0.2.0");
    expect(formatVersionOf(1)).toBe("0.2.0");
    expect(inCurrentFormat({ version: 1, title: "x" })).toEqual({ version: "0.2.0", title: "x" });
  });

  it("is 0.3.0 for a wizard made of step files, whatever it said before", () => {
    const shell = kernelShell({
      version: "0.3.0",
      title: "Steps",
      description: "",
      avatar: "round",
      start: "one",
      edges: { one: ["end"] },
    } as Parameters<typeof kernelShell>[0]);
    expect(shell.version).toBe("0.3.0");
    expect(wizardSchema.parse({ ...shell, version: 1 }).version).toBe("0.3.0");
  });

  it("refuses 0.3.0 without step files, and a version it does not know", () => {
    expect(wizardSchema.safeParse({ ...written, version: "0.3.0" }).success).toBe(false);
    expect(wizardSchema.safeParse({ ...written, version: 2 }).success).toBe(false);
  });
});
