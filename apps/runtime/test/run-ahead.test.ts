import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextInBrowser } from "@engenty/wizards-shared/definition";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { beforeAll, describe, expect, it, vi } from "vitest";

// The next page in the browser (docs/plans/fast-creation.md, Part 4): `RunView.ahead` holds the
// plain pages the browser may show with no server; pages carry a number, and a late retry is done.
const dir = mkdtempSync(join(tmpdir(), "wizards-run-ahead-"));
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

const T = "tenant-ahead";
const SPACE = "space-1";
const VISITOR = "v-ahead";

const page = (id: string, more: Record<string, unknown> = {}, fields?: object[]) => ({
  id,
  type: "form",
  title: `Seite ${id}`,
  fields: fields ?? [{ id: `${id}_f`, kind: "text", label: "Text" }],
  ...more,
});
const agent = {
  id: "work",
  type: "agent",
  title: "Arbeit",
  instructions: "Tu es.",
  tools: [],
  output: { format: "text" },
};
const done = { id: "done", type: "result", title: "Fertig", deliverables: [] };
const flow = (...steps: object[]) => ({
  version: 1,
  title: "Voraus",
  description: "",
  avatar: "round",
  steps: [...steps, done],
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
      title: "Voraus",
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
const view = async (runId: string) =>
  (await (await call("GET", `/${runId}`)).json()) as Record<string, any>;
const aheadIds = async (runId: string) => Object.keys((await view(runId)).ahead ?? {}).sort();

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

describe("ahead", () => {
  it("holds the current page and the plain pages its rules reach, with where each goes", async () => {
    const runId = await startRun(
      flow(
        page("a", {
          next: [{ when: { field: "a_f", op: "eq", value: "x" }, goto: "c" }],
        }),
        page("b", { section: "Zwei" }),
        page("c"),
      ),
    );
    const v = await view(runId);
    expect(v.rev).toBeTypeOf("number");
    expect(v.pagesSent).toBe(0);
    expect(Object.keys(v.ahead).sort()).toEqual(["a", "b", "c"]);
    expect(v.ahead.a.next).toEqual([
      { when: { field: "a_f", op: "eq", value: "x" }, goto: "c" },
      { goto: "b" },
    ]);
    // The last page goes to the result: the browser shows no result, the server decides.
    expect(v.ahead.c.next).toEqual([{ goto: "done" }]);
    expect(v.ahead.b.progress).toMatchObject({ done: 1, total: 4 });
    expect(nextInBrowser(v.ahead, "a", { a_f: "x" })).toBe("c");
    expect(nextInBrowser(v.ahead, "a", { a_f: "y" })).toBe("b");
    expect(nextInBrowser(v.ahead, "c", {})).toBeNull();
  });

  it("leaves out every page Part 4 lists, and stops where the server decides", async () => {
    const cases: [string, object[]][] = [
      ["an AI step", [page("a"), agent, page("z")]],
      ["a page with a timeout", [page("a"), page("b", { timeout: "2d" })]],
      ["a page with a reminder", [page("a"), page("b", { remind: "1d" })]],
      ["a page of the team", [page("a"), page("b", { who: "team" })]],
      [
        "decided fields",
        [page("a"), page("b", {}, [{ id: "b_f", kind: "text", label: "T", ask: "Mehr?" }])],
      ],
      ["page data", [page("a"), page("b", { data: { x: "steps.a" } })]],
      [
        "choices from earlier data",
        [
          page("a"),
          page("b", {}, [
            { id: "b_f", kind: "select", label: "T", options: ["x"], optionsFrom: "lists.l.name" },
          ]),
        ],
      ],
      [
        "a prefilled field",
        [page("a"), page("b", {}, [{ id: "b_f", kind: "text", label: "T", prefill: "steps.a" }])],
      ],
      [
        "a slot field",
        [page("a"), page("b", {}, [{ id: "b_f", kind: "slot", label: "T", options: ["2026-11-09T09:00:00+01:00"] }])],
      ],
      [
        "a field whose condition reads a step",
        [
          page("a"),
          page("b", {}, [
            { id: "b_f", kind: "text", label: "T", when: { field: "steps.a.x", op: "exists" } },
          ]),
        ],
      ],
    ];
    for (const [name, steps] of cases) {
      const runId = await startRun(flow(...steps));
      expect([name, await aheadIds(runId)]).toEqual([name, ["a"]]);
    }
  });

  it("says the server decides after a page with an `ask`, a `max` or a rule back", async () => {
    for (const next of [
      [{ ask: "Will die Person mehr?", goto: "b" }],
      [{ when: { field: "a_f", op: "exists" }, goto: "b", max: 2 }],
    ]) {
      const runId = await startRun(flow(page("a", { next }), page("b")));
      const v = await view(runId);
      expect(v.ahead.a.next).toBeNull();
      expect(nextInBrowser(v.ahead, "a", { a_f: "x" })).toBeNull();
    }
    const back = await startRun(flow(page("a"), page("b", { next: [{ goto: "a" }] })));
    await call("POST", `/${back}/pages/a`, { values: {} });
    expect((await view(back)).ahead.b.next).toBeNull();
  });

  it("is no viewer's who may not answer the page", async () => {
    const runId = await startRun(flow(page("a"), page("b", { who: "team" }), page("c")));
    await inTenant(() =>
      client.db
        .update(client.schema.run)
        .set({ status: "waiting_input", cursor: "b" })
        .where(eq(client.schema.run.id, runId)),
    );
    const v = await view(runId);
    expect(v.answeredBy).toBe("team");
    expect(v.ahead).toBeUndefined();
    expect(v.pagesSent).toBeUndefined();
  });
});

describe("pages with a number", () => {
  it("are kept in order; a retry of a number the run has is answered as done", async () => {
    const runId = await startRun(flow(page("a"), page("b"), page("c")));
    const first = await call("POST", `/${runId}/pages/a`, {
      values: { a_f: "1" },
      seq: 1,
      tab: "t1",
    });
    const answer = (await first.json()) as Record<string, unknown>;
    expect(first.status).toBe(200);
    expect(answer.rev).toBe((await row(runId))?.rev);
    expect((await row(runId))?.state.pagesSent).toEqual({ n: 1, step: "a", tab: "t1" });
    await call("POST", `/${runId}/pages/b`, { values: { b_f: "2" }, seq: 2, tab: "t1" });
    const before = await row(runId);
    // The answer to page a came late, after page b: done, and nothing moves.
    const late = await call("POST", `/${runId}/pages/a`, {
      values: { a_f: "1" },
      seq: 1,
      tab: "t1",
    });
    expect(late.status).toBe(200);
    expect(await late.json()).toMatchObject({ ok: true, already: true });
    const after = await row(runId);
    expect(after).toMatchObject({ cursor: "c", rev: before?.rev });
    expect(after?.state.values).toMatchObject({ a_f: "1", b_f: "2" });
    expect((await view(runId)).pagesSent).toBe(2);
    // Another tab's answer with the same number is no retry: the page is behind the run, refused.
    const other = await call("POST", `/${runId}/pages/b`, {
      values: { b_f: "3" },
      seq: 2,
      tab: "t2",
    });
    expect(other.status).toBe(409);
    expect((await row(runId))?.state.values).toMatchObject({ b_f: "2" });
  });

  it("an answer without a number still goes where the run stands", async () => {
    const runId = await startRun(flow(page("a"), page("b")));
    const stale = await call("POST", `/${runId}/pages/b`, { values: {} });
    expect(stale.status).toBe(409);
    expect((await call("POST", `/${runId}/pages/a`, { values: {} })).status).toBe(200);
  });
});
