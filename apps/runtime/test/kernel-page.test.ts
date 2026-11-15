import type { AskRow, Row } from "@engenty/wizards-kernel";
import { type KernelFile, kernelShell } from "@engenty/wizards-shared/kernel-file";
import { describe, expect, it } from "vitest";
import type { RunRow } from "../src/engine/types.js";
import type { KernelRunView } from "../src/kernel/host.js";
import { kernelPage } from "../src/kernel/page.js";

const file = {
  version: "0.3.0",
  title: "A letter",
  description: "",
  intro: "Tell me who it is for.",
  start: "ask",
  edges: { ask: ["write"], write: ["end"] },
  input: { fields: [{ id: "name", label: "Name", kind: "text" }] },
} as unknown as KernelFile;
const run = { id: "r", definition: kernelShell(file), updatedAt: new Date(0) } as unknown as RunRow;

const form = (step: string, n: number, state: AskRow["state"]): AskRow => ({
  n,
  step,
  role: "user",
  type: "form",
  title: step,
  fields: [{ id: "a", label: "A", kind: "text" }],
  state,
});
const view = (rows: Row[], cursor: string, extra: Partial<KernelRunView> = {}): KernelRunView => ({
  id: "r",
  status: "waiting_input",
  cursor,
  rows,
  waiting: rows.filter((row): row is AskRow => !("left" in row) && row.state === "waiting"),
  scores: [],
  rev: 0,
  ...extra,
});

describe("a run of version 0.3.0 on its page", () => {
  it("shows the intro above the first page only", () => {
    const first = kernelPage(run, view([form("input", 0, "waiting")], "input"));
    expect(first.definition.intro).toBe("Tell me who it is for.");

    const second = kernelPage(
      run,
      view([{ ...form("input", 0, "done"), answer: { name: "N" } }, form("ask", 1, "waiting")], "ask"),
    );
    expect(second.cursor).toBe("ask");
    expect(second.definition.intro).toBeUndefined();
  });

  it("names a step at work by the title its file writes, before it asked anything", () => {
    const page = kernelPage(
      run,
      view([{ n: 0, step: "ask", left: true, value: {}, to: "write" }], "write", {
        status: "running",
        waiting: [],
        titles: { write: { title: "The letter", working: "Writes the letter …" } },
      }),
    );
    expect(page.definition.steps.find((s) => s.id === "write")).toMatchObject({
      title: "The letter",
      working: "Writes the letter …",
    });
  });
});
