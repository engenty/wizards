import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { beforeAll, describe, expect, it, vi } from "vitest";

// What is typed on a page and not sent yet (docs/plans/fast-creation.md, Part 4, "Saving"): kept
// in `run.unsent`, apart from the state, and given back to whoever may answer the page.
const dir = mkdtempSync(join(tmpdir(), "wizards-run-unsent-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.RUNTIME_ROLE = "web";
const outside = (process.env.FEATURES ?? "").split(",").filter((f) => f.startsWith("fastCreate"));
process.env.FEATURES = ["durableRuns=on", ...outside].join(",");

vi.mock("../src/manage.js", async (original) => ({
  ...(await original<typeof import("../src/manage.js")>()),
  managed: true,
  runMail: async () => ({ ok: true, sent: true }),
  pushToDevice: async () => ({ ok: true }),
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
let app: { fetch: (r: Request) => Promise<Response> };

const T = "tenant-unsent";
const SPACE = "space-1";
const VISITOR = "v-typing";

const page = (id: string, more: Record<string, unknown> = {}) => ({
  id,
  type: "form",
  title: `Seite ${id}`,
  fields: [
    { id: `${id}_name`, kind: "text", label: "Name" },
    { id: `${id}_note`, kind: "textarea", label: "Notiz" },
  ],
  ...more,
});
const flow = (...steps: object[]) => ({
  version: 1,
  title: "Tippen",
  description: "",
  avatar: "round",
  steps: [...steps, { id: "done", type: "result", title: "Fertig", deliverables: [] }],
});

const inTenant = <R>(fn: () => Promise<R>) => client.withTenant(T, fn);
const row = (runId: string) =>
  inTenant(() => client.db.query.run.findFirst({ where: eq(client.schema.run.id, runId) }));

async function startRun(def: object) {
  return inTenant(async () => {
    const wizardId = nanoid(12);
    await client.db.insert(client.schema.wizard).values({
      id: wizardId,
      shareToken: nanoid(16),
      spaceId: SPACE,
      tenantId: T,
      title: "Tippen",
      draft: def as never,
      publishedVersion: 1,
    });
    return runner.createRun({
      wizardId,
      definition: def as never,
      files: [],
      version: 1,
      mode: "live",
      visitorId: VISITOR,
    });
  });
}

const call = (method: string, path: string, body?: unknown, visitor = VISITOR) =>
  app.fetch(
    new Request(`http://localhost:5181/api/runs${path}`, {
      method,
      headers: { "content-type": "application/json", "x-wizards-visitor": visitor },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
const view = async (runId: string, visitor = VISITOR) =>
  (await (await call("GET", `/${runId}`, undefined, visitor)).json()) as Record<string, any>;

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
  await inTenant(() =>
    client.db.insert(client.schema.space).values({ id: SPACE, tenantId: T, name: "Space" } as never),
  );
  app = (await import("../src/app")).default as never;
}, 60_000);

describe("what is typed and not sent", () => {
  it("is kept apart from the state: neither state nor rev changes", async () => {
    const runId = await startRun(flow(page("a"), page("b")));
    const before = await row(runId);
    const res = await call("PUT", `/${runId}/pages/a/unsent`, { values: { a_name: "Ad" } });
    expect(res.status).toBe(200);
    const after = await row(runId);
    expect(after?.unsent).toEqual({ a: { a_name: "Ad" } });
    expect(after?.rev).toBe(before?.rev);
    expect(after?.state).toEqual(before?.state);
    // The next save of the same page replaces it; another page's stays.
    await call("PUT", `/${runId}/pages/a/unsent`, { values: { a_name: "Ada", a_note: "x" } });
    await call("PUT", `/${runId}/pages/b/unsent`, { values: { b_name: "B" } });
    expect((await row(runId))?.unsent).toEqual({
      a: { a_name: "Ada", a_note: "x" },
      b: { b_name: "B" },
    });
  });

  it("comes back with the view of the page, for whoever may answer it", async () => {
    const runId = await startRun(flow(page("a"), page("b")));
    await call("PUT", `/${runId}/pages/a/unsent`, { values: { a_name: "Ada" } });
    expect((await view(runId)).unsent).toEqual({ a_name: "Ada" });
  });

  it("is saved in any status, and not by someone the run is not theirs", async () => {
    const runId = await startRun(flow(page("a"), page("b")));
    await inTenant(() =>
      client.db
        .update(client.schema.run)
        .set({ status: "running" })
        .where(eq(client.schema.run.id, runId)),
    );
    expect((await call("PUT", `/${runId}/pages/a/unsent`, { values: { a_name: "x" } })).status).toBe(
      200,
    );
    const stranger = await call("PUT", `/${runId}/pages/a/unsent`, { values: { a_name: "y" } }, "v-else");
    expect(stranger.status).toBe(404);
    expect((await row(runId))?.unsent).toEqual({ a: { a_name: "x" } });
  });

  it("refuses what is no page, and what is too large", async () => {
    const runId = await startRun(flow(page("a")));
    expect(
      (await call("PUT", `/${runId}/pages/done/unsent`, { values: { x: 1 } })).status,
    ).toBeGreaterThanOrEqual(400);
    const big = "x".repeat(70_000);
    expect((await call("PUT", `/${runId}/pages/a/unsent`, { values: { a_note: big } })).status).toBe(
      413,
    );
  });

  it("goes with the answer: the page's entry is cleared in the same update, the others stay", async () => {
    const runId = await startRun(flow(page("a"), page("b")));
    await call("PUT", `/${runId}/pages/a/unsent`, { values: { a_name: "Ada" } });
    await call("PUT", `/${runId}/pages/b/unsent`, { values: { b_name: "Bea" } });
    const res = await call("POST", `/${runId}/pages/a`, { values: { a_name: "Ada" } });
    expect(res.status).toBe(200);
    const after = await row(runId);
    expect(after).toMatchObject({ status: "waiting_input", cursor: "b" });
    expect(after?.unsent).toEqual({ b: { b_name: "Bea" } });
    expect(after?.state.values).toMatchObject({ a_name: "Ada" });
    // The next page starts from what was typed on it.
    expect((await view(runId)).unsent).toEqual({ b_name: "Bea" });
  });

  it("is no viewer's who may not answer the page", async () => {
    const runId = await startRun(flow(page("a"), page("b", { who: "team" })));
    // The run as a runner leaves it: waiting at the team's page.
    await inTenant(() =>
      client.db
        .update(client.schema.run)
        .set({ status: "waiting_input", cursor: "b", unsent: { b: { b_name: "intern" } } })
        .where(eq(client.schema.run.id, runId)),
    );
    const seen = await view(runId);
    expect(seen.answeredBy).toBe("team");
    expect(seen.unsent).toBeUndefined();
  });
});
