import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "wizards-run-who-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.FEATURES = "durableRuns=on";
process.env.RUNNER_CLOCK_MS = "100";

const T = "tenant-run-who";
const LENA = "lena-admin";
const JONAS = "jonas-named";
const ANNA = "anna-named";
const MAX = "max-member";
const KIM = "kim-client";

const mails = vi.fn(async (_input: Record<string, unknown>) => ({ ok: true, sent: true }));
const pushes = vi.fn(async (_input: Record<string, unknown>) => ({ ok: true }));
const people = vi.hoisted(() => ({ read: true }));
vi.mock("../src/manage.js", async (original) => ({
  ...(await original<typeof import("../src/manage.js")>()),
  managed: true,
  runMail: mails,
  pushToDevice: pushes,
  tenantInfo: async (id: string) => ({ id, status: "active", limits: {} }),
  tenantMembers: async () => {
    if (!people.read) {
      throw new Error("Manage-App away");
    }
    const member = (userId: string, name: string, role: string) => ({
      userId,
      name,
      email: `${userId}@example.com`,
      image: null,
      role,
      joinedAt: "2026-01-01",
    });
    return {
      members: [
        member(LENA, "Lena Berger", "owner"),
        member(JONAS, "Jonas Wieser", "member"),
        member(ANNA, "Anna Maier", "member"),
        member(MAX, "Max Huber", "member"),
        member(KIM, "Kim Roth", "client"),
      ],
      invitations: [],
      seats: { limit: null, taken: 5 },
    };
  },
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
vi.mock("../src/engine/steps.js", async (original) => ({
  ...(await original<typeof import("../src/engine/steps.js")>()),
  runAutomaticStep: async (step: { id: string }) => ({
    text: `made ${step.id}`,
    at: new Date().toISOString(),
  }),
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
const switched = vi.hoisted(() => ({ durable: true }));
vi.mock("../src/features.js", async (original) => {
  const real = await original<typeof import("../src/features.js")>();
  return {
    ...real,
    currentFeatures: async () => ({ ...(await real.currentFeatures()), durableRuns: switched.durable }),
    feature: (name: string, remote: unknown) =>
      name === "durableRuns" ? switched.durable : real.feature(name as never, remote as never),
  };
});

let client: typeof import("../src/db/client");
let runner: typeof import("../src/engine/runner");
let notices: typeof import("../src/engine/notices");
let signing: typeof import("../src/secrets/signing");
let services: typeof import("../src/services/runs");
let work: typeof import("../src/services/work-runs");
let plugins: typeof import("../src/plugins/runs");
let wizards: typeof import("../src/services/wizards");
let app: { fetch: (r: Request) => Promise<Response> };

const inTenant = <R>(fn: () => Promise<R>) => client.withTenant(T, fn);

const made = { id: "made", type: "agent", title: "Machen", instructions: "Do.", tools: [], output: { format: "text" } };
const end = { id: "done", type: "result", title: "Fertig", deliverables: [] };
const form = {
  id: "form",
  type: "page",
  title: "Deine Daten",
  fields: [{ id: "kunde", kind: "text", label: "Kunde" }],
};
const teamPage = {
  id: "team",
  type: "page",
  title: "Rückfrage",
  who: "team",
  fields: [{ id: "intern", kind: "text", label: "Intern" }],
};
const check = {
  id: "check",
  type: "review",
  title: "Prüfen",
  who: "team",
  show: ["made"],
  approve: true,
};
const flowOf = (...steps: unknown[]) => ({
  version: 2,
  title: "Angebot",
  description: "",
  avatar: "round",
  steps,
});

const row = (id: string) =>
  inTenant(() => client.db.query.run.findFirst({ where: eq(client.schema.run.id, id) }));

async function until(ok: () => boolean | Promise<boolean>, ms = 8000) {
  const end2 = Date.now() + ms;
  while (Date.now() < end2) {
    if (await ok()) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

const waitsOn = (id: string, stepId: string) =>
  until(async () => {
    const r = await row(id);
    return r?.status === "waiting_input" && r.cursor === stepId;
  });

async function startRun(
  steps: unknown[],
  options: {
    answerers?: string[] | "admins";
    visitorId?: string;
    userId?: string;
    mode?: "test" | "live";
    runner?: string;
    startedBy?: unknown;
    starts?: unknown[];
  } = {},
) {
  return inTenant(async () => {
    const def = flowOf(...steps);
    const wizardId = nanoid(12);
    await client.db.insert(client.schema.wizard).values({
      id: wizardId,
      shareToken: nanoid(16),
      spaceId: "space-1",
      tenantId: T,
      title: def.title,
      draft: def as never,
      publishedVersion: 1,
      answerers: options.answerers ?? [JONAS, ANNA],
      starts: (options.starts ?? []) as never,
    });
    const runId = await runner.createRun({
      wizardId,
      definition: def as never,
      files: [],
      version: 1,
      mode: options.mode ?? "live",
      userId: options.userId ?? null,
      visitorId: options.userId ? null : (options.visitorId ?? "v-1"),
      runner: options.runner ?? null,
      startedBy: options.startedBy as never,
    });
    return { runId, wizardId };
  });
}

/** A visitor's run, past their page and on the team's step. */
async function onTeamStep(steps: unknown[] = [form, made, check, end], visitorId = "v-1") {
  const { runId, wizardId } = await startRun(steps, { visitorId });
  await inTenant(() => runner.submitPage(runId, "form", { kunde: "Hofer" }, { visitorId }));
  const stepId = (steps.find((s) => (s as { who?: string }).who === "team") as { id: string }).id;
  expect(await waitsOn(runId, stepId)).toBe(true);
  return { runId, wizardId, stepId };
}

const signIn = (id: string | null, role = "member") => {
  who.user = id
    ? { id, tenantId: T, role, name: id, email: `${id}@example.com`, impersonatedBy: null }
    : null;
};

const call = (
  runId: string,
  path: string,
  method = "POST",
  body: unknown = {},
  options: { visitor?: string; ticket?: string } = {},
) =>
  app.fetch(
    new Request(
      `http://localhost:5181/api/runs/${runId}${path}${
        options.ticket ? `?rt=${encodeURIComponent(options.ticket)}` : ""
      }`,
      {
        method,
        headers: {
          "content-type": "application/json",
          ...(options.visitor ? { "x-wizards-visitor": options.visitor } : {}),
        },
        ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
      },
    ),
  );

/** Every door of a run that does something, with a body that would pass its own parsing. */
const DOORS: [string, string, string, unknown][] = [
  ["a page", "POST", "/pages/form", { values: {} }],
  ["a page of the team", "POST", "/pages/team", { values: { intern: "x" } }],
  ["a review", "POST", "/reviews/check", { type: "accept" }],
  ["back", "POST", "/back", {}],
  ["retry", "POST", "/retry", {}],
  ["cancel", "POST", "/cancel", {}],
  ["an ask", "POST", "/ask/ask1", { type: "skip" }],
  ["a question", "POST", "/question", { answer: "ja" }],
  ["talk", "POST", "/talk", {}],
  ["transcribe", "POST", "/transcribe", {}],
  ["uploads", "POST", "/uploads", {}],
  ["geocode", "POST", "/geocode", { lat: 1, lng: 1 }],
  ["a view's state", "PUT", "/views/made", { state: {} }],
  ["a step's data", "PUT", "/outputs/made", { json: {} }],
  ["the device's offer", "POST", "/device", {}],
  ["the device's answer", "POST", "/device/r1", {}],
  ["the browser's seat", "POST", "/browser/seat", { to: "person" }],
  ["the browser", "POST", "/browser/act", {}],
  ["a connection's sign-in", "POST", "/connections/c/oauth/k", {}],
  ["a connection's key", "POST", "/connections/c/credentials/k", {}],
  ["a connection's removal", "DELETE", "/connections/c", {}],
  ["a list's new row", "POST", "/lists/l/rows", { rows: [] }],
  ["a list's row", "PATCH", "/lists/l/rows/r", {}],
  ["a list's row gone", "DELETE", "/lists/l/rows/r", {}],
  ["the wizard's memory gone", "DELETE", "/store", {}],
  ["the phone's push", "POST", "/notify", { token: "12345678", platform: "ios" }],
  ["the phone's push gone", "DELETE", "/notify", {}],
  ["publishing the result", "POST", "/share", {}],
  ["taking it back", "DELETE", "/share", {}],
  ["sending it on", "POST", "/share/jobs", { target: "email" }],
  ["a job's cancel", "POST", "/share/jobs/j1/cancel", {}],
  ["a result's translation", "POST", "/translate-result", {}],
  ["what someone thought of it", "POST", "/feedback", { good: true }],
];

/** Doors that take no right to answer: saying one looks and reads in a language, and the two with a rule of their own. */
const OTHER_RULES = ["/:id/seen", "/:id/lang", "/:id/wake-now", "/:id/stop"];

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb(T);
  await client.controlDb
    .insert(client.control.tenant)
    .values({ id: T, status: "active" } as never)
    .onConflictDoNothing()
    .catch(() => undefined);
  const { env } = await import("../src/env");
  env.limits.concurrentRuns = 1000;
  env.runner.maxRuns = 1000;
  runner = await import("../src/engine/runner");
  await inTenant(() =>
    client.db
      .insert(client.schema.space)
      .values({ id: "space-1", tenantId: T, name: "Space" } as never),
  );
  notices = await import("../src/engine/notices");
  signing = await import("../src/secrets/signing");
  services = await import("../src/services/runs");
  work = await import("../src/services/work-runs");
  plugins = await import("../src/plugins/runs");
  wizards = await import("../src/services/wizards");
  app = (await import("../src/app")).default as never;
  runner.startRunner();
});

afterAll(async () => {
  await runner.stopRunner();
});

beforeEach(() => {
  switched.durable = true;
  people.read = true;
  signIn(null);
  mails.mockClear();
  pushes.mockClear();
});

describe("the list of doors", () => {
  it("holds every door of a run that writes: a new one has to say what it takes", async () => {
    const { runRoutes } = await import("../src/routes/runs");
    const writes = runRoutes.routes.filter(
      (r) => ["POST", "PUT", "PATCH", "DELETE"].includes(r.method) && r.path.startsWith("/:id"),
    );
    expect(writes.length).toBeGreaterThan(30);
    const missing = writes.filter((route) => {
      const pattern = new RegExp(
        `^${route.path.replace("/:id", "").replace(/:[a-zA-Z]+/g, "[^/]+")}$`,
      );
      return !(
        OTHER_RULES.includes(route.path) ||
        DOORS.some(([, method, path]) => method === route.method && pattern.test(path))
      );
    });
    expect(missing.map((r) => `${r.method} ${r.path}`)).toEqual([]);
  });
});

describe("on a step for the team", () => {
  it("a member nobody named is refused on every door", async () => {
    const { runId } = await onTeamStep();
    signIn(MAX);
    const before = await row(runId);
    for (const [name, method, path, body] of DOORS) {
      const res = await call(runId, path, method, body);
      expect([name, res.status]).toEqual([name, 403]);
    }
    const after = await row(runId);
    expect(after?.status).toBe("waiting_input");
    expect(after?.rev).toBe(before?.rev);
  });

  it("the run's own visitor is refused on every door", async () => {
    const { runId } = await onTeamStep();
    for (const [name, method, path, body] of DOORS) {
      const res = await call(runId, path, method, body, { visitor: "v-1" });
      expect([name, res.status]).toEqual([name, 403]);
    }
    expect((await row(runId))?.status).toBe("waiting_input");
  });

  it("the run's link is refused, the ticket in a mail too", async () => {
    const { runId } = await onTeamStep();
    const tickets = [
      signing.runTicket(runId),
      signing.runWaitTicket(runId, new Date(Date.now() + 60_000)),
    ];
    for (const ticket of tickets) {
      for (const [path, body] of [
        ["/reviews/check", { type: "accept" }],
        ["/back", {}],
      ] as const) {
        expect((await call(runId, path, "POST", body, { ticket })).status).toBe(403);
      }
    }
    expect((await row(runId))?.status).toBe("waiting_input");
  });

  it("a client of the organization is refused, even when named", async () => {
    const { runId, wizardId } = await onTeamStep();
    await inTenant(() =>
      client.db
        .update(client.schema.wizard)
        .set({ answerers: [KIM] })
        .where(eq(client.schema.wizard.id, wizardId)),
    );
    signIn(KIM, "client");
    expect((await call(runId, "/reviews/check", "POST", { type: "accept" })).status).toBe(404);
  });

  it("someone from another organization doesn't find the run", async () => {
    const { runId } = await onTeamStep();
    who.user = { ...(who.user ?? {}), id: JONAS, tenantId: "other", role: "owner", name: "x", email: "x", impersonatedBy: null };
    expect((await call(runId, "/reviews/check", "POST", { type: "accept" })).status).toBe(404);
  });

  it("an MCP client's person who isn't named is refused on each tool", async () => {
    const { runId } = await onTeamStep(undefined, "v-mcp");
    // MCP reaches a run by being its own, or a test run: this one is made reachable as a test run.
    await inTenant(() =>
      client.db
        .update(client.schema.run)
        .set({ mode: "test", userId: "someone" })
        .where(eq(client.schema.run.id, runId)),
    );
    const refused = { code: "forbidden" };
    await inTenant(async () => {
      await expect(services.answerRunPage(MAX, runId, "check", {})).rejects.toMatchObject(refused);
      await expect(
        services.reviewRun(MAX, runId, "check", { type: "accept" }),
      ).rejects.toMatchObject(refused);
      for (const action of ["back", "retry", "cancel"] as const) {
        await expect(services.controlRun(MAX, runId, action)).rejects.toMatchObject(refused);
      }
      await expect(services.answerRunAsk(MAX, runId, "a", "allow")).rejects.toMatchObject(refused);
      await expect(services.answerRunQuestion(MAX, runId, "ja")).rejects.toMatchObject(refused);
    });
    expect((await row(runId))?.status).toBe("waiting_input");
  });

  it("a plugin's door speaks for the visitor, so it is refused on each door", async () => {
    const { runId } = await onTeamStep(undefined, "v-door");
    const api = plugins.runsApiFor("door");
    const refused = { code: "forbidden" };
    const file = { name: "a.txt", mime: "text/plain", data: new Uint8Array([1]) };
    await inTenant(async () => {
      await expect(api.answerPage(runId, "check", {})).rejects.toMatchObject(refused);
      await expect(api.review(runId, "check", { type: "accept" })).rejects.toMatchObject(refused);
      await expect(api.answerAsk(runId, "a", "allow")).rejects.toMatchObject(refused);
      await expect(api.answerQuestion(runId, "ja")).rejects.toMatchObject(refused);
      for (const action of ["back", "retry", "cancel"] as const) {
        await expect(api.control(runId, action)).rejects.toMatchObject(refused);
      }
      await expect(api.upload(runId, file as never)).rejects.toMatchObject(refused);
      await expect(api.transcribe(runId, file as never)).rejects.toMatchObject(refused);
      const report = await api.report(runId);
      expect(report.waitingFor).toMatchObject({ answeredBy: "team" });
      expect(report.outputs.map((o) => o.stepId)).not.toContain("made");
    });
    expect((await row(runId))?.status).toBe("waiting_input");
  });

  it("a plugin's door doesn't reach a member's run, nor hand on its link", async () => {
    const { runId } = await startRun([form, end], { userId: MAX });
    const api = plugins.runsApiFor("door");
    await inTenant(async () => {
      await expect(api.answerPage(runId, "form", {})).rejects.toMatchObject({ code: "forbidden" });
      await expect(api.handoffUrl(runId)).rejects.toMatchObject({ code: "forbidden" });
    });
  });

  it("nobody fills it from a start's answers", async () => {
    const { runId: viaPlugin } = await inTenant(async () => {
      const def = flowOf(teamPage, end);
      const wizardId = nanoid(12);
      await client.db.insert(client.schema.wizard).values({
        id: wizardId,
        shareToken: nanoid(16),
        spaceId: "space-1",
        tenantId: T,
        title: def.title,
        draft: def as never,
        publishedVersion: 1,
      });
      await client.db.insert(client.schema.wizardVersion).values({
        id: nanoid(12),
        wizardId,
        version: 1,
        definition: def as never,
        files: [],
      } as never);
      return plugins
        .runsApiFor("door")
        .start({ wizardId, person: { channel: "c", id: "1" }, answers: { intern: "x" } });
    });
    const run = await row(viaPlugin);
    expect(run?.status).toBe("waiting_input");
    expect(run?.state.values.intern).toBeUndefined();
  });

  it("a started run's review waits for the team; other reviews pass as before", async () => {
    const { runId } = await startRun([made, check, end], {
      userId: LENA,
      startedBy: { kind: "schedule", startId: "s1" },
      starts: [{ id: "s1", kind: "schedule", passReviews: true }],
    });
    expect(await waitsOn(runId, "check")).toBe(true);
  });

  it("a named person answers, and the first answer counts", async () => {
    const { runId } = await onTeamStep([form, teamPage, end]);
    signIn(JONAS);
    expect((await call(runId, "/pages/team", "POST", { values: { intern: "ok" } })).status).toBe(
      200,
    );
    const run = await row(runId);
    expect(run?.state.answeredBy?.team).toEqual({ userId: JONAS, name: "Jonas Wieser" });
    signIn(ANNA);
    const second = await call(runId, "/pages/team", "POST", { values: { intern: "no" } });
    expect(second.status).toBe(409);
    expect((await second.json()).error).toContain("Jonas Wieser");
    expect((await row(runId))?.state.values.intern).toBe("ok");
  });

  it("an admin answers though not named; a test run's starter answers alone", async () => {
    const { runId } = await onTeamStep([form, teamPage, end]);
    signIn(LENA, "owner");
    expect((await call(runId, "/pages/team", "POST", { values: { intern: "ok" } })).status).toBe(
      200,
    );
    const test = await startRun([teamPage, end], { userId: MAX, mode: "test" });
    signIn(MAX);
    expect(
      (await call(test.runId, "/pages/team", "POST", { values: { intern: "ok" } })).status,
    ).toBe(200);
  });

  it("with nobody named or \"admins\", only the admins answer", async () => {
    for (const answerers of [[], "admins"] as const) {
      const { runId } = await startRun([teamPage, end], { answerers: answerers as never });
      signIn(JONAS);
      expect((await call(runId, "/pages/team", "POST", { values: {} })).status).toBe(403);
      signIn(LENA, "admin");
      expect((await call(runId, "/pages/team", "POST", { values: {} })).status).toBe(200);
    }
  });
});

describe("a person's own step", () => {
  it("a visitor's run asks its own visitor: a member and an owner step alike", async () => {
    for (const ownerStep of [form, { ...form, who: "owner" }]) {
      const { runId } = await startRun([ownerStep, end], { visitorId: "v-own" });
      signIn(MAX);
      expect((await call(runId, "/pages/form", "POST", { values: {} })).status).toBe(403);
      signIn(null);
      expect(
        (await call(runId, "/pages/form", "POST", { values: {} }, { visitor: "someone-else" }))
          .status,
      ).toBe(404);
      expect(
        (await call(runId, "/pages/form", "POST", { values: {} }, { visitor: "v-own" })).status,
      ).toBe(200);
    }
  });

  it("a member's run asks that member; a colleague is refused, an admin not", async () => {
    const { runId } = await startRun([{ ...form, who: "owner" }, end], { userId: ANNA });
    signIn(MAX);
    expect((await call(runId, "/pages/form", "POST", { values: {} })).status).toBe(403);
    signIn(ANNA);
    expect((await call(runId, "/pages/form", "POST", { values: {} })).status).toBe(200);
    const other = await startRun([form, end], { userId: ANNA });
    signIn(LENA, "admin");
    expect((await call(other.runId, "/pages/form", "POST", { values: {} })).status).toBe(200);
  });

  it("a member may not stop or try again what is someone else's", async () => {
    const { runId } = await startRun([form, end], { visitorId: "v-2" });
    signIn(MAX);
    expect((await call(runId, "/cancel")).status).toBe(403);
    expect((await call(runId, "/stop")).status).toBe(403);
    await inTenant(() =>
      client.db
        .update(client.schema.run)
        .set({ status: "failed" })
        .where(eq(client.schema.run.id, runId)),
    );
    expect((await call(runId, "/retry")).status).toBe(403);
    expect((await row(runId))?.status).toBe("failed");
  });

  it("what is over stays open to share for those who open the run", async () => {
    const { runId } = await startRun([form, end], { visitorId: "v-3" });
    await inTenant(() =>
      client.db
        .update(client.schema.run)
        .set({ status: "done", cursor: "done" })
        .where(eq(client.schema.run.id, runId)),
    );
    signIn(MAX);
    expect((await call(runId, "/share")).status).toBe(200);
    expect((await call(runId, "/back")).status).toBe(403);
  });

  it("nobody reopens what the team answered", async () => {
    const { runId } = await onTeamStep([form, teamPage, { ...form, id: "after", fields: [{ id: "x", kind: "text", label: "X" }] }, end]);
    signIn(JONAS);
    expect((await call(runId, "/pages/team", "POST", { values: {} })).status).toBe(200);
    expect(await waitsOn(runId, "after")).toBe(true);
    signIn(null);
    expect((await call(runId, "/back", "POST", {}, { visitor: "v-1" })).status).toBe(403);
    const view = await (await call(runId, "", "GET", undefined, { visitor: "v-1" })).json();
    expect(view.canBack).toBe(false);
    // The team's person isn't the visitor: they don't go on the visitor's page either.
    signIn(JONAS);
    expect((await call(runId, "/pages/after", "POST", { values: {} })).status).toBe(403);
  });

  it("someone who may answer goes back; the step they leave is asked again", async () => {
    const { runId } = await startRun(
      [form, { ...form, id: "second", fields: [{ id: "y", kind: "text", label: "Y" }] }, end],
      { visitorId: "v-4" },
    );
    expect(
      (await call(runId, "/pages/form", "POST", { values: {} }, { visitor: "v-4" })).status,
    ).toBe(200);
    expect(await waitsOn(runId, "second")).toBe(true);
    expect((await call(runId, "/back", "POST", {}, { visitor: "v-4" })).status).toBe(200);
    expect((await row(runId))?.cursor).toBe("form");
  });
});

describe("what a viewer sees", () => {
  it("a visitor doesn't see the team's step or what it shows", async () => {
    const { runId } = await onTeamStep();
    const view = await (await call(runId, "", "GET", undefined, { visitor: "v-1" })).json();
    expect(view.answeredBy).toBe("team");
    expect(view.step).toBeNull();
    expect(view.shown).toEqual([]);
    expect(view.outputs).toEqual({});
    const file = await call(runId, "/steps/made/download", "GET", undefined, { visitor: "v-1" });
    expect(file.status).toBe(404);
  });

  it("a visitor doesn't see what the team answered, later either", async () => {
    const after = { ...form, id: "after", fields: [{ id: "x", kind: "text", label: "X" }] };
    const { runId } = await onTeamStep([form, teamPage, after, end]);
    signIn(JONAS);
    await call(runId, "/pages/team", "POST", { values: { intern: "geheim" } });
    expect(await waitsOn(runId, "after")).toBe(true);
    signIn(null);
    const view = await (await call(runId, "", "GET", undefined, { visitor: "v-1" })).json();
    expect(view.answeredBy).toBeNull();
    expect(view.values.intern).toBeUndefined();
    expect(view.values.kunde).toBe("Hofer");
    expect(view.answered.map((s: { id: string }) => s.id)).toEqual(["form"]);
  });

  it("someone in the organization reads along, the named person sees it as theirs", async () => {
    const { runId } = await onTeamStep();
    signIn(MAX);
    const reading = await (await call(runId, "", "GET")).json();
    expect(reading.answeredBy).toBe("team");
    expect(reading.step.id).toBe("check");
    signIn(JONAS);
    const answering = await (await call(runId, "", "GET")).json();
    expect(answering.answeredBy).toBeNull();
    expect(answering.step.id).toBe("check");
  });

  it("an MCP report says someone else answers and asks nothing", async () => {
    const { runId } = await onTeamStep();
    await inTenant(() =>
      client.db
        .update(client.schema.run)
        .set({ mode: "test", userId: "someone" })
        .where(eq(client.schema.run.id, runId)),
    );
    const report = await inTenant(() => services.runReport(MAX, runId));
    expect(report.waitingFor).toMatchObject({ answeredBy: "team" });
  });
});

describe("an approval", () => {
  it("goes through the review, keeps who decided, and a rule reads it", async () => {
    const yes = { ...end, id: "yes", title: "Ja" };
    const no = { ...end, id: "no", title: "Nein" };
    const decides = {
      ...check,
      next: [{ when: { field: "steps.check.approved", op: "equals", value: true }, goto: "yes" }, { goto: "no" }],
    };
    const { runId } = await onTeamStep([form, made, decides, yes, no]);
    const held = () =>
      inTenant(() =>
        client.db.query.approval.findMany({ where: eq(client.schema.approval.runId, runId) }),
      );
    expect((await held()).map((a) => [a.state, a.heldFor, a.stepId])).toEqual([
      ["pending", "team", "check"],
    ]);
    signIn(JONAS);
    const res = await call(runId, "/reviews/check", "POST", { type: "decline", note: "Zu teuer" });
    expect(res.status).toBe(200);
    expect(await until(async () => (await row(runId))?.status === "done")).toBe(true);
    const run = await row(runId);
    expect(run?.cursor).toBe("no");
    expect(run?.state.outputs.check?.json).toEqual({ approved: false, note: "Zu teuer" });
    expect((await held()).map((a) => [a.state, a.decidedBy])).toEqual([["denied", JONAS]]);
  });

  it("a yes takes the rule's way", async () => {
    const yes = { ...end, id: "yes", title: "Ja" };
    const no = { ...end, id: "no", title: "Nein" };
    const decides = {
      ...check,
      next: [
        { when: { field: "steps.check.approved", op: "equals", value: true }, goto: "yes" },
        { goto: "no" },
      ],
    };
    const { runId } = await onTeamStep([form, made, decides, yes, no]);
    signIn(ANNA);
    expect((await call(runId, "/reviews/check", "POST", { type: "accept" })).status).toBe(200);
    expect(await until(async () => (await row(runId))?.status === "done")).toBe(true);
    expect((await row(runId))?.cursor).toBe("yes");
    const log = await inTenant(() =>
      client.db.query.runEvent.findMany({ where: eq(client.schema.runEvent.runId, runId) }),
    );
    expect(log.some((e) => e.note?.code === "stepApprovedBy")).toBe(true);
  });

  it("accepting approves, and a review that doesn't decide can't be declined", async () => {
    const { runId } = await onTeamStep();
    signIn(JONAS);
    expect((await call(runId, "/reviews/check", "POST", { type: "accept" })).status).toBe(200);
    expect((await row(runId))?.state.outputs.check?.json).toEqual({ approved: true });
    const plain = await onTeamStep([form, made, { ...check, approve: undefined }, end]);
    const res = await call(plain.runId, "/reviews/check", "POST", { type: "decline" });
    expect(res.status).toBe(409);
    expect((await row(plain.runId))?.status).toBe("waiting_input");
  });

  it("the row goes when the run moves on without a decision", async () => {
    const { runId } = await onTeamStep();
    signIn(LENA, "owner");
    expect((await call(runId, "/back")).status).toBe(200);
    const rows = await inTenant(() =>
      client.db.query.approval.findMany({ where: eq(client.schema.approval.runId, runId) }),
    );
    expect(rows).toEqual([]);
  });
});

describe("telling people", () => {
  const rows = (runId: string) =>
    inTenant(() =>
      client.db.query.notice.findMany({ where: eq(client.schema.notice.runId, runId) }),
    );
  /** Sends what is due for this run: the sender takes a batch, and other tests leave rows. */
  const deliver = async (runId: string, at = new Date(Date.now() + 60 * 60_000)) => {
    await inTenant(async () => {
      const others = (await client.db.query.notice.findMany()).filter((n) => n.runId !== runId);
      for (const n of others) {
        await client.db.delete(client.schema.notice).where(eq(client.schema.notice.id, n.id));
      }
      await notices.deliverNotices(at);
    });
  };

  it("a step for the team tells each person named, nobody else", async () => {
    const { runId } = await onTeamStep();
    const told = (await rows(runId)).filter((n) => n.kind === "needs_you");
    expect(told.map((n) => n.userId).sort()).toEqual([ANNA, JONAS].sort());
    expect(told.every((n) => !n.visitor)).toBe(true);
  });

  it("the mail goes to them with the link into Work, and no device hears of it", async () => {
    const { runId } = await onTeamStep();
    await deliver(runId);
    const sent = mails.mock.calls.map((c) => c[0] as { to: { userId?: string }; url: string });
    const toTeam = sent.filter((m) => m.url.endsWith(`/work/r/${runId}`));
    expect(toTeam.map((m) => m.to.userId).sort()).toEqual([ANNA, JONAS].sort());
    expect(sent.filter((m) => m.url.includes(runId)).length).toBe(2);
    expect(pushes).not.toHaveBeenCalled();
  });

  it("the visitor's looking at the page keeps nobody from telling the team", async () => {
    const { runId } = await onTeamStep();
    const { setRunViewed } = await import("../src/engine/push");
    await inTenant(() => setRunViewed(runId));
    await deliver(runId, new Date());
    const told = (await rows(runId)).filter((n) => n.kind === "needs_you");
    expect(told.map((n) => n.shown)).toEqual([true, true]);
    expect(mails.mock.calls.filter((c) => String(c[0].url).includes(runId)).length).toBe(2);
  });

  it("nobody is told what they did themselves", async () => {
    const second = { ...teamPage, id: "team2", fields: [{ id: "z", kind: "text", label: "Z" }] };
    const { runId } = await onTeamStep([form, teamPage, second, end]);
    await inTenant(() => client.db.delete(client.schema.notice).where(eq(client.schema.notice.runId, runId)));
    signIn(JONAS);
    expect((await call(runId, "/pages/team", "POST", { values: {} })).status).toBe(200);
    expect(await waitsOn(runId, "team2")).toBe(true);
    const told = (await rows(runId)).filter((n) => n.kind === "needs_you");
    expect(told.map((n) => n.userId)).toEqual([ANNA]);
  });

  it("after a step that worked, it is news again", async () => {
    const second = { ...teamPage, id: "team2", fields: [{ id: "z", kind: "text", label: "Z" }] };
    const { runId } = await onTeamStep([form, teamPage, made, second, end]);
    signIn(JONAS);
    expect((await call(runId, "/pages/team", "POST", { values: {} })).status).toBe(200);
    expect(await waitsOn(runId, "team2")).toBe(true);
    const told = (await rows(runId)).filter((n) => n.kind === "needs_you" && n.waitKey === "step:team2");
    expect(told.map((n) => n.userId).sort()).toEqual([ANNA, JONAS].sort());
  });

  it("what the team answered reaches the visitor on the next page", async () => {
    const after = { ...form, id: "after", fields: [{ id: "x", kind: "text", label: "X" }] };
    const { runId } = await onTeamStep([form, teamPage, after, end]);
    signIn(JONAS);
    await call(runId, "/pages/team", "POST", { values: {} });
    expect(await waitsOn(runId, "after")).toBe(true);
    const told = (await rows(runId)).filter((n) => n.waitKey === "step:after");
    expect(told.map((n) => n.visitor)).toEqual([true]);
  });

  it("a channel's run tells the team too; its visitor hears in the channel", async () => {
    const { runId } = await startRun([teamPage, end], { visitorId: "p:1", runner: "whatsapp" });
    const told = await rows(runId);
    expect(told.map((n) => n.userId).sort()).toEqual([ANNA, JONAS].sort());
  });

  it("with nobody named the admins are told; someone who left no longer is", async () => {
    const a = await startRun([teamPage, end], { answerers: [] });
    expect((await rows(a.runId)).map((n) => n.userId)).toEqual([LENA]);
    const b = await startRun([teamPage, end], { answerers: [JONAS, "left-the-firm"] });
    expect((await rows(b.runId)).map((n) => n.userId)).toEqual([JONAS]);
  });

  it("a test run stays with who tries it; the Manage-App away breaks nothing", async () => {
    const test = await startRun([made, teamPage, end], { userId: MAX, mode: "test" });
    expect(await waitsOn(test.runId, "team")).toBe(true);
    expect((await rows(test.runId)).map((n) => n.userId)).toEqual([MAX]);
    people.read = false;
    const away = await startRun([made, teamPage, end], { answerers: [JONAS] });
    expect(await waitsOn(away.runId, "team")).toBe(true);
    expect((await rows(away.runId)).map((n) => n.userId)).toEqual([JONAS]);
  });
});

describe("Work's lists", () => {
  const needs = (id: string, role = "member") =>
    inTenant(() => work.runsFor({ id, role: role as never })).then((r) => r.needs.map((n) => n.runId));

  it("a run on the team's step needs those named, not a colleague nor an admin", async () => {
    const { runId } = await onTeamStep();
    expect(await needs(JONAS)).toContain(runId);
    expect(await needs(MAX)).not.toContain(runId);
    expect(await needs(LENA, "owner")).not.toContain(runId);
    const line = (await inTenant(() => work.runsFor({ id: JONAS, role: "member" }))).needs.find(
      (r) => r.runId === runId,
    );
    expect(line).toMatchObject({ kind: "approve", step: "Prüfen", wizard: "Angebot" });
  });

  it("with nobody named it needs the admins", async () => {
    const { runId } = await startRun([teamPage, end], { answerers: [] });
    expect(await needs(LENA, "owner")).toContain(runId);
    expect(await needs(JONAS)).not.toContain(runId);
  });

  it("a member's own run needs them; once it waits for the team it no longer does", async () => {
    const { runId } = await startRun([form, teamPage, end], { userId: MAX });
    expect(await needs(MAX)).toContain(runId);
    await inTenant(() => runner.submitPage(runId, "form", {}, { userId: MAX }));
    expect(await waitsOn(runId, "team")).toBe(true);
    expect(await needs(MAX)).not.toContain(runId);
    expect(await needs(JONAS)).toContain(runId);
  });

  it("a run that waits for a time is under Waits; a visitor's page is nobody's", async () => {
    const pause = { id: "pause", type: "wait", title: "Warten", for: "2d" };
    const { runId } = await startRun([pause, end], { userId: MAX });
    expect(await until(async () => (await row(runId))?.status === "sleeping")).toBe(true);
    const lists = await inTenant(() => work.runsFor({ id: MAX, role: "member" }));
    expect(lists.waits.map((r) => r.runId)).toContain(runId);
    expect(lists.needs.map((r) => r.runId)).not.toContain(runId);
    const { runId: visitors } = await startRun([form, end], { visitorId: "v-9" });
    expect(await needs(LENA, "owner")).not.toContain(visitors);
  });

  it("a test run stays out, and a client has no list", async () => {
    const { runId } = await startRun([form, end], { userId: MAX, mode: "test" });
    expect(await needs(MAX)).not.toContain(runId);
    expect(await inTenant(() => work.runsFor({ id: KIM, role: "client" }))).toEqual({ needs: [], waits: [] });
  });
});

describe("naming who answers", () => {
  const set = (wizardId: string, answerers: unknown) =>
    app.fetch(
      new Request(`http://localhost:5181/api/studio/wizards/${wizardId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answerers }),
      }),
    );
  const named = async (wizardId: string) =>
    (
      await inTenant(() =>
        client.db.query.wizard.findFirst({ where: eq(client.schema.wizard.id, wizardId) }),
      )
    )?.answerers;

  it("is for admins, and takes people of the organization only", async () => {
    const { wizardId } = await startRun([teamPage, end], { answerers: [] });
    signIn(JONAS);
    expect((await set(wizardId, [JONAS])).status).toBe(403);
    expect(await named(wizardId)).toEqual([]);
    signIn(LENA, "owner");
    expect((await set(wizardId, [JONAS, ANNA])).status).toBe(200);
    expect(await named(wizardId)).toEqual([JONAS, ANNA]);
    expect((await set(wizardId, "admins")).status).toBe(200);
    expect(await named(wizardId)).toBe("admins");
    expect((await set(wizardId, ["left-the-firm"])).status).toBe(400);
    expect((await set(wizardId, [KIM])).status).toBe(400);
  });

  it("stays out of a wizard's file", async () => {
    const { wizardId } = await startRun([teamPage, end]);
    const file = await inTenant(async () =>
      JSON.stringify(
        (await client.db.query.wizard.findFirst({ where: eq(client.schema.wizard.id, wizardId) }))
          ?.draft,
      ),
    );
    expect(file).not.toContain(JONAS);
  });
});

describe("with the switch off", () => {
  beforeEach(() => {
    switched.durable = false;
  });

  it("every door stands as it does today, whatever the step says", async () => {
    const { runId } = await startRun([teamPage, form, end], { visitorId: "v-off" });
    signIn(MAX);
    expect((await call(runId, "/pages/team", "POST", { values: {} })).status).toBe(200);
    expect(await waitsOn(runId, "form")).toBe(true);
    const view = await (await call(runId, "", "GET")).json();
    expect(view.answeredBy).toBeNull();
    expect((await call(runId, "/back")).status).toBe(200);
    expect((await call(runId, "/cancel")).status).toBe(200);
    expect((await row(runId))?.status).toBe("cancelled");
  });

  it("the visitor answers a team's step, MCP and a plugin's door drive as before", async () => {
    const a = await startRun([teamPage, end], { visitorId: "v-off2" });
    expect(
      (await call(a.runId, "/pages/team", "POST", { values: {} }, { visitor: "v-off2" })).status,
    ).toBe(200);
    const b = await startRun([teamPage, end], { visitorId: "v-off3" });
    await inTenant(() => plugins.runsApiFor("door").answerPage(b.runId, "team", {}));
    const c = await startRun([teamPage, end], { userId: "someone", mode: "test" });
    await inTenant(() => services.answerRunPage(MAX, c.runId, "team", {}));
    expect((await row(c.runId))?.state.history).toContain("team");
  });

  it("nothing about who answered is kept, nobody on the team is told, no row is held", async () => {
    const { runId } = await startRun([teamPage, { ...check, show: ["team"] }, end], { visitorId: "v-off4" });
    signIn(JONAS);
    await call(runId, "/pages/team", "POST", { values: {} });
    const run = await row(runId);
    expect(run?.state.answeredBy).toBeUndefined();
    expect(run?.state.lastBy).toBeUndefined();
    const told = await inTenant(() =>
      client.db.query.notice.findMany({ where: eq(client.schema.notice.runId, runId) }),
    );
    expect(told).toEqual([]);
    const held = await inTenant(() =>
      client.db.query.approval.findMany({ where: eq(client.schema.approval.runId, runId) }),
    );
    expect(held).toEqual([]);
    expect(await inTenant(() => work.runsFor({ id: JONAS, role: "member" }))).toEqual({ needs: [], waits: [] });
  });

  it("a started run's review passes by its start, as today", async () => {
    const { runId } = await startRun([made, { ...check, approve: undefined }, end], {
      userId: LENA,
      startedBy: { kind: "schedule", startId: "s1" },
      starts: [{ id: "s1", kind: "schedule", passReviews: true }],
    });
    expect(await until(async () => (await row(runId))?.status === "done")).toBe(true);
  });
});
