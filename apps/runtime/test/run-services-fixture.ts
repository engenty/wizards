import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type WizardDefinition, wizardSchema } from "@engenty/wizards-shared/definition";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { eq } from "drizzle-orm";
import { vi } from "vitest";

/**
 * A runtime that serves the run's services, for the tests that call them (run-services-http,
 * services-contract): a wizard with a step for each service, runs of it that wait at their first
 * page with their token, and a model scripted per step, so nothing reaches the network.
 *
 * Import it first: it sets the runtime's environment and mocks before the app is loaded
 * (`loadRuntime`).
 */
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-run-services-"));
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
export const ON = "durableRuns=on,runServices=on";
process.env.FEATURES = ON;
process.env.PLUGINS_WATCH = "0";
process.env.PLUGIN_JOBS = "0";

const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 2, text: 2, reasoning: 0 },
};
/** What the model writes, in pieces, by the step the call is made for. */
export const answers: Record<string, string[]> = {
  write: ["Hello ", "there."],
  doc: ["<!doctype html><html><body><h1>Otters</h1></body></html>"],
  pick: [JSON.stringify({ otters: true })],
  torn: ["Otters "],
};
/** What the model says when it breaks off in step `torn`, with its provider's 503. */
export const TORN = "The model went away.";
/** The model as the gateway names it. */
export const MODEL = "test/scripted";

/** The row the model of step `acting` writes with its one tool call. */
export const ACTING_ROW = { title: "Beavers" };
/** The instructions of the wizard's agent `scribe`. */
export const SCRIBE = "You write as the scribe.";

/**
 * What the model writes for an agent step of the engine's, by what it is asked: `acting` calls
 * `list_write` once and then says so, `each` writes about its entry, `byagent` says whether it
 * runs as the scribe.
 */
function agentScript(step: string, prompt: unknown): unknown[] | null {
  const asked = JSON.stringify(prompt);
  if (step === "acting") {
    if (!asked.includes('"role":"tool"')) {
      return [
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "list_write",
          input: JSON.stringify({ list: "notes", rows: [ACTING_ROW] }),
        },
        { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
      ];
    }
    return textParts(["Noted the beavers."]);
  }
  if (step === "each") {
    return textParts([`About ${asked.match(/Write about (\w+)\./)?.[1] ?? "nothing"}.`]);
  }
  if (step === "byagent") {
    return textParts([asked.includes(SCRIBE) ? "As the scribe." : "Not as the scribe."]);
  }
  return null;
}

