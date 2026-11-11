import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type HandOver, type HostApi, hostApi } from "@engenty/wizards-engine/host-api";
import { type WizardDefinition, wizardSchema } from "@engenty/wizards-shared/definition";
import type { RunHostRef } from "@engenty/wizards-shared/run";
import type { FlowEvent, FlowResult } from "@engenty/wizards-shared/transition";
import { MockLanguageModelV3 } from "ai/test";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type LocalEdge,
  type LocalEdgeOptions,
  localEdge,
  pathOf,
} from "../../edge/test/local-edge.js";

/**
 * Runs in objects on local workerd (apps/edge, through Miniflare) where it is hard for them: a
 * wait of three days, a deploy in the middle of a model call, a cancel in the middle of a tool
 * call, a hundred runs at once (docs/plans/runs-on-their-own.md, 6.4). Each wizard runs here in
 * the runtime first, then in an object, and the object's run ends as the runtime's did: the same
 * status and step, the same outputs, the same lines in its log as people see them (`runLines`),
 * the same moves of the flow.
 *
 * This runtime is a whole one (`all`): it drives its own runs, and answers the objects' services
 * and copies; the objects' requests reach its app in this process. Nothing is deployed, and no
 * model is called: the model is a script, the tool a plugin of the test's own.
 *
 * Spawns workerd: run alone with `--maxWorkers=1`. `EDGE_RUNS` sets how many runs go at once.
 */
const ORIGIN = "http://localhost:5181";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-edge-waits-"));
process.env.APP_URL = ORIGIN;
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.RUNTIME_ROLE = "all";
process.env.FEATURES = "durableRuns=on,runServices=on,runHosts=on";
process.env.RUNNER_CLOCK_MS = "100";
process.env.PLUGINS_DIR = fileURLToPath(new URL("./fixtures/edge-runs/plugins", import.meta.url));
process.env.PLUGINS_WATCH = "0";
process.env.PLUGIN_JOBS = "0";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** How many runs go to one Worker at once. */
const RUNS_AT_ONCE = Number(process.env.EDGE_RUNS ?? 100);

/** Every move the runtime's flow made, with its wizard's title: its own runs', and a start it made for an object. */
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

/**
 * What the model answers, by the step that asks; each call kept with its run. `before`: awaited in
 * the middle of a call, after the stream started and before it says anything, where a test holds
 * a call open.
 */
