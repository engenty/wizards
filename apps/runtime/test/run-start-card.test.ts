import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The connect card at a run's start and where a step needs an account (docs/plans/run-connections.md,
 * step 3): a need with no account to use asks first, one account asks nothing, several are chosen
 * once; an admin may connect for the space, nobody else.
 */
const dir = mkdtempSync(join(tmpdir(), "wizards-run-start-card-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.RUNNER_CLOCK_MS = "100";
process.env.GOOGLE_OAUTH_CLIENT_ID = "client-id";
process.env.GOOGLE_OAUTH_CLIENT_SECRET = "client-secret";

const T = "tenant-run-start-card";
const LENA = "lena-admin";
const MAX = "max-member";
const SPACE = "space-1";

/** The switch `runConnections`, per test. */
const switches = vi.hoisted(() => ({ runConnections: true }));

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
/** The runs whose automatic steps ran. */
const ran = vi.hoisted(() => [] as string[]);
vi.mock("../src/engine/steps.js", async (original) => ({
  ...(await original<typeof import("../src/engine/steps.js")>()),
  runAutomaticStep: async (step: { id: string }, ctx: { runId: string }) => {
    ran.push(`${ctx.runId}:${step.id}`);
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
    currentFeatures: async () => ({
      ...(await real.currentFeatures()),
      durableRuns: true,
      runConnections: switches.runConnections,
    }),
    feature: (name: string, remote: unknown) =>
      name === "durableRuns" ? true : real.feature(name as never, remote as never),
  };
});

let client: typeof import("../src/db/client");
let runner: typeof import("../src/engine/runner");
let events: typeof import("../src/engine/events");
let own: typeof import("../src/connectors/person-connections");
let crypto: typeof import("../src/secrets/crypto");
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
const statusIs = (id: string, status: string) =>
  until(async () => (await row(id))?.status === status);

const box = { id: "box", kind: "mail", title: "Gmail" };
const page = {
  id: "ask",
  type: "form",
  title: "Wie lange?",
  fields: [{ id: "days", kind: "text", label: "Tage" }],
};
const read = {
  id: "read",
  type: "agent",
  title: "Mails lesen",
  instructions: "Read.",
  tools: [],
  connections: ["box"],
  output: { format: "text" },
};
const end = { id: "done", type: "result", title: "Fertig", deliverables: [] };

/** A wizard of the space with these steps, and a run of it by a member, an admin or a guest. */
async function startRun(steps: object[], by: { userId?: string; visitorId?: string }) {
  const def = {
    version: 1,
    title: "Wichtige Mails",
    description: "",
    avatar: "round",
    connections: [box],
    steps,
  };
  const wizardId = nanoid(12);
  const id = await inTenant(async () => {
    await client.db.insert(client.schema.wizard).values({
      id: wizardId,
      shareToken: nanoid(16),
      spaceId: SPACE,
      tenantId: T,
      title: def.title,
      draft: def as never,
      publishedVersion: 1,
    });
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
  return { id, wizardId };
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

interface Card {
  id: string;
  account: { label: string } | null;
  candidates: { id: string; owner: string; label: string; name: string | null; chosen: boolean }[];
  connectors: { id: string }[];
  forSpace?: string[];
}
const viewAs = async (runId: string, visitor?: string) =>
  (await (await call(runId, "", "GET", undefined, visitor)).json()) as {
    status: string;
    connect: Card[];
    signIn: unknown;
  };

/** An account of the person (or visitor) `holder`, kept as their own connection. */
const ownAccount = (holder: string, label: string) =>
  inTenant(() => own.saveConnection(holder, "mail-gmail", label, { accessToken: label }));

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
  own = await import("../src/connectors/person-connections");
  crypto = await import("../src/secrets/crypto");
  await inTenant(() =>
    client.db.insert(client.schema.space).values({ id: SPACE, tenantId: T, name: "Space" } as never),
  );
  app = (await import("../src/app")).default as never;
  runner.startRunner();
}, 120_000);

afterAll(async () => {
  await runner.stopRunner();
});

beforeEach(async () => {
  signIn(null);
  switches.runConnections = true;
  // Every test starts with nobody's accounts.
  await inTenant(async () => {
    await client.db.delete(client.schema.connectionChoice);
    await client.db.delete(client.schema.personConnection);
    await client.db.delete(client.schema.spaceConnection);
  });
});

describe("at a run's start", () => {
  it("one account that fits: no card, the run goes on by itself", async () => {
    await ownAccount(`u:${MAX}`, "max@gmail.com");
    const { id } = await startRun([read, end], { userId: MAX });
    expect(await statusIs(id, "done")).toBe(true);
    expect(ran).toContain(`${id}:read`);
    signIn(MAX);
    expect((await viewAs(id)).connect).toEqual([]);
  });

  it("no account: the card comes before the first page", async () => {
    const { id } = await startRun([page, read, end], { userId: MAX });
    expect(await statusIs(id, "waiting_input")).toBe(true);
    signIn(MAX);
    const view = await viewAs(id);
    expect(view.connect).toMatchObject([{ id: "box", account: null, candidates: [] }]);
    expect(view.connect[0].connectors.map((c) => c.id)).toContain("mail-gmail");
    // Someone of the organization reading along is asked nothing.
    signIn(LENA, "owner");
    expect((await viewAs(id)).connect).toEqual([]);
    await inTenant(() => runner.cancel(id));
  });

  it("no account and no page first: the run waits before the step, and goes on once connected", async () => {
    const { id, wizardId } = await startRun([read, end], { userId: MAX });
    expect(await statusIs(id, "sleeping")).toBe(true);
    expect(ran).not.toContain(`${id}:read`);
    expect((await row(id))?.state.pause).toEqual({
      kind: "sign_in",
      service: "Gmail",
      connection: "box",
    });
    const said = (await inTenant(() => events.recentEvents(id, 0, 50))).map((e) => e.note?.code);
    expect(said).toContain("stepWaitsConnect");
    signIn(MAX);
    const view = await viewAs(id);
    expect(view.connect.map((c) => c.id)).toEqual(["box"]);
    // The connect card of `connect` asks; the sign-in card of a refused account does not.
    expect(view.signIn).toBeNull();
    // Woken before anything is connected, it waits again and says nothing new.
    const rev = (await row(id))?.rev ?? 0;
    await call(id, "/signed-in", "POST", {});
    expect(
      await until(async () => {
        const r = await row(id);
        return (r?.rev ?? 0) > rev + 1 && r?.status === "sleeping";
      }),
    ).toBe(true);
    expect(ran).not.toContain(`${id}:read`);
    const told = (await inTenant(() => events.recentEvents(id, 0, 50))).filter(
      (e) => e.note?.code === "stepWaitsConnect",
    );
    expect(told).toHaveLength(1);
    // Connected (as the provider's callback keeps it): it goes on.
    await inTenant(async () => {
      const kept = await own.saveConnection(`u:${MAX}`, "mail-gmail", "max@gmail.com", {});
      await own.remember(wizardId, "box", `u:${MAX}`, { kind: "person", row: kept });
    });
    await call(id, "/signed-in", "POST", {});
    expect(await statusIs(id, "done")).toBe(true);
  });

  it("a page's connect field and the start card ask once, at the start", async () => {
    const connectPage = {
      id: "ask",
      type: "form",
      title: "Postfach",
      fields: [{ id: "mailbox", kind: "connection", label: "Postfach", connection: "box" }],
    };
    const { id, wizardId } = await startRun([connectPage, read, end], { userId: MAX });
    expect(await statusIs(id, "waiting_input")).toBe(true);
    signIn(MAX);
    expect((await viewAs(id)).connect.map((c) => c.id)).toEqual(["box"]);
    await inTenant(async () => {
      const kept = await own.saveConnection(`u:${MAX}`, "mail-gmail", "max@gmail.com", {});
      await own.remember(wizardId, "box", `u:${MAX}`, { kind: "person", row: kept });
    });
    const view = (await (await call(id, "")).json()) as {
      connect: Card[];
      connections: Card[];
    };
    expect(view.connect).toEqual([]);
    expect(view.connections).toMatchObject([{ id: "box", account: { label: "max@gmail.com" } }]);
    await inTenant(() => runner.cancel(id));
  });

  it("switch off: no card at the start, as before", async () => {
    switches.runConnections = false;
    const { id } = await startRun([page, read, end], { userId: MAX });
    expect(await statusIs(id, "waiting_input")).toBe(true);
    signIn(MAX);
    expect((await viewAs(id)).connect).toEqual([]);
    await inTenant(() => runner.cancel(id));
  });
});

describe("a need on a branch", () => {
  it("asks only when the run gets there", async () => {
    const choose = {
      id: "ask",
      type: "form",
      title: "Mails?",
      fields: [{ id: "mails", kind: "toggle", label: "Mails lesen" }],
      next: [{ when: { field: "mails", op: "truthy" }, goto: "read" }, { goto: "done" }],
    };
    const { id } = await startRun([choose, read, end], { userId: MAX });
    expect(await statusIs(id, "waiting_input")).toBe(true);
    signIn(MAX);
    expect((await viewAs(id)).connect).toEqual([]);
    await inTenant(() => runner.submitPage(id, "ask", { mails: true }, { userId: MAX }));
    expect(await statusIs(id, "sleeping")).toBe(true);
    expect(ran).not.toContain(`${id}:read`);
    expect((await viewAs(id)).connect.map((c) => c.id)).toEqual(["box"]);
    await inTenant(() => runner.cancel(id));
  });
});

describe("several accounts", () => {
  it("the card lists them; the one chosen is remembered and the next run asks nothing", async () => {
    await ownAccount(`u:${MAX}`, "max@gmail.com");
    await ownAccount(`u:${MAX}`, "max.work@gmail.com");
    const { id, wizardId } = await startRun([read, end], { userId: MAX });
    expect(await statusIs(id, "sleeping")).toBe(true);
    signIn(MAX);
    const [card] = (await viewAs(id)).connect;
    expect(card.account).toBeNull();
    expect(card.candidates.map((c) => [c.owner, c.label, c.chosen]).sort()).toEqual([
      ["person", "max.work@gmail.com", false],
      ["person", "max@gmail.com", false],
    ]);
    const work = card.candidates.find((c) => c.label === "max.work@gmail.com");
    // Someone else's account is none to choose.
    expect(
      (await call(id, "/connections/box/choice", "PUT", { owner: "person", id: "nope" })).status,
    ).toBe(404);
    const res = await call(id, "/connections/box/choice", "PUT", {
      owner: "person",
      id: work?.id,
    });
    expect(res.status).toBe(200);
    expect(await statusIs(id, "done")).toBe(true);
    const choice = await inTenant(() =>
      client.db.query.connectionChoice.findFirst({
        where: and(
          eq(client.schema.connectionChoice.wizardId, wizardId),
          eq(client.schema.connectionChoice.holder, `u:${MAX}`),
        ),
      }),
    );
    expect(choice?.personConnectionId).toBe(work?.id);
  });

  it("under „Was dieser Wizard sich merkt“: changed to another, and disconnected", async () => {
    await ownAccount(`u:${MAX}`, "max@gmail.com");
    await ownAccount(`u:${MAX}`, "max.work@gmail.com");
    const { id } = await startRun([page, end], { userId: MAX });
    signIn(MAX);
    const store = async () =>
      ((await (await call(id, "/store")).json()) as { connections: Card[] }).connections;
    const [listed] = await store();
    expect(listed.candidates).toHaveLength(2);
    const [first, second] = listed.candidates;
    await call(id, "/connections/box/choice", "PUT", { owner: "person", id: first.id });
    expect((await store())[0].account?.label).toBe(first.label);
    await call(id, "/connections/box/choice", "PUT", { owner: "person", id: second.id });
    expect((await store())[0].account?.label).toBe(second.label);
    expect((await call(id, "/connections/box", "DELETE")).status).toBe(200);
    // The account no wizard uses any more goes; the one left is the only one, and in use.
    const [left] = await store();
    expect(left.candidates.map((c) => c.label)).toEqual([first.label]);
    expect(left.account?.label).toBe(first.label);
    await inTenant(() => runner.cancel(id));
  });
});

describe("connecting for the space", () => {
  it("an admin may: a connection of the space, signed in as the space, and the space's choice", async () => {
    const { id, wizardId } = await startRun([read, end], { userId: LENA });
    expect(await statusIs(id, "sleeping")).toBe(true);
    signIn(LENA, "admin");
    // Gmail, kept by the space as its own Gmail connector; a mailbox over IMAP stays the person's.
    expect((await viewAs(id)).connect[0].forSpace).toEqual(["mail-gmail"]);
    const res = await call(id, "/connections/box/oauth/mail-gmail", "POST", { forSpace: true });
    const answer = (await res.json()) as { url: string };
    expect(res.status).toBe(200);
    expect(answer.url).toContain("client_id=client-id");
    const made = await inTenant(() =>
      client.db.query.spaceConnection.findMany({
        where: eq(client.schema.spaceConnection.spaceId, SPACE),
      }),
    );
    expect(made).toMatchObject([{ connectorId: "google-gmail", signIn: "space", name: "Gmail" }]);
    const choices = await inTenant(() =>
      client.db.query.connectionChoice.findMany({
        where: eq(client.schema.connectionChoice.wizardId, wizardId),
      }),
    );
    expect(choices.map((c) => [c.holder, c.spaceConnectionId]).sort()).toEqual(
      [
        [`s:${SPACE}`, made[0].id],
        [`u:${LENA}`, made[0].id],
      ].sort(),
    );
    // A second start of the sign-in takes the same connection again.
    await call(id, "/connections/box/oauth/mail-gmail", "POST", { forSpace: true });
    expect(
      await inTenant(() =>
        client.db.$count(
          client.schema.spaceConnection,
          eq(client.schema.spaceConnection.spaceId, SPACE),
        ),
      ),
    ).toBe(1);
    // Signed in as the space (as the provider's callback keeps it): the run goes on with it.
    await inTenant(() =>
      client.db
        .update(client.schema.spaceConnection)
        .set({ label: "team@firma.at", secret: crypto.seal({ accessToken: "t" }) })
        .where(eq(client.schema.spaceConnection.id, made[0].id)),
    );
    await call(id, "/signed-in", "POST", {});
    expect(await statusIs(id, "done")).toBe(true);
  });

  it("a member may not", async () => {
    const { id } = await startRun([read, end], { userId: MAX });
    expect(await statusIs(id, "sleeping")).toBe(true);
    signIn(MAX);
    expect((await viewAs(id)).connect[0].forSpace).toEqual([]);
    const res = await call(id, "/connections/box/oauth/mail-gmail", "POST", { forSpace: true });
    expect(res.status).toBe(403);
    expect(await inTenant(() => client.db.$count(client.schema.spaceConnection))).toBe(0);
    await inTenant(() => runner.cancel(id));
  });

  it("a guest never gets the option; their account stays the visitor's", async () => {
    const { id } = await startRun([read, end], { visitorId: "v-1" });
    expect(await statusIs(id, "sleeping")).toBe(true);
    const view = await viewAs(id, "v-1");
    expect(view.connect).toMatchObject([{ id: "box", forSpace: [] }]);
    const res = await call(
      id,
      "/connections/box/oauth/mail-gmail",
      "POST",
      { forSpace: true },
      "v-1",
    );
    expect(res.status).toBe(403);
    // Without it the sign-in is the visitor's own.
    const own = await call(id, "/connections/box/oauth/mail-gmail", "POST", {}, "v-1");
    expect(own.status).toBe(200);
    expect(await inTenant(() => client.db.$count(client.schema.spaceConnection))).toBe(0);
    await inTenant(() => runner.cancel(id));
  });
});
