import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type HostApi, type HostChange, hostApi } from "@engenty/wizards-engine/host-api";
import type { RunHostRef } from "@engenty/wizards-shared/run";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type LocalEdge, localEdge, pathOf } from "../../edge/test/local-edge.js";
import * as pinned from "./fixtures/pinned-runs/runs.js";

/**
 * The six pinned runs (fixtures/pinned-runs/runs.ts), each in an object of its own on local
 * workerd (apps/edge, through Miniflare): the run's state, turns and log in the object's storage,
 * woken by the object's alarm, everything outside the run asked of this runtime's run services
 * over HTTP with the run's token. The objects' requests reach this runtime's app in this process.
 * The runtime is a broker: it keeps each run's record and answers its services, and drives none.
 *
 * Each run starts here as a start for another host makes it (`createRun` with `drivenOn`), and
 * is handed over as the runtime hands a run to its host. Its first move is the tenant's, and so
 * is the log's first line: the object makes the rest, and the run ends as pinned. The model is
 * scripted per step, the tool step calls the pinned plugin.
 *
 * Every alarm call of an object makes at most one model call, a door's call none.
 */
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-edge-host-"));
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.RUNTIME_ROLE = "broker";
process.env.FEATURES = "durableRuns=on,runServices=on,runHosts=on";
process.env.PLUGINS_DIR = fileURLToPath(new URL("./fixtures/pinned-runs/plugins", import.meta.url));
process.env.PLUGINS_WATCH = "0";
process.env.PLUGIN_JOBS = "0";

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

/** The pinned runs' scripts, by run id; each call kept as "<step>", or "<step>?" for a decision. */
const scripted = vi.hoisted(() => ({
  scripts: new Map<string, (call: pinned.ModelCall) => string>(),
  calls: [] as { run: string; name: string }[],
}));
const modelFor = (run: string, step: string, decides: boolean) => {
  const answer = (options: { prompt: unknown }) => {
    const name = `${step}${decides ? "?" : ""}`;
    scripted.calls.push({ run, name });
    const n = scripted.calls.filter((c) => c.run === run && c.name === name).length;
    const script = scripted.scripts.get(run) ?? (() => "");
    return script({ step, decides, prompt: JSON.stringify(options.prompt), n });
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

type App = { request: (path: string, init?: RequestInit) => Response | Promise<Response> };

let client: typeof import("../src/db/client");
let runner: typeof import("../src/engine/runner");
let wizards: typeof import("../src/services/wizards");
let tokens: typeof import("../src/broker/token");
let hosts: typeof import("../src/engine/hosts");
let app: App;

const T = "tenant-edge-host";
const USER = "user-edge-host";
const ORIGIN = "http://localhost:5181";
const edges: LocalEdge[] = [];

/** A request an object sends that the test holds back: answered once `release` is called. */
type Hold = (path: string, body: string) => Promise<void> | null;
let hold: Hold = () => null;

/** An object's requests: the run's services, answered by this runtime's app. */
async function outbound(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin !== ORIGIN) {
    return new Response("Nothing else is reachable from here.", { status: 502 });
  }
  const body = request.method === "GET" ? undefined : await request.text();
  await hold(url.pathname, body ?? "");
  return app.request(`${url.pathname}${url.search}`, {
    method: request.method,
    headers: Object.fromEntries(request.headers),
    body,
  });
}

async function edgeAt(persist: string, watchdogMs = 3000): Promise<LocalEdge> {
  const edge = await localEdge({ persist, services: ORIGIN, outbound, probe: true, watchdogMs });
  edges.push(edge);
  return edge;
}

let edge: LocalEdge;

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  // Before a tenant's database opens: the test's plugin, with the tool step 3 calls.
  await (await import("../src/plugins/loader")).loadPlugins();
  runner = await import("../src/engine/runner");
  wizards = await import("../src/services/wizards");
  tokens = await import("../src/broker/token");
  hosts = await import("../src/engine/hosts");
  app = (await import("../src/app")).default as unknown as App;
  edge = await edgeAt(mkdtempSync(join(tmpdir(), "wizards-edge-objects-")));
}, 120_000);

afterAll(async () => {
  await Promise.all(edges.map((e) => e.dispose().catch(() => undefined)));
});

vi.setConfig({ testTimeout: 90_000 });

interface Placed {
  run: pinned.PinnedRun;
  id: string;
  token: string;
}

/**
 * The run's record at the tenant, placed on an object, and handed to it as the runtime hands a
 * run to its host: its token, its definition and its files, and the run as it stands after the
 * tenant's first move, with the record's revision.
 */
