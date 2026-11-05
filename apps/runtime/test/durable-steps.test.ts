import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateWizard, type WizardDefinition } from "@engenty/wizards-shared/definition";
import { createTool } from "@mastra/core/tools";
import { APICallError } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * A durable agent step in one process: what a person and the doors see of it, what it falls back
 * to, and what it leaves behind. The crashes are in durable-turn.test.ts, as real processes.
 */
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-durable-steps-"));
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.RUNTIME_ROLE = "runner";
process.env.FEATURES = "durableRuns=on,broker=off";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const tail = (reason: string) => ({
  type: "finish",
  finishReason: { unified: reason, raw: reason },
  usage,
});
const start = { type: "stream-start", warnings: [] };
const call = (id: string, name: string, input: unknown) => [
  start,
  { type: "tool-call", toolCallId: id, toolName: name, input: JSON.stringify(input) },
  tail("tool-calls"),
];
const say = (text: string) => [
  start,
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: text },
  { type: "text-end", id: "t" },
  tail("stop"),
];
const resultsOf = (options: any, name?: string) =>
  options.prompt
    .filter((m: any) => m.role === "tool")
    .flatMap((m: any) => m.content)
    .filter((c: any) => c.type === "tool-result" && (!name || c.toolName === name));

/** The model's next move, per test: what it answers given what it has seen. */
let script: (options: any) => unknown[] = () => say("done");
let modelCalls = 0;
const model = new MockLanguageModelV3({
  doGenerate: async (options: any) => ({
    content: script(options)
      .filter((part: any) => part.type === "text-delta")
      .map((part: any) => ({ type: "text", text: part.delta })) as never,
    finishReason: { unified: "stop", raw: "stop" },
    usage,
    warnings: [],
  }),
  doStream: async (options: any) => {
    modelCalls += 1;
    return { stream: convertArrayToReadableStream(script(options) as never[]) };
  },
});
let vendor = "test";
vi.mock("../src/models.js", async (original) => ({
  ...(await original<typeof import("../src/models.js")>()),
  textModel: async () => ({ model, ref: "test/scripted", vendor, gateway: false, metered: false }),
}));
/** The switch of the whole plan, as the runner reads it. */
let switchOn = true;
vi.mock("../src/broker/effect.js", async (original) => ({
  ...(await original<typeof import("../src/broker/effect.js")>()),
  effectsOn: async () => switchOn,
}));
vi.mock("../src/engine/requirements.js", async (original) => ({
  ...(await original<typeof import("../src/engine/requirements.js")>()),
  missingModelsSaid: async () => [],
}));

/** What the step's outside tool did, in the order it did it. */
let acted: string[] = [];
let answerChars = 0;
vi.mock("../src/tools/index.js", async (original) => ({
  ...(await original<typeof import("../src/tools/index.js")>()),
  buildStepTools: async (_step: unknown, ctx: any) => {
    const { brokerHost } = await import("../src/broker/host.js");
    const { codeTool, toolCallIdOf } = await import("../src/tools/code.js");
    const send = createTool({
      id: "send",
      description: "Sends something.",
      inputSchema: z.object({ to: z.string() }),
      execute: async (input, context) => {
        const out = await brokerHost({
          who: { kind: "step", id: ctx.stepId } as never,
          where: { runId: ctx.runId, stepId: ctx.stepId },
          url: new URL("https://mail.example/send"),
          method: "POST",
          effect: { turn: ctx.turn, toolCallId: toolCallIdOf(context, "send", input) },
          handler: async () => {
            acted.push(input.to);
            return { sent: input.to, filler: "x".repeat(answerChars) };
          },
        });
        return out.ok ? out.result : { uncertain: true };
      },
    });
    const program = codeTool({ send }, ctx);
    return {
      assets: [],
      instructions: program?.instructions,
      tools: { send, ...(program ? { [program.tool.id]: program.tool } : {}) },
    };
  },
}));

let client: typeof import("../src/db/client");
let runner: typeof import("../src/engine/runner");
let wizards: typeof import("../src/services/wizards");
let services: typeof import("../src/services/runs");
let shares: typeof import("../src/services/shares");
let app: { fetch: (req: Request) => Response | Promise<Response> };

