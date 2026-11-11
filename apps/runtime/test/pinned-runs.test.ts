import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type WizardDefinition, wizardSchema } from "@engenty/wizards-shared/definition";
import type { FlowEvent, FlowResult } from "@engenty/wizards-shared/transition";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as pinned from "./fixtures/pinned-runs/runs.js";

/**
 * Six runs end to end through the real runner, pinned: the moves `transition()` made, the run's
 * log (`run_event`) and where the run ends. The model is scripted per step, the tool step calls a
 * plugin of the test's own (fixtures/pinned-runs/plugins), nothing reaches the network.
 *
 * The code that runs a run moves out of engine/runner.ts and engine/steps.ts in steps that change
 * no behaviour. Such a move changes nothing here: an expectation that fails after one is a change
 * of behaviour, not of the test.
 *
 * pinned-runs-services.test.ts runs this file again with the run's services over HTTP, as
 * `PINNED_SERVICES` says: `here`, a server of this process that its runner asks on loopback
 * (`RUN_SERVICES_URL`, `PINNED_PORT`); `apart`, a broker of its own on the same data folder
 * (pinned-runs-broker.test.ts), which keeps what the model was asked and the tool's calls in files
 * there. The runs end as pinned all the same.
 */
const SERVICES = process.env.PINNED_SERVICES as "here" | "apart" | undefined;
/** The data folder this process shares with its broker, when the broker is apart. */
const APART = SERVICES === "apart" ? (process.env.DATA_DIR ?? "") : "";
process.env.DATA_DIR = APART || mkdtempSync(join(tmpdir(), "wizards-pinned-runs-"));
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.RUNTIME_ROLE = "runner";
process.env.FEATURES = SERVICES ? "durableRuns=on,runServices=on" : "durableRuns=on";
process.env.RUNNER_CLOCK_MS = "100";
process.env.PLUGINS_DIR = fileURLToPath(new URL("./fixtures/pinned-runs/plugins", import.meta.url));
process.env.PLUGINS_WATCH = "0";
process.env.PLUGIN_JOBS = "0";

/** Every move of every run as `transition()` took it and answered, with its wizard's title. */
const moves = vi.hoisted(() => [] as { wizard: string; move: string }[]);
vi.mock("@engenty/wizards-shared/transition", async (original) => {
  const mod = await original<typeof import("@engenty/wizards-shared/transition")>();
  const eventOf = (e: FlowEvent) => `${e.kind}${"stepId" in e ? ` ${e.stepId}` : ""}`;
  const commandOf = ({ command, run }: FlowResult) => {
    switch (command.kind) {
      case "run":
      case "ask":
        return `${command.kind} ${command.step.id}`;
      case "decide":
        return `decide ${command.stepId} [${command.rules.join(",")}]`;
      case "fail":
        return `fail ${command.stepId}`;
      case "waitSignal":
        return `waitSignal ${command.name}:${command.key}`;
      case "sleep":
        return `sleep ${run.cursor}${run.state.pause ? ` (${run.state.pause.kind})` : ""}`;
      default:
        return `${command.kind} ${run.cursor}`;
    }
  };
  return {
    ...mod,
    transition: (...args: Parameters<typeof mod.transition>) => {
      const [def, , event] = args;
      const result = mod.transition(...args);
      moves.push({
        wizard: def.title,
        move: `${eventOf(event)} ⇒ ${commandOf(result)} → ${result.run.status}`,
      });
      return result;
    },
  };
});

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const say = (text: string) => [
  { type: "stream-start", warnings: [] },
  ...(text
    ? [
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: text },
        { type: "text-end", id: "t" },
      ]
    : []),
  { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
];

/**
 * What the model answers, per test (fixtures/pinned-runs/runs.ts): by the step that asks, whether
 * it decides (the classifier class), the prompt as text and how often this step asked. Each call
 * is kept as "<step>", or "<step>?" for a decision.
 */
