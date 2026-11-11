import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { httpServices } from "@engenty/wizards-engine/http-services";
import type { RunReport } from "@engenty/wizards-shared/run-services";
import { nanoid } from "nanoid";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// A run ends at its tenant (docs/plans/runs-on-their-own.md, 4.4): a host that works on a run
// elsewhere posts a copy of its state at each person's step and at the end, and the tenant writes
// the record from it and sets off what the status change sets off, once.
const dir = mkdtempSync(join(tmpdir(), "wizards-run-report-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
// Serves the run's services and drives no run: the run works elsewhere.
process.env.RUNTIME_ROLE = "broker";
const BASE = "durableRuns=on,runServices=on";
process.env.FEATURES = BASE;

/** What the status changes set off, by run. */
const heard = vi.hoisted(() => ({
  notices: [] as { runId: string; kind: string }[],
  released: [] as string[],
  ended: [] as { runId: string; status: string }[],
  reported: [] as { runId: string; status: string }[],
}));

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
  releaseRun: async (runId: string) => {
    heard.released.push(runId);
  },
  canSpend: async () => true,
}));
vi.mock("../src/engine/notices.js", async (original) => {
  const actual = await original<typeof import("../src/engine/notices.js")>();
  return {
    ...actual,
    noticesFor: (async (run, kind, options) => {
      heard.notices.push({ runId: run.id, kind });
      return actual.noticesFor(run, kind, options);
    }) satisfies typeof actual.noticesFor,
  };
});
vi.mock("../src/plugins/events.js", async (original) => ({
  ...(await original<typeof import("../src/plugins/events.js")>()),
  runEnded: async (runId: string, status: string) => {
    heard.ended.push({ runId, status });
  },
}));
vi.mock("../src/services/manage-reports.js", async (original) => ({
  ...(await original<typeof import("../src/services/manage-reports.js")>()),
  reportRun: (runId: string, status: string) => {
    heard.reported.push({ runId, status });
  },
}));

let client: typeof import("../src/db/client");
let runner: typeof import("../src/engine/runner");
let store: typeof import("../src/engine/run-store");
let tokens: typeof import("../src/broker/token");
let signing: typeof import("../src/secrets/signing");
let app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> };

const TENANT = "tenant-run-report";
const OTHER = "tenant-run-report-other";
const SPACE = "space-1";
const ELSEWHERE = { kind: "node" as const, url: "http://127.0.0.1:9" };

/** Two pages, then the result. */
const def = {
  version: 1,
  title: "Report",
  description: "",
  avatar: "round",
  steps: [
    { id: "a", type: "form", title: "Seite", fields: [{ id: "a_f", kind: "text", label: "Text" }] },
    {
      id: "b",
      type: "form",
      title: "Noch eine",
      fields: [{ id: "b_f", kind: "text", label: "Mehr" }],
    },
    {
      id: "c",
      type: "agent",
      title: "Schreibt",
      instructions: "Write about otters.",
      output: { format: "text" },
      tools: [],
    },
    { id: "done", type: "result", title: "Fertig", deliverables: [] },
  ],
};

const inTenant = <T>(tenant: string, work: () => Promise<T>) => client.withTenant(tenant, work);

/** A run of `def` in `tenant`, placed elsewhere unless `here`, and its token. */
async function startRun(tenant = TENANT, here = false) {
  return inTenant(tenant, async () => {
    const wizardId = nanoid(12);
    await client.db.insert(client.schema.wizard).values({
      id: wizardId,
      shareToken: nanoid(16),
      spaceId: SPACE,
      tenantId: tenant,
      title: "Report",
      draft: def as never,
      publishedVersion: 1,
    });
    const runId = await runner.createRun({
      wizardId,
      definition: def as never,
      files: [],
      version: 1,
      mode: "live",
      userId: "u-person",
    });
    if (!here) {
      await store.runStore.setHost(runId, ELSEWHERE);
    }
    // Signed after the run was placed: the token names the host's kind.
    const token = await tokens.tokenOf((await store.runStore.get(runId))!);
    return { runId, token: token! };
  });
}

const recordOf = (runId: string, tenant = TENANT) =>
  inTenant(tenant, async () => (await store.runStore.get(runId))!);

/** A copy of the run as its host keeps it. */
function reportOf(
  rev: number,
  at: { status: RunReport["status"]; cursor: string | null },
  values: Record<string, unknown> = at.cursor === "done" ? { b_f: "Biber" } : {},
): RunReport {
  return {
    ...at,
    state: { values: { a_f: "Otter", ...values } } as never,
    wakeAt: null,
    rev,
    cost: 1234,
  };
}