const textParts = (pieces: string[], torn = false) => [
  { type: "text-start", id: "t" },
  ...pieces.map((delta) => ({ type: "text-delta", id: "t", delta })),
  // The model breaks off after its first words.
  ...(torn ? [{ type: "error", error: Object.assign(new Error(TORN), { statusCode: 503 }) }] : []),
  { type: "text-end", id: "t" },
  { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
];

const modelFor = (step: string) =>
  new MockLanguageModelV3({
    doGenerate: async () =>
      ({
        content: [{ type: "text", text: (answers[step] ?? []).join("") }],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        warnings: [],
      }) as never,
    doStream: async (options: { prompt: unknown }) => ({
      stream: convertArrayToReadableStream([
        { type: "stream-start", warnings: [] },
        ...(agentScript(step, options.prompt) ?? textParts(answers[step] ?? [], step === "torn")),
      ] as never[]),
    }),
  });
vi.mock("../src/models.js", async (original) => ({
  ...(await original<typeof import("../src/models.js")>()),
  textModel: async (_cls: string, meta: { stepId?: string } = {}) => ({
    model: modelFor(meta.stepId ?? "-"),
    ref: MODEL,
    vendor: "test",
    gateway: false,
    metered: true,
  }),
  systemOneAccess: async () => null,
  embeddingModel: async () => null,
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

export const USER = "user-run-services";
export const SCHEMA = "CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL);";
/** The wizard's agent that runs step `byagent`, on the low class. */
const SCRIBE_FILE = `---\ndescription: Writes a line as the scribe\nmodel: low\ntools: []\n---\n${SCRIBE}\n`;

export const definition: WizardDefinition = wizardSchema.parse({
  version: 1,
  title: "Services",
  description: "",
  avatar: "round",
  data: { scope: "shared", schema: "data/schema.sql" },
  lists: [{ id: "notes", title: "Notes", columns: [{ id: "title", name: "Title", type: "text" }] }],
  steps: [
    // The run waits here: nobody answers, so it stays under way and its token opens it.
    {
      id: "start",
      type: "form",
      title: "Start",
      fields: [{ id: "name", kind: "text", label: "Name" }],
    },
    {
      id: "write",
      type: "agent",
      title: "Write",
      instructions: "Write about otters.",
      output: { format: "text" },
      tools: [],
    },
    {
      id: "torn",
      type: "agent",
      title: "Torn",
      instructions: "Write.",
      output: { format: "text" },
      tools: [],
    },
    {
      id: "pick",
      type: "agent",
      title: "Pick",
      instructions: "Pick.",
      output: { format: "text" },
      tools: [],
    },
    { id: "doc", type: "generate", title: "Doc", asset: "document", prompt: "A page on otters." },
    // Agent steps the engine runs on the services: one whose model calls a tool, one per list
    // row, one the wizard's agent runs.
    {
      id: "acting",
      type: "agent",
      title: "Acting",
      instructions: "Note the beavers.",
      output: { format: "text" },
      tools: [],
    },
    {
      id: "each",
      type: "agent",
      title: "Each",
      instructions: "Write about {{item.title}}.",
      output: { format: "text" },
      tools: [],
      foreach: "lists.notes",
    },
    {
      id: "byagent",
      type: "agent",
      title: "By agent",
      instructions: "Write a line.",
      output: { format: "text" },
      tools: [],
      agent: "scribe",
    },
    { id: "done", type: "result", title: "Done", deliverables: [] },
  ],
});

export type App = { request: (path: string, init?: RequestInit) => Response | Promise<Response> };

export interface Runtime {
  app: App;
  client: typeof import("../src/db/client");
  runner: typeof import("../src/engine/runner");
  tokens: typeof import("../src/broker/token");
  signing: typeof import("../src/secrets/signing");
}

let loaded: Promise<Runtime> | null = null;

/** The runtime's app and the modules the tests reach into, loaded once its environment is set. */
export function loadRuntime(): Promise<Runtime> {
  loaded ??= (async () => {
    const client = await import("../src/db/client");
    await client.migrateControlDb();
    return {
      client,
      runner: await import("../src/engine/runner"),
      tokens: await import("../src/broker/token"),
      signing: await import("../src/secrets/signing"),
      app: (await import("../src/app")).default as unknown as App,
    };
  })();
  return loaded;
}

export interface Started {
  tenant: string;
  runId: string;
  token: string;
}

/** A run of `definition` in `tenant` that is not driven (no runner here), and its token. */
export async function startRun(tenant: string): Promise<Started> {
  const { client, runner, tokens } = await loadRuntime();
  const wizards = await import("../src/services/wizards");
  return client.withTenant(tenant, async () => {
    const { putBlob } = await import("../src/files/blobs");
    const fileOf = async (path: string, text: string, mime: string) => {
      const bytes = Buffer.from(text, "utf8");
      return { path, hash: await putBlob(bytes), mime, size: bytes.length };
    };
    const files = [
      await fileOf("data/schema.sql", SCHEMA, "application/sql"),
      await fileOf("agents/scribe.md", SCRIBE_FILE, "text/markdown"),
    ];
    const seed = await wizards.createWizard(USER, { definition });
    const runId = await runner.createRun({
      wizardId: seed.id,
      definition,
      files,
      version: null,
      mode: "test",
      userId: USER,
    });
    const run = await client.db.query.run.findFirst({ where: eq(client.schema.run.id, runId) });
    // The agent step is at work: its turn is on the run, as the step writes it before it lists its tools.
    await client.db
      .update(client.schema.run)
      .set({ state: { ...run!.state, turn: { stepId: "write", id: `${runId}.turn` } } })
      .where(eq(client.schema.run.id, runId));
    const token = run && (await tokens.tokenOf(run));
    if (!token) {
      throw new Error("no token");
    }
    return { tenant, runId, token };
  });
}

/** A call of the run's services through the app, as a host makes it. */
export async function post(token: string | null, path: string, body: unknown = {}) {
  const { app } = await loadRuntime();
  return app.request(`http://localhost:5181/api/run-services/v1/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}
