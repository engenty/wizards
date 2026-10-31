import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * The broker is heard (docs/plans/capabilities.md, A7a; docs/plans/broker.md, phase 2): the
 * critical kinds, decided in one place; a space's critical lines under its admins' bell and in
 * the report to the Manage-App; the hourly mail to the admins where none of them was in the
 * app; „Was darf …?“ and the log for the Protokoll page. HubSpot is played by a stub.
 */
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-broker-heard-"));
process.env.APP_URL = "http://localhost:5181";

const calls: { action: string; input: unknown }[] = [];

vi.mock("../src/engenty/connections-hubspot/connector", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/engenty/connections-hubspot/connector")>();
  const action = (id: string, group: "read" | "write" | "destructive", summary: string) => ({
    id,
    group,
    summary,
    description: summary,
    inputSchema: z.object({ email: z.string().optional(), to: z.string().optional() }),
    handler: async (input: unknown) => {
      calls.push({ action: id, input });
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
        action("send_mail", "write", "Send a mail"),
      ],
    },
  };
});

// The organization: the Manage-App says who is who, and takes the report.
const reported: { tenantId: string; body: any }[] = [];
vi.mock("../src/manage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/manage.js")>()),
  managed: true,
  tenantInfo: async () => ({ limits: { build: true } }),
  tenantMembers: async () => ({
    members: [
      { userId: "user-a", role: "owner", email: "a@firma.at", name: "A" },
      { userId: "user-b", role: "admin", email: "b@firma.at", name: "B" },
      { userId: "user-m", role: "member", email: "m@firma.at", name: "M" },
    ],
    invitations: [],
    seats: { limit: null, taken: 3 },
  }),
  postBrokerReport: async (tenantId: string, body: unknown) => {
    reported.push({ tenantId, body });
    return { ok: true };
  },
}));

// The server's own address sends the hourly mail; what it sends is kept here.
const mailed: { to: string[]; subject: string; text: string }[] = [];
vi.mock("../src/connectors/smtp.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/connectors/smtp.js")>()),
  serverSender: () => "wizards@server.test",
  sendFromServer: async (message: { to: string[]; subject: string; text: string }) => {
    mailed.push(message);
  },
}));

let client: typeof import("../src/db/client");
let broker: typeof import("../src/broker/index");
let service: typeof import("../src/connectors/space-connections");
let bell: typeof import("../src/services/broker-bell");
let notify: typeof import("../src/services/broker-notify");
let seen: typeof import("../src/services/seen");
let approvals: typeof import("../src/services/work-approvals");
let reports: typeof import("../src/services/manage-reports");
let access: typeof import("../src/services/access");
let space: string;
let connection: string;

const TENANT = "tenant-h";
const inTenant = <T>(fn: () => Promise<T>) => client.withTenant(TENANT, fn);
const owner = { id: "user-a", role: "owner" as const, tenantId: TENANT, name: "A", email: "a@firma.at" };
const member = { id: "user-m", role: "member" as const, tenantId: TENANT, name: "M", email: "m@firma.at" };
const guestRun = { runId: "run-g", spaceId: "", mode: "live" as const, guest: true };
const RULES = { read: "allow", write: "ask", destructive: "deny", send: "deny" } as const;

const call = (
  who: Parameters<typeof broker.brokerCall>[0]["who"],
  where: Parameters<typeof broker.brokerCall>[0]["where"],
  action: { id: string; kind?: "read" | "write" | "destructive" | "send" },
  ctx?: Parameters<typeof broker.brokerCall>[0]["ctx"],
) =>
  inTenant(async () => {
    const row = await service.spaceConnectionById(connection);
    const connector = await service.connectorOfRow(row);
    return broker.brokerCall({
      who,
      where,
      connection: { kind: "space_connection", row, connector },
      action,
      input: { to: "x@y.at" },
      ctx,
    });
  });

async function logOf(connectionId: string) {
  return inTenant(() =>
    client.db.query.brokerLog.findMany({
      where: (t, { eq }) => eq(t.connectionId, connectionId),
      orderBy: (t, { asc }) => [asc(t.at)],
    }),
  );
}

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb(TENANT);
  broker = await import("../src/broker/index");
  service = await import("../src/connectors/space-connections");
  bell = await import("../src/services/broker-bell");
  notify = await import("../src/services/broker-notify");
  seen = await import("../src/services/seen");
  approvals = await import("../src/services/work-approvals");
  reports = await import("../src/services/manage-reports");
  access = await import("../src/services/access");
  reports.startCriticalReports();
  const spaces = await import("../src/services/spaces");
  space = (await inTenant(() => spaces.createSpace("user-a", "Vertrieb"))).id;
  guestRun.spaceId = space;
  const row = await inTenant(() =>
    service.createSpaceConnection("user-a", space, {
      connectorId: "hubspot",
      name: "Vertrieb",
      signIn: "space",
      audience: "all",
      rules: RULES,
      actions: [],
    }),
  );
  connection = row.id;
  await inTenant(() =>
    service.signInWithCredentials(connection, { as: "space" }, { access_token: "pat-1" }),
  );
}, 60_000);