const scripted = vi.hoisted(() => ({
  script: (_call: pinned.ModelCall): string => "",
  calls: [] as { run: string; name: string }[],
}));
const modelFor = (run: string, step: string, decides: boolean) => {
  const answer = (options: { prompt: unknown }) => {
    const name = `${step}${decides ? "?" : ""}`;
    scripted.calls.push({ run, name });
    const n = scripted.calls.filter((c) => c.run === run && c.name === name).length;
    return scripted.script({ step, decides, prompt: JSON.stringify(options.prompt), n });
  };
  return new MockLanguageModelV3({
    doGenerate: async (options) => {
      const text = answer(options);
      return {
        content: text ? [{ type: "text", text }] : [],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        warnings: [],
      } as never;
    },
    doStream: async (options) => ({
      stream: convertArrayToReadableStream(say(answer(options)) as never[]),
    }),
  });
};
vi.mock("../src/models.js", async (original) => ({
  ...(await original<typeof import("../src/models.js")>()),
  textModel: async (cls: string, meta: { runId?: string; stepId?: string } = {}) => ({
    model: modelFor(meta.runId ?? "-", meta.stepId ?? "-", cls === "classifier"),
    ref: "test/scripted",
    vendor: "test",
    gateway: false,
    metered: false,
  }),
  // No decision model: every decision goes to the classifier's language model, the script.
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
let reports: typeof import("../src/services/runs");

const T = "tenant-pinned-runs";
const USER = "user-pinned";
const end = { id: "done", type: "result", title: "Done", deliverables: [] };
const wizard = (title: string, steps: unknown[]) =>
  wizardSchema.parse({ version: 1, title, description: "", avatar: "round", steps });

const start = (definition: WizardDefinition) =>
  client.withTenant(T, async () => {
    const created = await wizards.createWizard(USER, { definition: wizard("Seed", [end]) });
    return runner.createRun({
      wizardId: created.id,
      definition,
      files: [],
      version: null,
      mode: "test",
      userId: USER,
    });
  });

const row = (id: string) =>
  client.withTenant(T, () =>
    client.db.query.run.findFirst({ where: eq(client.schema.run.id, id) }),
  );
const line = (id: string) =>
  client.controlDb.query.runIndex.findFirst({ where: eq(client.control.runIndex.runId, id) });

async function until(ok: () => Promise<boolean>, ms: number) {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (await ok()) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/** The run stands at `status` and no runner holds it: its log is written to the end. */
async function rests(id: string, status: string, ms = 30_000) {
  const reached = await until(async () => {
    const l = await line(id);
    return (await row(id))?.status === status && !l?.active && l?.owner == null;
  }, ms);
  const r = await row(id);
  expect({ reached, status: r?.status, error: r?.error }).toEqual({
    reached: true,
    status,
    error: null,
  });
  expect(await seen(r!)).toMatchSnapshot();
  return r!;
}

const brand = { name: "Pinned", accent: null, logoUrl: null, theme: null } as never;

/**
 * What a person and a door see of the run where it rests, as the bytes they get: the run view, the
 * same with every step's output kept in the space, and the report. Run and wizard ids, times and
 * link signatures are placeholders; everything else is pinned.
 */
async function seen(r: NonNullable<Awaited<ReturnType<typeof row>>>) {
  const json = await client.withTenant(T, async () =>
    JSON.stringify({
      view: await runner.runView(r, brand),
      kept: await runner.runView(r, brand, new Set(r.definition.steps.map((s) => s.id))),
      report: await reports.runReportOf(r),
    }),
  );
  return json
    .replaceAll(r.id, "<run>")
    .replaceAll(r.wizardId, "<wizard>")
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, "<time>")
    .replace(/"(at|createdAt|time)":\d{10,}/g, '"$1":"<ms>"')
    .replace(/exp=\d+&sig=[\w-]+/g, "exp=<exp>&sig=<sig>")
    .replace(/sig_\w+/g, "<signal>");
}

/** The run's log as [step, type, what it said]: a note by its code and params, else its text. */
const logOf = async (id: string) =>
  (
    await client.withTenant(T, () =>
      client.db
        .select()
        .from(client.schema.runEvent)
        .where(eq(client.schema.runEvent.runId, id))
        .orderBy(client.schema.runEvent.id),
    )
  ).map((e) => [
    e.stepId,
    e.type,
    e.note
      ? `${e.note.code}${e.note.params ? ` ${JSON.stringify(e.note.params)}` : ""}`
      : e.message,
  ]);

/** The moves of one wizard's runs, as "event ⇒ command → status". */
const movesOf = (title: string) => moves.filter((m) => m.wizard === title).map((m) => m.move);

/** The JSON lines the broker apart wrote to a file of the data folder. */
const keptApart = <T>(name: string): T[] => {
  const file = join(APART, name);
  return existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as T)
    : [];
};

/** What the model was asked in one run, in order. */
const callsOf = (id: string) =>
  (APART ? keptApart<{ run: string; name: string }>("calls") : scripted.calls)
    .filter((c) => c.run === id)
    .map((c) => c.name);

/** The run ended done, as pinned: its moves, what the model was asked, its log and its state. */
async function ended(id: string, run: pinned.PinnedRun, ms?: number) {
  const r = await rests(id, "done", ms);
  expect(movesOf(run.title)).toEqual(run.moves);
  expect(await logOf(id)).toEqual(run.log);
  expect(callsOf(id)).toEqual(run.calls);
  expect({ cursor: r.cursor, wakeAt: r.wakeAt }).toEqual({ cursor: "done", wakeAt: null });
  expect(r.state).toEqual(run.state);
}

const stamps = () => {
  if (APART) {
    return keptApart<{ run: string }>("stamps");
  }
  const g = globalThis as { __pinnedStamps?: { run: string }[] };
  g.__pinnedStamps ??= [];
  return g.__pinnedStamps;
};

/** The run's services of this process, served on loopback for its own runner. */
let served: { close(): void } | null = null;
/** The calls of the run's services that came over HTTP, by service and call. */
const asked = new Map<string, number>();

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  // Before a tenant's database opens: the test's plugin, with the tool step 3 calls.
  await (await import("../src/plugins/loader")).loadPlugins();
  runner = await import("../src/engine/runner");
  wizards = await import("../src/services/wizards");
  reports = await import("../src/services/runs");
  if (SERVICES === "here") {
    const { serve } = await import("@hono/node-server");
    const app = (await import("../src/app")).default;
    const fetch = (request: Request) => {
      const call = new URL(request.url).pathname.split("/api/run-services/v1/")[1];
      if (call) {
        asked.set(call, (asked.get(call) ?? 0) + 1);
      }
      return app.fetch(request);
    };
    served = serve({ fetch, port: Number(process.env.PINNED_PORT), hostname: "127.0.0.1" });
  }
  runner.startRunner();
}, 60_000);

