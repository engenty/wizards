import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "wizards-roles-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
// This process is the web alone: it wakes runs and drives none.
process.env.RUNTIME_ROLE = "web";

let client: typeof import("../src/db/client");
let runner: typeof import("../src/engine/runner");
let wizards: typeof import("../src/services/wizards");

const T = "tenant-roles";

const definition = {
  version: 1,
  title: "Roles",
  description: "",
  avatar: "round",
  steps: [
    { id: "start", type: "page", title: "Start", fields: [{ id: "name", kind: "text", label: "Name" }] },
    { id: "done", type: "result", title: "Fertig", deliverables: [] },
  ],
};

async function until<T>(get: () => Promise<T>, ok: (v: T) => boolean, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  let v = await get();
  while (!ok(v) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 50));
    v = await get();
  }
  return v;
}

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  runner = await import("../src/engine/runner");
  wizards = await import("../src/services/wizards");
});

describe("web and runner apart", () => {
  it("the web puts a run in line and leaves it there; a runner's look takes and finishes it", async () => {
    const runId = await client.withTenant(T, async () => {
      const created = await wizards.createWizard("u", { definition });
      const w = await wizards.ownedWizard("u", created.id);
      const id = await runner.createRun({
        wizardId: w.id,
        definition: w.draft,
        files: [],
        version: null,
        mode: "test",
        userId: "u",
      });
      await runner.submitPage(id, "start", { name: "Ada" });
      return id;
    });
    const inLine = () =>
      client.controlDb.query.runIndex.findFirst({ where: eq(client.control.runIndex.runId, runId) });
    const status = () =>
      client.withTenant(T, async () => {
        const row = await client.db.query.run.findFirst({
          where: eq(client.schema.run.id, runId),
        });
        return row?.status;
      });
    await until(inLine, (r) => Boolean(r?.active));
    await new Promise((r) => setTimeout(r, 500));
    expect(await status()).toBe("running");
    expect(await inLine()).toMatchObject({ active: true, owner: null });

    runner.startRunner();
    expect(await until(status, (s) => s === "done")).toBe("done");
    expect(await until(inLine, (r) => r?.active === false)).toMatchObject({
      active: false,
      owner: null,
    });
  });
});
