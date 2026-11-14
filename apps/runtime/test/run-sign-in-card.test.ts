import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "wizards-run-sign-in-card-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.FEATURES = "durableRuns=on";
process.env.RUNNER_CLOCK_MS = "100";
process.env.GOOGLE_OAUTH_CLIENT_ID = "client-id";
process.env.GOOGLE_OAUTH_CLIENT_SECRET = "client-secret";

const T = "tenant-run-sign-in-card";
const LENA = "lena-admin";
const MAX = "max-member";

vi.mock("../src/manage.js", async (original) => ({
  ...(await original<typeof import("../src/manage.js")>()),
  managed: true,
  tenantInfo: async (id: string) => ({ id, status: "active", limits: {} }),
  tenantMembers: async () => ({ members: [], invitations: [], seats: { limit: null, taken: 0 } }),
}));
vi.mock("../src/engine/requirements.js", async (original) => ({
  ...(await original<typeof import("../src/engine/requirements.js")>()),
  missingModelsSaid: async () => [],
}));
vi.mock("../src/safety.js", async (original) => ({
  ...(await original<typeof import("../src/safety.js")>()),
  guestChecksOn: async () => false,
}));
vi.mock("../src/credits/credits.js", async (original) => ({
  ...(await original<typeof import("../src/credits/credits.js")>()),
  reserveForRun: async () => true,
  releaseRun: async () => undefined,
  canSpend: async () => true,
}));
/** What the step does on each try, by wizard: the first ones meet a missing sign-in, then it works. */
const script = vi.hoisted(() => ({ refusals: new Map<string, number>(), tries: [] as string[] }));
vi.mock("../src/engine/steps.js", async (original) => ({
  ...(await original<typeof import("../src/engine/steps.js")>()),
  runAutomaticStep: async (step: { id: string }, ctx: { runId: string; store: { wizardId: string } }) => {
    script.tries.push(ctx.runId);
    const left = script.refusals.get(ctx.store.wizardId) ?? 0;
    if (left > 0) {
      script.refusals.set(ctx.store.wizardId, left - 1);
      const { SignInNeeded } = await import("../src/engine/types.js");
      throw new SignInNeeded("Postfach", { code: "stepCallRefused" } as never, "box");
    }
    return { text: `made ${step.id}`, at: new Date().toISOString() };
  },
}));
/** Who is signed in, for the routes: null is nobody. */
const who = vi.hoisted(() => ({
  user: null as null | {
    id: string;
    tenantId: string;
    role: string;
    name: string;
    email: string;
    impersonatedBy: null;
  },
}));
vi.mock("../src/auth/index.js", async (original) => ({
  ...(await original<typeof import("../src/auth/index.js")>()),
  principalOf: async () => who.user,
}));
vi.mock("../src/features.js", async (original) => {
  const real = await original<typeof import("../src/features.js")>();
  return {
    ...real,
    currentFeatures: async () => ({ ...(await real.currentFeatures()), durableRuns: true }),
    feature: (name: string, remote: unknown) =>
      name === "durableRuns" ? true : real.feature(name as never, remote as never),
  };
});

let client: typeof import("../src/db/client");
let runner: typeof import("../src/engine/runner");
let events: typeof import("../src/engine/events");
let app: { fetch: (r: Request) => Promise<Response> };

const inTenant = <R>(fn: () => Promise<R>) => client.withTenant(T, fn);
const row = (id: string) =>
  inTenant(() => client.db.query.run.findFirst({ where: eq(client.schema.run.id, id) }));

async function until(ok: () => Promise<boolean>, ms = 8000) {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (await ok()) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}
const sleeps = (id: string) => until(async () => (await row(id))?.status === "sleeping");

const work = { id: "mail", type: "agent", title: "Mails lesen", instructions: "Read.", tools: [], output: { format: "text" } };
const end = { id: "done", type: "result", title: "Fertig", deliverables: [] };

/** A run whose step meets a missing sign-in to `box` once, by a visitor or a member. */
async function waitingRun(box: object, by: { visitorId?: string; userId?: string }) {
  const def = {
    version: 1,
    title: "Postfach",
    description: "",
    avatar: "round",
    connections: [{ id: "box", ...box }],
    steps: [work, end],
  };
  const wizardId = nanoid(12);
  const runId = await inTenant(async () => {
    await client.db.insert(client.schema.wizard).values({
      id: wizardId,
      shareToken: nanoid(16),
      spaceId: "space-1",
      tenantId: T,
      title: def.title,
      draft: def as never,
      publishedVersion: 1,
    });
    script.refusals.set(wizardId, 1);
    return runner.createRun({
      wizardId,
      definition: def as never,
      files: [],
      version: 1,
      mode: "live",
      userId: by.userId ?? null,
      visitorId: by.visitorId ?? null,
    });
  });
  expect(await sleeps(runId)).toBe(true);
  return { id: runId, wizardId };
}

const signIn = (id: string | null, role = "member") => {
  who.user = id
    ? { id, tenantId: T, role, name: id, email: `${id}@example.com`, impersonatedBy: null }
    : null;
};

