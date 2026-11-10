import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * What a run does outside happens once (broker/effect.ts), behind `durableRuns`. HubSpot is played
 * by a stubbed connector. A restart is the row put back to what a crash leaves: the state as it was
 * read from the database while the action ran, so the visit has to be on the run by then.
 */
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-effect-"));
process.env.APP_URL = "http://localhost:5181";
process.env.FEATURES = "durableRuns=on";

const acted: { action: string; key?: string }[] = [];
let during: (() => Promise<void>) | null = null;
let throwing: Error | null = null;

vi.mock("../src/engenty/connections-hubspot/connector", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/engenty/connections-hubspot/connector")>();
  const action = (id: string, group: "read" | "write" | "send", summary: string) => ({
    id,
    group,
    summary,
    description: summary,
    inputSchema: z.object({ email: z.string().optional() }),
    handler: async (_input: unknown, ctx: { idempotencyKey?: string }) => {
      acted.push({ action: id, key: ctx.idempotencyKey });
      await during?.();
      if (throwing) {
        throw throwing;
      }
      return { made: acted.length, again: false };
    },
  });
  return {
    ...mod,
    hubspotConnector: {
      ...mod.hubspotConnector,
      auth: {
        kind: "api_key",
        apiKey: {
          fields: [{ key: "access_token", label: "Token", secret: true }],
          verify: async () => ({ label: "HubSpot" }),
        },
      },
      actions: [
        action("list_contacts", "read", "List contacts"),
        action("create_contact", "write", "Create a contact"),
        action("send_note", "send", "Send a note"),
      ],
    },
  };
});

vi.mock("../src/engine/requirements", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/engine/requirements")>()),
  missingModelsSaid: async () => [],
  stepsWithoutModel: async () => new Set<string>(),
}));

let client: typeof import("../src/db/client");
let broker: typeof import("../src/broker/index");
let effects: typeof import("../src/broker/effect");
let runner: typeof import("../src/engine/runner");
let space = "";
let wizardId = "";

const TENANT = "tenant-effect";
const USER = "user-e";
const inTenant = <T>(fn: () => Promise<T>) => client.withTenant(TENANT, fn);

const connection = {
  id: "hub",
  connector: "hubspot",
  actions: ["list_contacts", "create_contact", "send_note"],
  policy: { create_contact: "allow", send_note: "allow" },
} as const;
const held = () =>
  ({
    kind: "store_secret",
    def: connection,
    scope: { wizardId, holder: `u:${USER}` },
    spaceId: space,
  }) as const;

const page = {
  id: "start",
  type: "form",
  title: "You",
  fields: [{ id: "email", kind: "text", label: "Mail" }],
};
const save = (next?: unknown) => ({
  id: "save",
  type: "tool",
  title: "Save",
  call: { connection: "hub", action: "create_contact", input: { email: "{{email}}" } },
  ...(next ? { next } : {}),
});
const result = { id: "done", type: "result", title: "Done", deliverables: [] };
const wizard = (steps: unknown[]) => ({
  version: 1,
  title: "Leads",
  description: "Leads into HubSpot",
  avatar: "dome",
  connections: [connection],
  steps,
});
const plain = wizard([page, save(), result]);
/** A model's step: the run's grant then has the connection's actions and a host. */
const reaching = wizard([
  page,
  {
    id: "sync",
    type: "agent",
    title: "Sync",
    instructions: "Sync it.",
    tools: ["http"],
    connections: ["hub"],
    hosts: ["api.example.com"],
    output: { format: "markdown" },
  },
  result,
]);

const startRun = (definition: unknown, unattended = false) =>
  inTenant(() =>
    runner.createRun({
      wizardId,
      definition: definition as never,
      files: [],
      version: null,
      mode: "test",
      userId: USER,
      unattended,
    }),
  );

const rowOf = (runId: string) =>
  inTenant(async () => {
    const row = await client.db.query.run.findFirst({
      where: eq(client.schema.run.id, runId),
    });
    if (!row) {
      throw new Error("no run");
    }
    return row;
  });
