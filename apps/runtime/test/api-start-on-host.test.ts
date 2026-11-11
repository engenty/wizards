import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type NodeHost, nodeHost } from "@engenty/wizards-run/node-host";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as pinned from "./fixtures/pinned-runs/runs.js";

/**
 * `POST /api/v1/spaces/:spaceId/runs` (docs/plans/runs-on-their-own.md, 5.2): a program starts a
 * run of a space that it drives on its own machine. The runtime checks and holds as for any
 * start, keeps the record, names the caller's host on it and answers with the run's token and
 * where its services are. A host in this process (`@engenty/wizards-run`) then drives the run to
 * its end with only that answer, its services this runtime's app; the run shows in the studio.
 */
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-api-start-on-host-"));
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.RUNTIME_ROLE = "all";
process.env.PLUGINS_DIR = fileURLToPath(new URL("./fixtures/pinned-runs/plugins", import.meta.url));
process.env.PLUGINS_WATCH = "0";
process.env.PLUGIN_JOBS = "0";
const ON = "durableRuns=on,runServices=on,wizardsRun=on";
process.env.FEATURES = ON;

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/** The pinned runs' scripts, by run id. */
const scripted = vi.hoisted(() => ({
  scripts: new Map<string, (call: pinned.ModelCall) => string>(),
  calls: [] as { run: string; name: string }[],
  /** How every class reaches its model, as the settings would say; unset: on credits. */
  way: null as string | null,
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
    doStream: async (options) => {
      const text = answer(options);
      return {
        stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          ...(text
            ? [
                { type: "text-start", id: "t" },
                { type: "text-delta", id: "t", delta: text },
                { type: "text-end", id: "t" },
              ]
            : []),
          { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
        ] as never[]),
      };
    },
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
  systemOneAccess: async () => null,
  embeddingModel: async () => null,
  modelWays: async (classes: Iterable<string>) =>
    Object.fromEntries([...classes].map((cls) => [cls, scripted.way ?? "credits"])),
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
let wizards: typeof import("../src/services/wizards");
let runs: typeof import("../src/services/runs");
let runner: typeof import("../src/engine/runner");
let control: typeof import("../src/tenants/control");
let tokens: typeof import("../src/broker/token");
let app: App;

/** A runtime that runs alone: its own keys, its one tenant. */
const T = "local";
const USER = "local";
const ORIGIN = "http://localhost:5181";
let hostKey = "";
let plainKey = "";
let spaceId = "";
const hosts: NodeHost[] = [];

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  await (await import("../src/plugins/loader")).loadPlugins();
  wizards = await import("../src/services/wizards");
  runs = await import("../src/services/runs");
  runner = await import("../src/engine/runner");
  control = await import("../src/tenants/control");
  tokens = await import("../src/broker/token");
  app = (await import("../src/app")).default as unknown as App;
  const keys = await import("../src/auth/keys");
  const { KEY_SCOPES } = await import("../src/mcp/scopes");
  hostKey = (await keys.createLocalKey("wizards run", [...KEY_SCOPES, "runs:host"])).key;
  plainKey = (await keys.createLocalKey("WordPress")).key;
}, 60_000);

afterAll(async () => {
  await Promise.all(hosts.map((h) => h.close()));
});

vi.setConfig({ testTimeout: 60_000 });

const inTenant = <T>(work: () => Promise<T>) => client.withTenant(T, work);

/** A published wizard of the space, from a pinned run's definition. */
async function published(run: pinned.PinnedRun): Promise<string> {
  return inTenant(async () => {
    const made = await wizards.createWizard(USER, { definition: run.wizard });
    await wizards.publishWizard(USER, made.id);
    const w = await client.db.query.wizard.findFirst({
      where: eq(client.schema.wizard.id, made.id),
    });
    spaceId = w?.spaceId ?? "";
    return made.id;
  });
}

function start(body: unknown, key = hostKey, space = () => spaceId) {
  return app.request(`${ORIGIN}/api/v1/spaces/${space()}/runs`, {
    method: "POST",
    headers: { "x-api-key": key, "content-type": "application/json", "x-wizards-client": "cli" },
    body: JSON.stringify(body),
  });
}