const T = "tenant-durable-steps";
const OTHER = "tenant-durable-steps-2";
const USER = "user-d";
const inTenant = <R>(fn: () => Promise<R>, tenant = T) => client.withTenant(tenant, fn);

const agentStep = (over: Record<string, unknown> = {}) => ({
  id: "work",
  type: "agent",
  title: "Work",
  instructions: "Do it.",
  tools: [],
  output: { format: "text" },
  durable: true,
  ...over,
});
const definitionOf = (...steps: unknown[]) =>
  ({
    version: 1,
    title: "Turn",
    description: "",
    avatar: "round",
    steps: [...steps, { id: "done", type: "result", title: "Fertig", deliverables: [] }],
  }) as unknown as WizardDefinition;

async function until(ok: () => Promise<boolean> | boolean, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok()) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

const row = (id: string, tenant = T) =>
  inTenant(() => client.db.query.run.findFirst({ where: eq(client.schema.run.id, id) }), tenant);

const startRun = (definition: WizardDefinition, tenant = T) =>
  inTenant(async () => {
    const created = await wizards.createWizard(USER, { definition });
    const w = await wizards.ownedWizard(USER, created.id);
    return runner.createRun({
      wizardId: w.id,
      definition: w.draft,
      files: [],
      version: null,
      mode: "test",
      userId: USER,
    });
  }, tenant);

const waitFor = async (id: string, status: string, tenant = T, ms = 30_000) => {
  const reached = await until(async () => (await row(id, tenant))?.status === status, ms);
  const r = await row(id, tenant);
  expect({ reached, status: r?.status, error: r?.error }).toEqual({
    reached: true,
    status,
    error: null,
  });
  return r!;
};

/** Mastra's rows of a tenant, by run id. */
const snapshots = async (tenant = T) => {
  const db = await client.tenantClient(tenant);
  const found = await db.execute(
    "SELECT workflow_name, run_id, length(snapshot) AS size FROM mastra_workflow_snapshot",
  );
  return found.rows as unknown as { workflow_name: string; run_id: string; size: number }[];
};

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  runner = await import("../src/engine/runner");
  wizards = await import("../src/services/wizards");
  services = await import("../src/services/runs");
  shares = await import("../src/services/shares");
  app = (await import("../src/app")).default;
  runner.startRunner();
}, 60_000);

afterAll(async () => {
  await runner.stopRunner();
});

beforeEach(() => {
  vendor = "test";
  switchOn = true;
  modelCalls = 0;
  acted = [];
  answerChars = 0;
  script = () => say("done");
});

vi.setConfig({ testTimeout: 60_000 });

describe("the format", () => {
  const issuesOf = (over: Record<string, unknown>) =>
    validateWizard(definitionOf(agentStep(over)))
      .map((i) => i.message)
      .filter((m) => /durable/i.test(m));

  it("takes durable on an AI step", () => {
    expect(issuesOf({})).toEqual([]);
    expect(issuesOf({ tools: ["web_search", "http", "code"] })).toEqual([]);
  });

  it("refuses the browser and the sandbox, whose state is gone when the step goes on", () => {
    expect(issuesOf({ tools: ["browser"] })[0]).toContain('"browser"');
    expect(issuesOf({ tools: ["sandbox"] })[0]).toContain('"sandbox"');
    expect(issuesOf({ durable: false, tools: ["browser"] })).toEqual([]);
  });

  it("says durable does nothing with each and with call", () => {
    expect(issuesOf({ each: "lists.x" }).join()).toContain('"each"');
    expect(
      issuesOf({
        call: { tool: "x_y", input: {} },
        output: { format: "json" },
      }).join(),
    ).toContain('"call"');
  });
});

