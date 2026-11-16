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
  it("shows the intro above the first page only, and keeps it for the chat", () => {
    const at = (page: RunRow) => page.definition.steps.findIndex((s) => s.id === page.cursor);
    const first = kernelPage(run, view([form("input", 0, "waiting")], "input"));
    expect(first.definition.intro).toBe("Tell me who it is for.");
    expect(at(first)).toBe(0);

    const second = kernelPage(
      run,
      view([{ ...form("input", 0, "done"), answer: { name: "N" } }, form("ask", 1, "waiting")], "ask"),
    );
    expect(second.cursor).toBe("ask");
    // The chat greets with the intro on every page; the page counts this one as not the first.
    expect(second.definition.intro).toBe("Tell me who it is for.");
    expect(at(second)).toBeGreaterThan(0);
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

  it("shows what a run's output reads when it took a way without the named downloads", () => {
    const booking = {
      ...file,
      start: "free",
      edges: { free: ["book", "full"], book: ["end"], full: ["end"] },
      output: { book: "book", full: "full" },
      result: { title: "Thanks", downloads: [{ from: "book", formats: ["pdf"] }] },
    } as unknown as KernelFile;
    const done = kernelPage(
      { ...run, definition: kernelShell(booking) } as RunRow,
      view(
        [
          { n: 0, step: "free", left: true, value: { slots: [] }, to: "full" },
          { n: 1, step: "full", left: true, value: "We will call you.", to: "end" },
        ],
        "end",
        { status: "done", waiting: [] },
      ),
    );
    const result = done.definition.steps.find((s) => s.id === "result") as { deliverables: unknown };
    expect(result.deliverables).toEqual([{ from: "full", formats: ["md"] }]);
  });
});
