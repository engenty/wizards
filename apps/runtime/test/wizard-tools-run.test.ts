import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wizardSchema } from "@engenty/wizards-shared/definition";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A wizard's function tools (docs/plans/wizard-code.md) in real runs: a scripted model calls
 * `wizard_<name>`, the tool runs in QuickJS, reaches the step's hosts through the broker and calls
 * the step's other tools. The network is a stub.
 */
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-tools-run-"));
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.RUNTIME_ROLE = "runner";
process.env.FEATURES = "codeSteps=on";
process.env.RUNNER_CLOCK_MS = "100";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const tail = (reason: string) => ({
  type: "finish",
  finishReason: { unified: reason, raw: reason },
  usage,
});
const begin = { type: "stream-start", warnings: [] };
const call = (name: string, input: unknown) => [
  begin,
  { type: "tool-call", toolCallId: `c-${name}`, toolName: name, input: JSON.stringify(input) },
  tail("tool-calls"),
];
const say = (text: string) => [
  begin,
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: text },
  { type: "text-end", id: "t" },
  tail("stop"),
];

/** The model calls one tool, then says what came back. */
let toolCall: { name: string; input: unknown } = { name: "wizard_score", input: {} };
const resultOf = (options: any) =>
  options.prompt
    .filter((m: any) => m.role === "tool")
    .flatMap((m: any) => m.content)
    .find((c: any) => c.type === "tool-result");
