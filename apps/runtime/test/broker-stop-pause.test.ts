import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * A stop that holds, and a connection that pauses (docs/plans/capabilities-next.md, 2a). Stopping
 * a run is the revoke: every path of the broker refuses a run that was stopped, is done or
 * failed, whatever the connection. A paused connection is refused for every caller, a plugin's
 * own job among them, at the call: a step that read its row before the pause is stopped at its
 * next call. HubSpot is played by a stubbed connector that takes keys.
 */
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-stop-pause-"));
process.env.APP_URL = "http://localhost:5181";

const calls: { action: string; token: string }[] = [];

vi.mock("../src/engenty/connections-hubspot/connector", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/engenty/connections-hubspot/connector")>();
  const action = (id: string, group: "read" | "write", summary: string) => ({
    id,
    group,
    summary,
    description: summary,
    inputSchema: z.object({ email: z.string().optional() }),
    handler: async (_input: unknown, ctx: { accessToken: string }) => {
      calls.push({ action: id, token: ctx.accessToken });
      return { done: id };
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
      ],
    },
  };
});

// An organization with roles: the Manage-App says who is who.
vi.mock("../src/manage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/manage.js")>()),
  managed: true,
  tenantInfo: async () => ({ limits: { build: true }, plan: { id: "pro", name: "Pro" }, features: {} }),
  tenantMembers: async () => ({
    members: [
      { userId: "user-a", role: "owner", name: "Anna" },
      { userId: "user-m", role: "member", name: "Max" },
    ],
  }),
}));

let client: typeof import("../src/db/client");
let broker: typeof import("../src/broker/index");
let service: typeof import("../src/connectors/space-connections");
let plugins: typeof import("../src/connectors/plugin-connections");
let access: typeof import("../src/services/access");
let runner: typeof import("../src/engine/runner");
let space: string;
let wizardId: string;

const TENANT = "tenant-stop";
const inTenant = <T>(fn: () => Promise<T>) => client.withTenant(TENANT, fn);
const TOKEN = "pat-secret-4";

const admin = { kind: "admin" as const, id: "user-a" };
const member = { kind: "person" as const, id: "user-m" };
const guest = { kind: "guest" as const, id: "visitor-1" };
const goose = { kind: "goose" as const, id: "user-a", admin: true };

const definition = {
  version: 1,
  title: "Leads",
  description: "Leads into HubSpot",
  avatar: "dome",
  connections: [{ id: "hub", connector: "hubspot" }],
  steps: [
    { id: "start", type: "form", title: "You", fields: [{ id: "email", kind: "email", label: "Mail" }] },
    {
      id: "sync",
      type: "agent",
      title: "Sync",
      instructions: "Sync.",
      tools: ["http"],
      hosts: ["api.example.com"],
      connections: ["hub"],
    },
    { id: "done", type: "result", title: "Done", deliverables: [] },
  ],
};

/** The member's store: what holds the wizard's own HubSpot sign-in and the browser's kept ones. */
const store = { wizardId: "", holder: "u:user-m" };

type Status = "running" | "waiting_input" | "sleeping" | "done" | "failed" | "cancelled";

async function runRow(id: string, status: Status, who: "member" | "guest" = "member") {
  await inTenant(() =>
    client.db.insert(client.schema.run).values({
      id,
      wizardId,
      tenantId: TENANT,
      definition: definition as never,
      files: [],
      grant: null,
      version: null,
      mode: "live",
      ...(who === "member" ? { userId: "user-m" } : { visitorId: "visitor-1" }),
      status,
      cursor: "sync",
      state: { values: {}, outputs: {}, history: [], notes: {} },
    }),
  );
}

const whereOf = (runId: string, extra: { share?: boolean; guest?: boolean } = {}) => ({
  runId,
  stepId: "sync",
  wizardId,
  spaceId: space,
  mode: "live" as const,
  guest: false,
  ...extra,
});

/** The lines of a run's refused calls: lines of one millisecond come in no order, so by what they are. */
const ended = async (connectionId: string, runId: string) =>
  (await logOf(connectionId, runId)).filter((l) => l.result === "run_ended");

async function logOf(connectionId: string, runId?: string) {
  const rows = await inTenant(() =>
    client.db.query.brokerLog.findMany({
      where: (t, { eq }) => eq(t.connectionId, connectionId),
      orderBy: (t, { asc }) => [asc(t.at), asc(t.id)],
    }),
  );
  return runId ? rows.filter((r) => r.runId === runId) : rows;
}

