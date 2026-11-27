import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-old-format-"));
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";

const { migrateControlDb, withTenant } = await import("../src/db/client.js");
const wizards = await import("../src/services/wizards.js");
const files = await import("../src/services/files.js");
const runner = await import("../src/engine/runner.js");
const { authoringGuide } = await import("../src/authoring/guide.js");

/**
 * Version 0.3.0 is the format (docs/plans/kernel.md). A wizard in version 0.2.0 loads only where
 * the switch `version020` is on; off, it is not listed, opened, saved or run.
 */
const old = {
  title: "Old",
  description: "",
  steps: [
    { id: "write", type: "agent", title: "Write", instructions: "Write.", tools: [], output: { format: "text" } },
    { id: "done", type: "result", title: "Done", deliverables: [] },
  ],
};

/** The switch as the `.features` file says it; the file has the last word. */
const version020 = async (on: boolean) => {
  writeFileSync(process.env.FEATURES_FILE as string, on ? "version020=on\n" : "");
  // The file is read again when it changed; a new modification time tells it.
  await new Promise((r) => setTimeout(r, 20));
};

beforeAll(() => migrateControlDb());

describe("with the switch for version 0.2.0 off", () => {
  it("starts a new wizard in version 0.3.0, with its first step file", async () => {
    await version020(false);
    await withTenant("of1", async () => {
      const { id } = await wizards.createWizard("u", { lang: "en" });
      const w = await wizards.ownedWizard("u", id);
      expect(w.draft.kernel?.version).toBe("0.3.0");
      expect(w.draft.kernel?.start).toBe("start");
      expect((await files.draftFiles(id)).map((f) => f.path)).toContain("steps/start.ts");
    });
  });

  it("does not save a wizard in version 0.2.0, and says how one is made", async () => {
    await version020(false);
    await withTenant("of2", async () => {
      await expect(wizards.createWizard("u", { definition: old })).rejects.toThrow(/step files/);
      const { id } = await wizards.createWizard("u", { lang: "en" });
      const w = await wizards.ownedWizard("u", id);
      await expect(
        wizards.writeDraft("u", id, { definition: old, baseRevision: w.revision }),
      ).rejects.toThrow(/step files/);
    });
  });

  it("neither lists, opens nor runs a wizard made in version 0.2.0 before", async () => {
    await version020(true);
    const id = await withTenant("of3", async () => (await wizards.createWizard("u", { definition: old })).id);
    await version020(false);
    await withTenant("of3", async () => {
      expect((await wizards.listWizards("u")).map((w) => w.id)).not.toContain(id);
      await expect(wizards.ownedWizard("u", id)).rejects.toThrow();
      await expect(
        runner.createRun({ wizardId: id, definition: old as never, files: [], version: null, mode: "test", userId: "u" }),
      ).rejects.toThrow(/format before step files/);
    });
    // On again, it is there as it was.
    await version020(true);
    await withTenant("of3", async () => {
      expect((await wizards.listWizards("u")).map((w) => w.id)).toContain(id);
    });
  });

  it("tells the assistant of step files only, without an example in version 0.2.0", () => {
    const off = authoringGuide([], [], [], [], {});
    expect(off).toContain("Never write a wizard in this form");
    expect(off).not.toContain("Example of a complete wizard in version 0.2.0");
    const on = authoringGuide([], [], [], [], { version020: true });
    expect(on).toContain("Example of a complete wizard in version 0.2.0");
    expect(on).toContain("for wizards made before");
  });
});
