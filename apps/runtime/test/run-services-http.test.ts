import type { TurnPart } from "@engenty/wizards-shared/run-services";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  loadRuntime,
  ON,
  post,
  type Runtime,
  SCHEMA,
  type Started,
  startRun,
  USER,
} from "./run-services-fixture";

/**
 * The run's services over HTTP (routes/run-services.ts): two tenants with a run each, every
 * service called once through the app with the run's token. The runtime, the wizard and the
 * scripted model are run-services-fixture.ts's.
 */
const A = "tenant-http-a";
const B = "tenant-http-b";

let client: Runtime["client"];
let signing: Runtime["signing"];

const json = async (res: Response | Promise<Response>, status = 200) => {
  const r = await res;
  const text = await r.text();
  expect(r.status, text).toBe(status);
  return text ? JSON.parse(text) : null;
};

let a: Started;
let b: Started;

beforeAll(async () => {
  ({ client, signing } = await loadRuntime());
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
      post(b.token, "files/save", {
        kind: "text",
        mime: "text/plain",
        name: "b.txt",
        base64: "Yg==",
      }),
    );
    expect((await post(a.token, "files/read", { ref: bFile.id })).status).toBe(404);
    expect((await post(b.token, "files/read", { ref: bFile.id })).status).toBe(200);
    const rows = await json(
      post(a.token, "data/query", {
        stepId: "write",
        scope: "shared",
        by: "wizard",
        sql: "SELECT text FROM notes",
      }),
    );
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
    expect(await json(post(a.token, "data/counts", { tenant: B, runId: b.runId }))).toEqual({
      notes: 1,
    });

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
      {
        error: { failure: { class: "retry", retryAfterMs: null }, message: "The model went away." },
      },
    ]);
  });

  it("refuse a step the run's wizard does not have, and a request that is not valid", async () => {
    expect(await json(post(a.token, "tools/list", { stepId: "elsewhere" }), 400)).toMatchObject({
      error: { failure: { class: "final" } },
    });
    expect((await post(a.token, "steps/run", { stepId: "write" })).status).toBe(400);
    expect((await post(a.token, "models/embed", { values: [] })).status).toBe(400);
    expect((await post(a.token, "models/nothing")).status).toBe(404);
    // A service's own failure keeps its class.
    expect(await json(post(a.token, "data/rows", { listId: "nope" }), 422)).toEqual({
      error: { failure: { class: "final" }, message: "No list nope in this wizard." },
    });
  });

  it("read an agent step's tools from the run's definition, and refuse what it doesn't have", async () => {
    const turn = `${a.runId}.turn`;
    const said = async (path: string, body: unknown) =>
      (await json(post(a.token, path, body), 400)).error.message;
    expect(await json(post(a.token, "tools/forStep", { stepId: "write", turn }))).toMatchObject({
      tools: expect.arrayContaining([expect.objectContaining({ name: "list_read" })]),
      assets: [],
      sandbox: false,
    });
    // An entry's tools: the step's entries are the list's rows, the one the first case wrote.
    expect(
      await json(post(a.token, "tools/forStep", { stepId: "each", turn, entry: 0 })),
    ).toMatchObject({ sandbox: false });
    expect(await said("tools/forStep", { stepId: "each", turn, entry: 1 })).toBe(
      "Step each has no entry 1.",
    );
    expect(await said("tools/forStep", { stepId: "write", turn, entry: 0 })).toBe(
      "Step write has no entries.",
    );
    expect(await said("tools/forStep", { stepId: "write", turn: `${b.runId}.turn` })).toBe(
      `The turn ${b.runId}.turn is not one of this run's.`,
    );
    expect(await said("tools/forStep", { stepId: "doc", turn })).toBe(
      "Step doc is not an agent step.",
    );
    expect(
      await said("tools/stepCall", {
        stepId: "each",
        turn,
        name: "list_read",
        input: {},
        effect: null,
      }),
    ).toBe("Step each has no entry named.");
    expect(await said("tools/ofAgent", { stepId: "write" })).toBe(
      "No agent of the wizard runs step write.",
    );
    // The agent's file gives the step's model and its instructions.
    expect(await json(post(a.token, "tools/ofAgent", { stepId: "byagent" }))).toMatchObject({
      step: { id: "byagent", model: "low" },
      instructions: "You write as the scribe.",
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