interface Started {
  runId: string;
  wizardId: string;
  token: string;
  services: string;
  host: { kind: string; url: string };
  definition: typeof pinned.tool.wizard;
  files: [];
  run: { cursor: string; status: string; state: unknown; wakeAt: number | null; rev: number };
}

/** The host for a started run, from the route's answer alone; each write copied to the record. */
async function hostFor(started: Started): Promise<NodeHost> {
  const host = await nodeHost({
    dir: mkdtempSync(join(tmpdir(), "wizards-api-run-")),
    services: {
      url: started.services,
      token: started.token,
      fetch: (input, init) => Promise.resolve(app.request(String(input), init)),
    },
    def: started.definition,
    files: started.files,
    run: { id: started.runId },
    // The tenant's copy of the run (the end at the tenant is 4.4's): its services read the run's
    // state from the record, and the studio lists it from there.
    onWrite: (r) =>
      inTenant(async () => {
        await client.db
          .update(client.schema.run)
          .set({
            cursor: r.cursor,
            status: r.status,
            state: r.state,
            wakeAt: r.wakeAt === null ? null : new Date(r.wakeAt),
          })
          .where(eq(client.schema.run.id, started.runId));
      }),
  });
  hosts.push(host);
  return host;
}

const stamps = () => {
  const g = globalThis as { __pinnedStamps?: { run: string }[] };
  g.__pinnedStamps ??= [];
  return g.__pinnedStamps;
};

/**
 * Nothing here drives the run: it is not in line, has no wake here, and a runner told to take it
 * leaves it as it was.
 */
async function leftAlone(started: Started) {
  const indexed = async () =>
    client.controlDb.query.runIndex.findFirst({
      where: eq(client.control.runIndex.runId, started.runId),
    });
  expect(await indexed()).toMatchObject({ active: false, wakeAt: null });
  await control.wakeRun(started.runId);
  expect(runner.takeNow(started.runId, T)).toBe(true);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && (await indexed())?.active) {
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(await indexed()).toMatchObject({ active: false, owner: null });
  const left = await inTenant(() => runner.loadRun(started.runId));
  const { cursor, status, rev } = started.run;
  expect(left).toMatchObject({ cursor, status, rev, driving: false });
}