const scripted = vi.hoisted(() => ({
  script: (_step: string): string => "",
  calls: [] as { run: string; step: string }[],
  before: null as null | ((run: string, step: string, n: number) => Promise<void> | undefined),
}));
const modelFor = (run: string, step: string) => {
  const call = () => {
    scripted.calls.push({ run, step });
    const n = scripted.calls.filter((c) => c.run === run && c.step === step).length;
    return { text: scripted.script(step), n };
  };
  return new MockLanguageModelV3({
    doGenerate: async () => {
      const { text, n } = call();
      await scripted.before?.(run, step, n);
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        warnings: [],
      } as never;
    },
    doStream: async () => {
      const { text, n } = call();
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "t" });
          await scripted.before?.(run, step, n);
          controller.enqueue({ type: "text-delta", id: "t", delta: text });
          controller.enqueue({ type: "text-end", id: "t" });
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage,
          });
          controller.close();
        },
      });
      return { stream } as never;
    },
  });
};
vi.mock("../src/models.js", async (original) => ({
  ...(await original<typeof import("../src/models.js")>()),
  textModel: async (_cls: string, meta: { runId?: string; stepId?: string } = {}) => ({
    model: modelFor(meta.runId ?? "-", meta.stepId ?? "-"),
    ref: "test/scripted",
    vendor: "test",
    gateway: false,
    metered: false,
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
/** Each end a run's tenant set off (`statusMoved`): the plugins hear of it once per end. */
const ends = vi.hoisted(() => [] as { runId: string; status: string }[]);
vi.mock("../src/plugins/events.js", async (original) => ({
  ...(await original<typeof import("../src/plugins/events.js")>()),
  runEnded: async (runId: string, status: string) => {
    ends.push({ runId, status });
  },
}));

type App = { request: (path: string, init?: RequestInit) => Response | Promise<Response> };

let client: typeof import("../src/db/client");
let runner: typeof import("../src/engine/runner");
let wizards: typeof import("../src/services/wizards");
let tokens: typeof import("../src/broker/token");
let hosts: typeof import("../src/engine/hosts");
let hostClient: typeof import("../src/engine/run-host-client");
let app: App;

const T = "tenant-edge-waits";
const USER = "user-edge-waits";
const edges: LocalEdge[] = [];

const end = { id: "done", type: "result", title: "Done", deliverables: [] };
const wizard = (title: string, steps: unknown[]) =>
  wizardSchema.parse({ version: 1, title, description: "", avatar: "round", steps });
const agent = (id: string, title: string, instructions: string) => ({
  id,
  type: "agent",
  title,
  instructions,
  output: { format: "text" },
});

const inTenant = <R>(fn: () => Promise<R>) => client.withTenant(T, fn);
const row = (id: string) =>
  inTenant(() => client.db.query.run.findFirst({ where: eq(client.schema.run.id, id) }));
const line = (id: string) =>
  client.controlDb.query.runIndex.findFirst({ where: eq(client.control.runIndex.runId, id) });

async function until<V>(read: () => Promise<V>, ok: (v: V) => boolean, ms: number): Promise<V> {
  const stop = Date.now() + ms;
  let value = await read();
  while (!ok(value)) {
    if (Date.now() > stop) {
      throw new Error(`timed out at ${JSON.stringify(value).slice(0, 600)}`);
    }
    await new Promise((r) => setTimeout(r, 100));
    value = await read();
  }
  return value;
}

/** The objects' requests: the run's services and its copies, answered by this runtime. */
async function outbound(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin !== ORIGIN) {
    return new Response("Nothing else is reachable from here.", { status: 502 });
  }
  return app.request(`${url.pathname}${url.search}`, {
    method: request.method,
    headers: Object.fromEntries(request.headers),
    body: request.method === "GET" ? undefined : await request.text(),
  });
}

async function edgeAt(
  options: Partial<Pick<LocalEdgeOptions, "persist" | "watchdogMs" | "clock" | "port">> = {},
): Promise<LocalEdge> {
  const edge = await localEdge({
    persist: options.persist ?? mkdtempSync(join(tmpdir(), "wizards-edge-waits-objects-")),
    services: ORIGIN,
    outbound,
    probe: true,
    watchdogMs: options.watchdogMs ?? 3000,
    clock: options.clock ?? false,
    ...(options.port ? { port: options.port } : {}),
  });
  edges.push(edge);
  return edge;
}

// --- the same wizard, here and in an object -----------------------------------------------------

/** A run of `def` this runtime drives, as a test run of the studio. */
const inRuntime = (def: WizardDefinition) =>
  inTenant(async () => {
    const seed = await wizards.createWizard(USER, { definition: def });
    return runner.createRun({
      wizardId: seed.id,
      definition: def,
      files: [],
      version: null,
      mode: "test",
      userId: USER,
    });
  });

/** It stands at `status` and no runner holds it: its log is written to the end. */
async function rests(id: string, status: string, ms = 60_000) {
  await until(
    async () => ({ status: (await row(id))?.status, line: await line(id) }),
    (v) => v.status === status && !v.line?.active && v.line?.owner == null,
    ms,
  );
  return (await row(id)) as NonNullable<Awaited<ReturnType<typeof row>>>;
}

interface Placed {
  id: string;
  token: string;
  /** The run's three calls at its object, with its token. */
  api: HostApi;
}

/**
 * A run of `def` placed on an object, as the runtime starts a run for another host
 * (`createRun` with `drivenOn`): the tenant's first move, then the hand-over's body.
 */
async function placed(def: WizardDefinition, at: LocalEdge): Promise<Placed & { body: HandOver }> {
  const host: RunHostRef = { kind: "edge", url: at.url };
  return inTenant(async () => {
    const seed = await wizards.createWizard(USER, { definition: def });
    const id = await runner.createRun({
      wizardId: seed.id,
      definition: def,
      files: [],
      version: null,
      mode: "test",
      userId: USER,
      drivenOn: host,
    });
    const r = await client.db.query.run.findFirst({ where: eq(client.schema.run.id, id) });
    const token = r && (await tokens.tokenOf(r));
    if (!(r && token)) {
      throw new Error("no token");
    }
    const body: HandOver = {
      runId: id,
      token,
      definition: r.definition,
      files: r.files,
      run: {
        cursor: r.cursor,
        status: r.status,
        state: r.state,
        wakeAt: r.wakeAt?.getTime() ?? null,
        rev: r.rev,
      },
    };
    return { id, token, body, api: apiOf(id, token, at) };
  });
}

/** Hands the run to its object, as the runtime hands a run to its host. */
const handOver = (p: { body: HandOver }, at: LocalEdge) =>
  inTenant(() => hosts.handOver({ kind: "edge", url: at.url }, p.body));

async function onObject(def: WizardDefinition, at: LocalEdge): Promise<Placed> {
  const p = await placed(def, at);
  await handOver(p, at);
  return p;
}

const apiOf = (runId: string, ticket: string, at: LocalEdge): HostApi =>
  hostApi({
    url: "http://edge.local",
    runId,
    tenant: T,
    ticket,
    fetch: (input, init) => at.fetch(pathOf(input), init),
  });

/** A time, or a run's random id in a line, the same wherever the run ran. */
const plain = (value: unknown) =>
  JSON.parse(
    JSON.stringify(value).replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, "<time>"),
  ) as unknown;

/**
 * The run where it ended, as its doors show it: where it stands and its outputs (`hostedRun`),
 * and its log, [step, type, a note by its code and params, else its text] (`runLines`).
 */
async function seen(id: string) {
  return inTenant(async () => {
    const r = await client.db.query.run.findFirst({ where: eq(client.schema.run.id, id) });
    if (!r) {
      throw new Error(`no run ${id}`);
    }
    const run = await hostClient.hostedRun(r);
    const lines = await hostClient.runLines(r, 500);
    return plain({
      status: run.status,
      cursor: run.cursor,
      outputs: run.state.outputs,
      log: lines.map((e) => [
        e.stepId,
        e.type,
        e.note
          ? `${e.note.code}${e.note.params ? ` ${JSON.stringify(e.note.params)}` : ""}`
          : e.message,
      ]),
    });
  });
}

/** The moves of the runs of `title` the runtime made, from `from` on. */
const movesHere = (title: string, from = 0) =>
  moves
    .slice(from)
    .filter((m) => m.wizard === title)
    .map((m) => m.move);

/** The moves the objects made for the runs of `title`. */
const movesThere = (title: string, at: LocalEdge[]) =>
  at
    .flatMap((e) => e.moves())
    .filter((m) => m.wizard === title)
    .map((m) => m.move);

const callsOf = (id: string) => scripted.calls.filter((c) => c.run === id).map((c) => c.step);

/** What each call of the run's object did: alarm or door, and how many model calls it made. */
const objectCallsOf = (id: string, at: LocalEdge[]) =>
  at
    .flatMap((e) => e.logs)
    .flatMap((l) => {
      const m = l.match(/^\[run ([^\]]+)\] (alarm|door) call: (\{.*\})$/);
      return m && m[1] === id
        ? [{ kind: m[2], ...(JSON.parse(m[3]) as { models: number; ms: number; ended: string }) }]
        : [];
    });

/** The run's record at its tenant ended with the object, at its revision, and its end was set off once. */
async function endedAtTenant(p: Placed, status: string) {
  const { run } = await p.api.state();
  const record = await row(p.id);
  expect(record).toMatchObject({ status, cursor: run.cursor, rev: run.rev });
  expect(ends.filter((e) => e.runId === p.id)).toEqual([{ runId: p.id, status }]);
}

/** A cancel through the doors: the run's host is asked, as `POST /api/runs/:id/cancel` does. */
const cancel = (id: string) =>
  inTenant(async () => {
    const r = await client.db.query.run.findFirst({ where: eq(client.schema.run.id, id) });
    await (await hostClient.hostClientOf(r as NonNullable<typeof r>)).send({ kind: "cancel" });
  });

/** The tool `held.hold` (fixtures/edge-runs/plugins): each run's call holds until let go. */
const held = new Map<
  string,
  { entered: () => void; came: Promise<void>; go: () => void; gone: Promise<void> }
>();
function heldOf(runId: string) {
  let h = held.get(runId);
  if (!h) {
    let entered = () => {};
    let go = () => {};
    const came = new Promise<void>((r) => {
      entered = r;
    });
    const gone = new Promise<void>((r) => {
      go = r;
    });
    h = { entered, came, go, gone };
    held.set(runId, h);
  }
  return h;
}

beforeAll(async () => {
  (globalThis as { __edgeHeld?: unknown }).__edgeHeld = {
    entered: (runId: string) => heldOf(runId).entered(),
    until: (runId: string) => heldOf(runId).gone,
  };
  client = await import("../src/db/client");
  await client.migrateControlDb();
  // Before a tenant's database opens: the test's plugin, with the tool that holds.
  await (await import("../src/plugins/loader")).loadPlugins();
  runner = await import("../src/engine/runner");
  wizards = await import("../src/services/wizards");
  tokens = await import("../src/broker/token");
  hosts = await import("../src/engine/hosts");
  hostClient = await import("../src/engine/run-host-client");
  app = (await import("../src/app")).default as unknown as App;
  runner.startRunner();
}, 120_000);

afterAll(async () => {
  for (const h of held.values()) {
    h.go();
  }
  await runner?.stopRunner();
  await Promise.all(edges.map((e) => e.dispose().catch(() => undefined)));
});

beforeEach(() => {
  scripted.script = () => "";
  scripted.before = null;
});

vi.setConfig({ testTimeout: 240_000 });

describe("a run in an object ends as the same run does in the runtime", () => {
  it("waits three days: the object's alarm wakes it once, when its clock moved on three days", async () => {
    const def = wizard("Edge: three days", [
      agent("before", "Before", "Say what comes before the pause."),
      { id: "pause", type: "wait", title: "Pause", for: "3d" },
      agent("after", "After", "Say what comes after the pause."),
      end,
    ]);
    scripted.script = (step) => (step === "before" ? "Before the pause." : "After the pause.");

    // Here, the time goes by as for every wait of the runtime (durable-wait.test.ts): the wake's
    // time, in the record and in the line, is put in the past, and the runtime's clock wakes it.
    const here = await inRuntime(def);
    const asleepHere = await rests(here, "sleeping");
    expect((asleepHere.wakeAt?.getTime() ?? 0) - Date.now()).toBeGreaterThan(3 * DAY - MINUTE);
    const past = new Date(Date.now() - 1000);
    await inTenant(() =>
      client.db
        .update(client.schema.run)
        .set({ wakeAt: past })
        .where(eq(client.schema.run.id, here)),
    );
    await client.controlDb
      .update(client.control.runIndex)
      .set({ wakeAt: past })
      .where(eq(client.control.runIndex.runId, here));
    await rests(here, "done");
    const wanted = await seen(here);
    const movesWanted = movesHere(def.title);
    const from = moves.length;

    // In an object, the object's own clock goes on three days.
    const edge = await edgeAt({ clock: true });
    const p = await onObject(def, edge);
    const asleep = await until(
      () => p.api.state(),
      (s) => s.run.status === "sleeping",
      60_000,
    );
    const { now, alarm } = await edge.clock(p.id);
    const wakeAt = asleep.run.wakeAt as number;
    expect(wakeAt - now).toBeGreaterThan(3 * DAY - MINUTE);
    // The one alarm is the wait's end; nothing else wakes it before.
    expect(alarm).toBe(wakeAt);
    await new Promise((r) => setTimeout(r, 2000));
    expect((await p.api.state()).run.status).toBe("sleeping");
    expect(movesThere(def.title, [edge]).filter((m) => m.startsWith("woke"))).toEqual([]);

    await edge.clock(p.id, { advance: 3 * DAY + MINUTE });
    await until(
      () => p.api.state(),
      (s) => s.run.status === "done",
      60_000,
    );
    // Woken once, by its alarm: one alarm call took it from the wait.
    expect(movesThere(def.title, [edge]).filter((m) => m.startsWith("woke"))).toEqual([
      "woke ⇒ run after → running",
    ]);
    expect((await edge.clock(p.id)).alarm).toBeNull();

    expect(await seen(p.id)).toEqual(wanted);
    expect([...movesHere(def.title, from), ...movesThere(def.title, [edge])]).toEqual(movesWanted);
    expect(callsOf(p.id)).toEqual(callsOf(here));
    await endedAtTenant(p, "done");
    expect(ends.filter((e) => e.runId === here)).toEqual([{ runId: here, status: "done" }]);
  });

  it("is deployed in the middle of a model call: the watchdog's alarm makes the call again, under the same turn", async () => {
    const def = wizard("Edge: deploy", [
      agent("draft", "Draft", "Write a draft."),
      agent("polish", "Polish", "Polish the draft."),
      end,
    ]);
    scripted.script = (step) => (step === "draft" ? "A draft." : "The draft, polished.");
    const here = await inRuntime(def);
    await rests(here, "done");
    const wanted = await seen(here);
    const movesWanted = movesHere(def.title);
    const from = moves.length;

    // The object's first model call of the draft streams, and holds there.
    const persist = mkdtempSync(join(tmpdir(), "wizards-edge-deploy-"));
    const first = await edgeAt({ persist, clock: true });
    let current = first;
    let reached = () => {};
    const inTheMiddle = new Promise<void>((r) => {
      reached = r;
    });
    let letGo = () => {};
    const stream = new Promise<void>((r) => {
      letGo = r;
    });
    let p: Placed | null = null;
    const turns: (string | undefined)[] = [];
    scripted.before = async (run, step, n) => {
      if (run === here || step !== "draft") {
        return;
      }
      if (n === 1) {
        reached();
        await stream;
      } else if (p) {
        // The call made again: the turn it is made in, as the object keeps the run.
        turns.push((await apiOf(p.id, p.token, current).state()).run.state.turn?.id);
      }
    };
    p = await onObject(def, first);
    await inTheMiddle;
    turns.push((await p.api.state()).run.state.turn?.id);
    expect(callsOf(p.id)).toEqual(["draft"]);
    // While the stream is open, longer than the watchdog's 3 s, the call keeps setting its
    // watchdog's alarm ahead: it never comes due in the middle of the call.
    for (let i = 0; i < 10; i++) {
      const { now, alarm } = await first.clock(p.id);
      expect(alarm).toBeGreaterThan(now);
      await new Promise((r) => setTimeout(r, 500));
    }

    // The deploy: workerd goes away with the call open; the model's answer reaches nobody.
    await first.dispose();
    letGo();

    // The new version on the same storage, at the same address: the watchdog's alarm goes on
    // with the run.
    const again = await edgeAt({ persist, clock: true, port: Number(new URL(first.url).port) });
    current = again;
    p = { ...p, api: apiOf(p.id, p.token, again) };
    await until(
      () => (p as Placed).api.state(),
      (s) => s.run.status === "done",
      60_000,
    );

    // The call with no saved result is made again (2.4), under the same turn; nothing else is.
    expect(callsOf(p.id)).toEqual(["draft", "draft", "polish"]);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toEqual(expect.any(String));
    expect(turns[1]).toBe(turns[0]);
    // The new version's calls: the watchdog's alarm first, one model call each at most.
    const calls = objectCallsOf(p.id, [again]);
    expect(calls[0]).toMatchObject({ kind: "alarm" });
    expect(calls.every((c) => c.models <= 1)).toBe(true);
    expect(calls.reduce((n, c) => n + c.models, 0)).toBe(2);

    expect(await seen(p.id)).toEqual(wanted);
    expect([...movesHere(def.title, from), ...movesThere(def.title, [first, again])]).toEqual(
      movesWanted,
    );
    await endedAtTenant(p, "done");
  });

  it("is cancelled in the middle of a tool call: it ends cancelled where it stood, at once", async () => {
    const def = wizard("Edge: cancel", [
      {
        id: "hold",
        type: "tool",
        title: "Hold",
        call: { tool: "held.hold", input: { word: "ab" } },
        output: { fields: [{ id: "said", kind: "text" }] },
      },
      agent("after", "After", "Say what comes after."),
      end,
    ]);
    scripted.script = () => "After.";

    const cancelled = async (id: string, read: () => Promise<string | undefined>) => {
      await heldOf(id).came;
      // Let go after 20 s at the latest, should the cancel wait for the tool.
      const timer = setTimeout(() => heldOf(id).go(), 20_000);
      const started = performance.now();
      await cancel(id);
      const took = performance.now() - started;
      await until(read, (status) => status === "cancelled", 30_000);
      heldOf(id).go();
      clearTimeout(timer);
      return took;
    };

    const here = await inRuntime(def);
    const tookHere = await cancelled(here, async () => (await row(here))?.status);
    await rests(here, "cancelled");
    // The tool's answer came after the cancel: whatever the runtime does with it is done now.
    await new Promise((r) => setTimeout(r, 1000));
    const wanted = await seen(here);
    const movesWanted = movesHere(def.title);
    const from = moves.length;

    const edge = await edgeAt();
    const p = await onObject(def, edge);
    const tookThere = await cancelled(p.id, async () => (await p.api.state()).run.status);
    await new Promise((r) => setTimeout(r, 1000));
    console.log(
      `[cancel in a tool call] answered after ${Math.round(tookHere)} ms here, ${Math.round(tookThere)} ms at the object`,
    );
    // The cancel does not wait for the tool to answer: it stops the alarm's call where it is.
    expect(tookThere).toBeLessThan(5000);
    expect(objectCallsOf(p.id, [edge]).map((c) => `${c.kind} ${c.ended}`)).toEqual([
      "alarm stopped",
      "door rest",
    ]);

    expect(await seen(p.id)).toEqual(wanted);
    // The runtime writes its cancel on the record; the object moves the flow with it.
    expect([...movesHere(def.title, from), ...movesThere(def.title, [edge])]).toEqual([
      ...movesWanted,
      "cancel ⇒ end hold → cancelled",
    ]);
    expect(callsOf(p.id)).toEqual(callsOf(here));
    await endedAtTenant(p, "cancelled");
  });

  it(`takes ${RUNS_AT_ONCE} runs at once on one Worker, and each ends done at its tenant once`, async () => {
    const def = wizard("Edge: many", [agent("hello", "Hello", "Say hello."), end]);
    scripted.script = () => "Hello.";
    const here = await inRuntime(def);
    await rests(here, "done");
    const wanted = await seen(here);

    const edge = await edgeAt({ watchdogMs: 30_000 });
    const runs: (Placed & { body: HandOver })[] = [];
    for (let i = 0; i < RUNS_AT_ONCE; i++) {
      runs.push(await placed(def, edge));
    }
    const ids = runs.map((p) => p.id);
    const started = performance.now();
    await Promise.all(runs.map((p) => handOver(p, edge)));
    const records = await until(
      () =>
        inTenant(() => client.db.query.run.findMany({ where: inArray(client.schema.run.id, ids) })),
      (rs) => rs.filter((r) => r.status === "done").length === ids.length,
      300_000,
    );
    const wall = performance.now() - started;
    console.log(
      `[${RUNS_AT_ONCE} runs at once] all done at their tenant ${Math.round(wall)} ms after the first hand-over`,
    );
    expect(records.map((r) => r.status)).toEqual(ids.map(() => "done"));

    for (const p of runs) {
      expect(await seen(p.id)).toEqual(wanted);
      expect(callsOf(p.id)).toEqual(["hello"]);
      await endedAtTenant(p, "done");
      const calls = objectCallsOf(p.id, [edge]);
      expect(calls.every((c) => c.models <= (c.kind === "alarm" ? 1 : 0))).toBe(true);
    }
  });
});
