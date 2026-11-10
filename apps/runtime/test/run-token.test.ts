import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { beforeAll, describe, expect, it, vi } from "vitest";

// A run's token (docs/plans/runs-on-their-own.md, 3.1): `createRun` draws its id, the runtime
// signs it from the run, and `readRunToken` opens the tenant the token names and checks the run.
const dir = mkdtempSync(join(tmpdir(), "wizards-run-token-"));
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
let tokens: typeof import("../src/broker/token");
let signing: typeof import("../src/secrets/signing");

const A = "tenant-token-a";
const B = "tenant-token-b";
const SPACE = "space-1";
const CLIENT = "space-client";
const PERSON = "u-person";

const def = {
  version: 1,
  title: "Token",
  description: "",
  avatar: "round",
  steps: [
    { id: "a", type: "form", title: "Seite", fields: [{ id: "a_f", kind: "text", label: "Text" }] },
    { id: "done", type: "result", title: "Fertig", deliverables: [] },
  ],
};

const row = (tenant: string, runId: string) =>
  client.withTenant(tenant, () =>
    client.db.query.run.findFirst({ where: eq(client.schema.run.id, runId) }),
  );

/** A run of `def` in `tenant`, started by `createRun`, and its token. */
async function startRun(tenant: string, more: { clientSpaceId?: string } = {}) {
  return client.withTenant(tenant, async () => {
    const wizardId = nanoid(12);
    await client.db.insert(client.schema.wizard).values({
      id: wizardId,
      shareToken: nanoid(16),
      spaceId: SPACE,
      tenantId: tenant,
      title: "Token",
      draft: def as never,
      publishedVersion: 1,
    });
    const runId = await runner.createRun({
      wizardId,
      definition: def as never,
      files: [],
      version: 1,
      mode: "live",
      userId: PERSON,
      ...more,
    });
    const run = await client.db.query.run.findFirst({ where: eq(client.schema.run.id, runId) });
    const token = run && (await tokens.tokenOf(run));
    if (!token) {
      throw new Error("no token");
    }
    return { runId, wizardId, token };
  });
}

const claimsIn = (token: string) => {
  const read = signing.runTokenClaims(token);
  if (!("claims" in read)) {
    throw new Error(read.refused);
  }
  return read.claims;
};

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  for (const tenant of [A, B]) {
    await client.openTenantDb(tenant);
    await client.controlDb
      .insert(client.control.tenant)
      .values({ id: tenant, status: "active" } as never)
      .onConflictDoNothing()
      .catch(() => undefined);
    await client.withTenant(tenant, async () => {
      await client.db
        .insert(client.schema.space)
        .values({ id: SPACE, tenantId: tenant, name: "Space" } as never);
      await client.db
        .insert(client.schema.space)
        .values({ id: CLIENT, tenantId: tenant, name: "Client", kind: "client", parentId: SPACE } as never);
    });
  }
  runner = await import("../src/engine/runner");
  tokens = await import("../src/broker/token");
  signing = await import("../src/secrets/signing");
}, 60_000);

