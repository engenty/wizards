import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nanoid } from "nanoid";
import { beforeAll, describe, expect, it, vi } from "vitest";

// A run's record names its host (docs/plans/runs-on-their-own.md, 4.1): null is this runtime, as
// for every run before other hosts; otherwise the host's kind and address, which the token carries.
const dir = mkdtempSync(join(tmpdir(), "wizards-run-host-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.RUNTIME_ROLE = "web";

vi.mock("../src/manage.js", async (original) => ({
  ...(await original<typeof import("../src/manage.js")>()),
  managed: true,
  tenantInfo: async (id: string) => ({ id, status: "active", limits: {} }),
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

const TENANT = "tenant-run-host";
const SPACE = "space-1";

const def = {
  version: 1,
  title: "Host",
  description: "",
  avatar: "round",
  steps: [
    { id: "a", type: "form", title: "Seite", fields: [{ id: "a_f", kind: "text", label: "Text" }] },
    { id: "done", type: "result", title: "Fertig", deliverables: [] },
  ],
};

const inTenant = <T>(work: () => Promise<T>) => client.withTenant(TENANT, work);

/** A run of `def`, started by `createRun`. */
async function startRun(): Promise<string> {
  return inTenant(async () => {
    const wizardId = nanoid(12);
    await client.db.insert(client.schema.wizard).values({
      id: wizardId,
      shareToken: nanoid(16),
      spaceId: SPACE,
      tenantId: TENANT,
      title: "Host",
      draft: def as never,
      publishedVersion: 1,
    });
    return runner.createRun({
      wizardId,
      definition: def as never,
      files: [],
      version: 1,
      mode: "live",
      userId: "u-person",
    });
  });
}

/** The run's token, signed from its record now. */
const tokenNow = (runId: string) =>
  inTenant(async () => {
    const run = await store.runStore.get(runId);
    const token = run && (await tokens.tokenOf(run));
    if (!token) {
      throw new Error("no token");
    }
    return token;
  });

beforeAll(async () => {
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
}, 60_000);

describe("a run's host", () => {
  it("a run without a host lives in this runtime and reads as before", async () => {
    const runId = await startRun();
    const run = await inTenant(() => store.runStore.get(runId));
    expect(run?.host).toBeNull();
    expect(run?.status).toBe("waiting_input");
    expect(await inTenant(() => store.runStore.hostOf(runId))).toBeNull();
    expect(await tokens.readRunToken(await tokenNow(runId))).toMatchObject({
      claims: { run: runId, host: "runtime" },
    });
  });

  it("a host round-trips through the store, and null brings the run back", async () => {
    const runId = await startRun();
    const elsewhere = { kind: "runtime" as const, url: "http://127.0.0.1:18899" };
    await inTenant(() => store.runStore.setHost(runId, elsewhere));
    expect(await inTenant(() => store.runStore.hostOf(runId))).toEqual(elsewhere);
    expect((await inTenant(() => store.runStore.get(runId)))?.host).toEqual(elsewhere);
    await inTenant(() => store.runStore.setHost(runId, null));
    expect(await inTenant(() => store.runStore.hostOf(runId))).toBeNull();
  });

  it("no run has no host", async () => {
    expect(await inTenant(() => store.runStore.hostOf("no-such-run"))).toBeUndefined();
  });

  it("the token names the record's host kind, and one naming another is refused", async () => {
    const runId = await startRun();
    const before = await tokenNow(runId);
    await inTenant(() =>
      store.runStore.setHost(runId, { kind: "node", url: "http://127.0.0.1:18898" }),
    );
    const now = await tokenNow(runId);
    expect(await tokens.readRunToken(now)).toMatchObject({ claims: { run: runId, host: "node" } });
    // Signed while the run lived here, it no longer matches the record.
    expect(await tokens.readRunToken(before)).toEqual({ refused: "claims" });
  });
});
