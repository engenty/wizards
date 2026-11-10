import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseWizard,
  type WizardDefinition,
  wizardSchema,
} from "@engenty/wizards-shared/definition";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * A tool step that calls `list_write`: what people send in becomes a row of a shared list with no
 * model, once per visit of the step. The runs go through the real runner, as in pinned-runs.
 */
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-list-write-step-"));
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.RUNTIME_ROLE = "runner";
process.env.FEATURES = "durableRuns=on";
process.env.RUNNER_CLOCK_MS = "100";
process.env.PLUGINS_WATCH = "0";
process.env.PLUGIN_JOBS = "0";

/** Every model a step asked for: none, here. */
const asked = vi.hoisted(() => [] as string[]);
vi.mock("../src/models.js", async (original) => ({
  ...(await original<typeof import("../src/models.js")>()),
  textModel: async (cls: string, meta: { stepId?: string } = {}) => {
    asked.push(`${meta.stepId}:${cls}`);
    throw new Error("No model in this test.");
  },
  systemOneAccess: async () => null,
}));
vi.mock("../src/safety.js", async (original) => ({
  ...(await original<typeof import("../src/safety.js")>()),
  guestChecksOn: async () => false,
}));
vi.mock("../src/engine/requirements.js", async (original) => ({
  ...(await original<typeof import("../src/engine/requirements.js")>()),
  missingModelsSaid: async () => [],
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

const T = "tenant-list-write-step";
const USER = "user-list-write";

const signups = {
  id: "signups",
  title: "Anmeldungen",
  shared: true,
  columns: [
    { id: "name", name: "Name", type: "text", required: true },
    { id: "email", name: "E-Mail", type: "text" },
    { id: "zip", name: "PLZ", type: "text" },
    { id: "guests", name: "Gäste", type: "number", format: { style: "integer" } },
  ],
};

const signUp = (rows: unknown[] = [{ name: "{{name}}", email: "{{email}}", zip: "{{zip}}", guests: "{{guests}}" }]) =>
  wizardSchema.parse({
    version: 1,
    title: "Sign-up",
    description: "",
    avatar: "round",
    lists: [signups],
    steps: [
      {
        id: "ask",
        type: "form",
        title: "Ask",
        fields: [
          { id: "name", kind: "text", label: "Name" },
          { id: "email", kind: "text", label: "E-Mail" },
          { id: "zip", kind: "text", label: "PLZ" },
          { id: "guests", kind: "number", label: "Gäste" },
        ],
      },
      {
        id: "save",
        type: "tool",
        title: "Save",
        call: { tool: "list_write", input: { list: "signups", rows } },
      },
      { id: "done", type: "result", title: "Done", deliverables: [] },
    ],
  });

/** A run of `definition`, with a wizard of its own: each has its own shared list. */
const start = (definition: WizardDefinition) =>
  client.withTenant(T, async () => {
    const created = await wizards.createWizard(USER, { definition });
    const id = await runner.createRun({
      wizardId: created.id,
      definition,
      files: [],
      version: null,
      mode: "live",
      userId: USER,
    });
    return { id, wizardId: created.id };
  });

const row = (id: string) =>
  client.withTenant(T, () =>
    client.db.query.run.findFirst({ where: eq(client.schema.run.id, id) }),
  );
const line = (id: string) =>
  client.controlDb.query.runIndex.findFirst({ where: eq(client.control.runIndex.runId, id) });

/** The run once it stands at `status` and no runner holds it, or after `ms` as it is. */
async function stands(id: string, status: string, ms = 30_000) {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    const l = await line(id);
    if ((await row(id))?.status === status && !l?.active && l?.owner == null) {
      break;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return (await row(id))!;
}

/** The run stands at `status` with no error. */
async function rests(id: string, status: string) {
  const r = await stands(id, status);
  expect({ status: r?.status, error: r?.error }).toEqual({ status, error: null });
  return r;
}

/** The cells of the wizard's shared list, in order. */
const listed = (wizardId: string) =>
  client.withTenant(T, async () => {
    const table = await client.db.query.spaceTable.findFirst({
      where: and(
        eq(client.schema.spaceTable.wizardId, wizardId),
        eq(client.schema.spaceTable.list, "signups"),
      ),
    });
    if (!table) {
      return [];
    }
    const rows = await client.db.query.spaceTableRow.findMany({
      where: eq(client.schema.spaceTableRow.tableId, table.id),
    });
    return rows.map((r) => r.cells);
  });

const answers = { name: "Anna", email: "anna@example.com", zip: "01234", guests: 2 };

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  runner = await import("../src/engine/runner");
  wizards = await import("../src/services/wizards");
  runner.startRunner();
}, 60_000);

afterAll(() => runner.stopRunner());

vi.setConfig({ testTimeout: 60_000 });

describe("a tool step with list_write", () => {
  it("saves the page's answers as a row of the shared list, with no model", async () => {
    const { id, wizardId } = await start(signUp());
    expect((await rests(id, "waiting_input")).cursor).toBe("ask");
    await client.withTenant(T, () => runner.submitPage(id, "ask", answers));
    const r = await rests(id, "done");

    expect(asked).toEqual([]);
    // Text stays text ("01234" keeps its zero), the number field's value a number.
    expect(await listed(wizardId)).toEqual([
      { name: "Anna", email: "anna@example.com", zip: "01234", guests: 2 },
    ]);
    expect(r.state.outputs.save?.json).toEqual({ added: 1, updated: 0, deleted: 0 });
    // The visit is kept: a restart of the step finds it done.
    const effect = await client.withTenant(T, () =>
      client.db.query.runEffect.findFirst({
        where: eq(client.schema.runEffect.runId, id),
      }),
    );
    expect(effect).toMatchObject({ id: `${id}:save:1`, tool: "list_write", state: "done" });
  });

  it("writes once per visit: a restart that finds the write done saves nothing again", async () => {
    const { id, wizardId } = await start(signUp());
    expect((await rests(id, "waiting_input")).cursor).toBe("ask");
    // As if the step had written in this visit before the process stopped.
    const before = { added: 1, updated: 0, deleted: 0 };
    await client.withTenant(T, () =>
      client.db.insert(client.schema.runEffect).values({
        id: `${id}:save:1`,
        runId: id,
        stepId: "save",
        tool: "list_write",
        state: "done",
        output: before,
        at: new Date(),
      }),
    );
    await client.withTenant(T, () => runner.submitPage(id, "ask", answers));
    const r = await rests(id, "done");

    expect(await listed(wizardId)).toEqual([]);
    expect(r.state.outputs.save?.json).toEqual(before);
  });

  it("fails the step as the AI step's tool would, on a value the column refuses", async () => {
    const { id, wizardId } = await start(signUp([{ email: "{{email}}" }]));
    expect((await rests(id, "waiting_input")).cursor).toBe("ask");
    await client.withTenant(T, () => runner.submitPage(id, "ask", answers));
    const r = await stands(id, "failed");

    expect(r.status).toBe("failed");
    expect(r.error).toContain('Column "name"');
    expect(await listed(wizardId)).toEqual([]);
  });
});

describe("the validator on list_write", () => {
  const steps = (input: unknown) => [
    { id: "ask", type: "form", title: "Ask", fields: [{ id: "name", kind: "text", label: "Name" }] },
    { id: "save", type: "tool", title: "Save", call: { tool: "list_write", input } },
    { id: "done", type: "result", title: "Done", deliverables: [] },
  ];
  const messages = (input: unknown, lists: unknown[] = [signups]) => {
    const parsed = parseWizard(
      { version: 1, title: "Sign-up", description: "", avatar: "round", lists, steps: steps(input) },
      [],
    );
    expect(parsed.ok, JSON.stringify(parsed.issues)).toBe(true);
    return parsed.issues.map((i) => i.message);
  };

  it("takes a row of the list's columns", () => {
    expect(messages({ list: "signups", rows: [{ name: "{{name}}" }] })).toEqual([]);
  });

  it("names a list the wizard does not have", () => {
    expect(messages({ list: "leads", rows: [{ name: "{{name}}" }] })).toEqual([
      'list_write names unknown list "leads".',
    ]);
  });

  it("names a row key that is no column", () => {
    expect(messages({ list: "signups", rows: [{ name: "{{name}}", mail: "{{name}}" }] })).toEqual([
      'list_write row 1: "mail" is no column of list "signups" (name, email, zip, guests).',
    ]);
  });

  it("asks for rows or deletes", () => {
    expect(messages({ list: "signups" })).toEqual([
      'list_write has "rows" to save or "delete", or both.',
    ]);
  });

  it("checks the templates of the rows", () => {
    expect(messages({ list: "signups", rows: [{ name: "{{nobody}}" }] }).join("\n")).toContain(
      "nobody",
    );
  });

  it("keeps any other plain name out of call.tool", () => {
    const parsed = parseWizard(
      {
        version: 1,
        title: "Sign-up",
        description: "",
        avatar: "round",
        lists: [signups],
        steps: [
          { id: "save", type: "tool", title: "Save", call: { tool: "list_read", input: { list: "signups" } } },
          { id: "done", type: "result", title: "Done", deliverables: [] },
        ],
      },
      [],
    );
    expect(parsed.ok).toBe(false);
  });
});
