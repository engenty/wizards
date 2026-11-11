import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelClass } from "@engenty/wizards-shared/definition";
import type { ModelWay } from "@engenty/wizards-shared/fit";
import { handOverSchema } from "@engenty/wizards-engine/host-api";
import type { RunHostRef } from "@engenty/wizards-shared/run";
import { nanoid } from "nanoid";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Where a new run lives (docs/plans/runs-on-their-own.md, 4.6): with other hosts off, here as
// always; with them on, the first listed host that can run the wizard, handed the run by
// `createRun`. A wizard that needs an installed client never leaves this runtime.
const dir = mkdtempSync(join(tmpdir(), "wizards-run-placing-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.RUNTIME_ROLE = "all";
process.env.FEATURES = "";

/** How the tenant reaches each class, as the settings would say. */
const ways = vi.hoisted(() => ({ current: {} as Partial<Record<string, string>> }));

vi.mock("../src/manage.js", async (original) => ({
  ...(await original<typeof import("../src/manage.js")>()),
  managed: true,
  tenantInfo: async (id: string) => ({ id, status: "active", limits: {} }),
}));
vi.mock("../src/models.js", async (original) => ({
  ...(await original<typeof import("../src/models.js")>()),
  modelWays: async (classes: Iterable<ModelClass>) =>
    Object.fromEntries([...classes].map((cls) => [cls, ways.current[cls]])),
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

let client: typeof import("../src/db/client");
let runner: typeof import("../src/engine/runner");
let store: typeof import("../src/engine/run-store");
let tokens: typeof import("../src/broker/token");
let hosts: typeof import("../src/engine/hosts");
let peer: typeof import("../src/routes/peer").peerRoutes;
let env: typeof import("../src/env").env;

const TENANT = "tenant-run-placing";
const SPACE = "space-1";

/** A page, then the result; it thinks on `standard` (a branch some runs take, say). */
const def = {
  version: 1,
  title: "Placing",
  description: "",
  avatar: "round",
  steps: [
    { id: "a", type: "form", title: "Seite", fields: [{ id: "a_f", kind: "text", label: "Text" }] },
    { id: "done", type: "result", title: "Fertig", deliverables: [] },
  ],
  requires: { models: ["standard"] },
};

/** What the other host was handed, and how it answers. */
let received: { path: string; auth: string | undefined; body: unknown }[] = [];
let answer = 202;
let server: Server;
let other: RunHostRef;
let another: RunHostRef;

const inTenant = <T>(work: () => Promise<T>) => client.withTenant(TENANT, work);

function useWays(way: ModelWay) {
  ways.current = { standard: way };
}

function listHosts(...listed: RunHostRef[]) {
  env.runHosts = listed;
}

/** A run of `def`, started by `createRun`. */
async function startRun(): Promise<string> {
  return inTenant(async () => {
    const wizardId = nanoid(12);
    await client.db.insert(client.schema.wizard).values({
      id: wizardId,
      shareToken: nanoid(16),
      spaceId: SPACE,
      tenantId: TENANT,
      title: "Placing",
      draft: def as never,
      publishedVersion: 1,
    });
    return runner.createRun({
      wizardId,
      definition: def as never,
      files: [{ path: "notes.md", hash: "abc123", mime: "text/markdown", size: 12 }],
      version: 1,
      mode: "live",
      userId: "u-person",
    });
  });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      received.push({
        path: req.url ?? "",
        auth: req.headers.authorization,
        body: JSON.parse(data || "null"),
      });
      res.writeHead(answer, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  other = { kind: "node", url };
  another = { kind: "runtime", url };

  client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb(TENANT);
  await client.controlDb
    .insert(client.control.tenant)
    .values({ id: TENANT, status: "active" } as never)
    .onConflictDoNothing()
    .catch(() => undefined);
  await inTenant(async () => {
    await client.db
      .insert(client.schema.space)
      .values({ id: SPACE, tenantId: TENANT, name: "Space" } as never);
  });
  runner = await import("../src/engine/runner");
  store = await import("../src/engine/run-store");
  tokens = await import("../src/broker/token");
  hosts = await import("../src/engine/hosts");
  env = (await import("../src/env")).env;
  peer = (await import("../src/routes/peer")).peerRoutes;
}, 60_000);

afterAll(async () => {
  await new Promise((done) => server.close(done));
});

beforeEach(() => {
  received = [];
  answer = 202;
  process.env.FEATURES = "";
  useWays("credits");
  listHosts();
});

describe("with other hosts off", () => {
  it("every run lives here, whatever is listed", async () => {
    listHosts(other);
    expect(await inTenant(() => hosts.hostFor(def as never))).toBeNull();
    const runId = await startRun();
    expect(await inTenant(() => store.runStore.hostOf(runId))).toBeNull();
    expect(received).toEqual([]);
  });
});

describe("with other hosts on", () => {
  beforeEach(() => {
    process.env.FEATURES = "runHosts=on";
  });

  it("nothing listed: the run lives here", async () => {
    expect(await inTenant(() => hosts.hostFor(def as never))).toBeNull();
    const runId = await startRun();
    expect(await inTenant(() => store.runStore.hostOf(runId))).toBeNull();
    expect(received).toEqual([]);
  });

  it("the first listed host that fits takes the run, handed its definition, files, token and state", async () => {
    listHosts({ kind: "edge", url: "http://127.0.0.1:9" }, other);
    useWays("ollama");
    // An object at the edge has no local model; `wizards run` reaches Ollama.
    expect(await inTenant(() => hosts.hostFor(def as never))).toEqual(other);

    const runId = await startRun();
    expect(await inTenant(() => store.runStore.hostOf(runId))).toEqual(other);
    expect(received).toHaveLength(1);
    const [call] = received;
    expect(call.path).toBe(`/api/peer/runs/${runId}/hand-over`);
    const handed = handOverSchema.parse(call.body);
    expect(call.auth).toBe(`Bearer ${handed.token}`);
    expect(handed).toMatchObject({
      runId,
      definition: { title: "Placing" },
      files: [{ path: "notes.md", hash: "abc123" }],
      run: { cursor: "a", status: "waiting_input", state: { values: {}, history: [] }, rev: 0 },
    });
    // The token is signed after the host was set: it names the host's kind and opens the run.
    expect(await tokens.readRunToken(handed.token)).toMatchObject({
      claims: { run: runId, host: "node", tenant: TENANT },
    });
  });

  it("a wizard that needs an installed client stays here, whatever is listed", async () => {
    listHosts(other, another, { kind: "edge", url: "http://127.0.0.1:9" });
    useWays("client");
    expect(await inTenant(() => hosts.hostFor(def as never))).toBeNull();
    const runId = await startRun();
    expect(await inTenant(() => store.runStore.hostOf(runId))).toBeNull();
    expect(received).toEqual([]);
  });

  it("Apple on this Mac keeps the run here too, even with another runtime listed", async () => {
    listHosts(another);
    useWays("apple");
    expect(await inTenant(() => hosts.hostFor(def as never))).toBeNull();
    useWays("key");
    expect(await inTenant(() => hosts.hostFor(def as never))).toEqual(another);
  });

  it("a host that does not take the run leaves it here, with a token of this runtime", async () => {
    listHosts(other);
    answer = 404;
    const runId = await startRun();
    expect(received).toHaveLength(1);
    expect(await inTenant(() => store.runStore.hostOf(runId))).toBeNull();
    const token = await inTenant(async () => {
      const run = await store.runStore.get(runId);
      return run && tokens.tokenOf(run);
    });
    expect(await tokens.readRunToken(token ?? "")).toMatchObject({
      claims: { run: runId, host: "runtime" },
    });
  });
});

describe("another runtime process takes a run handed to it", () => {
  beforeEach(() => {
    process.env.FEATURES = "runHosts=on";
  });

  /** A run placed on `another`, and what its hand-over carried. */
  async function placed() {
    listHosts(another);
    const runId = await startRun();
    const call = received[received.length - 1];
    return { runId, auth: call.auth ?? "", body: call.body as Record<string, unknown> };
  }

  const handOverTo = (runId: string, auth: string, body: unknown) =>
    peer.request(`/runs/${runId}/hand-over`, {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("takes the run its token names", async () => {
    const { runId, auth, body } = await placed();
    const res = await handOverTo(runId, auth, body);
    expect(res.status).toBe(202);
  });

  it("refuses a token that is not the run's", async () => {
    const { runId, body } = await placed();
    expect((await handOverTo(runId, "Bearer nonsense", body)).status).toBe(401);
    const { runId: second, auth } = await placed();
    // The second run's token does not open the first.
    expect((await handOverTo(runId, auth, { ...body, token: auth.slice(7) })).status).toBe(401);
    expect(second).not.toBe(runId);
  });

  it("refuses a body that is not this run's hand-over", async () => {
    const { runId, auth, body } = await placed();
    expect((await handOverTo(runId, auth, { ...body, runId: "another-run" })).status).toBe(400);
    expect((await handOverTo(runId, auth, { runId })).status).toBe(400);
  });

  it("refuses a run its record keeps on the tenant's runtime", async () => {
    const runId = await startRun();
    const { body } = await placed();
    const token = await inTenant(async () => {
      const run = await store.runStore.get(runId);
      return (run && (await tokens.tokenOf(run))) ?? "";
    });
    const res = await handOverTo(runId, `Bearer ${token}`, { ...body, runId, token });
    expect(res.status).toBe(409);
  });

  it("is not there while other hosts are off", async () => {
    const { runId, auth, body } = await placed();
    process.env.FEATURES = "";
    expect((await handOverTo(runId, auth, body)).status).toBe(404);
  });
});