const effectsOf = (runId: string) =>
  inTenant(() =>
    client.db.query.runEffect.findMany({ where: eq(client.schema.runEffect.runId, runId) }),
  );

async function settled(runId: string, ...statuses: string[]) {
  const wanted = statuses.length ? statuses : ["done", "failed", "waiting_input"];
  await vi.waitFor(
    async () => {
      const row = await rowOf(runId);
      if (!wanted.includes(row.status) || row.owner) {
        throw new Error(`still ${row.status}`);
      }
    },
    { timeout: 15_000, interval: 25 },
  );
  return rowOf(runId);
}

/** A run that answered its page, so its `save` step acts. */
async function submitted(definition: unknown, unattended = false) {
  const runId = await startRun(definition, unattended);
  await settled(runId, "waiting_input");
  await inTenant(() => runner.submitPage(runId, "start", { email: "lead@b.at" }));
  return runId;
}

/**
 * The run as a crash leaves it: `state`, on the step it was working on. It was running, and the
 * next take goes on from there; here that take is a retry.
 */
async function restart(runId: string, state: unknown) {
  await inTenant(async () => {
    await client.db
      .update(client.schema.run)
      .set({ state: state as never, cursor: "save", status: "failed", error: "gone", owner: null })
      .where(eq(client.schema.run.id, runId));
    await runner.retry(runId);
  });
}

/** Runs the action of a run's `save` step and keeps the state on the row while it ran. */
async function actingOnce(definition: unknown, unattended = false) {
  let state: unknown;
  let runId = "";
  during = async () => {
    state = (await rowOf(runId)).state;
    during = null;
  };
  runId = await startRun(definition, unattended);
  await settled(runId, "waiting_input");
  await inTenant(() => runner.submitPage(runId, "start", { email: "lead@b.at" }));
  await settled(runId, "done", "failed");
  return { runId, state };
}

const where = (runId: string) => ({
  runId,
  stepId: "save",
  wizardId,
  spaceId: space,
  mode: "test" as const,
  guest: false,
});

/** A write through the broker, as a durable turn's tool call makes it. */
const write = (
  runId: string,
  toolCallId = "call-1",
  ctx: Partial<import("../src/broker/index").BrokerContext> = {},
) =>
  inTenant(() =>
    broker.brokerCall({
      who: { kind: "person", id: USER },
      where: where(runId),
      connection: held(),
      action: { id: "create_contact" },
      input: { email: "lead@b.at" },
      ctx: { effect: { turn: `turn-${runId}`, toolCallId }, ...ctx },
    }),
  );

const logOf = (runId: string) =>
  inTenant(() =>
    client.db.query.brokerLog.findMany({
      where: and(
        eq(client.schema.brokerLog.runId, runId),
        eq(client.schema.brokerLog.actionId, "create_contact"),
      ),
    }),
  );

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb(TENANT);
  broker = await import("../src/broker/index");
  effects = await import("../src/broker/effect");
  runner = await import("../src/engine/runner");
  const spaces = await import("../src/services/spaces");
  const wizards = await import("../src/services/wizards");
  space = (await inTenant(() => spaces.createSpace(USER, "Vertrieb"))).id;
  wizardId = (await inTenant(() => wizards.createWizard(USER, { definition: plain as never }))).id;
  const { putSecret } = await import("../src/store/index");
  await inTenant(() =>
    putSecret({ wizardId, holder: `u:${USER}` }, "connection:hub", "hubspot", "HubSpot", {
      accessToken: JSON.stringify({ access_token: "pat-1" }),
      refreshToken: null,
      expiresAt: null,
      scopes: [],
    }),
  );
}, 60_000);

beforeEach(() => {
  acted.length = 0;
  during = null;
  throwing = null;
  process.env.FEATURES = "durableRuns=on";
});

afterEach(() => {
  process.env.FEATURES = "durableRuns=on";
});