const model = new MockLanguageModelV3({
  doGenerate: async (options: any) => {
    const result = resultOf(options);
    return {
      content: result
        ? [{ type: "text", text: JSON.stringify(result.output) }]
        : [
            {
              type: "tool-call",
              toolCallId: `c-${toolCall.name}`,
              toolName: toolCall.name,
              input: JSON.stringify(toolCall.input),
            },
          ],
      finishReason: result
        ? { unified: "stop", raw: "stop" }
        : { unified: "tool-calls", raw: "tool-calls" },
      usage,
      warnings: [],
    } as never;
  },
  doStream: async (options: any) => {
    const result = resultOf(options);
    const parts = result ? say(JSON.stringify(result.output)) : call(toolCall.name, toolCall.input);
    return { stream: convertArrayToReadableStream(parts as never[]) };
  },
});
vi.mock("../src/models.js", async (original) => ({
  ...(await original<typeof import("../src/models.js")>()),
  textModel: async () => ({ model, ref: "test/scripted", vendor: "test", gateway: false, metered: false }),
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
/** The network: every request lands here and answers with its host. */
const fetched: string[] = [];
vi.mock("../src/tools/net-guard.js", async (original) => ({
  ...(await original<typeof import("../src/tools/net-guard.js")>()),
  assertPublicUrl: async (raw: string) => new URL(raw),
  safeFetch: async (raw: string) => {
    fetched.push(raw);
    return new Response(JSON.stringify({ host: new URL(raw).hostname, rate: 1.1 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
}));

let client: typeof import("../src/db/client");
let runner: typeof import("../src/engine/runner");
let wizards: typeof import("../src/services/wizards");
let files: typeof import("../src/services/files");

const T = "tenant-wizard-tools";
const base = { title: "Tools", description: "", avatar: "round" };
const end = { id: "done", type: "result", title: "Done", deliverables: [] };

const SCORE = `
export const description = "Scores an offer against the budget";
export const input = {
  type: "object",
  properties: { price: { type: "number" }, budget: { type: "number" } },
  required: ["price", "budget"],
};
export const output = { type: "object", properties: { score: { type: "number" } }, required: ["score"] };
export async function run({ price, budget }: { price: number; budget: number }) {
  return { score: Math.max(0, 1 - price / budget) };
}
`;
const RATE = `
export const description = "Reads an exchange rate";
export const input = { type: "object", properties: { url: { type: "string" } }, required: ["url"] };
export async function run({ url }, { fetch }) {
  const res = await fetch(url);
  return { status: res.status, body: await res.json() };
}
`;
const READER = `
export const description = "Reads a page through the step's web_fetch";
export const input = { type: "object", properties: { url: { type: "string" } }, required: ["url"] };
export async function run({ url }, { tools }) {
  const page = await tools.web_fetch({ url });
  return { via: "web_fetch", status: page.status };
}
`;
const BROKEN = `
export const description = "Says it returns a number";
export const input = { type: "object", properties: {} };
export const output = { type: "object", properties: { n: { type: "number" } }, required: ["n"] };
export function run() { return { n: "not a number" }; }
`;

const stepWith = (tools: string[], hosts?: string[]) => ({
  id: "work",
  type: "agent",
  title: "Work",
  instructions: "Use the tool.",
  tools,
  ...(hosts ? { hosts } : {}),
  output: { format: "text" },
});

const row = (id: string) =>
  client.withTenant(T, () =>
    client.db.query.run.findFirst({ where: eq(client.schema.run.id, id) }),
  );
async function until(ok: () => Promise<boolean>, ms = 90_000) {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (await ok()) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/** Runs a wizard of one step to its end; a guest's run when `guest`. */
async function runStep(step: unknown, guest = false) {
  const id = await client.withTenant(T, async () => {
    const created = await wizards.createWizard("u", {
      definition: { ...base, steps: [end] } as never,
    });
    await files.seedFiles(created.id, {
      "tools/score.ts": SCORE,
      "tools/rate.ts": RATE,
      "tools/reader.js": READER,
      "tools/broken.ts": BROKEN,
    });
    return runner.createRun({
      wizardId: created.id,
      definition: wizardSchema.parse({ ...base, steps: [step, end] }),
      files: await files.draftFiles(created.id),
      version: null,
      mode: guest ? "live" : "test",
      userId: guest ? null : "u",
      visitorId: guest ? "visitor-1" : null,
    });
  });
  expect(await until(async () => ["done", "failed"].includes((await row(id))?.status ?? ""))).toBe(
    true,
  );
  const r = await row(id);
  expect({ status: r?.status, error: r?.error }).toEqual({ status: "done", error: null });
  return { id, text: String(r?.state.outputs.work?.text ?? "") };
}

const logOf = (runId: string) =>
  client.withTenant(T, () =>
    client.db
      .select()
      .from(client.schema.brokerLog)
      .where(eq(client.schema.brokerLog.runId, runId)),
  );

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  runner = await import("../src/engine/runner");
  wizards = await import("../src/services/wizards");
  files = await import("../src/services/files");
  runner.startRunner();
}, 180_000);
afterAll(() => runner?.stopRunner());
beforeEach(() => {
  fetched.length = 0;
});

describe("a wizard's function tools in a run", { timeout: 120_000 }, () => {
  it("are called by the step's model, and every call is a line of the broker's log", async () => {
    toolCall = { name: "wizard_score", input: { price: 25, budget: 100 } };
    const { id, text } = await runStep(stepWith(["wizard.score"]));
    expect(JSON.parse(text)).toMatchObject({ value: { score: 0.75 } });
    const lines = await logOf(id);
    expect(lines).toContainEqual(
      expect.objectContaining({
        connectionId: "tool:wizard.score",
        actionId: "wizard.score",
        kind: "run",
        outcome: "allow",
        result: "ok",
      }),
    );
  });

  it("reach the step's hosts through the broker, and no other host", async () => {
    toolCall = { name: "wizard_rate", input: { url: "https://api.example.com/eur" } };
    const listed = await runStep(stepWith(["wizard.rate"], ["api.example.com"]));
    expect(JSON.parse(listed.text)).toMatchObject({
      value: { status: 200, body: { host: "api.example.com" } },
    });
    expect(fetched).toEqual(["https://api.example.com/eur"]);
    expect(await logOf(listed.id)).toContainEqual(
      expect.objectContaining({
        connectionId: "host:api.example.com",
        actionId: "wizard.rate",
        outcome: "allow",
      }),
    );

    fetched.length = 0;
    toolCall = { name: "wizard_rate", input: { url: "https://other.example.net/eur" } };
    const refused = await runStep(stepWith(["wizard.rate"], ["api.example.com"]));
    expect(fetched).toEqual([]);
    expect(refused.text).toContain("other.example.net");
    expect(await logOf(refused.id)).toContainEqual(
      expect.objectContaining({
        connectionId: "host:other.example.net",
        actionId: "wizard.rate",
        outcome: "deny",
        result: "not_in_grant",
        critical: true,
      }),
    );
  });

  it("call the step's other tools", async () => {
    toolCall = { name: "wizard_reader", input: { url: "https://docs.example.org/page" } };
    const { text } = await runStep(stepWith(["web_fetch", "wizard.reader"]));
    expect(JSON.parse(text)).toMatchObject({ value: { via: "web_fetch", status: 200 } });
    expect(fetched).toEqual(["https://docs.example.org/page"]);
  });

  it("hand a result that doesn't fit their output back to the model as an error", async () => {
    toolCall = { name: "wizard_broken", input: {} };
    const { id, text } = await runStep(stepWith(["wizard.broken"]));
    expect(text).toContain("output schema");
    expect(await logOf(id)).toContainEqual(
      expect.objectContaining({ actionId: "wizard.broken", result: "output_unfit" }),
    );
  });

  it("run in a guest's run, which reaches the hosts of its grant", async () => {
    toolCall = { name: "wizard_rate", input: { url: "https://api.example.com/eur" } };
    const { id, text } = await runStep(stepWith(["wizard.rate"], ["api.example.com"]), true);
    expect(JSON.parse(text)).toMatchObject({ value: { status: 200 } });
    expect(await logOf(id)).toContainEqual(
      expect.objectContaining({ whoKind: "guest", actionId: "wizard.rate", outcome: "allow" }),
    );
  });

  it("do not start while code in wizards is off", async () => {
    process.env.FEATURES = "codeSteps=off";
    try {
      await expect(
        client.withTenant(T, () =>
          runner.createRun({
            wizardId: "w-off",
            definition: wizardSchema.parse({ ...base, steps: [stepWith(["wizard.score"]), end] }),
            files: [],
            version: null,
            mode: "test",
            userId: "u",
            visitorId: null,
          }),
        ),
      ).rejects.toThrow();
    } finally {
      process.env.FEATURES = "codeSteps=on";
    }
  });
});
