import { describe, expect, it } from "vitest";
import type { Step, WizardDefinition } from "@engenty/wizards-shared/definition";
import { mergeDrafts } from "@engenty/wizards-shared/merge";

const page = (id: string, title = id): Step => ({
  id,
  type: "page",
  title,
  fields: [{ id: `${id}F`, label: "F", kind: "text" }],
});
const result: Step = { id: "done", type: "result", title: "Done", deliverables: [] };
const wiz = (steps: Step[], title = "T"): WizardDefinition => ({
  version: 1,
  title,
  description: "",
  avatar: "round",
  steps,
});

const base = wiz([page("a"), page("b"), result]);
const titles = (w: WizardDefinition) => w.steps.map((s) => `${s.id}:${s.title}`);

describe("mergeDrafts", () => {
  it("keeps the studio's step edit and the other side's edit of another step", () => {
    const local = wiz([page("a", "A local"), page("b"), result]);
    const remote = wiz([page("a"), page("b", "B remote"), result]);
    expect(titles(mergeDrafts(base, local, remote))).toEqual([
      "a:A local",
      "b:B remote",
      "done:Done",
    ]);
  });

  it("lets the studio win when both changed the same step", () => {
    const local = wiz([page("a", "A local"), page("b"), result]);
    const remote = wiz([page("a", "A remote"), page("b"), result]);
    expect(titles(mergeDrafts(base, local, remote))[0]).toBe("a:A local");
  });

  it("places a step added in the studio and keeps one added elsewhere", () => {
    const local = wiz([page("a"), page("new"), page("b"), result]);
    const remote = wiz([page("a"), page("b"), page("mcp"), result]);
    expect(mergeDrafts(base, local, remote).steps.map((s) => s.id)).toEqual([
      "a",
      "new",
      "b",
      "mcp",
      "done",
    ]);
  });

  it("removes what the studio removed unless the other side changed it", () => {
    const local = wiz([page("b"), result]);
    expect(mergeDrafts(base, local, base).steps.map((s) => s.id)).toEqual(["b", "done"]);
    const remote = wiz([page("a", "A remote"), page("b"), result]);
    expect(mergeDrafts(base, local, remote).steps.map((s) => s.id)).toEqual(["a", "b", "done"]);
  });

  it("takes the studio's meta change and the other side's steps", () => {
    const local = wiz([page("a"), page("b"), result], "Local title");
    const remote = wiz([page("a"), result]);
    const merged = mergeDrafts(base, local, remote);
    expect(merged.title).toBe("Local title");
    expect(merged.steps.map((s) => s.id)).toEqual(["a", "done"]);
  });
});
