import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wizardSchema } from "@engenty/wizards-shared/definition";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A wizard's agents (docs/plans/wizard-code.md) in real runs: a step an agent runs gets the
 * agent's instructions and tools; a step that lists an agent as a tool hands it a task and gets
 * its answer. The model is scripted; the agent answers in JSON as its `output` says.
 */
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-agents-run-"));
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
const finish = (reason: string) => ({
  type: "finish",
  finishReason: { unified: reason, raw: reason },
  usage,
});
const begin = { type: "stream-start", warnings: [] };

/** What each call of the model was given: its system part, its tools, its last user text. */
const seen: { system: string; tools: string[]; task: string }[] = [];
/** The tool the step's model calls first. */
let toolCall: { name: string; input: unknown } = { name: "wizard_score", input: {} };

const textOf = (content: unknown) =>
  typeof content === "string"
    ? content
    : (content as { type: string; text?: string }[])
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");

/** The model's next move: call the tool it may call, else say what came back or answer. */
function next(options: any): { call?: { name: string; input: unknown }; text?: string } {
  const system = options.prompt
    .filter((m: any) => m.role === "system")
    .map((m: any) => m.content)
    .join("\n");
  const tools = (options.tools ?? []).map((t: any) => t.name);
  const task = textOf(options.prompt.filter((m: any) => m.role === "user").at(-1)?.content ?? "");
  seen.push({ system, tools, task });
  const result = options.prompt
    .filter((m: any) => m.role === "tool")
    .flatMap((m: any) => m.content)
    .find((c: any) => c.type === "tool-result");
  if (result) {
    return { text: JSON.stringify(result.output) };
  }
  if (tools.includes(toolCall.name)) {
    return { call: toolCall };
  }
  // The researcher, asked as a tool: its answer as its output says.
  return { text: '```json\n{"offers": ["Bike A", "Bike B"]}\n```' };
}

