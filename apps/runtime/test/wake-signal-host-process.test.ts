import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelClass } from "@engenty/wizards-shared/definition";
import type { RunHostRef } from "@engenty/wizards-shared/run";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Waits, signals and a stop of a run that lives on another runtime process
// (docs/plans/runs-on-their-own.md, 4.5). This process is a whole runtime (`all`): the tenant,
// with a runner and a clock of its own that must leave the run alone, and send its wake to the
// host. The second process (doors-host-worker.test.ts) is the runner the run is placed on; its
// own clock is slowed to an hour, so a wake it gets came from here.
const dir = mkdtempSync(join(tmpdir(), "wizards-wake-host-"));
const BASE = {
  DATA_DIR: dir,
  APP_URL: "http://localhost:5181",
  APP_SECRET: "wake-host-secret",
  LOCAL_ACCESS_KEY: "test-key",
  MARKETPLACE_URL: "off",
  AI_GATEWAY_API_KEY: "",
  OPENAI_API_KEY: "",
  ANTHROPIC_API_KEY: "",
  PLUGINS_WATCH: "0",
  PLUGIN_JOBS: "0",
  FEATURES: "durableRuns=on,runHosts=on",
};
Object.assign(process.env, BASE, { RUNTIME_ROLE: "all", RUNNER_CLOCK_MS: "100" });

/** Steps that worked in this process: none of the placed runs' may. */
const workedHere = vi.hoisted(() => [] as string[]);
vi.mock("@engenty/wizards-engine/steps/index", async (original) => ({
  ...(await original<typeof import("@engenty/wizards-engine/steps/index")>()),
  runAutomaticStep: async (step: { id: string }, ctx: { runId: string }) => {
    workedHere.push(ctx.runId);
    return { text: `made ${step.id} here`, at: new Date().toISOString() };
  },
}));
vi.mock("../src/models.js", async (original) => ({
  ...(await original<typeof import("../src/models.js")>()),
  modelWays: async (classes: Iterable<ModelClass>) =>
    Object.fromEntries([...classes].map((cls) => [cls, "credits"])),
}));
vi.mock("../src/engine/requirements.js", async (original) => ({
  ...(await original<typeof import("../src/engine/requirements.js")>()),
  missingModelsSaid: async () => [],
}));
vi.mock("../src/credits/credits.js", async (original) => ({
  ...(await original<typeof import("../src/credits/credits.js")>()),
  reserveForRun: async () => true,
  releaseRun: async () => undefined,
  canSpend: async () => true,
}));

const T = "tenant-wake-host";
const agent = (id: string) => ({
  id,
  type: "agent",
  title: id,
  instructions: "Write.",
  output: { format: "text" },
  tools: [],
});
const pause = { id: "pause", type: "wait", title: "Pause", for: "2d" };
const end = { id: "done", type: "result", title: "Done", deliverables: [] };
const page = {
  id: "ask",
  type: "form",
  title: "Ask",
  fields: [{ id: "x", kind: "text", label: "X" }],
};
let keys = 0;
const listening = (key: string) => ({
  id: "reply",
  type: "wait",
  title: "Reply",
  signal: { name: "invoice.paid", key },
});

let client: typeof import("../src/db/client");
let runner: typeof import("../src/engine/runner");
let store: typeof import("../src/engine/run-store");
let signals: typeof import("../src/engine/signals");
let hostClient: typeof import("../src/engine/run-host-client");
let env: typeof import("../src/env").env;

let child: ChildProcess;
let childSaid = "";
let host: RunHostRef;
const portFile = join(dir, "host-port");

/** What this process asked the run's host, by path and body. */
const peerCalls: { path: string; body: unknown }[] = [];

const inTenant = <R>(fn: () => Promise<R>) => client.withTenant(T, fn);
const row = (runId: string) =>
  inTenant(() => client.db.query.run.findFirst({ where: eq(client.schema.run.id, runId) }));
const line = (runId: string) =>
  client.controlDb.query.runIndex.findFirst({ where: eq(client.control.runIndex.runId, runId) });

async function until<V>(get: () => Promise<V>, ok: (v: V) => boolean, ms = 90_000): Promise<V> {
  const stop = Date.now() + ms;
  let v = await get();
  while (!ok(v)) {
    if (Date.now() > stop) {
      throw new Error(`timed out at ${JSON.stringify(v).slice(0, 600)}\n${childSaid.slice(-3000)}`);
    }
    await new Promise((r) => setTimeout(r, 100));
    v = await get();
  }
  return v;
}
const hasStatus = (runId: string, status: string) =>
  until(
    () => row(runId),
    (r) => r?.status === status,
  );