/** A connection of the space that signs in as the space, open to everyone, signed in. */
async function spaceConnection(name: string) {
  const row = await inTenant(() =>
    service.createSpaceConnection("user-a", space, {
      connectorId: "hubspot",
      name,
      signIn: "space",
      audience: "all",
      rules: { read: "allow", write: "allow", destructive: "deny", send: "allow" },
      actions: [],
    }),
  );
  await inTenant(() =>
    service.signInWithCredentials(row.id, { as: "space" }, { access_token: TOKEN }),
  );
  return row.id;
}

/** The connection as a step or a chat turn holds it: its row as it is now, and its connector. */
async function held(id: string) {
  return inTenant(async () => {
    const row = await service.spaceConnectionById(id);
    return { kind: "space_connection" as const, row, connector: await service.connectorOfRow(row) };
  });
}

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb(TENANT);
  broker = await import("../src/broker/index");
  service = await import("../src/connectors/space-connections");
  plugins = await import("../src/connectors/plugin-connections");
  access = await import("../src/services/access");
  runner = await import("../src/engine/runner");
  const spaces = await import("../src/services/spaces");
  const wizards = await import("../src/services/wizards");
  space = (await inTenant(() => spaces.createSpace("user-a", "Vertrieb"))).id;
  wizardId = (await inTenant(() => wizards.createWizard("user-a", { definition, spaceId: space })))
    .id;
  store.wizardId = wizardId;
  const { putSecret } = await import("../src/store/index");
  await inTenant(() =>
    putSecret(store, "connection:hub", "hubspot", "HubSpot", {
      accessToken: JSON.stringify({ access_token: TOKEN }),
      refreshToken: null,
      expiresAt: null,
      scopes: [],
    }),
  );
}, 60_000);

