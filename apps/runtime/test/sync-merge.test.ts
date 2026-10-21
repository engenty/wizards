import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type WizardDefinition, validateWizard } from "@engenty/wizards-shared/definition";
import { mergeJson, pathLabel, settleConflicts } from "@engenty/wizards-shared/sync-merge";
import { mergeText } from "@engenty/wizards-shared/text-merge";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

const pkg = unzipSync(
  readFileSync(
    fileURLToPath(
      new URL("../../../examples/wizards/alderbrook/report-a-problem.wizard", import.meta.url),
    ),
  ),
);
const base = JSON.parse(strFromU8(pkg["wizard.json"])).definition as WizardDefinition;
const copy = () => structuredClone(base);
const step = (d: WizardDefinition, id: string) => d.steps.find((s) => s.id === id) as any;
const ids = (d: WizardDefinition) => d.steps.map((s) => s.id);
const merged = (edit: (d: WizardDefinition) => void, other: (d: WizardDefinition) => void) => {
  const local = copy();
  const remote = copy();
  edit(local);
  other(remote);
  return mergeJson(base, local, remote);
};
const where = (m: ReturnType<typeof merged>) =>
  m.conflicts.map((c) => pathLabel(c.path, m.value, (s: any) => s.title ?? null));

// The cases of the study (docs/plans/tenant-sync.md, "Can a classic merge handle a wizard?").
describe("mergeJson on a wizard", () => {
  it("merges edits of different steps", () => {
    const m = merged(
      (d) => {
        step(d, "what").title = "Photo and place";
      },
      (d) => {
        step(d, "report").prompt += " Keep it short.";
      },
    );
    expect(m.conflicts).toEqual([]);
    expect(step(m.value, "what").title).toBe("Photo and place");
    expect(step(m.value, "report").prompt).toMatch(/Keep it short\.$/);
  });

  it("merges edits of neighbouring keys of one step", () => {
    const m = merged(
      (d) => {
        step(d, "file").instructions += " Be polite.";
      },
      (d) => {
        step(d, "file").tools = ["web_search"];
      },
    );
    expect(m.conflicts).toEqual([]);
    expect(step(m.value, "file").tools).toEqual(["web_search"]);
    expect(step(m.value, "file").instructions).toMatch(/Be polite\.$/);
  });

  it("keeps two steps added at the same place", () => {
    const m = merged(
      (d) => {
        d.steps.splice(1, 0, { id: "phone", type: "page", title: "Phone", fields: [] } as any);
      },
      (d) => {
        d.steps.splice(1, 0, { id: "consent", type: "page", title: "Consent", fields: [] } as any);
      },
    );
    expect(m.conflicts).toEqual([]);
    expect(ids(m.value)).toEqual(["what", "phone", "consent", "file", "located", "report", "done"]);
  });

  it("keeps two fields added at the end of one page", () => {
    const m = merged(
      (d) => {
        step(d, "what").fields.push({ id: "name", label: "Name", kind: "text" });
      },
      (d) => {
        step(d, "what").fields.push({ id: "urgent", label: "Urgent", kind: "checkbox" });
      },
    );
    expect(m.conflicts).toEqual([]);
    expect(step(m.value, "what").fields.map((f: any) => f.id).slice(-2)).toEqual([
      "name",
      "urgent",
    ]);
  });

  it("moves a step on one side and edits it on the other", () => {
    const m = merged(
      (d) => {
        const [x] = d.steps.splice(2, 1);
        d.steps.splice(1, 0, x);
      },
      (d) => {
        step(d, "located").prompt += " Use a red circle.";
      },
    );
    expect(m.conflicts).toEqual([]);
    expect(ids(m.value).slice(0, 3)).toEqual(["what", "located", "file"]);
    expect(step(m.value, "located").prompt).toMatch(/red circle\.$/);
  });

  it("names a conflict on the same key", () => {
    const m = merged(
      (d) => {
        step(d, "file").title = "Send the report";
      },
      (d) => {
        step(d, "file").title = "Report it";
      },
    );
    expect(where(m)).toEqual(["steps › “Send the report” › title"]);
    expect(m.conflicts[0]).toMatchObject({ kind: "value", local: "Send the report", remote: "Report it" });
  });

  it("names a step removed on one side and changed on the other", () => {
    const m = merged(
      (d) => {
        d.steps = d.steps.filter((s) => s.id !== "located");
      },
      (d) => {
        step(d, "located").prompt += " Use a red circle.";
      },
    );
    expect(m.conflicts).toHaveLength(1);
    expect(m.conflicts[0]).toMatchObject({ kind: "removed", path: ["steps", { id: "located" }] });
    expect(m.conflicts[0].local).toBeUndefined();
  });

  it("leaves a broken reference for the checks to find", () => {
    const m = merged(
      (d) => {
        const f = step(d, "what").fields.find((x: any) => x.id === "email");
        f.id = "mail";
        step(d, "file").instructions = step(d, "file").instructions.replace("{{email}}", "{{mail}}");
      },
      (d) => {
        step(d, "report").prompt += " Send a copy to {{email}}.";
      },
    );
    expect(m.conflicts).toEqual([]);
    const before = new Set(validateWizard(base).map((i) => i.message));
    expect(validateWizard(m.value).some((i) => !before.has(i.message))).toBe(true);
  });

  it("settles a conflict as chosen, and puts a removed step back where it stood", () => {
    const local = copy();
    const remote = copy();
    local.steps = local.steps.filter((s) => s.id !== "located");
    step(local, "file").title = "Mine";
    step(remote, "located").prompt += " Use a red circle.";
    step(remote, "file").title = "Theirs";
    const m = mergeJson(base, local, remote);
    expect(m.conflicts).toHaveLength(2);
    const settled = settleConflicts(
      m.value,
      m.conflicts,
      m.conflicts.map((c) => ({ take: c.kind === "removed" ? "remote" : "local" }) as const),
      { local, remote },
    );
    expect(ids(settled)).toEqual(ids(base));
    expect(step(settled, "file").title).toBe("Mine");
    expect(step(settled, "located").prompt).toMatch(/red circle\.$/);
  });

  it("calls two different new orders a conflict", () => {
    const m = merged(
      (d) => {
        d.steps = [d.steps[1], d.steps[0], ...d.steps.slice(2)];
      },
      (d) => {
        d.steps = [d.steps[0], d.steps[2], d.steps[1], ...d.steps.slice(3)];
      },
    );
    expect(m.conflicts.map((c) => c.kind)).toEqual(["order"]);
  });
});

