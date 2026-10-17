import { versionChanges } from "@engenty-wizards/shared/changes";
import type { WizardDefinition } from "@engenty-wizards/shared/definition";
import { describe, expect, it } from "vitest";

/** What "Änderungen live schalten" lists: the draft against the version people run. */

const page = (id: string, title: string, label = "Name") => ({
  id,
  title,
  type: "page" as const,
  fields: [{ id: `${id}-f`, kind: "text" as const, label, required: true }],
});

const wizard = (steps: ReturnType<typeof page>[], extra: Partial<WizardDefinition> = {}) =>
  ({ version: 1, title: "Tagesplan", description: "", avatar: "round", steps, ...extra }) as WizardDefinition;

describe("what the draft changes", () => {
  it("names nothing for the same version", () => {
    const def = wizard([page("a", "Wer?")]);
    expect(versionChanges({ definition: def, files: [] }, { definition: def, files: [] })).toEqual([]);
  });

  it("lists steps added, changed and removed by their titles, the wizard's own parts and the files", () => {
    const before = {
      definition: wizard([page("a", "Wer?"), page("b", "Newsletter"), page("c", "Wann?")]),
      files: [
        { path: "tipps.md", hash: "1" },
        { path: "alt.md", hash: "2" },
      ],
    };
    const after = {
      definition: wizard([page("c", "Wann?"), page("a", "Wer?", "Vorname"), page("d", "Wetter")], {
        intro: "Hallo",
      }),
      files: [
        { path: "tipps.md", hash: "9" },
        { path: "neu.md", hash: "3" },
      ],
    };
    expect(versionChanges(before, after)).toEqual([
      { kind: "wizard", change: "changed", parts: ["intro"] },
      { kind: "step", change: "changed", name: "Wer?", parts: ["fields"] },
      { kind: "step", change: "added", name: "Wetter" },
      { kind: "step", change: "removed", name: "Newsletter" },
      { kind: "order", change: "changed" },
      { kind: "file", change: "changed", name: "tipps.md" },
      { kind: "file", change: "added", name: "neu.md" },
      { kind: "file", change: "removed", name: "alt.md" },
    ]);
  });
});