describe("a call of a durable turn", () => {
  it("acts once when the same tool call comes again, and answers with what it stored", async () => {
    const runId = await startRun(plain);
    const first = await write(runId);
    const second = await write(runId);
    expect(acted).toHaveLength(1);
    expect(first).toMatchObject({ ok: true, result: { made: 1 } });
    expect(second).toMatchObject({ ok: true, result: { made: 1 } });
    const [row] = await effectsOf(runId);
    expect(row).toMatchObject({
      id: `turn-${runId}:call-1`,
      stepId: "save",
      tool: "hub:create_contact",
      state: "done",
      output: { made: 1, again: false },
    });
    // The log says it was not done twice, and a guest's count of mails sent stays right.
    expect((await logOf(runId)).map((l) => l.result).sort()).toEqual(["already_done", "ok"]);
  });

  it("passes the effect's id to the service as its key", async () => {
    const runId = await startRun(plain);
    await write(runId);
    expect(acted[0].key).toBe(`turn-${runId}:call-1`);
  });

  it("acts again on another tool call: a repeat the model means", async () => {
    const runId = await startRun(plain);
    await write(runId, "call-1");
    await write(runId, "call-2");
    expect(acted).toHaveLength(2);
    expect(await effectsOf(runId)).toHaveLength(2);
  });

  it("does not act on a found `started`, and tells the admins when nobody can be asked", async () => {
    const runId = await startRun(plain);
    await inTenant(() =>
      effects.startEffect({
        id: `turn-${runId}:call-1`,
        runId,
        stepId: "save",
        tool: "hub:create_contact",
      }),
    );
    const out = await write(runId);
    expect(out).toMatchObject({ ok: false, refused: "may_have_happened" });
    expect(acted).toHaveLength(0);
    expect((await effectsOf(runId))[0].state).toBe("started");
    // The run's log says what to check, for the person reading its timeline.
    const said = await inTenant(() =>
      client.db.query.runEvent.findMany({ where: (t, { eq }) => eq(t.runId, runId) }),
    );
    expect(said.filter((e) => e.type === "effect_unsure")).toHaveLength(1);
    expect((await logOf(runId))[0]).toMatchObject({
      outcome: "deny",
      rule: "once",
      result: "may_have_happened",
      critical: true,
      criticalKind: "refused_write",
    });
  });

  it("asks the person on a found `started`: their no leaves it", async () => {
    const runId = await startRun(plain);
    await inTenant(() =>
      effects.startEffect({
        id: `turn-${runId}:call-1`,
        runId,
        stepId: "save",
        tool: "hub:create_contact",
      }),
    );
    const ask = vi.fn(async () => ({ type: "skip" as const }));
    const out = await write(runId, "call-1", { ask });
    expect(out).toMatchObject({ ok: false, refused: "may_have_happened" });
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "confirm", again: true, once: true, service: "HubSpot" }),
    );
    expect(acted).toHaveLength(0);
    expect((await logOf(runId))[0]).toMatchObject({ result: "declined", critical: false });
  });

  it("repeats a found `started` on the person's yes, under the same key", async () => {
    const runId = await startRun(plain);
    await inTenant(() =>
      effects.startEffect({
        id: `turn-${runId}:call-1`,
        runId,
        stepId: "save",
        tool: "hub:create_contact",
      }),
    );
    const ask = vi.fn(async () => ({ type: "done" as const, remember: true }));
    const allowed = new Set<string>();
    const out = await write(runId, "call-1", { ask, allowed });
    expect(out.ok).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(acted).toEqual([{ action: "create_contact", key: `turn-${runId}:call-1` }]);
    expect((await effectsOf(runId))[0].state).toBe("done");
    // The yes was for this one call.
    expect(allowed.size).toBe(0);
  });

  it("lets a failed action be tried again: the service said no", async () => {
    const runId = await startRun(plain);
    throwing = new Error("hubspot_api_error (400): bad email");
    await expect(write(runId)).rejects.toThrow("bad email");
    expect((await effectsOf(runId))[0].state).toBe("failed");
    throwing = null;
    const out = await write(runId);
    expect(out).toMatchObject({ ok: true, result: { made: 2 } });
    expect(acted).toHaveLength(2);
    expect((await effectsOf(runId))[0].state).toBe("done");
  });

  it("keeps `started` where no answer came: the request may have arrived", async () => {
    const runId = await startRun(plain);
    throwing = Object.assign(new Error("The operation was aborted due to timeout"), {
      name: "TimeoutError",
    });
    await expect(write(runId)).rejects.toThrow("timeout");
    expect((await effectsOf(runId))[0].state).toBe("started");
    throwing = null;
    expect(await write(runId)).toMatchObject({ ok: false, refused: "may_have_happened" });
    expect(acted).toHaveLength(1);
  });

  it("never records a read", async () => {
    const runId = await startRun(reaching);
    for (let i = 0; i < 2; i++) {
      await inTenant(() =>
        broker.brokerCall({
          who: { kind: "person", id: USER },
          where: where(runId),
          connection: held(),
          action: { id: "list_contacts" },
          input: {},
          ctx: { effect: { turn: `turn-${runId}`, toolCallId: "call-r" } },
        }),
      );
    }
    expect(acted).toEqual([
      { action: "list_contacts", key: undefined },
      { action: "list_contacts", key: undefined },
    ]);
    expect(await effectsOf(runId)).toHaveLength(0);
  });

  it("does not record an agent step without a turn: its call ids change on a restart", async () => {
    const runId = await startRun(plain);
    await write(runId, "call-1", { effect: { toolCallId: "call-1" } });
    await write(runId, "call-1", { effect: { toolCallId: "call-1" } });
    expect(acted).toEqual([
      { action: "create_contact", key: undefined },
      { action: "create_contact", key: undefined },
    ]);
    expect(await effectsOf(runId)).toHaveLength(0);
  });

  it("does not record a call that says nothing of itself: a plugin's", async () => {
    const runId = await startRun(plain);
    await write(runId, "call-1", { effect: undefined });
    await write(runId, "call-1", { effect: undefined });
    expect(acted).toHaveLength(2);
    expect(await effectsOf(runId)).toHaveLength(0);
  });
});