describe("mergeJson on records", () => {
  it("merges a row cell by cell", () => {
    const b = { cells: { a: 1, b: 2, c: 3 } };
    const m = mergeJson(b, { cells: { a: 9, b: 2, c: 3 } }, { cells: { a: 1, b: 2, c: 7 } });
    expect(m).toEqual({ value: { cells: { a: 9, b: 2, c: 7 } }, conflicts: [] });
  });

  it("merges Markdown both sides changed in different places", () => {
    const text = ["# Title", "", "One.", "", "Two.", "", "Three."].join("\n");
    const m = mergeJson(
      { markdown: text },
      { markdown: text.replace("One.", "One, changed here.") },
      { markdown: text.replace("Three.", "Three, changed in the cloud.") },
    );
    expect(m.conflicts).toEqual([]);
    expect(m.value.markdown).toContain("One, changed here.");
    expect(m.value.markdown).toContain("Three, changed in the cloud.");
  });
});

describe("mergeText", () => {
  it("takes what each side changed", () => {
    const o = "a\nb\nc\nd\ne";
    expect(mergeText(o, "A\nb\nc\nd\ne", "a\nb\nc\nd\nE")).toEqual({
      text: "A\nb\nc\nd\nE",
      clean: true,
      conflicts: 0,
    });
  });

  it("takes lines added at both ends", () => {
    expect(mergeText("b\nc", "a\nb\nc", "b\nc\nd").text).toBe("a\nb\nc\nd");
  });

  it("calls the same line changed twice a conflict", () => {
    const m = mergeText("a\nb\nc", "a\nB\nc", "a\nβ\nc");
    expect(m.clean).toBe(false);
    expect(m.conflicts).toBe(1);
  });

  it("takes the same change made on both sides once", () => {
    expect(mergeText("a\nb", "a\nx\nb", "a\nx\nb")).toEqual({
      text: "a\nx\nb",
      clean: true,
      conflicts: 0,
    });
  });
});