async function post(token: string | null, body: unknown) {
  return app.request("http://localhost:5181/api/run-services/v1/run/report", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

/** The host's client: `run.report` over the app. */
const servicesOf = (token: string) =>
  httpServices({
    url: "http://localhost:5181",
    token,
    fetch: (input, init) => Promise.resolve(app.request(String(input), init)),
  });

const heardOf = (runId: string) => ({
  notices: heard.notices.filter((n) => n.runId === runId).map((n) => n.kind),
  released: heard.released.filter((id) => id === runId).length,
  ended: heard.ended.filter((e) => e.runId === runId).map((e) => e.status),
  reported: heard.reported.filter((r) => r.runId === runId).map((r) => r.status),
});

function forget() {
  heard.notices = [];
  heard.released = [];
  heard.ended = [];
  heard.reported = [];
}

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  for (const tenant of [TENANT, OTHER]) {
    await client.openTenantDb(tenant);
    await client.controlDb
      .insert(client.control.tenant)
      .values({ id: tenant, status: "active" } as never)
      .onConflictDoNothing()
      .catch(() => undefined);
    await inTenant(tenant, async () => {
      await client.db
        .insert(client.schema.space)
        .values({ id: SPACE, tenantId: tenant, name: "Space" } as never);
    });
  }
  runner = await import("../src/engine/runner");
  store = await import("../src/engine/run-store");
  tokens = await import("../src/broker/token");
  signing = await import("../src/secrets/signing");
  app = (await import("../src/app")).default as never;
}, 60_000);

beforeEach(() => {
  process.env.FEATURES = `${BASE},runHosts=on`;
});

afterEach(() => {
  process.env.FEATURES = BASE;
});