describe("a stop that holds", () => {
  let connectionId = "";

  beforeAll(async () => {
    connectionId = await spaceConnection("Kunden");
  });

  /** One call through each of the broker's four paths, as a step of this run. */
  async function fourPaths(runId: string, extra: { share?: boolean } = {}) {
    const where = whereOf(runId, extra);
    const handlers = {
      host: vi.fn(async () => ({ status: 200 })),
      send: vi.fn(async () => "sent"),
      secret: vi.fn(async (kept: unknown) => (kept ? "signed in" : "signed out")),
    };
    const ofSpace = await held(connectionId);
    const out = await inTenant(async () => ({
      // A connection of the space, and the wizard's own: the grant binds only the second.
      space: await broker.brokerCall({
        who: member,
        where,
        connection: ofSpace,
        action: { id: "list_contacts" },
        input: {},
      }),
      own: await broker.brokerCall({
        who: member,
        where,
        connection: { kind: "store_secret", def: definition.connections[0], scope: store, spaceId: space },
        action: { id: "list_contacts" },
        input: {},
      }),
      host: await broker.brokerHost({
        who: member,
        where,
        url: new URL("https://api.example.com/v1/prices?key=1"),
        method: "GET",
        handler: handlers.host,
      }),
      send: await broker.brokerSend({
        who: member,
        where,
        recipients: ["kundin@example.com"],
        input: { to: "kundin@example.com", subject: "Hallo" },
        handler: handlers.send,
      }),
      secret: await broker.brokerSecret({
        who: member,
        where,
        scope: store,
        slot: "browser",
        handler: handlers.secret,
      }),
    }));
    return { out, handlers };
  }

  const LINES = [
    ["host:api.example.com", "http_request"],
    ["mail:server", "send_message"],
    ["browser", "read_secret"],
    ["hub", "list_contacts"],
  ] as const;

  /** Every path refused this run's call, ran nothing and wrote its line. */
  async function expectRefused(
    runId: string,
    status: "cancelled" | "done" | "failed",
    reason: string,
    extra: { share?: boolean } = {},
  ) {
    calls.length = 0;
    const { out, handlers } = await fourPaths(runId, extra);
    for (const [path, answer] of Object.entries(out)) {
      expect(answer, path).toEqual({ ok: false, refused: "run_ended", reason });
    }
    expect(calls).toEqual([]);
    for (const handler of Object.values(handlers)) {
      expect(handler).not.toHaveBeenCalled();
    }
    for (const [connection, action] of [...LINES, [connectionId, "list_contacts"] as const]) {
      const line = (await ended(connection, runId)).at(-1);
      expect(line, connection).toMatchObject({
        runId,
        stepId: "sync",
        actionId: action,
        outcome: "deny",
        rule: `run.${status}`,
        reason,
        result: "run_ended",
      });
    }
  }

  it("leaves a run under way as it was: running, waiting for input, sleeping", async () => {
    for (const status of ["running", "waiting_input", "sleeping"] as const) {
      const id = `run-${status}`;
      await runRow(id, status);
      calls.length = 0;
      const { out, handlers } = await fourPaths(id);
      expect(out.space.ok, status).toBe(true);
      expect(out.own.ok, status).toBe(true);
      expect(out.host).toEqual({ ok: true, result: { status: 200 } });
      expect(out.send).toEqual({ ok: true, result: "sent" });
      expect(out.secret).toEqual({ ok: true, result: "signed out" });
      expect(calls.map((c) => c.action)).toEqual(["list_contacts", "list_contacts"]);
      expect(handlers.host).toHaveBeenCalledTimes(1);
      expect((await logOf(connectionId, id)).at(-1)).toMatchObject({ outcome: "allow", result: "ok" });
    }
  });

  it("refuses a stopped run's next call through each of the four paths, and logs it", async () => {
    await runRow("run-stop", "running");
    expect((await fourPaths("run-stop")).out.space.ok).toBe(true);
    // Stopped the way that exists: the run's cancel (`POST /runs/:id/cancel`, MCP `control_run`).
    await inTenant(() => runner.cancel("run-stop"));
    await expectRefused("run-stop", "cancelled", "The run was stopped.");
    // A read through a connection is no critical line; the request to a host and the mail are.
    expect((await ended(connectionId, "run-stop")).at(-1)).toMatchObject({ critical: false });
    expect((await ended("host:api.example.com", "run-stop")).at(-1)).toMatchObject({
      critical: true,
      criticalKind: "refused_write",
    });
    expect((await ended("mail:server", "run-stop")).at(-1)).toMatchObject({ critical: true });
  });

  it("refuses a write of a stopped run as a critical line, with no account read", async () => {
    calls.length = 0;
    const out = await inTenant(async () =>
      broker.brokerCall({
        who: { kind: "step", id: "sync", for: member },
        where: whereOf("run-stop"),
        connection: await held(connectionId),
        action: { id: "create_contact" },
        input: { email: "a@b.at" },
      }),
    );
    expect(out).toMatchObject({ ok: false, refused: "run_ended" });
    expect(calls).toEqual([]);
    expect((await ended(connectionId, "run-stop")).find((l) => l.whoKind === "step")).toMatchObject({
      kind: "write",
      result: "run_ended",
      critical: true,
      criticalKind: "refused_write",
    });
  });

  it("refuses a finished run's call too, and a failed one's", async () => {
    await runRow("run-done", "done");
    await expectRefused("run-done", "done", "The run is done.");
    await runRow("run-failed", "failed");
    await expectRefused("run-failed", "failed", "The run failed.");
  });

  it("lets a share job of a run that is done through, and of no other run", async () => {
    calls.length = 0;
    const { out, handlers } = await fourPaths("run-done", { share: true });
    expect(out.space.ok && out.own.ok && out.host.ok && out.send.ok && out.secret.ok).toBe(true);
    expect(handlers.send).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    await expectRefused("run-stop", "cancelled", "The run was stopped.", { share: true });
    await expectRefused("run-failed", "failed", "The run failed.", { share: true });
  });

  it("goes on once the run does: a failed run that is tried again calls", async () => {
    await inTenant(() =>
      client.db.update(client.schema.run).set({ status: "running" }).where(eq(client.schema.run.id, "run-failed")),
    );
    expect((await fourPaths("run-failed")).out.space.ok).toBe(true);
  });

  it("tells the model in words", async () => {
    const { connectionRefusalNote } = await import("../src/tools/connections");
    expect(connectionRefusalNote("run_ended", "Kunden")).toMatch(/run has ended/);
    expect(connectionRefusalNote("paused", "Kunden")).toMatch(/Kunden is paused/);
  });
});