describe("a turn", () => {
  it("runs to its result as any step, and leaves no snapshot", async () => {
    script = (options) =>
      resultsOf(options).length
        ? say("The last message.")
        : [
            start,
            { type: "text-start", id: "a" },
            { type: "text-delta", id: "a", delta: "I look first. " },
            { type: "text-end", id: "a" },
            ...call("c-1", "send", { to: "anna" }).slice(1),
          ];
    const id = await startRun(definitionOf(agentStep()));
    const r = await waitFor(id, "done");
    expect(r.state.outputs.work?.text).toBe("The last message.");
    expect(r.state.turn).toBeUndefined();
    expect((await snapshots()).filter((s) => s.run_id.startsWith(id))).toEqual([]);
    // Effects carry the turn's id, whose first part is the run's.
    const effects = await inTenant(() => client.db.query.runEffect.findMany());
    expect(effects.find((e) => e.runId === id)?.id).toMatch(new RegExp(`^${id}\\.[^:]+:c-1$`));
  });

  it("books each model step, as the person sees the run's cost grow", async () => {
    script = (options) =>
      resultsOf(options, "send").length < 2
        ? call(`c-${resultsOf(options).length}`, "send", { to: "anna" })
        : say("done");
    const id = await startRun(definitionOf(agentStep()));
    const r = await waitFor(id, "done");
    const costs = await inTenant(() => client.db.query.runCost.findMany());
    const mine = costs.find((c) => c.runId === id);
    // Three model steps at one token each way: the same as a step that is no turn books at once.
    const { tokenCostUsd } = await import("../src/models.js");
    const { usdToMicros } = await import("../src/credits/credits.js");
    const oneStep = usdToMicros(
      tokenCostUsd("test/scripted", { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 }),
    );
    expect(mine?.micros).toBe(3 * oneStep);
    expect(r.costMicros).toBe(3 * oneStep);
  });

  it("reports a json step's entries as they are written, and keeps its data", async () => {
    const entries = Array.from({ length: 12 }, (_, i) => `Rezept ${i} ${"y".repeat(60)}`);
    const json = `\`\`\`json\n${JSON.stringify({ recipes: entries, note: "fertig" })}\n\`\`\``;
    script = () => [
      start,
      { type: "text-start", id: "t" },
      ...json.match(/.{1,120}/gs)!.map((delta) => ({ type: "text-delta", id: "t", delta })),
      { type: "text-end", id: "t" },
      tail("stop"),
    ];
    const id = await startRun(
      definitionOf(
        agentStep({
          output: {
            format: "json",
            fields: [
              { id: "recipes", kind: "list", description: "Rezepte" },
              { id: "note", kind: "text", description: "Eine Notiz" },
            ],
          },
        }),
      ),
    );
    const r = await waitFor(id, "done");
    expect((r.state.outputs.work?.json as { note: string }).note).toBe("fertig");
    const events = await inTenant(() => client.db.query.runEvent.findMany());
    const found = events.filter(
      (e) => e.runId === id && e.note?.code === "found",
    );
    expect(found.length).toBeGreaterThan(5);
  });

  it("stops before a second write when a server repeats tool call ids", async () => {
    // A server that counts its ids per model step: every call is "call_0". Mastra shows its model
    // only the first result, and `run_effect` would take the second write for the first.
    script = (options) => {
      const n = resultsOf(options, "send").length;
      return n < 2 ? call("call_0", "send", { to: `person-${n}` }) : say("done");
    };
    const id = await startRun(definitionOf(agentStep()));
    await until(async () => (await row(id))?.status === "failed");
    const r = await row(id);
    expect(r?.status).toBe("failed");
    expect(r?.error).toContain("tool call ids");
    expect(acted).toEqual(["person-0"]);
    expect(modelCalls).toBe(2);
  });

  const unavailable = () =>
    new APICallError({
      message: "status 503",
      url: "http://x",
      requestBodyValues: {},
      statusCode: 503,
      responseHeaders: {},
      isRetryable: true,
    });

  it("doesn't start a failed turn over once it acted: its calls would get new ids", async () => {
    script = (options) => {
      if (resultsOf(options, "send").length) {
        throw unavailable();
      }
      return call(`call_${modelCalls}`, "send", { to: "anna" });
    };
    const id = await startRun(definitionOf(agentStep()));
    expect(await until(async () => (await row(id))?.status === "failed")).toBe(true);
    const r = await row(id);
    expect(r?.state.turn?.acted).toBe(true);
    expect(acted).toEqual(["anna"]);
  });

  it("tries a failed turn again that didn't act", async () => {
    script = () => {
      throw unavailable();
    };
    const id = await startRun(definitionOf(agentStep()));
    expect(await until(async () => (await row(id))?.status === "sleeping")).toBe(true);
    const r = await row(id);
    expect(r?.state.pause).toEqual({ kind: "retry" });
    expect(r?.state.turn?.acted).toBeUndefined();
    await inTenant(() => runner.cancel(id));
  });

  it("keeps a program's writes: run again, the same program acts on nothing twice", async () => {
    const code = `
      const a = await external_send({ to: "anna" });
      const b = await external_send({ to: "ben" });
      const c = await external_send({ to: "anna" });
      return [a.sent, b.sent, c.sent];`;
    let program = 0;
    script = (options) => {
      const n = resultsOf(options, "execute_typescript").length;
      program += 1;
      // The model repeats the same call id, as a crash in the program makes Mastra do.
      return n === 0
        ? call("program-1", "execute_typescript", { code })
        : say(`ran ${program}`);
    };
    const id = await startRun(definitionOf(agentStep({ tools: ["code"] })));
    await waitFor(id, "done");
    expect(acted).toEqual(["anna", "ben", "anna"]);
    const rows = (await inTenant(() => client.db.query.runEffect.findMany())).filter(
      (e) => e.runId === id,
    );
    // Three writes, three rows: anna twice, by how often she was written to.
    expect(rows.map((e) => e.state)).toEqual(["done", "done", "done"]);
    expect(new Set(rows.map((e) => e.id)).size).toBe(3);
    expect(rows.filter((e) => e.id.endsWith("/1"))).toHaveLength(1);

    // What a crash does: the same program under the same tool call id, in the same turn.
    const { toolCallIdOf, codeTool } = await import("../src/tools/code.js");
    expect(toolCallIdOf({ agent: { toolCallId: "direct" } }, "send", {})).toBe("direct");
    expect(codeTool).toBeTypeOf("function");
  });

  it("runs as any step while the switch is off: no turn, no question, no snapshot", async () => {
    switchOn = false;
    let offered: string[] = [];
    script = (options) => {
      offered = (options.tools ?? []).map((tool: { name: string }) => tool.name);
      return say("done");
    };
    const id = await startRun(definitionOf(agentStep()));
    const r = await waitFor(id, "done");
    expect(r.state.outputs.work?.text).toBe("done");
    expect(offered).toContain("send");
    expect(offered).not.toContain("ask_person");
    expect((await snapshots()).filter((s) => s.run_id.startsWith(id))).toEqual([]);
  });

  it("falls back to a normal step on an installed client, and says so", async () => {
    vendor = "claude";
    const id = await startRun(definitionOf(agentStep()));
    const r = await waitFor(id, "done");
    expect(r.state.outputs.work?.text).toBe("done");
    const events = await inTenant(() => client.db.query.runEvent.findMany());
    expect(
      events.some(
        (e) => e.runId === id && e.note?.code === "noDurable",
      ),
    ).toBe(true);
    expect((await snapshots()).filter((s) => s.run_id.startsWith(id))).toEqual([]);
  });
});