describe("a host's copy of its run", () => {
  it("a person's step, a step's start and the end: the record follows, each change sets its things off once", async () => {
    const { runId, token } = await startRun();
    const start = await recordOf(runId);
    const services = servicesOf(token);
    forget();

    // The run waits at its first page, as it was handed over.
    expect(start).toMatchObject({ status: "waiting_input", cursor: "a" });

    // The host reached the second page: the person is told; the status is the same, so nothing
    // else is set off.
    const atPage = reportOf(start.rev + 3, { status: "waiting_input", cursor: "b" });
    expect(await services.run.report(atPage)).toEqual({
      kept: true,
      status: "waiting_input",
      rev: start.rev + 3,
    });
    let record = await recordOf(runId);
    expect(record).toMatchObject({ status: "waiting_input", cursor: "b", rev: start.rev + 3 });
    expect(record.state.values).toEqual({ a_f: "Otter" });
    // The cost is the services' to book: a copy's is not taken.
    expect(record.costMicros).toBe(start.costMicros);
    expect(heardOf(runId)).toEqual({
      notices: ["needs_you"],
      released: 0,
      ended: [],
      reported: [],
    });

    // The same copy again, and an older one: nothing changes, nothing is set off.
    forget();
    expect(await services.run.report(atPage)).toEqual({
      kept: false,
      status: "waiting_input",
      rev: start.rev + 3,
    });
    expect(
      await services.run.report(reportOf(start.rev + 2, { status: "running", cursor: "a" })),
    ).toMatchObject({ kept: false, rev: start.rev + 3 });
    expect(await recordOf(runId)).toMatchObject({ status: "waiting_input", cursor: "b" });
    expect(heardOf(runId)).toEqual({ notices: [], released: 0, ended: [], reported: [] });

    // The next step starts: the run works again, on the state the services read from the record.
    forget();
    const atStep = reportOf(start.rev + 4, { status: "running", cursor: "c" }, { b_f: "Biber" });
    expect(await services.run.report(atStep)).toEqual({
      kept: true,
      status: "running",
      rev: start.rev + 4,
    });
    expect(await recordOf(runId)).toMatchObject({
      status: "running",
      cursor: "c",
      state: { values: { a_f: "Otter", b_f: "Biber" } },
    });
    expect(heardOf(runId)).toEqual({
      notices: [],
      released: 0,
      ended: [],
      reported: ["running"],
    });

    // Within the step its state moves on: written, nothing set off.
    forget();
    const within = reportOf(
      start.rev + 5,
      { status: "running", cursor: "c" },
      { b_f: "Biber", c_half: "Otters " },
    );
    expect(await services.run.report(within)).toMatchObject({ kept: true, rev: start.rev + 5 });
    expect((await recordOf(runId)).state.values).toMatchObject({ c_half: "Otters " });
    expect(heardOf(runId)).toEqual({ notices: [], released: 0, ended: [], reported: [] });

    // The end: the run is done by this very copy, though its token opens nothing once it is.
    const atEnd = reportOf(start.rev + 7, { status: "done", cursor: "done" });
    expect(await services.run.report(atEnd)).toEqual({
      kept: true,
      status: "done",
      rev: start.rev + 7,
    });
    record = await recordOf(runId);
    expect(record).toMatchObject({ status: "done", cursor: "done", rev: start.rev + 7 });
    expect(heardOf(runId)).toEqual({
      notices: ["done"],
      released: 1,
      ended: ["done"],
      reported: ["done"],
    });
    expect(await inTenant(TENANT, () => tokens.readRunToken(token))).toEqual({ refused: "over" });

    // The end once more (its answer was lost), and a later copy: the run is over, nothing moves.
    forget();
    expect(await services.run.report(atEnd)).toEqual({
      kept: false,
      status: "done",
      rev: start.rev + 7,
    });
    expect(
      await services.run.report(reportOf(start.rev + 11, { status: "failed", cursor: "done" })),
    ).toEqual({ kept: false, status: "done", rev: start.rev + 7 });
    expect(await recordOf(runId)).toMatchObject({ status: "done", rev: start.rev + 7 });
    expect(heardOf(runId)).toEqual({ notices: [], released: 0, ended: [], reported: [] });
  });

  it("a failed end keeps the host's words", async () => {
    const { runId, token } = await startRun();
    const start = await recordOf(runId);
    forget();
    const res = await post(token, {
      ...reportOf(start.rev + 1, { status: "failed", cursor: "a" }),
      error: "The mill stood still.",
    });
    expect(res.status).toBe(200);
    expect(await recordOf(runId)).toMatchObject({
      status: "failed",
      error: "The mill stood still.",
    });
    expect(heardOf(runId)).toMatchObject({ notices: ["failed"], released: 1, ended: ["failed"] });
  });

  it("a token that names another tenant is refused, and the run stays as it was", async () => {
    const { runId, token } = await startRun();
    const before = await recordOf(runId);
    const { claims } = signing.runTokenClaims(token) as { claims: Record<string, unknown> };
    const other = signing.runToken({ ...(claims as never), tenant: OTHER });
    const res = await post(other, reportOf(before.rev + 1, { status: "done", cursor: "done" }));
    expect(res.status).toBe(401);
    expect((await res.json()).error.message).toContain("no_run");
    // The other tenant's own run takes its own copy only.
    const theirs = await startRun(OTHER);
    const theirRev = (await recordOf(theirs.runId, OTHER)).rev;
    expect(
      await servicesOf(theirs.token).run.report(
        reportOf(theirRev + 1, { status: "waiting_input", cursor: "b" }),
      ),
    ).toMatchObject({ kept: true });
    expect(await recordOf(runId)).toMatchObject({
      status: before.status,
      cursor: before.cursor,
      rev: before.rev,
    });
  });

  it("refuses what is not a copy of a run that works elsewhere", async () => {
    const { runId, token } = await startRun();
    const rev = (await recordOf(runId)).rev;
    // No token, a broken one, a body that is not a run.
    const end = reportOf(rev + 1, { status: "done", cursor: "done" });
    expect((await post(null, end)).status).toBe(401);
    expect((await post(`${token}x`, end)).status).toBe(401);
    expect((await post(token, { status: "done" })).status).toBe(400);
    expect(await recordOf(runId)).toMatchObject({ rev });

    // A run this runtime drives writes its own record.
    const here = await startRun(TENANT, true);
    const hereRev = (await recordOf(here.runId)).rev;
    const res = await post(here.token, reportOf(hereRev + 1, { status: "done", cursor: "done" }));
    expect(res.status).toBe(409);
    expect(await recordOf(here.runId)).toMatchObject({ rev: hereRev });
  });

  it("with other hosts off, nothing answers", async () => {
    const { runId, token } = await startRun();
    const before = await recordOf(runId);
    process.env.FEATURES = BASE;
    const res = await post(token, reportOf(before.rev + 1, { status: "done", cursor: "done" }));
    expect(res.status).toBe(404);
    expect(await recordOf(runId)).toMatchObject({ status: before.status, rev: before.rev });
  });
});
