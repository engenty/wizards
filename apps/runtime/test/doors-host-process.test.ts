import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelClass } from "@engenty/wizards-shared/definition";
import { noteText, type RunView } from "@engenty/wizards-shared/run";
import type { RunHostRef } from "@engenty/wizards-shared/run";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The doors of a run that lives on another runtime process (docs/plans/runs-on-their-own.md,
// 4.3): this process serves the doors and drives no run (RUNTIME_ROLE=doors), the second one
// (doors-host-worker.test.ts) is a runner the run is placed on. The view, its stream, a page, a
// review, back, try again, a step's question, a view's state and cancel reach the run through
// that host's calls.
const dir = mkdtempSync(join(tmpdir(), "wizards-doors-host-"));
const SECRET = "doors-host-secret";
const BASE = {
  DATA_DIR: dir,
  APP_URL: "http://localhost:5181",
  APP_SECRET: SECRET,
  LOCAL_ACCESS_KEY: "test-key",
  MARKETPLACE_URL: "off",
  AI_GATEWAY_API_KEY: "",
  OPENAI_API_KEY: "",
  ANTHROPIC_API_KEY: "",
  PLUGINS_WATCH: "0",
  PLUGIN_JOBS: "0",
};
Object.assign(process.env, BASE, { RUNTIME_ROLE: "doors", FEATURES: "runHosts=on" });

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

const T = "tenant-doors-host";
const agent = (id: string) => ({
  id,
  type: "agent",
  title: id,
  instructions: "Write.",
  output: { format: "text" },
  tools: [],
});
const definition = {
  version: 1,
  title: "Doors elsewhere",
  description: "",
  avatar: "round",
  steps: [
    { id: "start", type: "form", title: "Start", fields: [{ id: "name", kind: "text", label: "Name" }] },
    agent("write"),
    agent("flaky"),
    { id: "check", type: "review", title: "Check", show: ["write"], edit: true },
    { id: "more", type: "form", title: "More", fields: [{ id: "ok", kind: "text", label: "Ok" }] },
    agent("asking"),
    { id: "done", type: "result", title: "Done", deliverables: [] },
  ],
};

let client: typeof import("../src/db/client");
let runner: typeof import("../src/engine/runner");
let store: typeof import("../src/engine/run-store");
let signing: typeof import("../src/secrets/signing");
let env: typeof import("../src/env").env;
let app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> };

let child: ChildProcess;
let childSaid = "";
let host: RunHostRef;
const portFile = join(dir, "host-port");

/** What this process asked the run's host, by path and body. */
const peerCalls: { path: string; body: unknown }[] = [];

const inTenant = <R>(fn: () => Promise<R>) => client.withTenant(T, fn);
const row = (runId: string) =>
  inTenant(() => client.db.query.run.findFirst({ where: eq(client.schema.run.id, runId) }));

async function until<V>(get: () => Promise<V>, ok: (v: V) => boolean, ms = 90_000): Promise<V> {
  const end = Date.now() + ms;
  let v = await get();
  while (!ok(v)) {
    if (Date.now() > end) {
      throw new Error(`timed out at ${JSON.stringify(v).slice(0, 600)}\n${childSaid.slice(-3000)}`);
    }
    await new Promise((r) => setTimeout(r, 100));
    v = await get();
  }
  return v;
}

async function startRun(): Promise<string> {
  const wizards = await import("../src/services/wizards");
  return inTenant(async () => {
    const made = await wizards.createWizard("u", { definition: definition as never });
    return runner.createRun({
      wizardId: made.id,
      definition: definition as never,
      files: [],
      version: null,
      mode: "test",
      userId: "u",
    });
  });
}