describe("a turn that asks a person", () => {
  const asksThenSends = (options: any) => {
    const answers = resultsOf(options, "ask_person");
    if (!answers.length) {
      return call("ask-1", "ask_person", { question: "Welches Angebot?" });
    }
    return resultsOf(options, "send").length
      ? say(`Done with ${JSON.stringify(answers[0].output)}`)
      : call("send-1", "send", { to: "anna" });
  };

  it("lets the run wait with the question in the view, and goes on with the answer", async () => {
    script = asksThenSends;
    const id = await startRun(definitionOf(agentStep()));
    const waiting = await waitFor(id, "waiting_input");
    expect(waiting.state.turn?.question).toBe("Welches Angebot?");
    // Apart from `run.ask`: nothing wipes it, and nothing holds the run.
    expect(waiting.ask).toBeNull();
    const view = await inTenant(() => runner.runView(waiting, {} as never));
    expect(view.question).toBe("Welches Angebot?");
    expect(view.ask).toBeNull();
    expect((await snapshots()).filter((s) => s.run_id.startsWith(id)).length).toBeGreaterThan(0);

    await inTenant(() => runner.answerTurn(id, "Das vom 28. Oktober"));
    const done = await waitFor(id, "done");
    expect(done.state.outputs.work?.text).toContain("Das vom 28. Oktober");
    expect(acted).toEqual(["anna"]);
    const view2 = await inTenant(() => runner.runView(done, {} as never));
    expect(view2.question).toBeNull();
  });

  it("refuses an answer when nothing is asked, and a second answer", async () => {
    script = asksThenSends;
    const id = await startRun(definitionOf(agentStep()));
    await waitFor(id, "waiting_input");
    await inTenant(() => runner.answerTurn(id, "one"));
    await expect(inTenant(() => runner.answerTurn(id, "two"))).rejects.toThrow();
    await waitFor(id, "done");
    await expect(inTenant(() => runner.answerTurn(id, "three"))).rejects.toThrow();
  });

  it("goes on waiting when a runner comes to a question it stopped at", async () => {
    // A process that died after the turn suspended and before the row said it waits.
    script = asksThenSends;
    const id = await startRun(definitionOf(agentStep()));
    const waiting = await waitFor(id, "waiting_input");
    await inTenant(async () => {
      await client.db
        .update(client.schema.run)
        .set({ status: "running" })
        .where(eq(client.schema.run.id, waiting.id));
      await runner.kick(id);
    });
    const again = await waitFor(id, "waiting_input");
    expect(again.state.turn?.question).toBe("Welches Angebot?");
    expect(modelCalls).toBe(1);
    await inTenant(() => runner.answerTurn(id, "gut"));
    await waitFor(id, "done");
  });

  it("gives up the turn when the person goes back, and starts it anew", async () => {
    script = asksThenSends;
    const id = await startRun(
      definitionOf(
        { id: "start", type: "page", title: "Start", fields: [{ id: "name", kind: "text", label: "Name" }] },
        agentStep(),
      ),
    );
    await inTenant(() => runner.submitPage(id, "start", { name: "Anna" }));
    const waiting = await waitFor(id, "waiting_input");
    expect(waiting.cursor).toBe("work");
    const first = waiting.state.turn?.id;
    await inTenant(() => runner.goBack(id));
    const back = await row(id);
    expect(back?.cursor).toBe("start");
    expect(back?.state.turn).toBeUndefined();
    await inTenant(() => runner.submitPage(id, "start", { name: "Ben" }));
    const second = await until(async () => {
      const r = await row(id);
      return r?.cursor === "work" && r.status === "waiting_input";
    });
    expect(second).toBe(true);
    expect((await row(id))?.state.turn?.id).not.toBe(first);
    await inTenant(() => runner.cancel(id));
  });

  it("is answered through the public door", async () => {
    script = asksThenSends;
    const cookie = "wz_vid=visitor-durable-0123456789ab";
    const { token, wizard } = await inTenant(async () => {
      const created = await wizards.createWizard(USER, {
        definition: definitionOf(agentStep()),
      });
      await wizards.publishWizard(USER, created.id);
      const w = await wizards.ownedWizard(USER, created.id);
      return { token: w.shareToken, wizard: created.id };
    });
    expect(wizard).toBeTruthy();
    const post = (path: string, body: unknown) =>
      app.fetch(
        new Request(`http://localhost:5181${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify(body),
        }),
      );
    const started = await post(`/api/public/wizards/${token}/runs`, {});
    expect(started.status).toBeLessThan(300);
    const { runId: id } = (await started.json()) as { runId: string };
    await waitFor(id, "waiting_input");
    const empty = await post(`/api/runs/${id}/question`, { answer: "  " });
    expect(empty.status).toBeGreaterThanOrEqual(400);
    const stranger = await app.fetch(
      new Request(`http://localhost:5181/api/runs/${id}/question`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: "wz_vid=someone-else-0123456789ab" },
        body: JSON.stringify({ answer: "nein" }),
      }),
    );
    expect(stranger.status).toBe(404);
    const answered = await post(`/api/runs/${id}/question`, { answer: "Das erste" });
    expect(answered.status).toBe(200);
    await waitFor(id, "done");
    const late = await post(`/api/runs/${id}/question`, { answer: "Noch was" });
    expect(late.status).toBe(409);
  });

  it("tells an MCP client what to ask, and takes the answer", async () => {
    script = asksThenSends;
    const id = await startRun(definitionOf(agentStep()));
    await waitFor(id, "waiting_input");
    const report = await inTenant(() => services.runReport(USER, id));
    expect((report as { waitingFor?: { question?: string } }).waitingFor?.question).toBe(
      "Welches Angebot?",
    );
    await inTenant(() => services.answerRunQuestion(USER, id, "Das zweite"));
    await waitFor(id, "done");
  });

  it("stops the turn on a cancel: no further model step, no further action", async () => {
    script = (options) => {
      const n = resultsOf(options, "send").length;
      return n >= 8 ? say("done") : call(`c-${n}`, "send", { to: `person-${n}` });
    };
    const id = await startRun(definitionOf(agentStep({ tools: [] })));
    await until(() => acted.length >= 2, 15_000);
    await inTenant(() => runner.cancel(id));
    await new Promise((r) => setTimeout(r, 1500));
    const after = acted.length;
    await new Promise((r) => setTimeout(r, 500));
    expect(acted.length).toBe(after);
    expect(after).toBeLessThan(8);
    expect((await row(id))?.status).toBe("cancelled");
  });
});

