import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HandOver, hostApi } from "@engenty/wizards-engine/host-api";
import { type WizardDefinition, wizardSchema } from "@engenty/wizards-shared/definition";
import { RUN_SERVICES_PATH } from "@engenty/wizards-shared/run-services";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type LocalEdge, localEdge, pathOf } from "./local-edge.js";

/**
 * A code step in a run's object on local workerd: QuickJS's WebAssembly comes as a module the
 * Worker imports, and a program that never ends is stopped by QuickJS's own count, since
 * workerd's clock stands still while code runs. The run's services are a fake here, with only
 * what these runs ask: the code from the workspace, and the copies of the run.
 */

const SERVICES = "http://services.local";

const CODE: Record<string, string> = {
  "sum.ts":
    "export function run(input: { label: string }) { const values: number[] = [1, 2, 39]; return { total: values.reduce((a, b) => a + b, 0), label: input.label }; }",
  "forever.js": "export function run() { while (true) {} }",
};

const wizard = (entry: string): WizardDefinition =>
  wizardSchema.parse({
    version: 1,
    title: `Code: ${entry}`,
    description: "",
    avatar: "round",
    steps: [
      {
        id: "sum",
        type: "code",
        title: "Sum",
        code: { entry, input: { label: "Sum of {{nothing}}three" } },
        output: {
          fields: [
            { id: "total", kind: "number" },
            { id: "label", kind: "text" },
          ],
        },
      },
      { id: "done", type: "result", title: "Done", deliverables: [] },
    ],
  });

/** What the objects reported, by run. */
const reports = new Map<string, { status: string; cursor: string | null }[]>();

/** The run's services, as far as these runs need them; the token is the run's id. */
async function services(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const call = url.pathname.slice(RUN_SERVICES_PATH.length + 1);
  const run = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const body = (await request.json()) as Record<string, unknown>;
  if (call === "files/workspace") {
    const code = CODE[String(body.path)];
    return code
      ? new Response(new TextEncoder().encode(code))
      : Response.json(
          { error: { failure: { class: "final" }, message: "no file" } },
          { status: 404 },
        );
  }
  if (call === "context/prepareInputs") {
    return new Response(null, { status: 204 });
  }
  if (call === "run/report") {
    reports.set(run, [
      ...(reports.get(run) ?? []),
      { status: String(body.status), cursor: (body.cursor as string | null) ?? null },
    ]);
    return Response.json({ kept: true, status: body.status, rev: body.rev });
  }
  return Response.json(
    { error: { failure: { class: "final" }, message: `not here: ${call}` } },
    { status: 400 },
  );
}

let edge: LocalEdge;

beforeAll(async () => {
  edge = await localEdge({
    persist: mkdtempSync(join(tmpdir(), "wizards-edge-code-")),
    services: SERVICES,
    outbound: services,
  });
}, 60_000);

afterAll(async () => {
  await edge?.dispose();
});

/** Hands a run that has not started to its object, as the tenant does. */
async function handOver(runId: string, def: WizardDefinition) {
  const body: HandOver = {
    runId,
    token: runId,
    definition: def,
    files: [],
    run: {
      cursor: null,
      status: "running",
      state: { values: {}, outputs: {}, history: [], notes: {} },
      wakeAt: null,
      rev: 1,
    },
  };
  return edge.fetch(`/api/peer/runs/${runId}/hand-over`, {
    method: "POST",
    headers: { authorization: `Bearer ${runId}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const api = (runId: string) =>
  hostApi({
    url: "http://edge.local",
    runId,
    tenant: "t",
    ticket: runId,
    fetch: (input, init) => edge.fetch(pathOf(input), init),
  });

async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, ms: number) {
  const stop = Date.now() + ms;
  let value = await read();
  while (!ok(value) && Date.now() < stop) {
    await new Promise((r) => setTimeout(r, 100));
    value = await read();
  }
  return value;
}

describe("a code step in a run's object", () => {
  it("runs the wizard's function in QuickJS on workerd", async () => {
    const res = await handOver("run-sum", wizard("sum.ts"));
    expect(res.status).toBe(202);
    const { run, error } = await until(
      () => api("run-sum").state(),
      (s) => s.run.status === "done",
      20_000,
    );
    expect({ ...run, error }).toMatchObject({ cursor: "done", status: "done", error: null });
    expect(run.state.outputs.sum).toMatchObject({ json: { total: 42, label: "Sum of three" } });
    // A copy at the step's start and at the end.
    expect(reports.get("run-sum")?.at(-1)).toEqual({ status: "done", cursor: "done" });
  });

  it("stops a function that never ends, though the clock stands still", async () => {
    await handOver("run-forever", wizard("forever.js"));
    const state = await until(
      () => api("run-forever").state(),
      (s) => s.run.status === "failed",
      120_000,
    );
    expect(state.run.status).toBe("failed");
    expect(state.error).toContain("timed out after 10000ms");
  }, 150_000);

  it("refuses a hand-over without the run's token, and calls without it", async () => {
    const res = await edge.fetch("/api/peer/runs/run-sum/hand-over", {
      method: "POST",
      headers: { authorization: "Bearer someone-else", "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const stranger = hostApi({
      url: "http://edge.local",
      runId: "run-sum",
      tenant: "t",
      ticket: "not-the-token",
      fetch: (input, init) => edge.fetch(pathOf(input), init),
    });
    await expect(stranger.state()).rejects.toMatchObject({ status: 401 });
    await expect(api("run-nobody").state()).rejects.toMatchObject({ status: 404 });
    // The same hand-over again: the run is here already, nothing changes.
    const again = await handOver("run-sum", wizard("sum.ts"));
    expect(again.status).toBe(202);
    expect((await api("run-sum").state()).run.status).toBe("done");
  });
});