const call = (runId: string, path: string, method = "GET", body?: unknown, visitor?: string) =>
  app.fetch(
    new Request(`http://localhost:5181/api/runs/${runId}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(visitor ? { "x-wizards-visitor": visitor } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
const viewAs = async (runId: string, visitor?: string) =>
  (await (await call(runId, "", "GET", undefined, visitor)).json()) as {
    signIn: null | { admin: true } | { connection: { id: string; account: unknown; connectors: { id: string; auth: string }[] } };
  };

async function spaceConnection(id: string, signIn: "space" | "person", audience = "all") {
  await inTenant(() =>
    client.db.insert(client.schema.spaceConnection).values({
      id,
      spaceId: "space-1",
      connectorId: "google-gmail",
      name: "Vertrieb",
      signIn,
      audience: audience as never,
      rules: { read: "allow", write: "ask", destructive: "deny", send: "ask" },
    }),
  );
}

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb(T);
  await client.controlDb
    .insert(client.control.tenant)
    .values({ id: T, status: "active" } as never)
    .onConflictDoNothing()
    .catch(() => undefined);
  runner = await import("../src/engine/runner");
  events = await import("../src/engine/events");
  await inTenant(() =>
    client.db.insert(client.schema.space).values({ id: "space-1", tenantId: T, name: "Space" } as never),
  );
  app = (await import("../src/app")).default as never;
  runner.startRunner();
}, 120_000);

afterAll(async () => {
  await runner.stopRunner();
});

beforeEach(() => signIn(null));

describe("a step that waits for a sign-in to the wizard's own account", () => {
  it("the pause names the connection, and the guest whose run it is gets the card", async () => {
    const { id } = await waitingRun({ kind: "mail", title: "Postfach" }, { visitorId: "v-1" });
    expect((await row(id))?.state.pause).toEqual({
      kind: "sign_in",
      service: "Postfach",
      connection: "box",
    });
    const view = await viewAs(id, "v-1");
    expect(view.signIn).toMatchObject({ connection: { id: "box", account: null } });
    const connectors = view.signIn && "connection" in view.signIn ? view.signIn.connection.connectors : [];
    expect(connectors.map((c) => c.id)).toContain("imap");
    // Someone of the organization reading along signs nobody in.
    signIn(LENA, "owner");
    expect((await viewAs(id)).signIn).toBeNull();
    await inTenant(() => runner.cancel(id));
  });

  it("goes on at once after the sign-in, and the card goes with the wait", async () => {
    const { id } = await waitingRun({ kind: "mail", title: "Postfach" }, { visitorId: "v-2" });
    const before = script.tries.filter((t) => t === id).length;
    const res = await call(id, "/signed-in", "POST", {}, "v-2");
    expect(res.status).toBe(200);
    expect(await until(async () => (await row(id))?.status === "done")).toBe(true);
    expect(script.tries.filter((t) => t === id).length).toBe(before + 1);
    expect((await row(id))?.state.pause).toBeUndefined();
    expect((await viewAs(id, "v-2")).signIn).toBeNull();
  });

  it("a look before the sign-in waits again and says nothing new", async () => {
    const { id, wizardId } = await waitingRun(
      { kind: "mail", title: "Postfach" },
      { visitorId: "v-3" },
    );
    script.refusals.set(wizardId, 1);
    const rev = (await row(id))?.rev ?? 0;
    await call(id, "/signed-in", "POST", {}, "v-3");
    expect(
      await until(async () => {
        const r = await row(id);
        return (r?.rev ?? 0) > rev + 1 && r?.status === "sleeping";
      }),
    ).toBe(true);
    const told = (await inTenant(() => events.recentEvents(id, 0, 50))).filter(
      (e) => e.note?.code === "stepWaitsSignIn",
    );
    expect(told).toHaveLength(1);
    await inTenant(() => runner.cancel(id));
  });
});

describe("a step that waits for a sign-in to a connection of the space", () => {
  it("where each person signs in: the member whose run it is gets the card, and signs in from it", async () => {
    await spaceConnection("sc-each", "person");
    const { id } = await waitingRun({ spaceConnection: "sc-each" }, { userId: MAX });
    signIn(MAX);
    const view = await viewAs(id);
    expect(view.signIn).toMatchObject({
      connection: { id: "box", account: null, connectors: [{ id: "google-gmail", auth: "oauth2" }] },
    });
    const res = await call(id, "/connections/box/oauth/google-gmail", "POST", {});
    expect(res.status).toBe(200);
    expect(((await res.json()) as { url: string }).url).toContain("client_id=client-id");
    await inTenant(() => runner.cancel(id));
  });

  it("a guest never gets the card for it, and the route turns them down", async () => {
    const { id } = await waitingRun({ spaceConnection: "sc-each" }, { visitorId: "v-4" });
    expect((await viewAs(id, "v-4")).signIn).toBeNull();
    const res = await call(id, "/connections/box/oauth/google-gmail", "POST", {}, "v-4");
    expect(res.status).toBe(403);
    await inTenant(() => runner.cancel(id));
  });

  it("a member it is not open to gets no card, and the space's rule turns them down", async () => {
    await spaceConnection("sc-admins", "person", "admins");
    const { id } = await waitingRun({ spaceConnection: "sc-admins" }, { userId: MAX });
    signIn(MAX);
    expect((await viewAs(id)).signIn).toBeNull();
    const res = await call(id, "/connections/box/oauth/google-gmail", "POST", {});
    expect(res.status).toBe(403);
    await inTenant(() => runner.cancel(id));
  });

  it("that signs in as the space: an admin's to sign in again, with no card", async () => {
    await spaceConnection("sc-space", "space");
    const { id } = await waitingRun({ spaceConnection: "sc-space" }, { userId: MAX });
    signIn(MAX);
    expect((await viewAs(id)).signIn).toEqual({ admin: true });
    const said = (await inTenant(() => events.recentEvents(id, 0, 50))).map((e) => e.note?.code);
    expect(said).toContain("stepWaitsAdminSignIn");
    expect(said).not.toContain("stepWaitsSignIn");
    await inTenant(() => runner.cancel(id));
  });
});