describe("a connection that pauses", () => {
  type App = { fetch: (req: Request) => Response | Promise<Response> };
  const url = (path: string) => `http://localhost:5181/api/studio${path}`;
  let id = "";
  let ofPlugin = "";

  /** The studio's routes as a signed-in person of the organization with this role. */
  async function appAs(role: "owner" | "member"): Promise<App> {
    const { connectionRoutes } = await import("../src/routes/connections");
    const { brokerRoutes } = await import("../src/routes/broker");
    const { ServiceError } = await import("../src/services/errors");
    const user = { id: role === "owner" ? "user-a" : "user-m", role, tenantId: TENANT };
    return new Hono<{ Variables: { user: typeof user } }>()
      .onError((err, c) =>
        err instanceof ServiceError ? c.json(err.toJSON(), err.status) : c.json({ error: String(err) }, 500),
      )
      .use("*", async (c, next) => {
        c.set("user", user);
        await client.withTenant(TENANT, () => access.asRole(role, next));
      })
      .route("/api/studio", connectionRoutes as never)
      .route("/api/studio", brokerRoutes as never);
  }
  const post = (app: App, path: string) => app.fetch(new Request(url(path), { method: "POST" }));

  const shop = () => plugins.pluginConnections("shop");

  /** Every caller the broker knows, each with a call that runs while nothing pauses. */
  const callers = () => [
    { name: "a guest's run", who: guest, where: whereOf("run-guest", { guest: true }), action: "list_contacts" },
    { name: "a member's run", who: member, where: whereOf("run-running"), action: "list_contacts" },
    {
      name: "a member's fixed step",
      who: { kind: "step" as const, id: "sync", for: member },
      where: whereOf("run-running"),
      action: "create_contact",
    },
    { name: "an admin's chat", who: admin, where: { chatId: "chat-a", spaceId: space }, action: "create_contact" },
    { name: "Goose", who: goose, where: { spaceId: space }, action: "list_contacts" },
  ];

  const callAll = async (connection: Awaited<ReturnType<typeof held>>) => {
    const answers: Record<string, Awaited<ReturnType<typeof broker.brokerCall>>> = {};
    for (const { name, who, where, action } of callers()) {
      answers[name] = await inTenant(() =>
        broker.brokerCall({ who, where, connection, action: { id: action }, input: {}, ctx: { confirmed: true } }),
      );
    }
    return answers;
  };

  beforeAll(async () => {
    id = await spaceConnection("Bestellungen");
    await runRow("run-guest", "running", "guest");
    ofPlugin = (
      await inTenant(() =>
        shop().connect({
          space,
          connector: "hubspot",
          actions: ["list_contacts", "create_contact"],
          credentials: { access_token: TOKEN },
        }),
      )
    ).id;
  });

  it("is for the admins to pause and resume: a member is refused", async () => {
    const memberApp = await appAs("member");
    expect((await post(memberApp, `/connections/${id}/pause`)).status).toBe(403);
    expect((await post(memberApp, `/connections/${id}/resume`)).status).toBe(403);
    await expect(
      inTenant(() => access.asRole("member", () => service.pauseSpaceConnection("user-m", id, true))),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect((await held(id)).row.pausedAt).toBeNull();
    expect(await logOf(id)).toEqual([]);
  });

  it("runs for every caller while nothing pauses", async () => {
    calls.length = 0;
    const answers = await callAll(await held(id));
    for (const [name, out] of Object.entries(answers)) {
      expect(out.ok, name).toBe(true);
    }
    await inTenant(() => shop().call(ofPlugin, "create_contact", { email: "job@b.at" }));
    expect(calls).toHaveLength(6);
  });

  it("refuses every caller once an admin paused it, a step that started before among them", async () => {
    // What a step's tools and a chat turn hold: the row as it was before the pause.
    const before = await held(id);
    const owner = await appAs("owner");
    const paused = await post(owner, `/connections/${id}/pause`);
    expect(paused.status).toBe(200);
    const view = await paused.json();
    expect(view.pausedAt).toEqual(expect.any(String));
    expect(view.pausedByName).toBe("Anna");
    expect(before.row.pausedAt).toBeNull();

    calls.length = 0;
    for (const connection of [before, await held(id)]) {
      for (const [name, out] of Object.entries(await callAll(connection))) {
        expect(out, name).toMatchObject({ ok: false, refused: "paused" });
        expect(out.ok || out.reason, name).toMatch(/paused/);
      }
    }
    expect(calls).toEqual([]);
    // Each refusal is a line of the log, and none of them rings: the admins paused it themselves.
    const refused = (await logOf(id)).filter((l) => l.result === "paused");
    expect(refused).toHaveLength(10);
    for (const line of refused) {
      expect(line).toMatchObject({ outcome: "deny", rule: "paused", critical: false });
    }
    expect(refused.map((l) => l.whoKind).sort()).toEqual(
      ["admin", "goose", "guest", "person", "step"].flatMap((kind) => [kind, kind]),
    );
  });

  it("refuses a plugin's own job on its paused connection, before `own_job` is asked", async () => {
    await inTenant(() => service.pauseSpaceConnection("user-a", ofPlugin, true));
    calls.length = 0;
    await expect(
      inTenant(() => shop().call(ofPlugin, "create_contact", { email: "job@b.at" })),
    ).rejects.toThrow(/paused/);
    expect(calls).toEqual([]);
    // The pause's own line may share its millisecond: the refusal is found by what it is.
    expect((await logOf(ofPlugin)).filter((l) => l.result === "paused")).toHaveLength(1);
    expect((await logOf(ofPlugin)).find((l) => l.result === "paused")).toMatchObject({
      whoKind: "plugin",
      whoId: "shop",
      runId: null,
      outcome: "deny",
      rule: "paused",
      result: "paused",
    });
    const { row, connector } = await held(ofPlugin);
    expect(
      broker.decide({
        who: { kind: "plugin", id: "shop" },
        where: { spaceId: space },
        connection: { kind: "space_connection", row, connector },
        actionId: "create_contact",
        kind: "write",
      }),
    ).toMatchObject({ outcome: "deny", rule: "paused", refused: "paused" });
  });

  it("answers „Was darf …?“ with the pause, and shows it in the lists", async () => {
    const owner = await appAs("owner");
    const res = await owner.fetch(
      new Request(url(`/spaces/${space}/broker/ask?who=admin&resource=${id}&action=list_contacts&in=chat`)),
    );
    expect(await res.json()).toMatchObject({ outcome: "deny", rule: "paused", refused: "paused" });
    const listed = await owner.fetch(new Request(url(`/spaces/${space}/connections`)));
    const shown = (await listed.json()).connections.find((c: { id: string }) => c.id === id);
    expect(shown.pausedAt).toEqual(expect.any(String));
    expect(shown.pausedByName).toBe("Anna");
    expect(shown).not.toHaveProperty("pausedBy");
  });

  it("resumes as it was: every caller runs again, nothing was lost", async () => {
    const owner = await appAs("owner");
    const resumed = await post(owner, `/connections/${id}/resume`);
    expect(await resumed.json()).toMatchObject({ pausedAt: null, pausedByName: null, audience: "all" });
    await inTenant(() => service.pauseSpaceConnection("user-a", ofPlugin, false));
    calls.length = 0;
    for (const [name, out] of Object.entries(await callAll(await held(id)))) {
      expect(out.ok, name).toBe(true);
    }
    await inTenant(() => shop().call(ofPlugin, "create_contact", { email: "job@b.at" }));
    expect(calls).toHaveLength(6);
    expect(calls.every((c) => c.token.includes(TOKEN))).toBe(true);
  });

  it("logs pausing and resuming as a changed rule, critical, with who did it", async () => {
    const changes = (await logOf(id)).filter((l) => l.actionId === "change_rules");
    expect(changes).toHaveLength(2);
    for (const line of changes) {
      expect(line).toMatchObject({
        whoKind: "admin",
        whoId: "user-a",
        spaceId: space,
        outcome: "allow",
        critical: true,
        criticalKind: "rule_changed",
      });
    }
    expect(changes.map((l) => l.reason)).toEqual([
      "The connection is paused: nobody reaches it.",
      "The connection is resumed.",
    ]);
    // Pausing what pauses changes nothing and writes no line.
    await inTenant(() => service.pauseSpaceConnection("user-a", id, false));
    expect((await logOf(id)).filter((l) => l.actionId === "change_rules")).toHaveLength(2);
  });

  it("is gone for a step that still holds it once the connection was removed", async () => {
    const gone = await spaceConnection("Alt");
    const before = await held(gone);
    await inTenant(() => service.removeSpaceConnection("user-a", gone));
    calls.length = 0;
    const out = await inTenant(() =>
      broker.brokerCall({
        who: member,
        where: whereOf("run-running"),
        connection: before,
        action: { id: "list_contacts" },
        input: {},
      }),
    );
    expect(out).toMatchObject({ ok: false, refused: "not_connected" });
    expect(calls).toEqual([]);
  });
});