describe("the critical kinds, decided in one place", () => {
  const base = { whoKind: "person", kind: "write", outcome: "deny", result: "denied", connectionId: "c1", actionId: "create", rule: "rules.write" };
  const of = (row: Partial<typeof base>, context?: { firstUse?: boolean }) =>
    broker.criticalOf({ ...base, ...row }, context);

  it("a refused write, delete or send", () => {
    expect(of({})).toBe("refused_write");
    expect(of({ kind: "destructive", rule: "rules.destructive" })).toBe("refused_write");
    expect(of({ kind: "send", result: "not_in_grant", rule: "grant" })).toBe("refused_write");
    expect(of({ kind: "write", result: "ai_step_writes", rule: "ai_step_writes" })).toBe("refused_write");
  });
  it("a guest reaching a connection outside its audience, but not a member's refused read", () => {
    expect(of({ whoKind: "guest", kind: "read", rule: "audience" })).toBe("outside_audience");
    expect(of({ whoKind: "guest", kind: "write", rule: "audience" })).toBe("outside_audience");
    expect(of({ whoKind: "person", kind: "read", rule: "audience" })).toBeNull();
    expect(of({ kind: "read", result: "not_connected", rule: null })).toBeNull();
  });
  it("a host not in the grant", () => {
    expect(of({ connectionId: "host:api.example.com", actionId: "http_request", kind: "send", result: "not_in_grant", rule: "grant" })).toBe("host_not_in_grant");
  });
  it("a limit reached", () => {
    expect(of({ kind: "send", result: "run_limit", rule: "guest_send" })).toBe("limit_reached");
    expect(of({ kind: "send", result: "day_limit", rule: "guest_send" })).toBe("limit_reached");
  });
  it("a sign-in that ran out or was refused", () => {
    expect(of({ outcome: "deny", result: "sign_in_failed", kind: "read" })).toBe("sign_in_failed");
    expect(of({ outcome: "allow", result: "sign_in_failed", kind: "read" })).toBe("sign_in_failed");
    expect(broker.signInRefused(new Error("Gmail (401): who are you"))).toBe(true);
    expect(broker.signInRefused(new Error("invalid_grant"))).toBe(true);
    expect(broker.signInRefused(new Error("HubSpot (500): down"))).toBe(false);
  });
  it("the first use of a new connection", () => {
    expect(of({ outcome: "allow", result: "ok", kind: "read" }, { firstUse: true })).toBe("first_use");
    expect(of({ outcome: "allow", result: "ok", kind: "read" }, { firstUse: false })).toBeNull();
    expect(of({ outcome: "allow", result: "ok", kind: "write" })).toBeNull();
  });
  it("a rule changed", () => {
    expect(of({ actionId: broker.RULE_CHANGE_ACTION, outcome: "allow", result: "ok", connectionId: "rwx" })).toBe("rule_changed");
  });
});