describe("the switch off", () => {
  it("is today's behaviour: every call acts and nothing is recorded", async () => {
    process.env.FEATURES = "durableRuns=false";
    const runId = await startRun(plain);
    await write(runId);
    await write(runId);
    expect(acted).toEqual([
      { action: "create_contact", key: undefined },
      { action: "create_contact", key: undefined },
    ]);
    expect(await effectsOf(runId)).toHaveLength(0);
  });

  it("leaves a run of a fixed step with no visit and no row, and a restart repeats", async () => {
    process.env.FEATURES = "durableRuns=false";
    const { runId, state } = await actingOnce(plain);
    expect((await rowOf(runId)).status).toBe("done");
    expect((await rowOf(runId)).state.visits).toBeUndefined();
    await restart(runId, state);
    await settled(runId, "done", "failed");
    expect(acted).toHaveLength(2);
    expect(await effectsOf(runId)).toHaveLength(0);
  });
});

describe("a fixed step's call in a real run", () => {
  it("has its visit on the run before it acts", async () => {
    const { state } = await actingOnce(plain);
    expect(state).toMatchObject({ visits: { save: 1 }, visiting: "save" });
  });

  it("acts once when the run starts again after the action", async () => {
    const { runId, state } = await actingOnce(plain);
    expect((await rowOf(runId)).status).toBe("done");
    expect((await rowOf(runId)).state.visiting).toBeUndefined();
    await restart(runId, state);
    const row = await settled(runId, "done", "failed");
    expect(row.status).toBe("done");
    expect(acted).toHaveLength(1);
    // The step's output is what the action answered the first time.
    expect(row.state.outputs.save?.json).toMatchObject({ made: 1 });
    expect(await effectsOf(runId)).toEqual([
      expect.objectContaining({ id: `${runId}:save:1`, state: "done" }),
    ]);
    expect(acted[0].key).toBe(`${runId}:save:1`);
  });

  it("does not act on a found `started` when the run starts again, and the step says so", async () => {
    const { runId, state } = await actingOnce(plain, true);
    await inTenant(() =>
      client.db
        .update(client.schema.runEffect)
        .set({ state: "started" })
        .where(eq(client.schema.runEffect.runId, runId)),
    );
    await restart(runId, state);
    const row = await settled(runId, "failed");
    expect(acted).toHaveLength(1);
    expect(row.error).toContain("may have happened");
    const { noteText } = await import("@engenty/wizards-shared/run");
    expect(
      noteText({
        code: "stepCallMayHaveHappened",
        params: { service: "HubSpot", action: "Create a contact" },
      }),
    ).toContain("HubSpot");
  });

  it("tries again after a service's short trouble: the row keeps it to one action", async () => {
    throwing = Object.assign(new Error("status 503"), { statusCode: 503 });
    const runId = await startRun(plain);
    await inTenant(() => runner.submitPage(runId, "start", { email: "lead@b.at" }));
    const row = await settled(runId, "sleeping", "failed");
    throwing = null;
    expect(row.status).toBe("sleeping");
    expect(row.state.pause).toEqual({ kind: "retry" });
    // The same visit: the try that comes finds this row.
    expect(row.state.visiting).toBe("save");
    await inTenant(() => runner.cancel(runId));
  });

  it("asks a person who is there, and acts again only on their yes", async () => {
    const { runId, state } = await actingOnce(plain);
    await inTenant(() =>
      client.db
        .update(client.schema.runEffect)
        .set({ state: "started" })
        .where(eq(client.schema.runEffect.runId, runId)),
    );
    await restart(runId, state);
    await vi.waitFor(
      async () => {
        const row = await rowOf(runId);
        if (row.ask?.kind !== "confirm" || !row.ask.again) {
          throw new Error("no question yet");
        }
      },
      { timeout: 15_000, interval: 25 },
    );
    expect(acted).toHaveLength(1);
    const asked = (await rowOf(runId)).ask;
    const { answerAsk } = await import("../src/engine/asks");
    await inTenant(() => answerAsk(runId, asked?.id ?? "", { type: "done" }));
    const row = await settled(runId, "done", "failed");
    expect(row.status).toBe("done");
    expect(acted).toHaveLength(2);
    expect(acted[1].key).toBe(acted[0].key);
  });

  it("acts on every turn of a loop: a real repeat", async () => {
    const looping = wizard([
      page,
      save([{ when: { field: "steps.save.again", op: "eq", value: false }, goto: "save", max: 2 }]),
      result,
    ]);
    const runId = await submitted(looping);
    const row = await settled(runId, "done", "failed");
    expect(row.status).toBe("done");
    expect(acted).toHaveLength(3);
    expect(row.state.visits).toEqual({ save: 3 });
    expect((await effectsOf(runId)).map((e) => e.id).sort()).toEqual([
      `${runId}:save:1`,
      `${runId}:save:2`,
      `${runId}:save:3`,
    ]);
  });

  it("acts again after going back: a new visit", async () => {
    const runId = await submitted(plain);
    await settled(runId, "done");
    await inTenant(() => runner.goBack(runId));
    await inTenant(() => runner.submitPage(runId, "start", { email: "other@b.at" }));
    await vi.waitFor(() => expect(acted).toHaveLength(2), { timeout: 15_000, interval: 25 });
    const row = await settled(runId, "done");
    expect(row.state.visits).toEqual({ save: 2 });
  });

  it("acts again on a regenerate: a new visit", async () => {
    const reviewed = wizard([
      page,
      save(),
      { id: "check", type: "review", title: "Check", show: ["save"] },
      result,
    ]);
    const runId = await submitted(reviewed);
    await settled(runId, "waiting_input");
    await vi.waitFor(async () => expect((await rowOf(runId)).cursor).toBe("check"), {
      timeout: 15_000,
      interval: 25,
    });
    await inTenant(() =>
      runner.reviewStep(runId, "check", { type: "regenerate", target: "save", note: "Again." }),
    );
    await vi.waitFor(() => expect(acted).toHaveLength(2), { timeout: 15_000, interval: 25 });
    await vi.waitFor(async () => expect((await rowOf(runId)).cursor).toBe("check"), {
      timeout: 15_000,
      interval: 25,
    });
    expect((await rowOf(runId)).state.visits).toEqual({ save: 2 });
  });

  it("gets a new visit after going back from a step that failed behind its action", async () => {
    const { runId, state } = await actingOnce(plain);
    // The step's action ran, and the run stopped before it went on: going back closes that visit.
    await inTenant(() =>
      client.db
        .update(client.schema.run)
        .set({
          state: { ...(state as object), history: ["start"] } as never,
          cursor: "save",
          status: "failed",
        })
        .where(eq(client.schema.run.id, runId)),
    );
    await inTenant(() => runner.goBack(runId));
    await inTenant(() => runner.submitPage(runId, "start", { email: "other@b.at" }));
    await vi.waitFor(() => expect(acted).toHaveLength(2), { timeout: 15_000, interval: 25 });
    expect((await settled(runId, "done")).state.visits).toEqual({ save: 2 });
  });

  it("tries a failed action again on a retry, in the same visit", async () => {
    throwing = new Error("hubspot_api_error (500): try later");
    const runId = await submitted(plain);
    const failed = await settled(runId, "failed");
    expect(failed.state.visits).toEqual({ save: 1 });
    throwing = null;
    await inTenant(() => runner.retry(runId));
    const row = await settled(runId, "done", "failed");
    expect(row.status).toBe("done");
    expect(acted).toHaveLength(2);
    expect(row.state.visits).toEqual({ save: 1 });
    expect((await effectsOf(runId)).map((e) => e.state)).toEqual(["done"]);
  });

  it("goes with its run", async () => {
    const { runId } = await actingOnce(plain);
    expect(await effectsOf(runId)).toHaveLength(1);
    await inTenant(() =>
      client.db.delete(client.schema.run).where(eq(client.schema.run.id, runId)),
    );
    expect(await effectsOf(runId)).toHaveLength(0);
  });
});

