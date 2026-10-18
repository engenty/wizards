import { describe, expect, it } from "vitest";
import type { WizardDefinition } from "@engenty/wizards-shared/definition";
import { applyOps, OpError } from "../src/authoring/ops";

const base: WizardDefinition = {
  version: 1,
  title: "T",
  description: "",
  avatar: "round",
  intro: "Hallo",
  steps: [
    { id: "ask", type: "page", title: "Ask", fields: [{ id: "topic", label: "T", kind: "text" }] },
    { id: "done", type: "result", title: "Done", deliverables: [] },
  ],
};

const ids = (def: unknown) => (def as WizardDefinition).steps.map((s) => s.id);

describe("applyOps", () => {
  it("inserts a new step before the closing result step", () => {
    const next = applyOps(base, [
      {
        op: "upsert_step",
        step: { id: "write", type: "agent", title: "W", instructions: "x" },
      },
    ]);
    expect(ids(next)).toEqual(["ask", "write", "done"]);
  });

  it("replaces a step in place and moves it when anchored", () => {
    const replaced = applyOps(base, [
      { op: "upsert_step", step: { id: "ask", type: "page", title: "New", fields: [] } },
    ]) as WizardDefinition;
    expect(replaced.steps[0].title).toBe("New");

    const moved = applyOps(base, [
      { op: "upsert_step", step: { id: "ask", type: "page", title: "A", fields: [] }, after: "done" },
    ]);
    expect(ids(moved)).toEqual(["done", "ask"]);
  });

  it("removes and moves steps, in order", () => {
    const next = applyOps(base, [
      { op: "upsert_step", step: { id: "a", type: "agent", title: "A", instructions: "x" } },
      { op: "move_step", stepId: "a", before: "ask" },
      { op: "remove_step", stepId: "ask" },
    ]);
    expect(ids(next)).toEqual(["a", "done"]);
  });

  it("sets meta and removes the intro with null", () => {
    const next = applyOps(base, [
      { op: "set_meta", title: "Neu", intro: null, avatar: "flame" },
    ]) as WizardDefinition;
    expect(next.title).toBe("Neu");
    expect(next.avatar).toBe("flame");
    expect(next.intro).toBeUndefined();
    expect(base.title).toBe("T");
  });

  it("sets the whole style and removes it with null", () => {
    const styled = applyOps(base, [
      { op: "set_meta", style: { accent: "#ff7a1a", effects: ["webs"] } },
    ]) as WizardDefinition;
    expect(styled.style).toEqual({ accent: "#ff7a1a", effects: ["webs"] });
    const plain = applyOps(styled, [{ op: "set_meta", style: null }]) as WizardDefinition;
    expect(plain.style).toBeUndefined();
  });

  it("names the op that points at a missing step", () => {
    expect(() => applyOps(base, [{ op: "remove_step", stepId: "nope" }])).toThrow(OpError);
    expect(() => applyOps(base, [{ op: "move_step", stepId: "ask", after: "nope" }])).toThrow(
      /op 1 \(move_step\).*nope/,
    );
  });
});
