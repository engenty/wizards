import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wizardSchema } from "@engenty/wizards-shared/definition";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "wizards-code-step-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.RUNTIME_ROLE = "runner";
process.env.FEATURES = "codeSteps=on";
process.env.RUNNER_CLOCK_MS = "100";

vi.mock("../src/safety.js", async (original) => ({
  ...(await original<typeof import("../src/safety.js")>()),
  guestChecksOn: async () => false,
}));
vi.mock("../src/credits/credits.js", async (original) => ({
  ...(await original<typeof import("../src/credits/credits.js")>()),
  canSpend: async () => true,
  reserveForRun: async () => true,
  releaseRun: async () => undefined,
}));

let client: typeof import("../src/db/client");
let runner: typeof import("../src/engine/runner");
let wizards: typeof import("../src/services/wizards");
let files: typeof import("../src/services/files");

const T = "tenant-code-step";
const end = { id: "done", type: "result", title: "Done", deliverables: [] };
const big = { id: "big", type: "result", title: "Big", deliverables: [] };
const base = { title: "Code", description: "", avatar: "round" };
const SOURCE = `
export function run(input: { budget: number; note: string; today: string }) {
  const year = new Date(input.today).getUTCFullYear();
  const months = [1, 2, 3].map((m) => ({ month: m, amount: input.budget / 3 }));
  return { total: input.budget * 2, note: input.note, year, months };
}
`;
const ask = {
  id: "ask",
  type: "form",
  title: "Ask",
  fields: [
    { id: "budget", label: "Budget", kind: "number" },
    { id: "name", label: "Name", kind: "text" },
  ],
};
const steps = [
  ask,
  {
    id: "sum",
    type: "code",
    title: "Sum",
    code: {
      entry: "code/sum.ts",
      input: { budget: "budget", note: "{{name}} pays {{budget}}", today: "today" },
    },
    output: {
      fields: [
        { id: "total", kind: "number" },
        { id: "note", kind: "text" },
        { id: "year", kind: "number" },
        { id: "months", kind: "table" },
      ],
    },
    next: [{ when: { field: "steps.sum.total", op: "gt", value: 100 }, goto: "big" }],
  },
  end,
  big,
];

const row = (id: string) =>
  client.withTenant(T, () =>
    client.db.query.run.findFirst({ where: eq(client.schema.run.id, id) }),
  );
async function until(ok: () => Promise<boolean>, ms = 15_000) {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (await ok()) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

const start = () =>
  client.withTenant(T, async () => {
    const created = await wizards.createWizard("u", {
      definition: { ...base, steps: [end] } as never,
    });
    await files.seedFiles(created.id, { "code/sum.ts": SOURCE });
    return runner.createRun({
      wizardId: created.id,
      definition: wizardSchema.parse({ ...base, steps }),
      files: await files.draftFiles(created.id),
      version: null,
      mode: "test",
      userId: "u",
      visitorId: null,
    });
  });

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  runner = await import("../src/engine/runner");
  wizards = await import("../src/services/wizards");
  files = await import("../src/services/files");
  runner.startRunner();
});
afterAll(() => runner.stopRunner());

describe("a code step in a run", () => {
  it("runs the wizard's file with its input, and its output decides the branch", async () => {
    const id = await start();
    expect(await until(async () => (await row(id))?.status === "waiting_input")).toBe(true);
    await client.withTenant(T, () => runner.submitPage(id, "ask", { budget: 60, name: "Ada" }));
    expect(await until(async () => (await row(id))?.status === "done")).toBe(true);
    const r = await row(id);
    expect(r?.state.outputs.sum?.json).toMatchObject({
      total: 120,
      note: "Ada pays 60",
      year: new Date().getUTCFullYear(),
      months: [
        { month: 1, amount: 20 },
        { month: 2, amount: 20 },
        { month: 3, amount: 20 },
      ],
    });
    // The branch on its total went past "done" to "big".
    expect(r?.cursor).toBe("big");
  });

  it("does not start while code steps are off", async () => {
    process.env.FEATURES = "codeSteps=off";
    try {
      await expect(start()).rejects.toThrow();
    } finally {
      process.env.FEATURES = "codeSteps=on";
    }
  });
});