/** It waits, and no runner holds it. */
const rests = (runId: string, status: string) =>
  until(
    async () => ({ run: await row(runId), line: await line(runId) }),
    ({ run, line }) => run?.status === status && line?.active === false && line.owner === null,
  );

async function start(steps: unknown[]): Promise<{ runId: string; spaceId: string }> {
  const wizards = await import("../src/services/wizards");
  const definition = { version: 1, title: "Elsewhere", description: "", avatar: "round", steps };
  return inTenant(async () => {
    const made = await wizards.createWizard("u", { definition: definition as never });
    const w = await wizards.ownedWizard("u", made.id);
    const runId = await runner.createRun({
      wizardId: made.id,
      definition: definition as never,
      files: [],
      version: null,
      mode: "test",
      userId: "u",
    });
    // The run lives on the second process, and the line knows it.
    expect(await store.runStore.hostOf(runId)).toEqual(host);
    expect((await line(runId))?.host).toEqual(host);
    return { runId, spaceId: w.spaceId };
  });
}

/** The time passes: both copies of the wake time are in the past. */
async function pass(runId: string) {
  const past = new Date(Date.now() - 1000);
  await inTenant(() =>
    client.db.update(client.schema.run).set({ wakeAt: past }).where(eq(client.schema.run.id, runId)),
  );
  await setLineWake(runId, past);
}
const setLineWake = (runId: string, wakeAt: Date | null) =>
  client.controlDb
    .update(client.control.runIndex)
    .set({ wakeAt })
    .where(eq(client.control.runIndex.runId, runId));

const sentKinds = (runId: string) =>
  peerCalls
    .filter((c) => c.path === `/api/peer/runs/${runId}/events`)
    .map((c) => (c.body as { event: { kind: string } }).event.kind);

