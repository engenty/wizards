import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-draft-events-"));
process.env.LOCAL_ACCESS_KEY = "test-key";

const { db, migrateControlDb, withTenant } = await import("../src/db/client.js");
const schema = await import("../src/db/schema.js");
const { createWizard } = await import("../src/services/wizards.js");
const { emitDraftChanged, pruneDraftChanges, subscribeDraft } = await import(
  "../src/services/draft-events.js"
);

const change = (wizardId: string, revision: number) => ({
  wizardId,
  kind: "draft" as const,
  revision,
  source: "mcp" as const,
  client: "Claude Code",
  note: null,
  touched: ["step-1"],
});

const definition = {
  title: "Test",
  description: "",
  inputs: [],
  steps: [{ id: "write", type: "agent", title: "Write", prompt: "Write." }],
  output: { format: "markdown", from: "write" },
};

/** A wizard in the tenant: the notices hang on it. */
const wizardIn = async () =>
  (await createWizard("user-a", { definition } as never)).id;

beforeAll(() => migrateControlDb());

describe("the draft's notices", () => {
  it("reach a subscriber at once, from this process", async () => {
    await withTenant("d1", async () => {
      const w1 = await wizardIn();
      const heard: number[] = [];
      const stop = subscribeDraft(w1, (c) => heard.push(c.revision));
      await vi.waitFor(async () => {
        await emitDraftChanged(change(w1, heard.length + 1));
        expect(heard.length).toBeGreaterThan(0);
      });
      stop();
    });
  });

  it("reach a subscriber from what another process wrote", async () => {
    await withTenant("d2", async () => {
      const w2 = await wizardIn();
      const heard: number[] = [];
      const stop = subscribeDraft(w2, (c) => heard.push(c.revision));
      await new Promise((r) => setTimeout(r, 100));
      // No wake-up: only the row, as a write of the process answering MCP leaves it.
      await db.insert(schema.draftChange).values({ wizardId: w2, change: change(w2, 7) });
      await vi.waitFor(() => expect(heard).toEqual([7]), { timeout: 5000 });
      stop();
    });
  });

  it("start from now, and go after an hour", async () => {
    await withTenant("d3", async () => {
      const w3 = await wizardIn();
      await emitDraftChanged(change(w3, 1));
      const heard: number[] = [];
      const stop = subscribeDraft(w3, (c) => heard.push(c.revision));
      await new Promise((r) => setTimeout(r, 100));
      expect(heard).toEqual([]);
      stop();
      await pruneDraftChanges(Date.now() + 2 * 3600_000);
      expect(await db.select().from(schema.draftChange)).toEqual([]);
    });
  });
});
