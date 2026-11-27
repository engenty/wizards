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

  it("shows a step's work with what a person changed of it in a review, until the step runs again", () => {
    const changed = (edits: unknown): Row[] => [
      { n: 0, step: "write", left: true, value: "Do not click.", to: "check" } as unknown as Row,
      { n: 1, step: "sum", left: true, value: { total: 1, note: "net" }, to: "check" } as unknown as Row,
      { n: 2, step: "check", role: "user", type: "review", show: ["write", "sum"], edit: true, state: "done", answer: { approved: true, edits } } as unknown as Row,
      { n: 3, step: "check", left: true, value: { approved: true, edits }, to: "end" } as unknown as Row,
    ];
    const rows = changed({ write: "Ask first, then click.", sum: { total: 2 }, gone: "x" });
    const edited = kernelPage(run, view(rows, "end", { status: "done", waiting: [] }));
    expect(edited.state.outputs.write.text).toBe("Ask first, then click.");
    expect(edited.state.outputs.sum.json).toEqual({ total: 2, note: "net" });
    expect(edited.state.outputs.gone).toBeUndefined();

    // The step ran again after the review: what it left then is what there is.
    const again = kernelPage(
      run,
      view([...rows, { n: 4, step: "write", left: true, value: "A new text.", to: "end" } as unknown as Row], "end", { status: "done", waiting: [] }),
    );
    expect(again.state.outputs.write.text).toBe("A new text.");
  });

  it("carries the line under a page's title: what a form is for, what a review is to check", () => {
    const asked = { ...form("ask", 0, "waiting"), description: "For the letter's first line." };
    const onForm = kernelPage(run, view([asked], "ask"));
    expect(onForm.definition.steps.find((s) => s.id === "ask")).toMatchObject({
      type: "form",
      description: "For the letter's first line.",
    });
    const review = {
      n: 0,
      step: "check",
      role: "user",
      type: "review",
      title: "Is the letter right?",
      description: "Check the name and the date.",
      approve: true,
      state: "waiting",
    } as AskRow;
    const onReview = kernelPage(run, view([review], "check"));
    expect(onReview.definition.steps.find((s) => s.id === "check")).toMatchObject({
      type: "review",
      title: "Is the letter right?",
      description: "Check the name and the date.",
    });
  });
});