describe("the turn's end", () => {
  it("is on the row before Mastra drops the snapshot", async () => {
    // A process that dies in between would start the whole turn over, with new tool call ids.
    const { DurableAgent } = await import("@mastra/core/agent/durable");
    const seen: unknown[] = [];
    let id = "";
    const original = DurableAgent.prototype.deleteRunSnapshots;
    DurableAgent.prototype.deleteRunSnapshots = async function (runId: string) {
      const r = id ? await row(id) : null;
      seen.push(r?.state.turn?.end ?? (r?.state.outputs.work ? "saved" : null));
      return original.call(this, runId);
    };
    try {
      script = () => say("The end.");
      id = await startRun(definitionOf(agentStep()));
      await waitFor(id, "done");
    } finally {
      DurableAgent.prototype.deleteRunSnapshots = original;
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(Boolean)).toBe(true);
  });
});

describe("what a run leaves behind", () => {
  it("removes a waiting turn's snapshot with the run, and nobody else's", async () => {
    script = () => call("ask-1", "ask_person", { question: "Was noch?" });
    const gone = await startRun(definitionOf(agentStep()));
    const stays = await startRun(definitionOf(agentStep()));
    await waitFor(gone, "waiting_input");
    await waitFor(stays, "waiting_input");
    expect((await snapshots()).some((s) => s.run_id.startsWith(gone))).toBe(true);
    await inTenant(async () => {
      await client.db
        .update(client.schema.run)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(client.schema.run.id, gone));
      await shares.purgeExpiredRuns();
    });
    const left = await snapshots();
    expect(left.some((s) => s.run_id.startsWith(gone))).toBe(false);
    expect(left.some((s) => s.run_id.startsWith(stays))).toBe(true);
    // What this leaves is exactly what a chat's Mastra store has: no other table holds the run.
    const db = await client.tenantClient(T);
    const tables = await db.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'mastra_%'",
    );
    for (const { name } of tables.rows as unknown as { name: string }[]) {
      const columns = await db.execute(`PRAGMA table_info(${name})`);
      const runColumn = (columns.rows as unknown as { name: string }[]).find((c) =>
        ["run_id", "runId"].includes(c.name),
      );
      if (runColumn) {
        const found = await db.execute({
          sql: `SELECT count(*) AS n FROM ${name} WHERE ${runColumn.name} LIKE ?`,
          args: [`${gone}%`],
        });
        expect({ name, rows: (found.rows[0] as unknown as { n: number }).n }).toEqual({
          name,
          rows: 0,
        });
      }
    }
    await inTenant(() => runner.cancel(stays));
  });
});