describe("a run's token", () => {
  it("createRun keeps the token's id, not the token, and the token reads back as the run", async () => {
    const { runId, wizardId, token } = await startRun(A);
    const run = await row(A, runId);
    expect(run?.tokenId).toBeTruthy();
    expect(JSON.stringify(run)).not.toContain(token);
    const read = await tokens.readRunToken(token);
    expect(read).toEqual({
      claims: {
        jti: run?.tokenId,
        tenant: A,
        run: runId,
        wizard: wizardId,
        space: SPACE,
        dataSpace: SPACE,
        mode: "live",
        holder: `u:${PERSON}`,
        host: "runtime",
        exp: Math.floor((run?.expiresAt?.getTime() ?? 0) / 1000),
      },
    });
    // Signed again from the run, it is the same token.
    expect(await client.withTenant(A, async () => run && tokens.tokenOf(run))).toBe(token);
  });

  it("a run of a client space names that space for its data", async () => {
    const { token } = await startRun(A, { clientSpaceId: CLIENT });
    const read = await tokens.readRunToken(token);
    expect(read).toMatchObject({ claims: { space: SPACE, dataSpace: CLIENT } });
  });

  it("a token of tenant A is refused for tenant B", async () => {
    const { token } = await startRun(A);
    // Signed by this runtime, naming tenant B: B has no such run.
    const forB = signing.runToken({ ...claimsIn(token), tenant: B });
    expect(await tokens.readRunToken(forB)).toEqual({ refused: "no_run" });
    // A run of B with the same id is still not the token's run.
    const { runId: other } = await startRun(B);
    const same = await row(B, other);
    const onB = signing.runToken({ ...claimsIn(token), tenant: B, run: other });
    expect(same?.tokenId).not.toBe(claimsIn(token).jti);
    expect(await tokens.readRunToken(onB)).toEqual({ refused: "not_this_run" });
    // A's own token still opens A's run.
    expect(await tokens.readRunToken(token)).toHaveProperty("claims");
  });

  it("an ended run's token is refused", async () => {
    for (const status of ["done", "failed", "cancelled"] as const) {
      const { runId, token } = await startRun(A);
      await client.withTenant(A, () =>
        client.db.update(client.schema.run).set({ status }).where(eq(client.schema.run.id, runId)),
      );
      expect(await tokens.readRunToken(token)).toEqual({ refused: "over" });
    }
  });

  it("a run that waits or sleeps keeps its token", async () => {
    const { runId, token } = await startRun(A);
    for (const status of ["running", "sleeping", "waiting_signal", "waiting_input"] as const) {
      await client.withTenant(A, () =>
        client.db.update(client.schema.run).set({ status }).where(eq(client.schema.run.id, runId)),
      );
      expect(await tokens.readRunToken(token)).toHaveProperty("claims");
    }
  });

  it("a changed claim is refused", async () => {
    const { token } = await startRun(A);
    const claims = claimsIn(token);
    // Changed in the token, its signature no longer holds.
    const [, sig] = token.split(".");
    const body = Buffer.from(JSON.stringify({ ...claims, mode: "test" })).toString("base64url");
    expect(await tokens.readRunToken(`${body}.${sig}`)).toEqual({ refused: "signature" });
    // Signed, but saying what the run does not.
    const changes = [
      { wizard: "other-wizard" },
      { space: "other-space" },
      { dataSpace: CLIENT },
      { mode: "test" as const },
      { holder: "v:someone" },
    ];
    for (const change of changes) {
      expect(await tokens.readRunToken(signing.runToken({ ...claims, ...change }))).toEqual({
        refused: "claims",
      });
    }
    // Another token id is another token.
    expect(await tokens.readRunToken(signing.runToken({ ...claims, jti: "other" }))).toEqual({
      refused: "not_this_run",
    });
  });

  it("an expired token is refused, a later one of the same run is not", async () => {
    const { token } = await startRun(A);
    const claims = claimsIn(token);
    const past = Math.floor(Date.now() / 1000) - 60;
    expect(await tokens.readRunToken(signing.runToken({ ...claims, exp: past }))).toEqual({
      refused: "expired",
    });
    const later = claims.exp + 7 * 24 * 3600;
    expect(await tokens.readRunToken(signing.runToken({ ...claims, exp: later }))).toHaveProperty(
      "claims",
    );
  });

  it("a run from before tokens has none, and its signed claims open nothing", async () => {
    const { runId, token } = await startRun(A);
    await client.withTenant(A, () =>
      client.db
        .update(client.schema.run)
        .set({ tokenId: null })
        .where(eq(client.schema.run.id, runId)),
    );
    const run = await row(A, runId);
    expect(await client.withTenant(A, async () => run && tokens.tokenOf(run))).toBeNull();
    expect(await tokens.readRunToken(token)).toEqual({ refused: "not_this_run" });
  });

  it("anything else is refused without throwing", async () => {
    for (const bad of ["", "x", "a.b.c", "not-json.sig", `${"e30"}.${"sig"}`]) {
      const read = await tokens.readRunToken(bad);
      expect(read).toHaveProperty("refused");
    }
  });
});
