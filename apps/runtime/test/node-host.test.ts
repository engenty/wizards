import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type HostChange, hostApi } from "@engenty/wizards-engine/host-api";
import { type NodeHost, type NodeHostOptions, nodeHost } from "@engenty/wizards-run/node-host";
import type { FlowEvent, FlowResult } from "@engenty/wizards-shared/transition";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as pinned from "./fixtures/pinned-runs/runs.js";

/**
 * The six pinned runs (fixtures/pinned-runs/runs.ts) on a host in a Node process
 * (`@engenty/wizards-run`): the run's state, turns and log in a folder of its own, everything
 * outside the run asked of this runtime's run services over HTTP with the run's token. The
 * runtime is a broker here: it holds the run's record and answers its services, and drives
 * nothing. The model is scripted per step, the tool step calls the pinned plugin.
 *
 * The runs make the moves, the model calls and the log the runtime's own runner makes, and end
 * with the same state. One difference, as on the engine's host in memory: a run that starts at a
 * page stands there with a `resume` of its own (pinned.test.ts in packages/engine).
 */
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-node-host-"));
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.RUNTIME_ROLE = "broker";
process.env.FEATURES = "durableRuns=on,runServices=on";
process.env.PLUGINS_DIR = fileURLToPath(new URL("./fixtures/pinned-runs/plugins", import.meta.url));
process.env.PLUGINS_WATCH = "0";
process.env.PLUGIN_JOBS = "0";

/** Every move `transition()` made, as "event ⇒ command → status", with its wizard's title. */
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
let app: App;

const T = "tenant-node-host";
const USER = "user-node-host";
const ORIGIN = "http://localhost:5181";
const hosts: NodeHost[] = [];

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  // Before a tenant's database opens: the test's plugin, with the tool step 3 calls.
  await (await import("../src/plugins/loader")).loadPlugins();
  runner = await import("../src/engine/runner");
  wizards = await import("../src/services/wizards");
  tokens = await import("../src/broker/token");
  app = (await import("../src/app")).default as unknown as App;
}, 60_000);

afterAll(async () => {
  await Promise.all(hosts.map((h) => h.close()));
});

vi.setConfig({ testTimeout: 60_000 });

/** A run placed at the tenant: its record, its token and a folder for its host. */
interface Placed {
  run: pinned.PinnedRun;
  id: string;
  token: string;
  dir: string;
}

/**
 * The run's record at the tenant, as a start for another host makes it: the services read the
 * run there and its token opens it. `createRun` takes the run's first move there too; the host
 * makes its own, so those moves are not counted.
 */
async function place(run: pinned.PinnedRun): Promise<Placed> {
  const { id, token } = await client.withTenant(T, async () => {
    const seed = await wizards.createWizard(USER, { definition: run.wizard });
    const id = await runner.createRun({
      wizardId: seed.id,
      definition: run.wizard,
      files: [],
      version: null,
      mode: "test",
      userId: USER,
    });
    const row = await client.db.query.run.findFirst({ where: eq(client.schema.run.id, id) });
    const token = row && (await tokens.tokenOf(row));
    if (!token) {
      throw new Error("no token");
    }
    return { id, token };
  });
  for (let i = moves.length - 1; i >= 0; i--) {
    if (moves[i].wizard === run.title) {
      moves.splice(i, 1);
    }
  }
  scripted.scripts.set(id, run.script);
  return { run, id, token, dir: mkdtempSync(join(tmpdir(), "wizards-node-run-")) };
}

/** A host for the placed run, its services this runtime's app; each write copied to the record. */
async function hostOf(p: Placed, more: Partial<NodeHostOptions> = {}): Promise<NodeHost> {
  const host = await nodeHost({
    dir: p.dir,
    services: {
      url: ORIGIN,
      token: p.token,
      fetch: (input, init) => Promise.resolve(app.request(String(input), init)),
    },
    def: p.run.wizard,
    files: [],
    run: { id: p.id },
    // This test writes the record itself, with every write: no copies over `run/report`.
    reports: false,
    // The tenant's copy of the run: its services read the run's state from the record (a foreach
    // over an earlier step's output, the step's turn).
    onWrite: (r) =>
      client.withTenant(T, async () => {
        await client.db
          .update(client.schema.run)
          .set({
            cursor: r.cursor,
            status: r.status,
            state: r.state,
            wakeAt: r.wakeAt === null ? null : new Date(r.wakeAt),
          })
          .where(eq(client.schema.run.id, p.id));
      }),
    ...more,
  });
  hosts.push(host);
  return host;
}

/**
 * The moves as `advance` makes them from `start`: a run that starts at a page stands there with
 * a `resume` (packages/engine/test/pinned.test.ts).
 */
const fromStart = (pinnedMoves: string[]) =>
  pinnedMoves.flatMap((m, i) =>
    i === 0 && m.startsWith("start ⇒ ask ") ? [m, m.replace("start ⇒", "resume ⇒")] : [m],
  );

