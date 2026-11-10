import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "wizards-page-timing-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.RUNTIME_ROLE = "runner";
process.env.RUNNER_CLOCK_MS = "100";

vi.mock("@engenty/wizards-engine/steps/index", async (original) => ({
  ...(await original<typeof import("@engenty/wizards-engine/steps/index")>()),
  runAutomaticStep: async () => ({ text: "made", at: new Date().toISOString() }),
}));
vi.mock("../src/engine/requirements.js", async (original) => ({
  ...(await original<typeof import("../src/engine/requirements.js")>()),
  missingModelsSaid: async () => [],
}));
vi.mock("../src/safety.js", async (original) => ({
  ...(await original<typeof import("../src/safety.js")>()),
  guestChecksOn: async () => false,
}));
vi.mock("../src/credits/credits.js", async (original) => ({
  ...(await original<typeof import("../src/credits/credits.js")>()),
  reserveForRun: async () => true,
  releaseRun: async () => undefined,
}));

let client: typeof import("../src/db/client");
let runner: typeof import("../src/engine/runner");
let wizards: typeof import("../src/services/wizards");

const T = "local";
const SECRET_ANSWER = "the-answer-nobody-logs";
const page = (id: string) => ({
  id,
  type: "form",
  title: id,
  fields: [{ id: `${id}_f`, kind: "text", label: "F", required: false }],
});
const agent = {
  id: "work",
  type: "agent",
  title: "Work",
  instructions: "Do it.",
  tools: [],
  output: { format: "text" },
};
const end = { id: "done", type: "result", title: "Fertig", deliverables: [] };
const base = { version: 1, title: "Timing", description: "", avatar: "round" };

const row = (id: string) =>
  client.withTenant(T, () =>
    client.db.query.run.findFirst({ where: eq(client.schema.run.id, id) }),
  );
async function waitsAt(id: string, step: string) {
  const stop = Date.now() + 8000;
  while (Date.now() < stop) {
    const r = await row(id);
    if (r?.status === "waiting_input" && r.cursor === step) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`run ${id} did not reach ${step}`);
}
const lines = (id: string, spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith(`[timing] page run=${id} `));

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  runner = await import("../src/engine/runner");
  wizards = await import("../src/services/wizards");
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe("from an answer to the next page", () => {
  it("logs the time once, with timings and no answers, and leaves nothing on the run", async () => {
    const spy = vi.spyOn(console, "info");
    const steps = [page("one"), page("two"), agent, page("three"), end];
    const id = await client.withTenant(T, async () => {
      const { id: wizardId } = await wizards.createWizard("u", {
        definition: { ...base, steps: [page("seed"), end] } as never,
      });
      return runner.createRun({
        wizardId,
        definition: { ...base, steps } as never,
        files: [],
        version: null,
        mode: "test",
        userId: "u",
      });
    });
    await waitsAt(id, "one");
    expect(lines(id, spy)).toEqual([]);

    await client.withTenant(T, () => runner.submitPage(id, "one", { one_f: SECRET_ANSWER }));
    await waitsAt(id, "two");
    await vi.waitFor(() => expect(lines(id, spy)).toHaveLength(1));
    const [first] = lines(id, spy);
    expect(first).toMatch(
      new RegExp(`^\\[timing\\] page run=${id} ms=\\d+ direct=true role=runner durable=(on|off) runner=(yes|no)$`),
    );
    expect((await row(id))?.state.answered).toBeUndefined();

    // A step that worked in between is not a plain page.
    await client.withTenant(T, () => runner.submitPage(id, "two", {}));
    await waitsAt(id, "three");
    await vi.waitFor(() => expect(lines(id, spy)).toHaveLength(2));
    expect(lines(id, spy)[1]).toContain(" direct=false ");

    const all = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(all).not.toContain(SECRET_ANSWER);
  });
});
