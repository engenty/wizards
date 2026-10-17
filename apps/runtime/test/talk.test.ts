import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "wizards-talk-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
// A key is there, so only the wizard's own switch decides.
process.env.OPENAI_API_KEY = "sk-test";

let client: typeof import("../src/db/client");
let wizards: typeof import("../src/services/wizards");
let runner: typeof import("../src/engine/runner");
let wizardId: string;

const definition = {
  version: 1,
  title: "Rückruf",
  description: "Wer, wann, worum",
  avatar: "dome",
  steps: [
    {
      id: "contact",
      type: "page",
      title: "Kontakt",
      fields: [{ id: "name", kind: "text", label: "Name", required: true }],
    },
  ],
};

type Run = Parameters<typeof import("../src/engine/runner").talkAllowed>[0];
const runOf = (mode: "test" | "live") => ({ mode, wizardId }) as Run;

describe("a live conversation on a run", () => {
  beforeAll(async () => {
    client = await import("../src/db/client");
    await client.migrateControlDb();
    wizards = await import("../src/services/wizards");
    runner = await import("../src/engine/runner");
    await (await import("../src/models")).loadLocalModels();
    await client.withTenant("tenant-a", async () => {
      wizardId = (await wizards.createWizard("user-a", { definition })).id;
    });
  }, 60_000);

  it("is closed to visitors while the owner has live voice and video off", async () => {
    await client.withTenant("tenant-a", async () => {
      expect(await runner.talkAllowed(runOf("live"))).toBe(false);
    });
  });

  it("is open to the owner's test run all the same", async () => {
    await client.withTenant("tenant-a", async () => {
      expect(await runner.talkAllowed(runOf("test"))).toBe(true);
    });
  });

  it("opens to visitors once live voice or video is on", async () => {
    for (const on of ["talk", "video"]) {
      await client.withTenant("tenant-a", async () => {
        await wizards.updateWizardSettings("user-a", wizardId, {
          runners: { default: "steps", enabled: ["steps", on] },
        });
        expect(await runner.talkAllowed(runOf("live"))).toBe(true);
      });
    }
  });
});