describe("two tenants in one process", () => {
  it("keeps each turn's snapshot in its own database, and both run at once", async () => {
    script = (options) => {
      const asked = resultsOf(options, "ask_person").length;
      const sent = resultsOf(options, "send").length;
      if (!asked) {
        return call(`ask-${modelCalls}`, "ask_person", { question: "Wer?" });
      }
      return sent < 3 ? call(`send-${modelCalls}-${sent}`, "send", { to: "x" }) : say("done");
    };
    const a = await startRun(definitionOf(agentStep()), T);
    const b = await startRun(definitionOf(agentStep()), OTHER);
    await waitFor(a, "waiting_input", T);
    await waitFor(b, "waiting_input", OTHER);
    expect((await snapshots(T)).some((s) => s.run_id.startsWith(a))).toBe(true);
    expect((await snapshots(T)).some((s) => s.run_id.startsWith(b))).toBe(false);
    expect((await snapshots(OTHER)).some((s) => s.run_id.startsWith(b))).toBe(true);
    expect((await snapshots(OTHER)).some((s) => s.run_id.startsWith(a))).toBe(false);
    await Promise.all([
      inTenant(() => runner.answerTurn(a, "A"), T),
      inTenant(() => runner.answerTurn(b, "B"), OTHER),
    ]);
    const [doneA, doneB] = await Promise.all([
      waitFor(a, "done", T),
      waitFor(b, "done", OTHER),
    ]);
    expect(doneA.state.outputs.work?.text).toBe("done");
    expect(doneB.state.outputs.work?.text).toBe("done");
  });
});