async function place(run: pinned.PinnedRun, at: LocalEdge): Promise<Placed> {
  const host: RunHostRef = { kind: "edge", url: at.url };
  const placed = await client.withTenant(T, async () => {
    const seed = await wizards.createWizard(USER, { definition: run.wizard });
    const id = await runner.createRun({
      wizardId: seed.id,
      definition: run.wizard,
      files: [],
      version: null,
      mode: "test",
      userId: USER,
      drivenOn: host,
    });
    const row = await client.db.query.run.findFirst({ where: eq(client.schema.run.id, id) });
    const token = row && (await tokens.tokenOf(row));
    if (!(row && token)) {
      throw new Error("no token");
    }
    await hosts.handOver(host, {
      runId: id,
      token,
      definition: row.definition,
      files: row.files,
      run: {
        cursor: row.cursor,
        status: row.status,
        state: row.state,
        wakeAt: row.wakeAt?.getTime() ?? null,
        rev: row.rev,
      },
    });
    return { id, token };
  });
  scripted.scripts.set(placed.id, run.script);
  return { run, ...placed };
}

/** The three calls of the run's object, through the Worker, with the run's token. */
const apiOf = (p: Placed, at: LocalEdge, ticket = p.token): HostApi =>
  hostApi({
    url: "http://edge.local",
    runId: p.id,
    tenant: T,
    ticket,
    fetch: (input, init) => at.fetch(pathOf(input), init),
  });

/** The run's log as its object keeps it: [step, type, a note by its code and params, else its text]. */
async function logOf(api: HostApi) {
  const stop = new AbortController();
  let lines: HostChange["events"] = [];
  for await (const change of api.changes(0, stop.signal, 0)) {
    lines = change.events;
    break;
  }
  stop.abort();
  return lines.map((e) => [
    e.stepId,
    e.type,
    e.note
      ? `${e.note.code}${e.note.params ? ` ${JSON.stringify(e.note.params)}` : ""}`
      : e.message,
  ]);
}

const callsOf = (id: string) => scripted.calls.filter((c) => c.run === id).map((c) => c.name);

/** What each call of the run's object did: alarm or door, and how many model calls it made. */
const objectCallsOf = (id: string, at: LocalEdge[]) =>
  at
    .flatMap((e) => e.logs)
    .flatMap((line) => {
      const m = line.match(/^\[run ([^\]]+)\] (alarm|door) call: (\{.*\})$/);
      return m && m[1] === id
        ? [{ kind: m[2], ...(JSON.parse(m[3]) as { models: number; ended: string }) }]
        : [];
    });

async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, ms: number) {
  const stop = Date.now() + ms;
  let value = await read();
  while (!ok(value) && Date.now() < stop) {
    await new Promise((r) => setTimeout(r, 100));
    value = await read();
  }
  return value;
}

/**
 * The run ended done, as pinned: its moves after the tenant's first, what the model was asked,
 * its log after the tenant's first line, and its state. Its record at the tenant ended with it.
 * `cut`: model calls made in an object's call that was stopped before it said what it did.
 */
async function ended(p: Placed, at: LocalEdge[] = [edge], cut = 0) {
  const api = apiOf(p, at.at(-1) as LocalEdge);
  const { run } = await until(
    () => api.state(),
    (s) => s.run.status === "done",
    60_000,
  );
  const moves = at.flatMap((e) => e.moves()).filter((m) => m.wizard === p.run.title);
  expect(moves.map((m) => m.move)).toEqual(p.run.moves.slice(1));
  expect(callsOf(p.id)).toEqual(p.run.calls);
  expect(await logOf(api)).toEqual(p.run.log.slice(1));
  const { cursor, status, wakeAt, state } = run;
  expect({ cursor, status, wakeAt }).toEqual({ cursor: "done", status: "done", wakeAt: null });
  expect(state).toEqual(p.run.state);
  // One model call an alarm call at most, none in a door's; each made in one.
  const calls = objectCallsOf(p.id, at);
  expect(calls.filter((c) => c.kind === "door").every((c) => c.models === 0)).toBe(true);
  expect(calls.filter((c) => c.kind === "alarm").every((c) => c.models <= 1)).toBe(true);
  const toolCalls = p.run.wizard.steps.filter((s) => s.type === "tool").length;
  expect(calls.reduce((n, c) => n + c.models, cut)).toBe(p.run.calls.length + toolCalls);
  // The end's copy reached the tenant.
  const record = await client.withTenant(T, () =>
    client.db.query.run.findFirst({ where: eq(client.schema.run.id, p.id) }),
  );
  expect(record).toMatchObject({ status: "done", cursor: "done", rev: run.rev });
}

const stamps = () => {
  const g = globalThis as { __pinnedStamps?: { run: string }[] };
  g.__pinnedStamps ??= [];
  return g.__pinnedStamps;
};