describe("a request through http_request", () => {
  const request = (runId: string, method: string, handler: (key?: string) => Promise<unknown>) =>
    inTenant(() =>
      broker.brokerHost({
        who: { kind: "person", id: USER },
        where: where(runId),
        url: new URL("https://api.example.com/orders"),
        method,
        effect: { turn: `turn-${runId}`, toolCallId: "call-h" },
        handler,
      }),
    );

  it("acts once when it is no GET, with the key in hand", async () => {
    const runId = await startRun(reaching);
    const handler = vi.fn(async (_key?: string) => ({ status: 201, body: "made" }));
    await request(runId, "POST", handler);
    const again = await request(runId, "POST", handler);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(`turn-${runId}:call-h`);
    expect(again).toEqual({ ok: true, result: { status: 201, body: "made" } });
  });

  it("does not act on a found `started`", async () => {
    const runId = await startRun(reaching);
    await inTenant(() =>
      effects.startEffect({
        id: `turn-${runId}:call-h`,
        runId,
        stepId: "save",
        tool: "host:api.example.com",
      }),
    );
    const handler = vi.fn(async () => ({ status: 201 }));
    expect(await request(runId, "POST", handler)).toMatchObject({
      ok: false,
      refused: "may_have_happened",
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("leaves a GET alone: a read", async () => {
    const runId = await startRun(reaching);
    const handler = vi.fn(async () => ({ status: 200 }));
    await request(runId, "GET", handler);
    await request(runId, "GET", handler);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(await effectsOf(runId)).toHaveLength(0);
  });
});

describe("the tools a model calls", () => {
  const tools = async (runId: string, turn?: string) => {
    const { toolsOf } = await import("../src/tools/connector");
    return inTenant(() =>
      toolsOf(
        connection as never,
        {
          runId,
          tenantId: TENANT,
          holder: { kind: "person", id: USER, role: "member" },
          test: true,
          stepId: "sync",
          turn,
          store: { wizardId, holder: `u:${USER}` },
          def: reaching,
          lang: null,
          files: [],
          state: { values: {}, outputs: {}, history: [], notes: {} },
          space: { id: space },
          signal: new AbortController().signal,
          resources: { allowed: new Set<string>() },
          emit: async () => {},
          ask: async () => null,
        } as never,
        {} as never,
      ),
    );
  };

  it("acts once for a turn's tool call", async () => {
    const runId = await startRun(reaching);
    const { hubspot_create_contact: create } = await tools(runId, "turn-t");
    const context = { agent: { toolCallId: "call-7" } };
    const first = await inTenant(() => create.execute({ email: "a@b.at" }, context));
    const second = await inTenant(() => create.execute({ email: "other words@b.at" }, context));
    expect(acted).toHaveLength(1);
    expect(acted[0].key).toBe("turn-t:call-7");
    expect(second).toEqual(first);
  });

  it("repeats without a turn, as an agent step without durable does today", async () => {
    const runId = await startRun(reaching);
    const { hubspot_create_contact: create } = await tools(runId);
    const context = { agent: { toolCallId: "call-7" } };
    await inTenant(() => create.execute({ email: "a@b.at" }, context));
    await inTenant(() => create.execute({ email: "a@b.at" }, context));
    expect(acted).toHaveLength(2);
    expect(await effectsOf(runId)).toHaveLength(0);
  });
});

describe("services that take a key of their own", () => {
  const ctxOf = (fetchImpl: unknown, idempotencyKey?: string) =>
    ({ accessToken: "t", fetchImpl, idempotencyKey, log: () => {} }) as never;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const event = { start: "2026-11-05T10:00:00Z", end: "2026-11-05T11:00:00Z", summary: "Termin" };

  it("Google Calendar: the event's own id, the same for one key, and a 409 finds the event", async () => {
    const { calendarConnector } = await import(
      "../src/engenty/connections-google/connectors/calendar"
    );
    const create = calendarConnector.actions.find((a) => a.id === "create_event");
    const sent: { url: string; id?: string }[] = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      const id = init?.body ? (JSON.parse(init.body as string).id as string) : undefined;
      sent.push({ url, id });
      if (init?.method === "POST" && sent.length > 1) {
        return json({ error: "duplicate" }, 409);
      }
      return json({ id: id ?? sent[0]?.id, summary: "Termin" });
    };
    const first = (await create?.handler(event, ctxOf(fetchImpl, "turn:call"))) as { id: string };
    const second = (await create?.handler(event, ctxOf(fetchImpl, "turn:call"))) as { id: string };
    expect(sent[0].id).toMatch(/^[0-9a-v]{5,1024}$/);
    expect(sent[1].id).toBe(sent[0].id);
    expect(sent[2].url).toContain(`/events/${sent[0].id}`);
    expect(second.id).toBe(first.id);
  });

  it("Google Calendar: no id without a key", async () => {
    const { calendarConnector } = await import(
      "../src/engenty/connections-google/connectors/calendar"
    );
    const create = calendarConnector.actions.find((a) => a.id === "create_event");
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      json({ id: "g1", summary: "Termin" }),
    );
    await create?.handler(event, ctxOf(fetchImpl));
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body as string).id).toBeUndefined();
  });

  it("Outlook: transactionId on a new event", async () => {
    const { microsoftOutlookConnector } = await import(
      "../src/engenty/connections-microsoft/outlook"
    );
    const create = microsoftOutlookConnector.actions.find((a) => a.id === "create_event");
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => json({ id: "m1" }));
    const input = { start: "2026-11-05T10:00:00", end: "2026-11-05T11:00:00", subject: "Termin" };
    await create?.handler(input, ctxOf(fetchImpl, "turn:call"));
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body as string).transactionId).toBe("turn:call");
    await create?.handler(input, ctxOf(fetchImpl));
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body as string).transactionId).toBeUndefined();
  });

  it("an imported API: only into the idempotency header its spec declares", async () => {
    const { buildHttpRequest } = await import(
      "../src/engenty/connections-external/invoke/http-invoker"
    );
    const request = (params: { name: string; location: "header" }[]) =>
      buildHttpRequest({
        accessToken: "t",
        auth: { kind: "none" },
        baseUrl: "https://api.example.com",
        idempotencyKey: "turn:call",
        input: {},
        invoke: { kind: "http", method: "post", path_template: "/orders", params },
      } as never);
    const declared = request([{ name: "Idempotency-Key", location: "header" }]);
    expect(declared.headers.get("idempotency-key")).toBe("turn:call");
    expect(request([]).headers.get("idempotency-key")).toBeNull();
  });
});