describe("starting a run on the caller's host", () => {
  it("a published wizard: its token drives the run to the end, the studio lists it", async () => {
    const wizardId = await published(pinned.decision);
    const res = await start({ host: "node", wizardId });
    expect(res.status).toBe(200);
    const started = (await res.json()) as Started;
    scripted.scripts.set(started.runId, pinned.decision.script);
    expect(started).toMatchObject({
      wizardId,
      services: ORIGIN,
      host: { kind: "node", url: "local" },
      definition: { title: pinned.decision.title },
      run: { cursor: "ask", status: "waiting_input", wakeAt: null },
    });

    // The record names the caller's host and client; the token says the host's kind.
    const record = await inTenant(() => runner.loadRun(started.runId));
    expect(record).toMatchObject({
      host: { kind: "node", url: "local" },
      client: "cli",
      mode: "live",
      rev: started.run.rev,
    });
    expect(await tokens.readRunToken(started.token)).toMatchObject({
      claims: { run: started.runId, tenant: T, host: "node" },
    });

    await leftAlone(started);

    const host = await hostFor(started);
    await host.start();
    await host.send({
      kind: "answered",
      stepId: "ask",
      values: { message: "Broken on arrival, I want my money back!" },
    });
    await host.idle();
    const { run } = await host.state();
    expect(run).toMatchObject({ cursor: "done", status: "done", wakeAt: null });
    expect(run.state).toEqual(pinned.decision.state);

    const listed = await inTenant(() => runs.listRuns(USER, wizardId));
    expect(listed.find((r) => r.id === started.runId)).toMatchObject({
      mode: "live",
      status: "done",
    });
  });

  it("a definition: the draft of a new wizard, run as a test of it", async () => {
    // What `wizards validate` checks: `requires` says what the steps need.
    const definition = { ...pinned.tool.wizard, requires: { plugins: ["pinned"] } };
    // The space this test starts in: the published wizard's.
    if (!spaceId) {
      await published(pinned.decision);
    }
    const res = await start({ host: "node", definition, files: [] });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    const started = (await res.json()) as Started;
    expect(started.run).toMatchObject({
      cursor: pinned.tool.wizard.steps[0].id,
      status: "running",
    });
    const w = await inTenant(() =>
      client.db.query.wizard.findFirst({ where: eq(client.schema.wizard.id, started.wizardId) }),
    );
    expect(w).toMatchObject({ spaceId, title: pinned.tool.title, publishedVersion: null });
    // A run that would go on by itself: no runner here makes its tool step.
    await leftAlone(started);
    expect(stamps().filter((s) => s.run === started.runId)).toEqual([]);

    const host = await hostFor(started);
    await host.start();
    await host.idle();
    const { run } = await host.state();
    expect(run).toMatchObject({ cursor: "done", status: "done" });
    expect(run.state).toEqual(pinned.tool.state);
    const listed = await inTenant(() => runs.listRuns(USER, started.wizardId));
    expect(listed).toEqual([
      expect.objectContaining({ id: started.runId, mode: "test", status: "done" }),
    ]);

    // Sent again with that wizard, the same wizard holds it: no new one is made.
    const again = await start({
      host: "node",
      wizardId: started.wizardId,
      definition,
      files: [],
    });
    expect(again.status).toBe(200);
    expect(((await again.json()) as Started).wizardId).toBe(started.wizardId);
  });

  it("a definition that doesn't validate starts nothing", async () => {
    const broken = { version: 1, title: "Broken", steps: [] };
    const res = await start({ host: "node", definition: broken });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "has_issues" });
  });

  it("refuses: off, no scope, at the edge, a wizard that needs this computer", async () => {
    const wizardId = await published(pinned.decision);
    const before = (await inTenant(() => runs.listRuns(USER, wizardId))).length;

    process.env.FEATURES = "durableRuns=on,runServices=on";
    try {
      expect((await start({ host: "node", wizardId })).status).toBe(404);
      // Without the run's services over HTTP nobody could drive it elsewhere.
      process.env.FEATURES = "durableRuns=on,wizardsRun=on";
      expect((await start({ host: "node", wizardId })).status).toBe(404);
    } finally {
      process.env.FEATURES = ON;
    }

    // A key that names no scopes has every one but this.
    const plain = await start({ host: "node", wizardId }, plainKey);
    expect(plain.status).toBe(403);
    expect(await plain.json()).toMatchObject({ code: "insufficient_scope" });
    expect((await start({ host: "node", wizardId }, "wz_unknown")).status).toBe(401);

    const edge = await start({ host: "edge", wizardId });
    expect(edge.status).toBe(400);
    expect(await edge.json()).toMatchObject({ code: "host" });
    expect((await start({ host: "node" })).status).toBe(400);

    // Its model runs through an AI client installed here: no other host can run it.
    scripted.way = "client";
    try {
      const unfit = await start({ host: "node", wizardId });
      expect(unfit.status).toBe(409);
      const body = (await unfit.json()) as { error: string; code: string; missing: unknown[] };
      expect(body).toMatchObject({ code: "host_unfit" });
      expect(body.missing).toContainEqual({ cls: "standard", way: "client" });
      expect(body.error).toMatch(/AI client/);
    } finally {
      scripted.way = null;
    }

    // A client the Manage-App's list revoked.
    const clients = await import("../src/clients");
    clients.setClientList({
      clients: [{ id: "cli", name: "Command line", runsPerHour: null, revoked: true }],
      unknown: { allow: true, runsPerHour: null },
    });
    try {
      const revoked = await start({ host: "node", wizardId });
      expect(revoked.status).toBe(403);
      expect(await revoked.json()).toMatchObject({ code: "client_refused" });
    } finally {
      clients.setClientList(null);
    }

    // Another space's id: its wizards aren't there.
    expect((await start({ host: "node", wizardId }, hostKey, () => "space-other")).status).toBe(
      404,
    );
    expect((await inTenant(() => runs.listRuns(USER, wizardId))).length).toBe(before);
  });
});