describe("heard: the bell and the report", () => {
  it("logs the first use as critical, and nothing of a later allowed read", async () => {
    const first = await call({ kind: "person", id: "user-m" }, { chatId: "chat-1", spaceId: space }, { id: "list_contacts" });
    expect(first.ok).toBe(true);
    expect((await logOf(connection)).at(-1)).toMatchObject({ outcome: "allow", result: "ok", rule: "rules.read", critical: true, criticalKind: "first_use" });
    const again = await call({ kind: "person", id: "user-m" }, { chatId: "chat-1", spaceId: space }, { id: "list_contacts" });
    expect(again.ok).toBe(true);
    expect((await logOf(connection)).at(-1)).toMatchObject({ critical: false, criticalKind: null });
  });

  it("puts a guest's refused send under an admin's bell, not a member's, and into the report at once", async () => {
    reported.length = 0;
    // An AI step of a guest's run: the space's sign-in never sends for it (A4), before any rule.
    const refused = await call({ kind: "guest", id: "visitor-1" }, guestRun, { id: "send_mail", kind: "send" });
    expect(refused).toMatchObject({ ok: false, refused: "ai_step_writes" });
    expect((await logOf(connection)).at(-1)).toMatchObject({ outcome: "deny", rule: "ai_step_writes", critical: true, criticalKind: "refused_write" });

    const admins = await inTenant(() => bell.criticalsFor(owner));
    expect(admins.critical[0]).toMatchObject({ kind: "refused_write", who: { kind: "guest", id: "visitor-1" }, connectionId: connection, actionId: "send_mail", runId: "run-g", spaceId: space });
    expect(admins.unseen).toBeGreaterThan(0);
    expect(await inTenant(() => bell.criticalsFor(member))).toEqual({ critical: [], unseen: 0 });

    // Opened: the lines stay, the count is gone.
    await inTenant(() => bell.bellOpened(owner));
    const opened = await inTenant(() => bell.criticalsFor(owner));
    expect(opened.critical.length).toBe(admins.critical.length);
    expect(opened.unseen).toBe(0);

    expect(reported).toEqual([
      { tenantId: TENANT, body: { batch: "at_once", lines: [expect.objectContaining({ kind: "refused_write", who: { kind: "guest", id: "visitor-1" }, connection, action: "send_mail", outcome: "deny", rule: "ai_step_writes" })] } },
    ]);
  });

  it("keeps a member's critical line for the daily report, and a rule change is one", async () => {
    reported.length = 0;
    await inTenant(() =>
      access.asRole("owner", () =>
        service.updateSpaceConnection("user-a", connection, { rules: { ...RULES, write: "allow" }, audience: "members" }),
      ),
    );
    const row = (await logOf(connection)).at(-1);
    expect(row).toMatchObject({ whoKind: "admin", whoId: "user-a", actionId: broker.RULE_CHANGE_ACTION, critical: true, criticalKind: "rule_changed" });
    expect(row?.reason).toMatch(/audience is now members/);
    expect(row?.reason).toMatch(/write: ask → allow/);
    expect(reported).toEqual([]);
    await reports.reportCriticalDaily();
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ tenantId: TENANT, body: { batch: "daily" } });
    expect(reported[0].body.lines.map((l: any) => l.kind)).toEqual(["first_use", "rule_changed"]);
    expect(reported[0].body.lines.some((l: any) => l.who.kind === "guest")).toBe(false);
    // A patch that changes neither logs nothing.
    await inTenant(() => access.asRole("owner", () => service.updateSpaceConnection("user-a", connection, { name: "Sales" })));
    expect((await logOf(connection)).at(-1)?.id).toBe(row?.id);
  });

  it("shows an admin a call held in a private chat they are not in; a member sees only their own", async () => {
    await inTenant(async () => {
      await client.db.insert(client.schema.chat).values({ id: "chat-p", tenantId: TENANT, spaceId: space, title: "Private", private: true, createdBy: "user-m" } as never);
      await approvals.holdCall({ chatId: "chat-p", userId: "user-m" }, `hubspot_${connection}_create_contact`, {}, "admins");
      await approvals.holdCall({ chatId: "chat-p", userId: "user-m" }, "mailer_send", {}, "asker");
    });
    const forOwner = await inTenant(() => approvals.waitingFor(owner, []));
    expect(forOwner.map((a) => a.heldFor).sort()).toEqual(["admins", "asker"]);
    expect(await inTenant(() => approvals.waitingFor(member, []))).toEqual([]);
    const own = await inTenant(() => approvals.waitingFor(member, ["chat-p"]));
    expect(own.map((a) => a.toolName)).toEqual(["mailer_send"]);
  });
});

describe("the hourly mail", () => {
  it("goes to the admins once, with the lines since the last one, and not again for the same lines", async () => {
    mailed.length = 0;
    // Opening the bell above counted as being in the app: forgotten, so the mail goes out.
    await inTenant(() => client.db.delete(client.schema.personSeen));
    const round = await inTenant(() => notify.sendCriticalMails());
    expect(round.sent).toEqual([space]);
    expect(mailed).toHaveLength(1);
    expect(mailed[0].to.sort()).toEqual(["a@firma.at", "b@firma.at"]);
    expect(mailed[0].subject).toContain("Vertrieb");
    expect(mailed[0].text).toContain("send_mail");
    expect(mailed[0].text).toContain("/work/waiting");
    // Nothing new: nothing goes out.
    const again = await inTenant(() => notify.sendCriticalMails());
    expect(again).toEqual({ sent: [], skipped: [] });
    expect(mailed).toHaveLength(1);
  });

  it("is skipped where an admin was in the app since", async () => {
    mailed.length = 0;
    await new Promise((r) => setTimeout(r, 5));
    await call({ kind: "guest", id: "visitor-2" }, guestRun, { id: "send_mail", kind: "send" });
    await inTenant(() => seen.markSeen("user-b"));
    const round = await inTenant(() => notify.sendCriticalMails());
    expect(round).toEqual({ sent: [], skipped: [space] });
    expect(mailed).toEqual([]);
  });

  it("is off when the space says so", async () => {
    mailed.length = 0;
    await inTenant(() => client.db.update(client.schema.space).set({ notify: { bell: true, mail: "off" } }));
    await new Promise((r) => setTimeout(r, 5));
    await call({ kind: "guest", id: "visitor-3" }, guestRun, { id: "send_mail", kind: "send" });
    const round = await inTenant(() => notify.sendCriticalMails());
    expect(round).toEqual({ sent: [], skipped: [] });
    expect(mailed).toEqual([]);
    await inTenant(() => client.db.update(client.schema.space).set({ notify: { bell: true, mail: "hourly" } }));
  });
});