afterAll(async () => {
  await runner.stopRunner();
  served?.close();
});

beforeEach(() => {
  scripted.script = () => "";
});

vi.setConfig({ testTimeout: 60_000 });

describe("a run, pinned end to end", () => {
  it("1: a page, an agent that writes, an approval, the result", async () => {
    const run = pinned.pageAgentReview;
    scripted.script = run.script;
    const id = await start(run.wizard);
    expect((await rests(id, "waiting_input")).cursor).toBe("ask");
    await client.withTenant(T, () => runner.submitPage(id, "ask", { topic: "otters" }));
    expect((await rests(id, "waiting_input")).cursor).toBe("check");
    await client.withTenant(T, () => runner.reviewStep(id, "check", { type: "accept" }));
    await ended(id, run);
  });

  it("2: a decision step branches, and the other branch never runs", async () => {
    const run = pinned.decision;
    scripted.script = run.script;
    const id = await start(run.wizard);
    await rests(id, "waiting_input");
    await client.withTenant(T, () =>
      runner.submitPage(id, "ask", { message: "Broken on arrival, I want my money back!" }),
    );
    await ended(id, run);
  });

  it("3: a tool step calls a plugin's tool once, with no model", async () => {
    const run = pinned.tool;
    const id = await start(run.wizard);
    await ended(id, run);
    // The tool's one call, its input filled in: "3" became a number.
    expect(stamps().filter((s) => s.run === id)).toEqual([
      { run: id, step: "stamp", word: "ab", times: 3 },
    ]);
  });

  it("4: foreach runs an agent once per entry of a list", async () => {
    const run = pinned.foreach;
    scripted.script = run.script;
    await ended(await start(run.wizard), run);
  });

  it("5: a wait for a signal, and the signal comes", async () => {
    const run = pinned.signal;
    scripted.script = run.script;
    const id = await start(run.wizard);
    const waiting = await rests(id, "waiting_signal");
    expect({ cursor: waiting.cursor, wakeAt: waiting.wakeAt }).toEqual({
      cursor: "paid",
      wakeAt: null,
    });
    const sent = await client.withTenant(T, () =>
      runner.signalRun(id, { data: { amount: 42, extra: "dropped" }, source: "test" }),
    );
    expect(sent?.runs).toBe(1);
    await ended(id, run);
  });

  it("6: a step that fails once passes on its retry", async () => {
    const run = pinned.retry;
    scripted.script = run.script;
    const id = await start(run.wizard);
    const asleep = await rests(id, "sleeping");
    expect(asleep.cursor).toBe("draft");
    // The clock wakes it after FLOW_LIMITS.failureRetryMs (10 s), with nobody's help.
    expect(asleep.wakeAt!.getTime() - Date.now()).toBeGreaterThan(5_000);
    expect(asleep.state).toEqual(pinned.retryAsleep);
    expect(movesOf(run.title)).toEqual(run.moves.slice(0, 2));
    await ended(id, run, 40_000);
  });
});

describe.runIf(SERVICES)("a run whose services are asked over HTTP", () => {
  it.runIf(SERVICES === "here")("asked them over HTTP in the six runs above", () => {
    // The model's turns, the tool, the release at each drive's end.
    expect([...asked.keys()]).toEqual(
      expect.arrayContaining(["models/agentModel", "models/agentTurn", "tools/call", "run/release"]),
    );
  });

  it("fails its step for good when it is from before tokens: no step works in the runner's process", async () => {
    const run = pinned.pageAgentReview;
    scripted.script = run.script;
    const id = await start(run.wizard);
    const resting = async (status: string) =>
      (await row(id))?.status === status && (await line(id))?.owner == null;
    expect(await until(() => resting("waiting_input"), 30_000)).toBe(true);
    await client.withTenant(T, () =>
      client.db.update(client.schema.run).set({ tokenId: null }).where(eq(client.schema.run.id, id)),
    );
    await client.withTenant(T, () => runner.submitPage(id, "ask", { topic: "otters" }));
    expect(await until(() => resting("failed"), 30_000)).toBe(true);
    const failed = await row(id);
    expect({ cursor: failed?.cursor, error: failed?.error }).toEqual({
      cursor: "write",
      error: "This run started before an update and can't go on. Start it again.",
    });
    // Nobody was asked: the step's model never wrote.
    expect(callsOf(id)).toEqual([]);
  });
});
