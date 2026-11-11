import { answers, loadRuntime, ON, USER } from "./run-services-fixture";
import {
  type HostApi,
  HostApiError,
  type HostChange,
  type HostState,
  hostApi,
} from "@engenty/wizards-engine/host-api";
import { type WizardDefinition, wizardSchema } from "@engenty/wizards-shared/definition";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// A run's host reached from another process with only its three calls (docs/plans/
// runs-on-their-own.md, "Doors"): state, changes, events. The runner here drives the run; the
// client never touches the database.
const WITH_HOSTS = `${ON},runHosts=on`;
process.env.FEATURES = WITH_HOSTS;

const TENANT = "tenant-host-api";
const OTHER = "tenant-host-api-other";
const URL_ = "http://localhost:5181";

const definition: WizardDefinition = wizardSchema.parse({
  version: 1,
  title: "Host",
  description: "",
  avatar: "round",
  steps: [
    { id: "start", type: "form", title: "Start", fields: [{ id: "name", kind: "text", label: "Name" }] },
    {
      id: "write",
      type: "agent",
      title: "Write",
      instructions: "Write about otters.",
      output: { format: "text" },
      tools: [],
    },
    { id: "more", type: "form", title: "More", fields: [{ id: "ok", kind: "text", label: "Ok" }] },
    { id: "done", type: "result", title: "Done", deliverables: [] },
  ],
});

let runtime: Awaited<ReturnType<typeof loadRuntime>>;

/** A run of `definition` at its first page. */
async function startRun(tenant: string): Promise<string> {
  const { client, runner } = runtime;
  const wizards = await import("../src/services/wizards");
  return client.withTenant(tenant, async () => {
    const seed = await wizards.createWizard(USER, { definition });
    return runner.createRun({
      wizardId: seed.id,
      definition,
      files: [],
      version: null,
      mode: "test",
      userId: USER,
    });
  });
}

/** The client as another process holds it: the run, its tenant, a fresh peer ticket per call. */
function clientOf(runId: string, tenant = TENANT, ticket?: string): HostApi {
  return hostApi({
    url: URL_,
    runId,
    tenant,
    ticket: ticket ?? (() => runtime.signing.peerTicket(runId, tenant)),
    fetch: (input, init) => runtime.app.request(String(input), init),
  });
}

/**
 * Follows the run's changes from `from` until `ok` holds for its state, reading the state again
 * at each change. The changes it saw come along.
 */
async function follow(api: HostApi, from: HostState, ok: (s: HostState) => boolean) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 30_000);
  const seen: HostChange[] = [];
  try {
    for await (const change of api.changes(from.run.rev, abort.signal, from.event)) {
      seen.push(change);
      const state = await api.state();
      if (ok(state)) {
        return { state, seen };
      }
    }
    throw new Error(`the changes ended first: ${JSON.stringify(seen)}`);
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}

const refusal = (work: Promise<unknown>) =>
  work.then(
    () => null,
    (err: unknown) => (err instanceof HostApiError ? err.status : err),
  );

beforeAll(async () => {
  runtime = await loadRuntime();
  answers.write = ["Hello ", "there."];
  runtime.runner.startRunner();
}, 60_000);

afterAll(() => runtime.runner.stopRunner());

