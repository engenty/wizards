import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONNECTION_RULES } from "@engenty/wizards-shared/connectors";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * A connection's limits (docs/plans/capabilities-next.md, 2b): calls per run and calls per day,
 * empty for none, for every caller. A call that would run takes its place by writing its line,
 * so of two calls at once only one gets the last place; the one past a limit is refused under a
 * name of its own, and the admins hear of it once. A guest's mails keep their own numbers. A
 * fixed step whose rule is „Mit Freigabe“ is warned of, not refused. HubSpot is played by a
 * stubbed connector that takes keys.
 */
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-limits-"));
process.env.APP_URL = "http://localhost:5181";

const calls: string[] = [];
/** What the stubbed actions do before they answer: a test holds a call open, or fails it. */
let during: (action: string) => Promise<void> = async () => {};

vi.mock("../src/engenty/connections-hubspot/connector", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/engenty/connections-hubspot/connector")>();
  const action = (id: string, group: "read" | "write" | "send", summary: string) => ({
    id,
    group,
    summary,
    description: summary,
    inputSchema: z.object({ email: z.string().optional(), to: z.string().optional() }),
    handler: async () => {
      calls.push(id);
      await during(id);
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
        action("send_mail", "send", "Send a mail"),
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
let wizards: typeof import("../src/services/wizards");
let space: string;
let wizardId: string;

const TENANT = "tenant-limits";
const inTenant = <T>(fn: () => Promise<T>) => client.withTenant(TENANT, fn);

const admin = { kind: "admin" as const, id: "user-a" };
const member = { kind: "person" as const, id: "user-m" };
const guest = { kind: "guest" as const, id: "visitor-1" };
const goose = { kind: "goose" as const, id: "user-a", admin: true };
const fixedStep = { kind: "step" as const, id: "save", for: member };

/** The wizard: a page that collects the guest's address, an AI step, a fixed step, the result. */
const definitionWith = (connection: string) => ({
  version: 1,
  title: "Leads",
  description: "Leads into HubSpot",
  avatar: "dome",
  connections: [{ id: "crm", spaceConnection: connection, actions: ["list_contacts"] }],
  steps: [
    { id: "start", type: "form", title: "You", fields: [{ id: "email", kind: "email", label: "Mail" }] },
    { id: "read", type: "agent", title: "Read", instructions: "Read.", connections: ["crm"] },
    {
      id: "save",
      type: "tool",
      title: "Save",
      call: { connection: "crm", action: "create_contact", input: { email: "{{email}}" } },
    },
    { id: "done", type: "result", title: "Done", deliverables: [] },
  ],
});

async function runRow(id: string, who: "member" | "guest" = "member", connection = "none") {
  await inTenant(() =>
    client.db.insert(client.schema.run).values({
      id,
      wizardId,
      tenantId: TENANT,
      definition: definitionWith(connection) as never,
      files: [],
      grant: null,
      version: null,
      mode: "live",
      ...(who === "member" ? { userId: "user-m" } : { visitorId: "visitor-1" }),
      status: "running",
      cursor: "read",
      state: { values: { email: "kundin@example.com" }, outputs: {}, history: [], notes: {} },
    }),
  );
}

const inRun = (runId: string, extra: { guest?: boolean; stepId?: string } = {}) => ({
  runId,
  stepId: "read",
  wizardId,
  spaceId: space,
  mode: "live" as const,
  guest: false,
  ...extra,
});

async function logOf(connectionId: string) {
  return inTenant(() =>
    client.db.query.brokerLog.findMany({
      where: (t, { eq }) => eq(t.connectionId, connectionId),
      orderBy: (t, { asc }) => [asc(t.at), asc(t.id)],
    }),
  );
}

/** The lines a limit refused; lines of one millisecond come in no order, so by what they are. */
const refusedBy = async (connectionId: string, result: "calls_per_run" | "calls_per_day") =>
  (await logOf(connectionId)).filter((l) => l.result === result);

/** A connection of the space that signs in as the space, open to everyone, every rule „Erlaubt“. */
async function spaceConnection(name: string, rules: Record<string, string> = {}) {
  const row = await inTenant(() =>
    service.createSpaceConnection("user-a", space, {
      connectorId: "hubspot",
      name,
      signIn: "space",
      audience: "all",
      rules: { read: "allow", write: "allow", destructive: "deny", send: "allow", ...rules } as never,
      actions: [],
    }),
  );
  await inTenant(() =>
    service.signInWithCredentials(row.id, { as: "space" }, { access_token: "pat-secret-5" }),
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

type Limits = { callsPerRun?: number | null; callsPerDay?: number | null };
const setLimits = (id: string, limits: Limits) =>
  inTenant(() => service.updateSpaceConnection("user-a", id, limits));

type Held = Awaited<ReturnType<typeof held>>;
type Caller = { who: Parameters<typeof broker.brokerCall>[0]["who"]; where: object; action?: string };

const call = (connection: Held, { who, where, action = "list_contacts" }: Caller, input: object = {}) =>
  inTenant(() =>
    broker.brokerCall({ who, where, connection, action: { id: action }, input, ctx: { confirmed: true } }),
  );

/** Every kind of caller the broker knows, but a plugin's own job (it has a connection of its own). */
const callers = (): Record<string, Caller> => ({
  "an admin's chat": { who: admin, where: { chatId: "chat-a", spaceId: space }, action: "create_contact" },
  "a member's chat": { who: member, where: { chatId: "chat-m", spaceId: space } },
  Goose: { who: goose, where: { spaceId: space } },
  "a guest's run": { who: guest, where: inRun("run-guest", { guest: true }) },
  "an AI step": { who: member, where: inRun("run-m") },
  "a fixed step": { who: fixedStep, where: inRun("run-m", { stepId: "save" }), action: "create_contact" },
});

type App = Hono<{ Variables: { user: { id: string; role: string; tenantId: string } } }>;

/** The studio's routes as a signed-in person of the organization with this role. */
async function appAs(role: "owner" | "member"): Promise<App> {
  const { connectionRoutes } = await import("../src/routes/connections");
  const { ServiceError } = await import("../src/services/errors");
  const user = { id: role === "owner" ? "user-a" : "user-m", role, tenantId: TENANT };
  return new Hono<{ Variables: { user: typeof user } }>()
    .onError((err, c) =>
      err instanceof ServiceError
        ? c.json(err.toJSON(), err.status)
        : c.json({ error: String(err) }, err instanceof z.ZodError ? 400 : 500),
    )
    .use("*", async (c, next) => {
      c.set("user", user);
      await client.withTenant(TENANT, () => access.asRole(role, next));
    })
    .route("/api/studio", connectionRoutes as never);
}

const patch = (app: App, id: string, body: object) =>
  app.fetch(
    new Request(`http://localhost/api/studio/connections/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const viewOf = async (app: App, id: string) => {
  const listed = await app.fetch(new Request(`http://localhost/api/studio/spaces/${space}/connections`));
  return (await listed.json()).connections.find((c: { id: string }) => c.id === id);
};

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb(TENANT);
  broker = await import("../src/broker/index");
  service = await import("../src/connectors/space-connections");
  plugins = await import("../src/connectors/plugin-connections");
  access = await import("../src/services/access");
  wizards = await import("../src/services/wizards");
  const spaces = await import("../src/services/spaces");
  space = (await inTenant(() => spaces.createSpace("user-a", "Vertrieb"))).id;
  wizardId = (
    await inTenant(() =>
      wizards.createWizard("user-a", { definition: definitionWith("none"), spaceId: space }),
    )
  ).id;
  await runRow("run-m");
  await runRow("run-guest", "guest");
}, 60_000);

describe("a connection's limits", () => {
  it("starts with none: empty, and every caller's calls run as before", async () => {
    const id = await spaceConnection("Ohne Grenzen");
    expect((await held(id)).row).toMatchObject({ callsPerRun: null, callsPerDay: null });
    const connection = await held(id);
    for (let round = 0; round < 3; round++) {
      for (const [name, caller] of Object.entries(callers())) {
        expect((await call(connection, caller)).ok, name).toBe(true);
      }
    }
    // One line per call, written once, at its end.
    const lines = await logOf(id);
    expect(lines).toHaveLength(18);
    expect(lines.every((l) => l.result === "ok")).toBe(true);
    // The callers hold the row as it was before any call: still only the first call is a first use.
    expect(lines.filter((l) => l.criticalKind === "first_use")).toHaveLength(1);
    expect(await viewOf(await appAs("owner"), id)).toMatchObject({
      callsPerRun: null,
      callsPerDay: null,
      callsToday: 18,
    });
  });

  it("is the admins' to set, with whole numbers from 1 or empty, and the change is a critical line", async () => {
    const id = await spaceConnection("Grenzen setzen");
    const memberApp = await appAs("member");
    expect((await patch(memberApp, id, { callsPerRun: 5 })).status).toBe(403);
    const owner = await appAs("owner");
    for (const wrong of [0, -1, 1.5, "5", 1_000_001]) {
      expect((await patch(owner, id, { callsPerDay: wrong })).status, String(wrong)).toBe(400);
    }
    expect(await logOf(id)).toEqual([]);

    const set = await patch(owner, id, { callsPerRun: 5 });
    expect(await set.json()).toMatchObject({ callsPerRun: 5, callsPerDay: null, callsToday: 0 });
    await patch(owner, id, { callsPerDay: 200 });
    // The same number again changes nothing and says nothing.
    await patch(owner, id, { callsPerDay: 200 });
    await patch(owner, id, { callsPerRun: null });
    const lines = await logOf(id);
    expect(lines.map((l) => l.reason)).toEqual([
      "The limits changed: calls per run: none → 5.",
      "The limits changed: calls per day: none → 200.",
      "The limits changed: calls per run: 5 → none.",
    ]);
    for (const line of lines) {
      expect(line).toMatchObject({
        whoKind: "admin",
        whoId: "user-a",
        actionId: "change_rules",
        outcome: "allow",
        critical: true,
        criticalKind: "rule_changed",
      });
      expect(JSON.parse(line.inputSummary).fields).toHaveProperty("limits");
    }
    // A changed limit is no call: it takes no place under the limit it set.
    expect(await viewOf(owner, id)).toMatchObject({ callsPerRun: null, callsPerDay: 200, callsToday: 0 });
  });

  it("refuses a run's call past its calls per run, whoever calls, and each run counts for itself", async () => {
    const id = await spaceConnection("Je Lauf");
    await setLimits(id, { callsPerRun: 3 });
    await runRow("run-other");
    const connection = await held(id);
    const inThisRun = callers();
    calls.length = 0;
    // An AI step, a fixed step and an AI step again: three calls of one run.
    for (const name of ["an AI step", "a fixed step", "an AI step"]) {
      expect((await call(connection, inThisRun[name])).ok, name).toBe(true);
    }
    const fourth = await call(connection, inThisRun["a fixed step"]);
    expect(fourth).toEqual({
      ok: false,
      refused: "calls_per_run",
      reason: "The connection takes 3 calls from one run, and this run has made them.",
    });
    expect((await call(connection, inThisRun["an AI step"])).ok).toBe(false);
    expect(calls).toHaveLength(3);

    // The first refusal is heard of; the one after it is a line, and rings nothing.
    const refused = await refusedBy(id, "calls_per_run");
    expect(refused).toHaveLength(2);
    expect(refused.map((l) => l.critical).sort()).toEqual([false, true]);
    expect(refused.find((l) => l.critical)).toMatchObject({
      whoKind: "step",
      runId: "run-m",
      outcome: "deny",
      rule: "limits.run",
      criticalKind: "limit_reached",
    });

    // Another run has its own three; a chat, Goose and a guest's other run are no part of this one.
    for (let i = 0; i < 3; i++) {
      expect((await call(connection, { who: member, where: inRun("run-other") })).ok).toBe(true);
    }
    expect(await call(connection, { who: member, where: inRun("run-other") })).toMatchObject({
      refused: "calls_per_run",
    });
    for (const name of ["an admin's chat", "a member's chat", "Goose", "a guest's run"]) {
      expect((await call(connection, inThisRun[name])).ok, name).toBe(true);
    }
    expect((await refusedBy(id, "calls_per_run")).filter((l) => l.critical)).toHaveLength(2);
  });

  it("counts every kind of caller for the day, a call with no run among them", async () => {
    const id = await spaceConnection("Je Tag");
    await setLimits(id, { callsPerDay: 6 });
    const connection = await held(id);
    calls.length = 0;
    for (const [name, caller] of Object.entries(callers())) {
      expect((await call(connection, caller)).ok, name).toBe(true);
    }
    expect((await viewOf(await appAs("owner"), id)).callsToday).toBe(6);
    // Today's six are made: nobody gets a seventh, with a run or without.
    for (const [name, caller] of Object.entries(callers())) {
      expect(await call(connection, caller), name).toEqual({
        ok: false,
        refused: "calls_per_day",
        reason: "The connection takes 6 calls a day, and today's are made.",
      });
    }
    expect(calls).toHaveLength(6);
    const refused = await refusedBy(id, "calls_per_day");
    expect(refused.map((l) => l.whoKind).sort()).toEqual(
      ["admin", "goose", "guest", "person", "person", "step"],
    );
    expect(refused.every((l) => l.rule === "limits.day" && l.outcome === "deny")).toBe(true);
    expect(refused.filter((l) => l.critical)).toHaveLength(1);

    // Yesterday's calls are yesterday's: the day starts again at midnight (UTC).
    await inTenant(() =>
      client.db
        .update(client.schema.brokerLog)
        .set({ at: new Date(Date.now() - 24 * 3600_000) })
        .where(eq(client.schema.brokerLog.connectionId, id)),
    );
    expect((await call(connection, callers().Goose)).ok).toBe(true);
    // A higher limit, or none, is asked at the call: the row a step read at its start is not.
    await setLimits(id, { callsPerDay: 1 });
    expect(await call(connection, callers().Goose)).toMatchObject({ refused: "calls_per_day" });
    await setLimits(id, { callsPerDay: null });
    expect((await call(connection, callers().Goose)).ok).toBe(true);
  });

  it("counts a plugin's own job on its connection", async () => {
    const shop = plugins.pluginConnections("shop");
    const ofPlugin = (
      await inTenant(() =>
        shop.connect({
          space,
          connector: "hubspot",
          actions: ["list_contacts", "create_contact"],
          credentials: { access_token: "pat-secret-5" },
        }),
      )
    ).id;
    await setLimits(ofPlugin, { callsPerDay: 2, callsPerRun: 1 });
    calls.length = 0;
    // No run: the calls per run say nothing of a job.
    await inTenant(() => shop.call(ofPlugin, "create_contact", { email: "a@b.at" }));
    await inTenant(() => shop.call(ofPlugin, "list_contacts", {}));
    await expect(inTenant(() => shop.call(ofPlugin, "list_contacts", {}))).rejects.toThrow(
      /takes 2 calls a day/,
    );
    expect(calls).toHaveLength(2);
    expect((await refusedBy(ofPlugin, "calls_per_day"))[0]).toMatchObject({
      whoKind: "plugin",
      whoId: "shop",
      runId: null,
      critical: true,
      criticalKind: "limit_reached",
    });
  });

  it("gives a place only to a call that reaches the service: a failed one took it, a refused or held one did not", async () => {
    const id = await spaceConnection("Nur was läuft", { write: "ask", send: "deny" });
    await setLimits(id, { callsPerDay: 3 });
    const connection = await held(id);
    const chat = { who: member, where: { chatId: "chat-m", spaceId: space } };
    // „Nie“, „Mit Freigabe“ (held for the admins) and an action the connector has not: no place.
    expect(await call(connection, { ...chat, action: "send_mail" })).toMatchObject({ refused: "denied" });
    expect(
      await inTenant(() =>
        broker.brokerCall({ ...chat, connection, action: { id: "create_contact" }, input: {} }),
      ),
    ).toMatchObject({ refused: "needs_approval" });
    expect(await call(connection, { ...chat, action: "no_such_action" })).toMatchObject({
      refused: "no_action",
    });
    expect((await viewOf(await appAs("owner"), id)).callsToday).toBe(0);

    // The service failed: the call reached it, so its place is taken, and its line says how it ended.
    during = async () => {
      throw new TypeError("HubSpot is down");
    };
    await expect(call(connection, chat)).rejects.toThrow("HubSpot is down");
    during = async () => {};
    expect((await logOf(id)).at(-1)).toMatchObject({ outcome: "allow", result: "TypeError" });
    expect((await call(connection, chat)).ok).toBe(true);
    // An admin approved the held call: it runs now, and takes the last place.
    expect(
      (
        await inTenant(() =>
          broker.brokerCall({
            ...chat,
            connection,
            action: { id: "create_contact" },
            input: {},
            ctx: { approved: true },
          }),
        )
      ).ok,
    ).toBe(true);
    expect(await call(connection, chat)).toMatchObject({ refused: "calls_per_day" });
    expect((await viewOf(await appAs("owner"), id)).callsToday).toBe(3);
  });

  it("lets one of two calls at once take the last place", async () => {
    const id = await spaceConnection("Zugleich");
    await setLimits(id, { callsPerDay: 3, callsPerRun: 3 });
    const connection = await held(id);
    const caller = { who: member, where: inRun("run-m") };
    expect((await call(connection, caller)).ok).toBe(true);
    expect((await call(connection, caller)).ok).toBe(true);

    // Five calls race for the one place left, and the one that gets it is held open meanwhile.
    calls.length = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let seen: Awaited<ReturnType<typeof logOf>> = [];
    during = async () => {
      // The call under way has its line already: that is how it holds the place.
      seen = await logOf(id);
      await gate;
    };
    const racing = Array.from({ length: 5 }, () => call(connection, caller));
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    release();
    const answers = await Promise.all(racing);
    during = async () => {};

    expect(answers.filter((a) => a.ok)).toHaveLength(1);
    expect(answers.filter((a) => !a.ok && a.refused === "calls_per_run")).toHaveLength(4);
    expect(calls).toHaveLength(1);
    expect(seen.filter((l) => l.result === null)).toHaveLength(1);
    // Its end filled the line in: nothing stays open, and the three calls are three lines.
    const lines = (await logOf(id)).filter((l) => l.actionId !== "change_rules");
    expect(lines.filter((l) => l.result === "ok")).toHaveLength(3);
    expect(lines.filter((l) => l.result === null)).toHaveLength(0);
    expect(lines.filter((l) => l.result === "calls_per_run")).toHaveLength(4);
    expect(lines.filter((l) => l.critical && l.criticalKind === "limit_reached").length).toBeGreaterThan(0);
  });

  it("hears of a connection's first use on the line that took its place", async () => {
    const id = await spaceConnection("Erste Nutzung");
    await setLimits(id, { callsPerDay: 10 });
    const heard: string[] = [];
    const stop = broker.onCritical((row) => heard.push(`${row.criticalKind}:${row.result}`));
    const connection = await held(id);
    expect((await call(connection, callers().Goose)).ok).toBe(true);
    expect((await call(connection, callers().Goose)).ok).toBe(true);
    stop();
    expect(heard).toEqual(["first_use:ok"]);
    expect((await logOf(id)).filter((l) => l.criticalKind === "first_use")).toHaveLength(1);
  });

  it("keeps a guest's mails at their own numbers, beside the connection's", async () => {
    const id = await spaceConnection("Post");
    const connection = await held(id);
    const mail = (runId: string) =>
      call(
        connection,
        // A guest's run sends as the space from its fixed step only.
        {
          who: { kind: "step", id: "save", for: guest },
          where: inRun(runId, { guest: true, stepId: "save" }),
          action: "send_mail",
        },
        { to: "kundin@example.com" },
      );
    // No limit on the connection: three mails per run, as before, and the fourth is the run's.
    await runRow("run-g1", "guest");
    for (let i = 0; i < 3; i++) {
      expect((await mail("run-g1")).ok).toBe(true);
    }
    expect(await mail("run-g1")).toMatchObject({ ok: false, refused: "run_limit" });
    // The wizard's mails per day, as before.
    await inTenant(() =>
      client.db
        .update(client.schema.wizard)
        .set({ dailyMailLimit: 3 })
        .where(eq(client.schema.wizard.id, wizardId)),
    );
    await runRow("run-g2", "guest");
    expect(await mail("run-g2")).toMatchObject({ ok: false, refused: "day_limit" });
    await inTenant(() =>
      client.db
        .update(client.schema.wizard)
        .set({ dailyMailLimit: 50 })
        .where(eq(client.schema.wizard.id, wizardId)),
    );
    // A wide limit on the connection changes none of it; a narrow one comes on top, under its own name.
    await setLimits(id, { callsPerRun: 100, callsPerDay: 100 });
    expect((await mail("run-g2")).ok).toBe(true);
    expect((await mail("run-g2")).ok).toBe(true);
    expect((await mail("run-g2")).ok).toBe(true);
    expect(await mail("run-g2")).toMatchObject({ ok: false, refused: "run_limit" });
    await setLimits(id, { callsPerRun: 1 });
    await runRow("run-g3", "guest");
    expect((await mail("run-g3")).ok).toBe(true);
    expect(await mail("run-g3")).toMatchObject({ ok: false, refused: "calls_per_run" });
    for (const line of [...(await refusedBy(id, "calls_per_run")), ...(await logOf(id)).filter((l) => l.result === "run_limit")]) {
      expect(line).toMatchObject({ outcome: "deny", critical: true, criticalKind: "limit_reached" });
    }
  });

  it("decides what is critical in one place: a limit rings once", () => {
    const of = (result: string, limitHeard = false) =>
      broker.criticalOf(
        { whoKind: "person", kind: "read", outcome: "deny", result, connectionId: "c", actionId: "a", rule: "limits.day" },
        { limitHeard },
      );
    expect(of("calls_per_run")).toBe("limit_reached");
    expect(of("calls_per_day")).toBe("limit_reached");
    expect(of("calls_per_run", true)).toBeNull();
    expect(of("calls_per_day", true)).toBeNull();
    // A guest's mails ring each time, as they did.
    expect(of("run_limit", true)).toBe("limit_reached");
  });
});

describe("what a caller reads of a limit", () => {
  let id = "";
  let def: ReturnType<typeof definitionWith>;

  function contextOf(runId: string, stepId: string) {
    const state = { values: { email: "lead@b.at" }, outputs: {}, history: [], notes: {} };
    return {
      runId,
      tenantId: TENANT,
      holder: { kind: "person", id: "user-m", role: "member" },
      test: false,
      stepId,
      store: { wizardId, holder: "u:user-m" },
      def,
      lang: null,
      files: [],
      state,
      scope: { def, state, brand: {} },
      space: { id: space },
      spaceFiles: [],
      signal: new AbortController().signal,
      resources: { allowed: new Set<string>() },
      emit: async () => {},
      ask: async () => null,
      call: {},
    } as unknown as import("../src/engine/types").StepContext;
  }

  beforeAll(async () => {
    id = await spaceConnection("Kunden");
    def = definitionWith(id);
    await runRow("run-words", "member", id);
    await runRow("run-words-2", "member", id);
  });

  it("tells a model in its tool's answer, and fails a fixed step with a note of its own", async () => {
    const { toolsOf } = await import("../src/tools/connector");
    const steps = await import("../src/engine/steps");
    const tools = await inTenant(() =>
      toolsOf(def.connections[0] as never, contextOf("run-words", "read"), {} as never),
    );
    const list = tools.hubspot_list_contacts as unknown as {
      execute: (input: object) => Promise<{ result?: string; error?: string }>;
    };
    await setLimits(id, { callsPerRun: 1, callsPerDay: 2 });
    expect((await inTenant(() => list.execute({}))).result).toContain("list_contacts");
    const refused = await inTenant(() => list.execute({}));
    expect(refused.error).toMatch(/HubSpot takes only so many calls from one run/);
    expect(refused.error).not.toMatch(/mail|message/i);

    const save = () =>
      inTenant(() => steps.runAutomaticStep(def.steps[2] as never, contextOf("run-words", "save")));
    await expect(save()).rejects.toMatchObject({
      note: { code: "stepCallsPerRun", params: { service: "HubSpot" } },
    });
    // Another run takes the day's last place; after it the day's limit speaks, to a step and a model.
    const other = () =>
      inTenant(() => steps.runAutomaticStep(def.steps[2] as never, contextOf("run-words-2", "save")));
    expect((await other()).json).toMatchObject({ done: "create_contact" });
    await setLimits(id, { callsPerRun: null });
    await expect(other()).rejects.toMatchObject({
      note: { code: "stepCallsPerDay", params: { service: "HubSpot" } },
    });
    expect((await inTenant(() => list.execute({}))).error).toMatch(/HubSpot takes only so many calls a day/);
    const { connectionRefusalNote } = await import("../src/tools/connections");
    expect(connectionRefusalNote("calls_per_day", "Kunden (HubSpot)")).toMatch(/calls a day/);
    expect(connectionRefusalNote("calls_per_run", "Kunden (HubSpot)")).toMatch(/from one run/);
  });
});

describe("the editor's warning for a fixed step", () => {
  const warningsOf = (connection: string, edit: (def: ReturnType<typeof definitionWith>) => void = () => {}) => {
    const def = definitionWith(connection);
    edit(def);
    return inTenant(() => wizards.stepWarnings(space, def as never));
  };

  it("warns where the rule is „Mit Freigabe“, and reads the rule as it is now", async () => {
    // A new connection starts with Ändern and Senden on „Mit Freigabe“.
    const row = await inTenant(() =>
      service.createSpaceConnection("user-a", space, {
        connectorId: "hubspot",
        name: "CRM",
        signIn: "space",
        rules: DEFAULT_CONNECTION_RULES,
        actions: [],
      }),
    );
    expect(await warningsOf(row.id)).toEqual([
      {
        stepId: "save",
        kind: "needs_approval",
        connection: { id: row.id, name: "CRM" },
        action: { id: "create_contact", kind: "write" },
      },
    ]);
    // A read never waits; a send does.
    expect(
      await warningsOf(row.id, (def) => {
        def.steps[2].call = { connection: "crm", action: "list_contacts", input: {} } as never;
      }),
    ).toEqual([]);
    expect(
      await warningsOf(row.id, (def) => {
        def.steps[2].call = { connection: "crm", action: "send_mail", input: {} } as never;
      }),
    ).toMatchObject([{ stepId: "save", action: { id: "send_mail", kind: "send" } }]);

    await inTenant(() =>
      service.updateSpaceConnection("user-a", row.id, {
        rules: { read: "allow", write: "allow", destructive: "deny", send: "ask" },
      }),
    );
    expect(await warningsOf(row.id)).toEqual([]);
    // „Nie“ is another matter, and so is a pause: the step is refused there, not held.
    await inTenant(() =>
      service.updateSpaceConnection("user-a", row.id, {
        rules: { read: "allow", write: "deny", destructive: "deny", send: "ask" },
      }),
    );
    expect(await warningsOf(row.id)).toEqual([]);
  });

  it("never warns for a wizard's own connection, and is no issue: the draft saves and publishes", async () => {
    expect(
      await warningsOf("none", (def) => {
        def.connections = [{ id: "crm", connector: "hubspot" } as never];
      }),
    ).toEqual([]);

    const row = await inTenant(() =>
      service.createSpaceConnection("user-a", space, {
        connectorId: "hubspot",
        name: "Bestellungen",
        signIn: "space",
        rules: DEFAULT_CONNECTION_RULES,
        actions: [],
      }),
    );
    const made = await inTenant(() =>
      wizards.createWizard("user-a", { definition: definitionWith(row.id), spaceId: space }),
    );
    const written = await inTenant(() =>
      wizards.writeDraft("user-a", made.id, { definition: definitionWith(row.id), baseRevision: 0 }),
    );
    expect(written.issues).toEqual([]);
    expect(written.warnings).toMatchObject([{ stepId: "save", connection: { name: "Bestellungen" } }]);
    const state = await inTenant(async () =>
      wizards.wizardState(await wizards.ownedWizard("user-a", made.id)),
    );
    expect(state.issues).toEqual([]);
    expect(state.warnings).toHaveLength(1);
    await expect(inTenant(() => wizards.publishWizard("user-a", made.id))).resolves.toBeTruthy();
  });
});