/** The doors of one run, with its ticket, as a browser calls them. */
function doors(runId: string) {
  const rt = encodeURIComponent(signing.runTicket(runId));
  const headers = { "content-type": "application/json", "accept-language": "en" };
  return {
    view: async () =>
      (await (await app.request(`/api/runs/${runId}?rt=${rt}`, { headers })).json()) as RunView,
    post: (path: string, body?: unknown, method = "POST") =>
      app.request(`/api/runs/${runId}/${path}?rt=${rt}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    stream: async () => {
      const res = await app.request(`/api/runs/${runId}/stream?rt=${rt}`, { headers });
      const reader = res.body?.getReader();
      const views: RunView[] = [];
      const decoder = new TextDecoder();
      let buffered = "";
      const reading = (async () => {
        for (;;) {
          const chunk = await reader?.read().catch(() => null);
          if (!chunk || chunk.done) {
            return;
          }
          buffered += decoder.decode(chunk.value, { stream: true });
          let end = buffered.indexOf("\n\n");
          while (end >= 0) {
            const block = buffered.slice(0, end);
            buffered = buffered.slice(end + 2);
            if (block.includes("event: view")) {
              const data = block.split("\n").find((l) => l.startsWith("data: "));
              if (data) {
                views.push(JSON.parse(data.slice(6)) as RunView);
              }
            }
            end = buffered.indexOf("\n\n");
          }
        }
      })();
      return {
        views,
        close: async () => {
          await reader?.cancel().catch(() => undefined);
          await reading;
        },
      };
    },
  };
}

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
        FEATURES: "runHosts=on",
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
  signing = await import("../src/secrets/signing");
  env = (await import("../src/env")).env;
  app = (await import("../src/app")).default;

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

  const end = Date.now() + 150_000;
  while (!existsSync(portFile)) {
    if (Date.now() > end || child.exitCode !== null) {
      throw new Error(`the second process did not start:\n${childSaid.slice(-4000)}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  host = { kind: "runtime", url: `http://127.0.0.1:${readFileSync(portFile, "utf8").trim()}` };
  env.runHosts = [host];
}, 180_000);

afterAll(async () => {
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

describe("the doors of a run on another runtime process", () => {
  it(
    "show, stream and answer it through its host: a page, try again, a review, back, a step's question",
    { timeout: 300_000 },
    async () => {
      const runId = await startRun();
      // The run lives on the second process: its record says so, and it was handed over there.
      expect(await inTenant(() => store.runStore.hostOf(runId))).toEqual(host);
      expect(peerCalls.map((c) => c.path)).toContain(`/api/peer/runs/${runId}/hand-over`);
      const run = doors(runId);

      const first = await run.view();
      expect(first).toMatchObject({ status: "waiting_input", step: { id: "start" } });
      expect(peerCalls.map((c) => c.path)).toContain(`/api/peer/runs/${runId}/state`);

      const stream = await run.stream();
      // Each move is waited for on the stream of views: it follows the host's changes.
      const streamed = (ok: (v: RunView) => boolean) =>
        until(
          async () => stream.views.at(-1),
          (v) => Boolean(v && ok(v)),
        ) as Promise<RunView>;
      try {
        const answered = await run.post("pages/start", { values: { name: "Ada" } });
        expect(answered.status).toBe(200);
        expect(((await answered.json()) as { rev: number }).rev).toBeGreaterThan(first.rev);

        // The second process drives the run; its first try at `flaky` fails.
        await streamed((v) => v.status === "failed");
        expect((await run.view()).error).toBeTruthy();
        expect((await run.post("retry")).status).toBe(200);

        await streamed((v) => v.status === "waiting_input" && v.step?.id === "check");
        expect((await run.view()).values).toMatchObject({ name: "Ada" });

        // What the person did in a step's view is kept by the host.
        expect((await run.post("views/write", { state: { ticked: [1] } }, "PUT")).status).toBe(200);
        expect((await row(runId))?.state.outputs.write?.view).toEqual({ ticked: [1] });

        // A page the run does not stand on: refused by the host, in the door's words.
        const outdated = await run.post("pages/start", { values: { name: "Bo" } });
        expect(outdated.status).toBe(409);
        expect(await outdated.json()).toEqual({ error: noteText({ code: "pageOutdated" }, "en") });

        const reviewed = await run.post("reviews/check", {
          type: "accept",
          edits: { write: "Edited by Ada" },
        });
        expect(reviewed.status).toBe(200);
        await streamed((v) => v.status === "waiting_input" && v.step?.id === "more");
        expect((await row(runId))?.state.outputs.write?.text).toBe("Edited by Ada");

        expect((await run.post("back")).status).toBe(200);
        await streamed((v) => v.status === "waiting_input" && v.step?.id === "check");
        expect((await run.post("reviews/check", { type: "accept" })).status).toBe(200);
        await streamed((v) => v.status === "waiting_input" && v.step?.id === "more");

        expect((await run.post("pages/more", { values: { ok: "yes" } })).status).toBe(200);
        // `asking` asks the person while it works; the view has it from the host.
        const asked = await streamed((v) => Boolean(v.ask));
        expect(asked.ask).toMatchObject({ kind: "confirm", service: "Notes" });
        expect((await run.post(`ask/${asked.ask?.id}`, { type: "done" })).status).toBe(200);
        await streamed((v) => v.status === "done");
        expect((await row(runId))?.state.outputs.asking?.text).toBe("asked: done");
        // A question no longer open.
        const closed = await run.post(`ask/${asked.ask?.id}`, { type: "done" });
        expect(closed.status).toBe(409);
        expect(await closed.json()).toEqual({ error: noteText({ code: "askClosed" }, "en") });

        expect(stream.views[0]).toMatchObject({ status: "waiting_input", step: { id: "start" } });
      } finally {
        await stream.close();
      }
      expect(peerCalls.map((c) => c.path)).toContain(`/api/peer/runs/${runId}/changes`);
      expect(sentKinds(runId)).toEqual([
        "answered",
        "resume",
        "viewKept",
        "answered",
        "reviewed",
        "back",
        "reviewed",
        "answered",
        "askAnswered",
        "askAnswered",
      ]);
    },
  );

  it("cancels it through its host", { timeout: 120_000 }, async () => {
    const runId = await startRun();
    expect(await inTenant(() => store.runStore.hostOf(runId))).toEqual(host);
    const run = doors(runId);
    expect((await run.post("cancel")).status).toBe(200);
    expect(sentKinds(runId)).toEqual(["cancel"]);
    expect(await until(run.view, (v) => v.status === "cancelled")).toMatchObject({
      status: "cancelled",
    });
  });

  it("with other hosts off, reads the run from its record and asks no host", async () => {
    const runId = await startRun();
    process.env.FEATURES = "";
    try {
      const before = peerCalls.length;
      // A run placed while the switch was on: the record names the host, the doors read the record.
      expect(await doors(runId).view()).toMatchObject({
        status: "waiting_input",
        step: { id: "start" },
      });
      expect(peerCalls.length).toBe(before);
    } finally {
      process.env.FEATURES = "runHosts=on";
    }
  });
});