/** The run's log as the folder keeps it: [step, type, a note by its code and params, else its text]. */
const logOf = (dir: string) =>
  readFileSync(join(dir, "events.ndjson"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .map((e) => [
      e.stepId,
      e.type,
      e.note
        ? `${e.note.code}${e.note.params ? ` ${JSON.stringify(e.note.params)}` : ""}`
        : e.message,
    ]);

const callsOf = (id: string) => scripted.calls.filter((c) => c.run === id).map((c) => c.name);

/** The run ended done, as pinned: its moves, what the model was asked, its log and its state. */
async function ended(host: NodeHost, p: Placed) {
  await host.idle();
  const { run } = await host.state();
  expect(moves.filter((m) => m.wizard === p.run.title).map((m) => m.move)).toEqual(
    fromStart(p.run.moves),
  );
  expect(callsOf(p.id)).toEqual(p.run.calls);
  expect(logOf(p.dir)).toEqual(p.run.log);
  const { cursor, status, wakeAt, state } = run;
  expect({ cursor, status, wakeAt }).toEqual({ cursor: "done", status: "done", wakeAt: null });
  expect(state).toEqual(p.run.state);
}

async function until(ok: () => Promise<boolean>, ms: number) {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (await ok()) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

const stamps = () => {
  const g = globalThis as { __pinnedStamps?: { run: string }[] };
  g.__pinnedStamps ??= [];
  return g.__pinnedStamps;
};

describe("a pinned run, on a host in a Node process", () => {
  it("1: a page, an agent that writes, an approval, the result, driven over the loopback", async () => {
    const p = await place(pinned.pageAgentReview);
    const host = await hostOf(p);
    await host.start();
    expect(host.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const api = hostApi({ url: host.url, runId: p.id, tenant: T, ticket: host.secret });
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

    // Nobody without the host's secret; nothing the host makes itself; nothing it doesn't wait for.
    const stranger = hostApi({ url: host.url, runId: p.id, tenant: T, ticket: "not-the-secret" });
    await expect(stranger.state()).rejects.toMatchObject({ status: 401 });
    await expect(api.send({ kind: "start" })).rejects.toMatchObject({ status: 400 });
    await expect(
      api.send({ kind: "reviewed", stepId: "check", approved: true }),
    ).rejects.toMatchObject({ status: 409 });
    const other = hostApi({ url: host.url, runId: "run-other", tenant: T, ticket: host.secret });
    await expect(other.state()).rejects.toMatchObject({ status: 404 });

    const sent = await api.send({ kind: "answered", stepId: "ask", values: { topic: "otters" } });
    expect(sent.rev).toBeGreaterThan(at.run.rev);
    await host.idle();
    expect((await api.state()).run).toMatchObject({ cursor: "check", status: "waiting_input" });
    await api.send({ kind: "reviewed", stepId: "check", approved: true });
    await ended(host, p);

    // The stream told every line after the one it started from, and the last revision.
    const last = await api.state();
    const lines = () => seen.flatMap((c) => c.events);
    expect(
      await until(
        async () => seen.at(-1)?.rev === last.run.rev && lines().at(-1)?.id === last.event,
        10_000,
      ),
    ).toBe(true);
    expect(lines().map((e) => [e.stepId, e.type])).toEqual(
      p.run.log.slice(1).map(([stepId, type]) => [stepId, type]),
    );
    following.abort();
    await followed;
  });

  it("2: a decision step branches, and the other branch never runs", async () => {
    const p = await place(pinned.decision);
    const host = await hostOf(p);
    await host.start();
    await host.send({
      kind: "answered",
      stepId: "ask",
      values: { message: "Broken on arrival, I want my money back!" },
    });
    await ended(host, p);
  });

  it("3: a tool step calls a plugin's tool once, with no model", async () => {
    const p = await place(pinned.tool);
    const host = await hostOf(p);
    await host.start();
    await ended(host, p);
    // The tool's one call at the tenant, its input filled in: "3" became a number.
    expect(stamps().filter((s) => s.run === p.id)).toEqual([
      { run: p.id, step: "stamp", word: "ab", times: 3 },
    ]);
  });

  it("4: foreach runs an agent once per entry, and a host started again goes on between two steps", async () => {
    const p = await place(pinned.foreach);
    const first = await hostOf(p);
    // The process goes away once the first step is done, before the second starts.
    let gone = false;
    first.watch(({ events }) => {
      if (events.some((e) => e.stepId === "gather" && e.type === "step_done")) {
        gone = true;
        void first.close();
      }
    });
    await first.start();
    expect(gone).toBe(true);
    const left = JSON.parse(readFileSync(join(p.dir, "run.json"), "utf8"));
    expect(left.run).toMatchObject({ cursor: "each", status: "running" });
    expect(callsOf(p.id)).toEqual(["gather"]);

    const again = await hostOf(p);
    await again.start();
    await ended(again, p);
  });

  it("5: a wait for a signal, and the signal comes", async () => {
    const p = await place(pinned.signal);
    const host = await hostOf(p);
    await host.start();
    expect((await host.state()).run).toMatchObject({
      cursor: "paid",
      status: "waiting_signal",
      wakeAt: null,
    });
    await host.send({
      kind: "signal",
      stepId: "paid",
      id: "sig_node1",
      data: { amount: 42, extra: "dropped" },
    });
    await ended(host, p);
  });

  it("6: a step that fails once passes on its retry, woken by the host's timer", async () => {
    const p = await place(pinned.retry);
    const host = await hostOf(p);
    await host.start();
    const asleep = (await host.state()).run;
    expect(asleep).toMatchObject({ cursor: "draft", status: "sleeping" });
    // FLOW_LIMITS.failureRetryMs (10 s) from now.
    expect(asleep.wakeAt! - Date.now()).toBeGreaterThan(5_000);
    expect(asleep.state).toEqual(pinned.retryAsleep);
    expect(await until(async () => (await host.state()).run.status === "done", 30_000)).toBe(true);
    await ended(host, p);
  });

  it("a host started again wakes a run whose wake is past at once", async () => {
    const p = await place(pinned.retry);
    const first = await hostOf(p);
    await first.start();
    expect((await first.state()).run).toMatchObject({ cursor: "draft", status: "sleeping" });
    await first.close();
    // The process comes back after the run's time.
    const later = await hostOf(p, { now: () => Date.now() + 10_000 });
    await later.start();
    await ended(later, p);
  });
});