/**
 * A turn stored by the pinned Mastra, resumed on every run of this test: a Mastra upgrade that can
 * no longer read what a waiting run has stored fails here, before it reaches a run that waits.
 * `WRITE_TURN_FIXTURE=1` stores a new one, after looking at why the old one stopped working.
 */
describe("a turn stored by an earlier Mastra", () => {
  const file = join(__dirname, "fixtures", "durable-turn-suspended.json");
  const rowsOf = async (turn: string) => {
    const db = await client.tenantClient(T);
    const rows = await db.execute({
      sql: "SELECT workflow_name, run_id, resourceId, json(snapshot) AS snapshot, createdAt, updatedAt FROM mastra_workflow_snapshot WHERE run_id = ?",
      args: [turn],
    });
    return rows.rows.map((r) => ({ ...r }));
  };

  it.runIf(process.env.WRITE_TURN_FIXTURE)("is stored", async () => {
    script = () => call("ask-stored", "ask_person", { question: "Stored question?" });
    const id = await startRun(definitionOf(agentStep()));
    const r = await waitFor(id, "waiting_input");
    const turn = r.state.turn?.id as string;
    const { version } = JSON.parse(
      readFileSync(join(__dirname, "../node_modules/@mastra/core/package.json"), "utf8"),
    );
    writeFileSync(
      file,
      `${JSON.stringify({ mastra: version, turn, rows: await rowsOf(turn) }, null, 1)}\n`,
    );
  });

  it("goes on with the answer", async () => {
    const stored = JSON.parse(readFileSync(file, "utf8")) as {
      mastra: string;
      turn: string;
      rows: Record<string, unknown>[];
    };
    expect(stored.mastra).toMatch(/^\d+\.\d+\.\d+/);
    const db = await client.tenantClient(T);
    const definition = definitionOf(agentStep());
    const id = await startRun(definition);
    await waitFor(id, "done");
    for (const r of stored.rows) {
      const names = Object.keys(r);
      await db.execute({
        sql: `INSERT OR REPLACE INTO mastra_workflow_snapshot (${names.join(",")}) VALUES (${names.map((n) => (n === "snapshot" ? "jsonb(?)" : "?")).join(",")})`,
        args: names.map((n) => r[n]) as never[],
      });
    }
    await inTenant(() =>
      client.db
        .update(client.schema.run)
        .set({
          status: "waiting_input",
          cursor: "work",
          state: {
            history: [],
            values: {},
            outputs: {},
            notes: {},
            turn: { stepId: "work", id: stored.turn, question: "Stored question?" },
          } as never,
        })
        .where(eq(client.schema.run.id, id)),
    );
    script = (options) =>
      resultsOf(options, "ask_person").length
        ? say(`Resumed with ${JSON.stringify(resultsOf(options, "ask_person")[0].output)}`)
        : say("It started over, which it must not.");
    await inTenant(() => runner.answerTurn(id, "from the fixture"));
    const done = await waitFor(id, "done");
    expect(done.state.outputs.work?.text).toContain("from the fixture");
  });
});

