import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type WizardDefinition, wizardSchema } from "@engenty/wizards-shared/definition";
import type { TurnPart } from "@engenty/wizards-shared/run-services";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The run's services over HTTP (routes/run-services.ts): two tenants with a run each, every
 * service called once through the app with the run's token. The model is scripted per step,
 * nothing reaches the network.
 */
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-run-services-http-"));
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
const ON = "durableRuns=on,runServices=on";
process.env.FEATURES = ON;
process.env.PLUGINS_WATCH = "0";
process.env.PLUGIN_JOBS = "0";

const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 2, text: 2, reasoning: 0 },
};
/** What the model writes, in pieces, by the step the call is made for. */
const answers: Record<string, string[]> = {
  write: ["Hello ", "there."],
  doc: ["<!doctype html><html><body><h1>Otters</h1></body></html>"],
  pick: [JSON.stringify({ otters: true })],
  torn: ["Otters "],
};
const modelFor = (step: string) =>
  new MockLanguageModelV3({
    doGenerate: async () =>
      ({
        content: [{ type: "text", text: (answers[step] ?? []).join("") }],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        warnings: [],
      }) as never,
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        ...(answers[step] ?? []).map((delta) => ({ type: "text-delta", id: "t", delta })),
        // The model breaks off after its first words.
        ...(step === "torn" ? [{ type: "error", error: new Error("The model went away.") }] : []),
        { type: "text-end", id: "t" },
        { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
      ] as never[]),
    }),
  });
vi.mock("../src/models.js", async (original) => ({
  ...(await original<typeof import("../src/models.js")>()),
  textModel: async (_cls: string, meta: { stepId?: string } = {}) => ({
    model: modelFor(meta.stepId ?? "-"),
    ref: "test/scripted",
    vendor: "test",
    gateway: false,
    metered: true,
  }),
  systemOneAccess: async () => null,
  embeddingModel: async () => null,
}));
vi.mock("../src/safety.js", async (original) => ({
  ...(await original<typeof import("../src/safety.js")>()),
  guestChecksOn: async () => false,
}));
vi.mock("../src/engine/requirements.js", async (original) => ({
  ...(await original<typeof import("../src/engine/requirements.js")>()),
  missingModelsSaid: async () => [],
}));
vi.mock("../src/credits/credits.js", async (original) => ({
  ...(await original<typeof import("../src/credits/credits.js")>()),
  canSpend: async () => true,
  reserveForRun: async () => true,
  releaseRun: async () => undefined,
}));

type App = { request: (path: string, init?: RequestInit) => Response | Promise<Response> };

let app: App;
let client: typeof import("../src/db/client");
let runner: typeof import("../src/engine/runner");
let wizards: typeof import("../src/services/wizards");
let tokens: typeof import("../src/broker/token");
let signing: typeof import("../src/secrets/signing");

const A = "tenant-http-a";
const B = "tenant-http-b";
const USER = "user-http";
const SCHEMA = "CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL);";

const definition: WizardDefinition = wizardSchema.parse({
  version: 1,
  title: "Services",
  description: "",
  avatar: "round",
  data: { scope: "shared", schema: "data/schema.sql" },
  lists: [{ id: "notes", title: "Notes", columns: [{ id: "title", name: "Title", type: "text" }] }],
  steps: [
    // The run waits here: nobody answers, so it stays under way and its token opens it.
    { id: "start", type: "form", title: "Start", fields: [{ id: "name", kind: "text", label: "Name" }] },
    {
      id: "write",
      type: "agent",
      title: "Write",
      instructions: "Write about otters.",
      output: { format: "text" },
      tools: [],
    },
    {
      id: "torn",
      type: "agent",
      title: "Torn",
      instructions: "Write.",
      output: { format: "text" },
      tools: [],
    },
    {
      id: "pick",
      type: "agent",
      title: "Pick",
      instructions: "Pick.",
      output: { format: "text" },
      tools: [],
    },
    { id: "doc", type: "generate", title: "Doc", asset: "document", prompt: "A page on otters." },
    { id: "done", type: "result", title: "Done", deliverables: [] },
  ],
});

interface Started {
  tenant: string;
  runId: string;
  token: string;
}

/** A run of `definition` in `tenant` that is not driven (no runner here), and its token. */
const startRun = (tenant: string): Promise<Started> =>
  client.withTenant(tenant, async () => {
    const { putBlob } = await import("../src/files/blobs");
    const schemaBytes = Buffer.from(SCHEMA, "utf8");
    const files = [
      {
        path: "data/schema.sql",
        hash: await putBlob(schemaBytes),
        mime: "application/sql",
        size: schemaBytes.length,
      },
    ];
    const seed = await wizards.createWizard(USER, { definition });
    const runId = await runner.createRun({
      wizardId: seed.id,
      definition,
      files,
      version: null,
      mode: "test",
      userId: USER,
    });
    const run = await client.db.query.run.findFirst({ where: eq(client.schema.run.id, runId) });
    // The agent step is at work: its turn is on the run, as the step writes it before it lists its tools.
    await client.db
      .update(client.schema.run)
      .set({ state: { ...run!.state, turn: { stepId: "write", id: `${runId}.turn` } } })
      .where(eq(client.schema.run.id, runId));
    const token = run && (await tokens.tokenOf(run));
    if (!token) {
      throw new Error("no token");
    }
    return { tenant, runId, token };
  });