describe("a host's three calls", () => {
  it("drive a run from its first page to its end", async () => {
    const runId = await startRun(TENANT);
    const api = clientOf(runId);

    const first = await api.state();
    expect(first.run).toMatchObject({ cursor: "start", status: "waiting_input" });

    const sent = await api.send({ kind: "answered", stepId: "start", values: { name: "Ada" } });
    expect(sent.rev).toBeGreaterThan(first.run.rev);

    const atMore = await follow(
      api,
      first,
      (s) => s.run.cursor === "more" && s.run.status === "waiting_input",
    );
    expect(atMore.state.run.state.values).toMatchObject({ name: "Ada" });
    expect(atMore.state.run.state.outputs.write?.text).toBe("Hello there.");
    // Every change is a newer revision or new lines, the lines in order and each once.
    const revs = atMore.seen.map((c) => c.rev);
    expect(revs[0]).toBeGreaterThan(first.run.rev);
    expect([...revs].sort((a, b) => a - b)).toEqual(revs);
    const ids = atMore.seen.flatMap((c) => c.events.map((e) => e.id));
    expect(ids.every((id) => id > first.event)).toBe(true);
    expect([...new Set(ids)].sort((a, b) => a - b)).toEqual(ids);
    expect(
      atMore.seen.flatMap((c) => c.events).some((e) => e.stepId === "write" && e.type === "step_done"),
    ).toBe(true);

    await api.send({ kind: "answered", stepId: "more", values: { ok: "yes" } });
    const end = await follow(api, atMore.state, (s) => s.run.status === "done");
    expect(end.state.run.cursor).toBe("done");
    expect(end.state.run.state.values).toMatchObject({ name: "Ada", ok: "yes" });
  }, 60_000);

  it("refuses an answer to a page the run does not stand on", async () => {
    const runId = await startRun(TENANT);
    const api = clientOf(runId);
    // A page the run does not stand on.
    expect(
      await refusal(api.send({ kind: "answered", stepId: "more", values: { ok: "x" } })),
    ).toBe(409);
    expect((await api.state()).run.cursor).toBe("start");
  });

  it("refuses what the host makes itself, and a wake before its time without a name", async () => {
    const runId = await startRun(TENANT);
    const api = clientOf(runId);
    expect(await refusal(api.send({ kind: "start" }))).toBe(400);
    expect(
      await refusal(api.send({ kind: "stepDone", stepId: "write", output: { at: "x" } })),
    ).toBe(400);
    expect(
      await refusal(api.send({ kind: "signal", stepId: "start", id: "s", data: null })),
    ).toBe(400);
    // Not an event at all.
    expect(await refusal(api.send({ kind: "nothing" } as never))).toBe(400);
  });

  it("cancels a run", async () => {
    const runId = await startRun(TENANT);
    const api = clientOf(runId);
    await api.send({ kind: "cancel" });
    expect((await api.state()).run.status).toBe("cancelled");
  });

  it("refuses a ticket that does not open the run in its tenant", async () => {
    const runId = await startRun(TENANT);
    const other = await startRun(OTHER);
    const { peerTicket } = runtime.signing;
    // Not a ticket.
    expect(await refusal(clientOf(runId, TENANT, "1.bad").state())).toBe(401);
    // Another run's ticket.
    expect(await refusal(clientOf(runId, TENANT, peerTicket(other, TENANT)).state())).toBe(401);
    // The run's ticket, sent for another tenant.
    expect(await refusal(clientOf(runId, OTHER, peerTicket(runId, TENANT)).state())).toBe(401);
    // A ticket for the other tenant opens only its own run: this one is not there.
    expect(await refusal(clientOf(runId, OTHER).state())).toBe(404);
    // Each call checks it, the stream and the events too.
    const bad = clientOf(runId, TENANT, "1.bad");
    expect(await refusal(bad.send({ kind: "cancel" }))).toBe(401);
    const lines = (async () => {
      for await (const _ of bad.changes(0)) {
        // nothing comes
      }
    })();
    expect(await refusal(lines)).toBe(401);
    expect((await clientOf(runId).state()).run.status).toBe("waiting_input");
  });

  it("is not there with the switch off", async () => {
    const runId = await startRun(TENANT);
    process.env.FEATURES = ON;
    try {
      const api = clientOf(runId);
      expect(await refusal(api.state())).toBe(404);
      expect(await refusal(api.send({ kind: "cancel" }))).toBe(404);
      expect(await refusal(clientOf(runId, TENANT, "1.bad").state())).toBe(404);
    } finally {
      process.env.FEATURES = WITH_HOSTS;
    }
    expect((await clientOf(runId).state()).run.status).toBe("waiting_input");
  });
});