describe("a pinned run, in an object of its own on local workerd", () => {
  it("1: a page, an agent that writes, an approval, the result, driven through the Worker", async () => {
    const p = await place(pinned.pageAgentReview, edge);
    const api = apiOf(p, edge);
    const at = await api.state();
    expect(at.run).toMatchObject({ cursor: "ask", status: "waiting_input" });

    // Its changes from here on, as a door follows them.
    const following = new AbortController();
    const seen: HostChange[] = [];
    const followed = (async () => {
      for await (const change of api.changes(at.run.rev, following.signal, at.event)) {
        seen.push(change);
      }
    })();

    // Nobody without the run's token; nothing the engine makes itself; nothing it doesn't wait for.
    await expect(apiOf(p, edge, "not-the-token").state()).rejects.toMatchObject({ status: 401 });
    await expect(api.send({ kind: "start" })).rejects.toMatchObject({ status: 400 });
    await expect(
      api.send({ kind: "askAnswered", askId: "a1", answer: { type: "skip" } }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      api.send({ kind: "reviewed", stepId: "check", approved: true }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      api.send({ kind: "answered", stepId: "check", values: { topic: "otters" } }),
    ).rejects.toMatchObject({ status: 409 });
    const other = hostApi({
      url: "http://edge.local",
      runId: "run-other",
      tenant: T,
      ticket: p.token,
      fetch: (input, init) => edge.fetch(pathOf(input), init),
    });
    await expect(other.state()).rejects.toMatchObject({ status: 404 });

    const sent = await api.send({ kind: "answered", stepId: "ask", values: { topic: "otters" } });
    expect(sent.rev).toBeGreaterThan(at.run.rev);
    // The door's call stops before the model: the alarm writes, and the run waits at the review.
    const review = await until(
      () => api.state(),
      (s) => s.run.status === "waiting_input",
      30_000,
    );
    expect(review.run).toMatchObject({ cursor: "check", status: "waiting_input" });
    await api.send({ kind: "reviewed", stepId: "check", approved: true });
    await ended(p);

    // The stream told every line after the one it started from, and the last revision.
    const last = await api.state();
    const lines = () => seen.flatMap((c) => c.events);
    await until(
      async () => seen,
      () => seen.at(-1)?.rev === last.run.rev && lines().at(-1)?.id === last.event,
      10_000,
    );
    expect(lines().map((e) => [e.stepId, e.type])).toEqual(
      p.run.log.slice(1).map(([stepId, type]) => [stepId, type]),
    );
    following.abort();
    await followed;
  });

  it("2: a decision step branches, and the other branch never runs", async () => {
    const p = await place(pinned.decision, edge);
    await apiOf(p, edge).send({
      kind: "answered",
      stepId: "ask",
      values: { message: "Broken on arrival, I want my money back!" },
    });
    await ended(p);
  });

  it("3: a tool step calls a plugin's tool once, with no model", async () => {
    const p = await place(pinned.tool, edge);
    await ended(p);
    // The tool's one call at the tenant, its input filled in: "3" became a number.
    expect(stamps().filter((s) => s.run === p.id)).toEqual([
      { run: p.id, step: "stamp", word: "ab", times: 3 },
    ]);
  });

  it("4: foreach runs an agent once per entry, and the object restarted between two steps goes on", async () => {
    const persist = mkdtempSync(join(tmpdir(), "wizards-edge-restart-"));
    const first = await edgeAt(persist);
    // The copy of the run as its second step starts is held: the object stops there.
    let held: () => void = () => {};
    const stopped = new Promise<void>((reached) => {
      hold = (path, body) =>
        path.endsWith("/run/report") && /"cursor":"each"/.test(body) && /"running"/.test(body)
          ? new Promise<void>((release) => {
              held = release;
              reached();
            })
          : null;
    });
    const p = await place(pinned.foreach, first);
    await stopped;
    hold = () => null;
    expect(callsOf(p.id)).toEqual(["gather"]);
    await first.dispose();
    held();

    // The same objects again, on the same storage: the watchdog's alarm goes on with the run.
    const again = await edgeAt(persist);
    // The call that was stopped had made gather's model call.
    await ended(p, [first, again], 1);
  });

  it("5: a wait for a signal, and the signal comes", async () => {
    const p = await place(pinned.signal, edge);
    const api = apiOf(p, edge);
    const waiting = await until(
      () => api.state(),
      (s) => s.run.status === "waiting_signal",
      30_000,
    );
    expect(waiting.run).toMatchObject({ cursor: "paid", status: "waiting_signal", wakeAt: null });
    await api.send({
      kind: "signal",
      stepId: "paid",
      id: "sig_edge1",
      data: { amount: 42, extra: "dropped" },
    });
    await ended(p);
  });

  it("6: a step that fails once passes on its retry, woken by the object's alarm", async () => {
    const p = await place(pinned.retry, edge);
    const api = apiOf(p, edge);
    const asleep = await until(
      () => api.state(),
      (s) => s.run.status === "sleeping",
      30_000,
    );
    expect(asleep.run).toMatchObject({ cursor: "draft", status: "sleeping" });
    // FLOW_LIMITS.failureRetryMs (10 s) from the failure.
    expect(asleep.run.wakeAt! - Date.now()).toBeGreaterThan(3_000);
    expect(asleep.run.state).toEqual(pinned.retryAsleep);
    await ended(p);
  });
});