beforeAll(async () => {
  child = spawn(
    "pnpm",
    ["exec", "vitest", "run", "test/doors-host-worker.test.ts", "--pool=forks", "--reporter=dot"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...BASE,
        RUNTIME_ROLE: "runner",
        RUNNER_CLOCK_MS: "3600000",
        HOST_PORT_FILE: portFile,
      },
      stdio: "pipe",
      detached: true,
    },
  );
  child.stdout?.on("data", (d) => {
    childSaid += String(d);
  });
  child.stderr?.on("data", (d) => {
    childSaid += String(d);
  });

  client = await import("../src/db/client");
  await client.migrateControlDb();
  runner = await import("../src/engine/runner");
  store = await import("../src/engine/run-store");
  signals = await import("../src/engine/signals");
  hostClient = await import("../src/engine/run-host-client");
  env = (await import("../src/env")).env;

  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("/api/peer/runs/")) {
      peerCalls.push({
        path: new URL(url).pathname,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
    }
    return realFetch(input, init);
  });

  const stop = Date.now() + 150_000;
  while (!existsSync(portFile)) {
    if (Date.now() > stop || child.exitCode !== null) {
      throw new Error(`the second process did not start:\n${childSaid.slice(-4000)}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  host = { kind: "runtime", url: `http://127.0.0.1:${readFileSync(portFile, "utf8").trim()}` };
  env.runHosts = [host];
  // This process is a runner too: it must not take the runs placed on the other one.
  runner.startRunner();
}, 180_000);

afterAll(async () => {
  await runner?.stopRunner();
  writeFileSync(`${portFile}.stop`, "");
  const ended = await Promise.race([
    new Promise<boolean>((done) => child.once("exit", () => done(true))),
    new Promise<boolean>((done) => setTimeout(() => done(false), 20_000)),
  ]);
  if (!ended && child.pid) {
    process.kill(-child.pid, "SIGKILL");
  }
  vi.restoreAllMocks();
}, 30_000);

describe("a timed wait of a run on another runtime process", () => {
  it(
    "the clock here sends the wake to its host; the run goes on there, and a second wake changes nothing",
    { timeout: 180_000 },
    async () => {
      const { runId } = await start([agent("before"), pause, agent("after"), end]);
      await rests(runId, "sleeping");
      const asleep = await row(runId);
      expect(asleep?.state.outputs.before?.text).toBe("made before");
      expect((asleep?.wakeAt?.getTime() ?? 0) - Date.now()).toBeGreaterThan(47 * 3600_000);
      // The host put the time on the line, as for a run of its own.
      expect((await line(runId))?.wakeAt?.getTime()).toBe(asleep?.wakeAt?.getTime());

      await pass(runId);
      await hasStatus(runId, "done");
      const done = await row(runId);
      expect(done?.state.outputs.pause?.json).toEqual({ waited: true });
      expect(done?.state.outputs.after?.text).toBe("made after");
      expect(sentKinds(runId)).toEqual(["woke"]);
      expect((await line(runId))?.wakeAt).toBeNull();

      // A wake for a run that went on: the host refuses it, nothing moves, the clock forgets it.
      await setLineWake(runId, new Date(Date.now() - 1000));
      await until(
        async () => ({ kinds: sentKinds(runId), line: await line(runId) }),
        ({ kinds, line }) => kinds.length === 2 && line?.wakeAt === null,
      );
      await new Promise((r) => setTimeout(r, 500));
      expect(sentKinds(runId)).toEqual(["woke", "woke"]);
      expect((await row(runId))?.status).toBe("done");
      expect((await row(runId))?.rev).toBe(done?.rev);
      expect(workedHere).not.toContain(runId);
    },
  );

  it("an early wake finds the run as it is, and its host puts the time back", async () => {
    const { runId } = await start([pause, end]);
    await rests(runId, "sleeping");
    const before = (await row(runId))?.wakeAt?.getTime();
    // Only the line's copy is due: a stale clock.
    await setLineWake(runId, new Date(Date.now() - 1000));
    await until(
      () => line(runId),
      (l) => l?.wakeAt?.getTime() === before && l.active === false && l.owner === null,
    );
    expect(sentKinds(runId)).toContain("woke");
    expect((await row(runId))?.status).toBe("sleeping");
    expect((await row(runId))?.wakeAt?.getTime()).toBe(before);
  });

  it("a stop reaches its host: the run ends, its wake is gone, the clock sends nothing", async () => {
    const { runId } = await start([pause, end]);
    await rests(runId, "sleeping");
    const run = await row(runId);
    await inTenant(async () =>
      (await hostClient.hostClientOf({ id: runId, host: run?.host ?? null })).send(
        { kind: "stop" },
        { name: "Ada" },
      ),
    );
    expect((await row(runId))?.status).toBe("cancelled");
    expect((await line(runId))?.wakeAt).toBeNull();
    await new Promise((r) => setTimeout(r, 500));
    expect(sentKinds(runId)).toEqual(["stop"]);
  });
});

describe("a signal for a run on another runtime process", () => {
  it("kept here, then sent to its host: the wait takes it there", { timeout: 120_000 }, async () => {
    const key = `anna-${++keys}@example.com`;
    const { runId, spaceId } = await start([listening(key), agent("after"), end]);
    await rests(runId, "waiting_signal");
    const sent = await inTenant(() =>
      signals.sendSignal({
        spaceId,
        scope: signals.SPACE_SCOPE,
        name: "invoice.paid",
        key,
        data: { amount: 18400 },
        source: "test",
      }),
    );
    expect(sent.runs).toBe(1);
    await hasStatus(runId, "done");
    const done = await row(runId);
    expect(done?.state.outputs.reply?.json).toEqual({
      came: true,
      timedOut: false,
      data: { amount: 18400 },
    });
    expect(done?.state.outputs.after?.text).toBe("made after");
    expect(done?.state.signals).toEqual([sent.id]);
    expect(sentKinds(runId)).toEqual(["signal"]);
    expect(peerCalls.find((c) => c.path === `/api/peer/runs/${runId}/events`)?.body).toMatchObject(
      { event: { kind: "signal", stepId: "reply", id: sent.id, data: { amount: 18400 } } },
    );
    expect(workedHere).not.toContain(runId);
  });

  it("before the wait: is not lost", { timeout: 120_000 }, async () => {
    const key = `anna-${++keys}@example.com`;
    const { runId, spaceId } = await start([page, listening(key), agent("after"), end]);
    await rests(runId, "waiting_input");
    const sent = await inTenant(() =>
      signals.sendSignal({
        spaceId,
        scope: signals.SPACE_SCOPE,
        name: "invoice.paid",
        key,
        data: { early: true },
        source: "test",
      }),
    );
    expect(sent.runs).toBe(0);
    await inTenant(async () =>
      (await hostClient.hostClientOf({ id: runId, host })).send({
        kind: "answered",
        stepId: "ask",
        values: { x: "go" },
      }),
    );
    await hasStatus(runId, "done");
    expect((await row(runId))?.state.outputs.reply?.json).toMatchObject({
      came: true,
      data: { early: true },
    });
  });

  it("for this one run (a test event): read where its host has it, and sent there", async () => {
    const key = `anna-${++keys}@example.com`;
    const { runId } = await start([listening(key), end]);
    await rests(runId, "waiting_signal");
    const sent = await inTenant(() => runner.signalRun(runId, { data: {}, source: "test" }));
    expect(sent?.runs).toBe(1);
    await hasStatus(runId, "done");
    expect(sentKinds(runId)).toEqual(["signal"]);
    // Where the run stood was asked of its host.
    expect(peerCalls.map((c) => c.path)).toContain(`/api/peer/runs/${runId}/state`);
  });
});