const model = new MockLanguageModelV3({
  doGenerate: async (options: any) => {
    const move = next(options);
    return {
      content: move.call
        ? [
            {
              type: "tool-call",
              toolCallId: `c-${move.call.name}`,
              toolName: move.call.name,
              input: JSON.stringify(move.call.input),
            },
          ]
        : [{ type: "text", text: move.text }],
      finishReason: move.call
        ? { unified: "tool-calls", raw: "tool-calls" }
        : { unified: "stop", raw: "stop" },
      usage,
      warnings: [],
    } as never;
  },
  doStream: async (options: any) => {
    const move = next(options);
    const parts = move.call
      ? [
          begin,
          {
            type: "tool-call",
            toolCallId: `c-${move.call.name}`,
            toolName: move.call.name,
            input: JSON.stringify(move.call.input),
          },
          finish("tool-calls"),
        ]
      : [
          begin,
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: move.text },
          { type: "text-end", id: "t" },
          finish("stop"),
        ];
    return { stream: convertArrayToReadableStream(parts as never[]) };
  },
});
/** The classes the runs asked for. */
const classes: string[] = [];
vi.mock("../src/models.js", async (original) => ({
  ...(await original<typeof import("../src/models.js")>()),
  textModel: async (cls: string) => {
    classes.push(cls);
    return { model, ref: "test/scripted", vendor: "test", gateway: false, metered: false };
  },
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
let files: typeof import("../src/services/files");

const T = "tenant-wizard-agents";
const base = { title: "Agents", description: "", avatar: "round" };
const end = { id: "done", type: "result", title: "Done", deliverables: [] };

const SCORE = `
export const description = "Scores an offer against the budget";
export const input = {
  type: "object",
  properties: { price: { type: "number" }, budget: { type: "number" } },
  required: ["price", "budget"],
};
export async function run({ price, budget }: { price: number; budget: number }) {
  return { score: Math.max(0, 1 - price / budget) };
}
`;
const SCORER = `---
description: Scores offers against the budget
model: low
tools: [wizard.score, web_fetch]
---
You score offers against the budget. Always use the score tool.
`;
const RESEARCHER = `---
description: Finds offers for a product
model: high
tools: [web_fetch]
output:
  type: object
  properties:
    offers: { type: array, items: { type: string } }
  required: [offers]
---
You research offers on the web.
`;

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

/** Runs a wizard of one step to its end. */
async function runStep(step: Record<string, unknown>) {
  const id = await client.withTenant(T, async () => {
    const created = await wizards.createWizard("u", {
      definition: { ...base, steps: [end] } as never,
    });
    await files.seedFiles(created.id, {
      "tools/score.ts": SCORE,
      "agents/scorer.md": SCORER,
      "agents/researcher.md": RESEARCHER,
    });
    return runner.createRun({
      wizardId: created.id,
      definition: wizardSchema.parse({ ...base, steps: [step, end] }),
      files: await files.draftFiles(created.id),
      version: null,
      mode: "test",
      userId: "u",
      visitorId: null,
    });
  });
  expect(await until(async () => ["done", "failed"].includes((await row(id))?.status ?? ""))).toBe(
    true,
  );
  const r = await row(id);
  return { id, status: r?.status, error: r?.error, text: String(r?.state.outputs.work?.text ?? "") };
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
  seen.length = 0;
  classes.length = 0;
});

describe("a wizard's agents in a run", { timeout: 120_000 }, () => {
  it("run a step: the agent's instructions, model and tools, the step's task", async () => {
    toolCall = { name: "wizard_score", input: { price: 25, budget: 100 } };
    const out = await runStep({
      id: "work",
      type: "agent",
      title: "Work",
      agent: "scorer",
      instructions: "Score the bike for {{budget}}.",
      output: { format: "text" },
    });
    expect({ status: out.status, error: out.error }).toEqual({ status: "done", error: null });
    expect(JSON.parse(out.text)).toMatchObject({ value: { score: 0.75 } });
    expect(classes[0]).toBe("low");
    expect(seen[0].system).toContain("# AGENT\nYou score offers against the budget.");
    expect(seen[0].tools).toEqual(expect.arrayContaining(["wizard_score", "web_fetch"]));
    expect(seen[0].task).toContain("# TASK\nScore the bike for");
  });

  it("run a step with the tools it narrows to, and fail one that widens them", async () => {
    toolCall = { name: "wizard_score", input: { price: 25, budget: 100 } };
    const narrowed = await runStep({
      id: "work",
      type: "agent",
      title: "Work",
      agent: "scorer",
      instructions: "Score.",
      tools: ["web_fetch"],
      output: { format: "text" },
    });
    expect(narrowed.status).toBe("done");
    expect(seen[0].tools).not.toContain("wizard_score");

    const widened = await runStep({
      id: "work",
      type: "agent",
      title: "Work",
      agent: "scorer",
      instructions: "Score.",
      tools: ["browser"],
      output: { format: "text" },
    });
    expect(widened.status).toBe("failed");
  });

  it("are a tool: the step's model hands a task over and gets the agent's output", async () => {
    toolCall = { name: "agent_researcher", input: { task: "Find offers for a {{bike}}" } };
    const out = await runStep({
      id: "work",
      type: "agent",
      title: "Work",
      instructions: "Ask the researcher.",
      tools: ["agent.researcher"],
      output: { format: "text" },
    });
    expect({ status: out.status, error: out.error }).toEqual({ status: "done", error: null });
    expect(JSON.parse(out.text)).toMatchObject({ value: { offers: ["Bike A", "Bike B"] } });
    // The agent got its own system part and tools, and the task as written: no template.
    const asked = seen.find((s) => s.system.includes("# AGENT\nYou research offers"));
    expect(asked?.tools).toContain("web_fetch");
    expect(asked?.tools).not.toContain("agent_researcher");
    expect(asked?.task).toContain("Find offers for a { {bike}}");
    expect(classes).toContain("high");
    expect(await logOf(out.id)).toContainEqual(
      expect.objectContaining({
        connectionId: "tool:agent.researcher",
        actionId: "agent.researcher",
        kind: "run",
        result: "ok",
      }),
    );
  });

  it("fail a step whose agent has no file", async () => {
    const out = await runStep({
      id: "work",
      type: "agent",
      title: "Work",
      agent: "gone",
      instructions: "Go.",
      output: { format: "text" },
    });
    expect(out.status).toBe("failed");
  });
});