describe("„Was darf …?“ and the log, for the admins", () => {
  type App = { fetch: (req: Request) => Response | Promise<Response> };
  const url = (path: string) => `http://localhost:5181/api/studio${path}`;

  async function appAs(role: "owner" | "member"): Promise<App> {
    const { brokerRoutes } = await import("../src/routes/broker");
    const { ServiceError } = await import("../src/services/errors");
    const user = role === "owner" ? owner : member;
    return new Hono<{ Variables: { user: typeof user } }>()
      .onError((err, c) =>
        err instanceof ServiceError ? c.json(err.toJSON(), err.status) : c.json({ error: String(err) }, 500),
      )
      .use("*", async (c, next) => {
        c.set("user", user);
        await client.withTenant(TENANT, () => access.asRole(role, next));
      })
      .route("/api/studio", brokerRoutes as never);
  }
  const get = async (app: App, path: string) => {
    const res = await app.fetch(new Request(url(path)));
    return { status: res.status, body: (await res.json()) as any };
  };

  it("answers with the outcome and the rule, and nothing runs", async () => {
    const owner = await appAs("owner");
    calls.length = 0;
    const before = (await logOf(connection)).length;
    const guest = await get(owner, `/spaces/${space}/broker/ask?who=guest&resource=${connection}&action=list_contacts`);
    expect(guest.status).toBe(200);
    expect(guest.body).toMatchObject({ who: { kind: "guest" }, action: { id: "list_contacts", kind: "read", known: true }, outcome: "deny", rule: "audience" });
    const write = await get(owner, `/spaces/${space}/broker/ask?who=person&resource=${connection}&action=create_contact&in=chat`);
    expect(write.body).toMatchObject({ outcome: "allow", rule: "rules.write" });
    const aiStep = await get(owner, `/spaces/${space}/broker/ask?who=person&resource=${connection}&action=create_contact&in=run`);
    expect(aiStep.body).toMatchObject({ outcome: "deny", rule: "ai_step_writes", refused: "ai_step_writes" });
    const send = await get(owner, `/spaces/${space}/broker/ask?who=admin&resource=${connection}&action=send_mail&in=none`);
    // The stub's send_mail is a write action; the rule for writes is "allow" since the change above.
    expect(send.body).toMatchObject({ outcome: "allow", rule: "rules.write" });
    expect(calls).toEqual([]);
    expect((await logOf(connection)).length).toBe(before);
    expect((await get(owner, `/spaces/${space}/broker/ask?who=guest&resource=nope&action=x`)).status).toBe(404);
  });

  it("lists the log with its filters; a member gets 403", async () => {
    const owner = await appAs("owner");
    const all = await get(owner, `/spaces/${space}/broker/log`);
    expect(all.status).toBe(200);
    expect(all.body.lines.length).toBeGreaterThan(3);
    expect(all.body.lines[0].at >= all.body.lines[1].at).toBe(true);
    const critical = await get(owner, `/spaces/${space}/broker/log?critical=true`);
    expect(critical.body.lines.every((l: any) => l.critical)).toBe(true);
    expect(critical.body.lines.length).toBeLessThan(all.body.lines.length);
    const guests = await get(owner, `/spaces/${space}/broker/log?who=guest&outcome=deny`);
    expect(guests.body.lines.length).toBeGreaterThan(0);
    expect(guests.body.lines.every((l: any) => l.who.kind === "guest" && l.outcome === "deny")).toBe(true);
    const rwx = await get(owner, `/spaces/${space}/broker/log?connection=rwx`);
    expect(rwx.body.lines).toEqual([]);
    const since = await get(owner, `/spaces/${space}/broker/log?since=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`);
    expect(since.body.lines).toEqual([]);
    expect(all.body.lines[0].input).toMatchObject({ fields: expect.any(Object) });
    expect(JSON.stringify(all.body)).not.toContain("pat-1");

    const memberApp = await appAs("member");
    expect((await get(memberApp, `/spaces/${space}/broker/log`)).status).toBe(403);
    expect((await get(memberApp, `/spaces/${space}/broker/ask?who=guest&resource=${connection}&action=list_contacts`)).status).toBe(403);
  });
});