const post = (token: string | null, path: string, body: unknown = {}) =>
  app.request(`http://localhost:5181/api/run-services/v1/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

const json = async (res: Response | Promise<Response>, status = 200) => {
  const r = await res;
  const text = await r.text();
  expect(r.status, text).toBe(status);
  return text ? JSON.parse(text) : null;
};

let a: Started;
let b: Started;

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  runner = await import("../src/engine/runner");
  wizards = await import("../src/services/wizards");
  tokens = await import("../src/broker/token");
  signing = await import("../src/secrets/signing");
  app = (await import("../src/app")).default as unknown as App;
  a = await startRun(A);
  b = await startRun(B);
}, 180_000);

vi.setConfig({ testTimeout: 120_000 });

describe("the run's services over HTTP", () => {
  it("answer every call of a run's token, in its tenant", async () => {
    for (const run of [a, b]) {
      const { token } = run;

      // models: a streamed turn, a decision, no embedding model here.
      const res = await post(token, "models/turn", {
        stepId: "write",
        class: "standard",
        messages: [{ role: "user", content: "Write about otters." }],
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/application\/x-ndjson/);
      const parts = (await res.text())
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as TurnPart);
      expect(parts).toEqual([
        { type: "text", text: "Hello " },
        { type: "text", text: "there." },
        {
          type: "finish",
          reason: "stop",
          usage: { inputTokens: 3, outputTokens: 2 },
          model: "test/scripted",
        },
      ]);
      expect(
        await json(
          post(token, "models/decide", {
            stepId: "pick",
            state: "A river with otters.",
            questions: { otters: { type: "noul", instructions: "Are there otters?" } },
          }),
        ),
      ).toEqual({ answers: { otters: { type: "noul", noul: 1 } }, source: "llm" });
      expect(await json(post(token, "models/embed", { values: ["otters"] }))).toBeNull();

      // tools: the step's tools as descriptors, one called.
      const tools = await json(post(token, "tools/list", { stepId: "write" }));
      expect(tools.map((t: { name: string }) => t.name)).toContain("list_write");
      expect(
        await json(
          post(token, "tools/call", {
            stepId: "write",
            name: "list_write",
            input: { list: "notes", rows: [{ title: `Otters of ${run.tenant}` }] },
            effect: null,
          }),
        ),
      ).toEqual({ output: { added: 1, updated: 0, deleted: 0 } });

      // context: what the model is told beside the task; the answers made ready.
      const setting = await json(post(token, "context/forStep", { stepId: "write" }));
      expect(setting).toMatchObject({ lang: "en", skills: "" });
      expect((await post(token, "context/prepareInputs", { stepId: "write" })).status).toBe(204);

      // files: saved as base64, read back as bytes with the reference, linked; uploads, workspace.
      const ref = await json(
        post(token, "files/save", {
          kind: "text",
          mime: "text/plain",
          name: "otters-ü.txt",
          base64: Buffer.from("Otters hold hands.").toString("base64"),
        }),
      );
      expect(ref).toMatchObject({ kind: "text", mime: "text/plain", name: "otters-ü.txt" });
      const read = await post(token, "files/read", { ref: ref.id });
      expect(read.status).toBe(200);
      expect(read.headers.get("content-type")).toBe("application/octet-stream");
      expect(JSON.parse(read.headers.get("x-asset-ref") ?? "")).toEqual({
        id: ref.id,
        kind: "text",
        mime: "text/plain",
        name: "otters-ü.txt",
      });
      expect(await read.text()).toBe("Otters hold hands.");
      expect(await json(post(token, "files/link", { ref: ref.id }))).toMatch(
        new RegExp(`/api/runs/${run.runId}/assets/${ref.id}\\?exp=\\d+&sig=`),
      );
      expect(await json(post(token, "files/uploads"))).toEqual([]);
      const ws = await post(token, "files/workspace", { path: "data/schema.sql" });
      expect(ws.status).toBe(200);
      expect(await ws.text()).toBe(SCHEMA);
      expect((await post(token, "files/workspace", { path: "nope.txt" })).status).toBe(404);
      expect((await post(token, "files/read", { ref: "nope" })).status).toBe(404);

      // data: the wizard's database written and read; the list the tool wrote.
      const statement = { stepId: "write", scope: "shared", by: "wizard" };
      expect(
        await json(
          post(token, "data/exec", {
            ...statement,
            sql: "INSERT INTO notes (text) VALUES (:text)",
            params: { text: run.tenant },
          }),
        ),
      ).toMatchObject({ changes: 1 });
      expect(
        await json(post(token, "data/query", { ...statement, sql: "SELECT text FROM notes" })),
      ).toMatchObject({ rows: [{ text: run.tenant }] });
      expect(await json(post(token, "data/counts"))).toEqual({ notes: 1 });
      const notes = await json(post(token, "data/rows", { listId: "notes" }));
      expect(notes.rows.map((r: { cells: { title: string } }) => r.cells.title)).toEqual([
        `Otters of ${run.tenant}`,
      ]);

      // steps: a document made whole.
      expect(await json(post(token, "steps/run", { stepId: "doc" }))).toMatchObject({
        assets: [{ kind: "html", name: "doc.html" }],
      });

      // people: the run's person hears it is done.
      expect((await post(token, "people/tell", { kind: "done" })).status).toBe(204);
      const told = await client.withTenant(run.tenant, () =>
        client.db.query.notice.findMany({ where: eq(client.schema.notice.runId, run.runId) }),
      );
      expect(told.map((n) => [n.kind, n.userId])).toEqual([["done", USER]]);
    }
  });

  it("refuse a call across tenants: the token alone names the tenant and the run", async () => {
    // A's token reads A's run and its files only: B's file is no file of A's tenant.
    const bFile = await json(
      post(b.token, "files/save", { kind: "text", mime: "text/plain", name: "b.txt", base64: "Yg==" }),
    );
    expect((await post(a.token, "files/read", { ref: bFile.id })).status).toBe(404);
    expect((await post(b.token, "files/read", { ref: bFile.id })).status).toBe(200);
    const rows = await json(post(a.token, "data/query", {
      stepId: "write",
      scope: "shared",
      by: "wizard",
      sql: "SELECT text FROM notes",
    }));
    expect(rows.rows).toEqual([{ text: A }]);

    // A token signed for A's run that names tenant B, or B's run in tenant A, opens nothing.
    const claims = (token: string) => {
      const read = signing.runTokenClaims(token);
      if (!("claims" in read)) {
        throw new Error(read.refused);
      }
      return read.claims;
    };
    const aClaims = claims(a.token);
    const bClaims = claims(b.token);
    for (const forged of [
      signing.runToken({ ...aClaims, tenant: B }),
      signing.runToken({ ...aClaims, run: bClaims.run }),
      signing.runToken({ ...bClaims, tenant: A }),
    ]) {
      const res = await json(post(forged, "data/counts"), 401);
      expect(res).toMatchObject({ error: { failure: { class: "final" } } });
    }
    // A body that names another tenant or run changes nothing: only A's run is told.
    expect(
      await json(post(a.token, "data/counts", { tenant: B, runId: b.runId })),
    ).toEqual({ notes: 1 });

    // No token, a token of nobody's: refused.
    expect((await post(null, "data/counts")).status).toBe(401);
    expect((await post(`${a.token}x`, "data/counts")).status).toBe(401);
  });

  it("end a turn the model broke off with a line that says why", async () => {
    const res = await post(a.token, "models/turn", {
      stepId: "torn",
      class: "standard",
      messages: [{ role: "user", content: "Write." }],
    });
    expect(res.status).toBe(200);
    const lines = (await res.text())
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(lines).toEqual([
      { type: "text", text: "Otters " },
      { error: { failure: { class: "retry", retryAfterMs: null }, message: "The model went away." } },
    ]);
  });

  it("refuse a step the run's wizard does not have, and a request that is not valid", async () => {
    expect(
      await json(post(a.token, "tools/list", { stepId: "elsewhere" }), 400),
    ).toMatchObject({ error: { failure: { class: "final" } } });
    expect((await post(a.token, "steps/run", { stepId: "write" })).status).toBe(400);
    expect((await post(a.token, "models/embed", { values: [] })).status).toBe(400);
    expect((await post(a.token, "models/nothing")).status).toBe(404);
    // A service's own failure keeps its class.
    expect(await json(post(a.token, "data/rows", { listId: "nope" }), 422)).toEqual({
      error: { failure: { class: "final" }, message: "No list nope in this wizard." },
    });
  });

  it("answer nothing while the switch is off", async () => {
    process.env.FEATURES = "durableRuns=on,runServices=off";
    try {
      for (const token of [a.token, null, "nobody"]) {
        const res = await post(token, "data/counts");
        expect(res.status).toBe(404);
        expect(await res.json()).toMatchObject({ code: "not_found" });
      }
    } finally {
      process.env.FEATURES = ON;
    }
  });
});