describe("a turn of 60 model steps", () => {
  it("measures its snapshot and what a checkpoint costs", { timeout: 180_000 }, async () => {
    const STEPS = 60;
    const CHARS = 8000; // What a connector's answer is clipped to.
    answerChars = CHARS;
    const db = await client.tenantClient(T);
    const sizes: number[] = [];
    const times: number[] = [];
    let turnId = "";
    script = (options) => {
      const n = resultsOf(options, "send").length;
      times.push(Date.now());
      return n < STEPS - 1 ? call(`c-${n}`, "send", { to: `person-${n}` }) : say("done");
    };
    const definition = definitionOf(
      agentStep({ connections: ["hub"] }),
    );
    (definition as unknown as { connections: unknown[] }).connections = [
      { id: "hub", connector: "hubspot", actions: ["list_contacts"] },
    ];
    const started = Date.now();
    const id = await startRun(definition);
    const look = setInterval(async () => {
      turnId ||= (await row(id))?.state.turn?.id ?? "";
      if (turnId) {
        const rows = await db.execute({
          sql: "SELECT sum(length(snapshot)) AS size FROM mastra_workflow_snapshot WHERE run_id = ?",
          args: [turnId],
        });
        const size = Number((rows.rows[0] as unknown as { size: number }).size ?? 0);
        if (size) {
          sizes.push(size);
        }
      }
    }, 500);
    const r = await waitFor(id, "done", T, 150_000);
    clearInterval(look);
    const ms = Date.now() - started;
    expect(acted).toHaveLength(STEPS - 1);
    expect(r.state.outputs.work?.text).toBe("done");
    const biggest = Math.max(...sizes);
    const gap = (a: number, b: number) => Math.round((times[b] - times[a]) / (b - a));
    console.log(
      `[60 steps] ms per model step: steps 1-10 ${gap(0, 10)}, 20-30 ${gap(20, 30)}, 40-50 ${gap(40, 50)}, 50-59 ${gap(50, 59)}`,
    );
    console.log(
      `[60 steps] ${STEPS} model steps, ${CHARS} characters per tool answer: ${ms} ms in all, ${Math.round(ms / STEPS)} ms per step, largest snapshot ${Math.round(biggest / 1024)} KB`,
    );
    writeFileSync(
      join(process.env.DATA_DIR as string, "measure.json"),
      JSON.stringify({ STEPS, CHARS, ms, biggest }),
    );
    // What the conversation holds, a few times over at most: both of Mastra's rows hold it.
    expect(biggest).toBeLessThan(STEPS * CHARS * 6);

    // The same turn on a plain agent, without a store: what the checkpoints add.
    acted = [];
    const { Agent } = await import("@mastra/core/agent");
    const { buildStepTools } = await import("../src/tools/index.js");
    const { tools } = await buildStepTools(
      {} as never,
      { stepId: "plain", runId: "plain", signal: new AbortController().signal, emit: async () => {} } as never,
      {} as never,
      [],
    );
    const plain = new Agent({
      id: "plain",
      name: "plain",
      instructions: "x",
      model: model as never,
      tools: tools as never,
    });
    const before = Date.now();
    const stream = await plain.stream("Do it.", { maxSteps: 60 });
    for await (const _ of stream.fullStream as AsyncIterable<unknown>) {
      // Reads it to the end.
    }
    const plainMs = Date.now() - before;
    expect(acted).toHaveLength(STEPS - 1);
    console.log(`[60 steps] the same on a plain agent: ${plainMs} ms in all`);
  });
});
