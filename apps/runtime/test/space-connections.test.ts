import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { Hono } from "hono";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * Connections belong to the space (docs/plans/capabilities.md, A5): admins set one up and choose
 * how it signs in, who may use it and what each kind of action may do; the broker decides by
 * those words. HubSpot is played by a stubbed connector that takes keys and has a read, a write
 * and a delete.
 */
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-space-connections-"));
process.env.APP_URL = "http://localhost:5181";

const calls: { action: string; input: unknown; token: string }[] = [];

vi.mock("../src/engenty/connections-hubspot/connector", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/engenty/connections-hubspot/connector")>();
  const real = mod.hubspotConnector;
  const action = (id: string, group: "read" | "write" | "destructive", summary: string) => ({
    id,
    group,
    summary,
    description: summary,
    inputSchema: z.object({ email: z.string().optional(), id: z.string().optional() }),
    handler: async (input: unknown, ctx: { accessToken: string }) => {
      calls.push({ action: id, input, token: ctx.accessToken });
      return { done: id, contacts: [{ id: "7" }] };
    },
  });
  return {
    ...mod,
    hubspotConnector: {
      ...real,
      auth: {
        kind: "api_key",
        apiKey: {
          fields: [{ key: "access_token", label: "Token", secret: true }],
          verify: async (keys: Record<string, string>) => {
            if (keys.access_token === "wrong") {
              throw new Error("401 from HubSpot");
            }
            return { label: `HubSpot ${keys.access_token.slice(-1)}` };
          },
        },
      },
      actions: [
        action("list_contacts", "read", "List contacts"),
        action("create_contact", "write", "Create a contact"),
        action("delete_contact", "destructive", "Delete a contact"),
      ],
    },
  };
});

// An organization with roles: the Manage-App says who is who; nothing else of it is asked here.
vi.mock("../src/manage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/manage.js")>()),
  managed: true,
  tenantInfo: async () => ({ limits: { build: true } }),
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
let access: typeof import("../src/services/access");
let space: string;

const TENANT = "tenant-c";
const inTenant = <T>(fn: () => Promise<T>) => client.withTenant(TENANT, fn);
const TOKEN = "pat-secret-9";

const admin = { kind: "admin" as const, id: "user-a" };
const member = { kind: "person" as const, id: "user-m" };
const guest = { kind: "guest" as const, id: "visitor-1" };
const memberRun = { runId: "run-m", spaceId: "", mode: "live" as const, guest: false };
/** A Work chat: no run, so a write is a confirmed action, not an AI step's (A7). */
const memberChat = { chatId: "chat-m", spaceId: "" };
const guestRun = { runId: "run-g", spaceId: "", mode: "live" as const, guest: true };

const RULES = { read: "allow", write: "ask", destructive: "deny", send: "ask" } as const;

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
  access = await import("../src/services/access");
  const spaces = await import("../src/services/spaces");
  space = (await inTenant(() => spaces.createSpace("user-a", "Vertrieb"))).id;
  memberRun.spaceId = space;
  memberChat.spaceId = space;
  guestRun.spaceId = space;
}, 60_000);

describe("the conversion: plugin connections become connections of the space", () => {
  it("moves every plugin_connection row and drops the table", async () => {
    const db = createClient({ url: ":memory:" });
    await db.executeMultiple(`
      CREATE TABLE space (id text PRIMARY KEY NOT NULL);
      INSERT INTO space VALUES ('s1');
      CREATE TABLE plugin_connection (
        id text PRIMARY KEY NOT NULL, plugin text NOT NULL, space_id text NOT NULL,
        connector text NOT NULL, label text NOT NULL, actions text NOT NULL, data text NOT NULL,
        created_by text, created_at integer NOT NULL, updated_at integer NOT NULL,
        FOREIGN KEY (space_id) REFERENCES space(id) ON DELETE cascade
      );
      INSERT INTO plugin_connection VALUES
        ('pc1', 'appointments', 's1', 'google-calendar', 'kalender@firma.at', '["list_events","create_event"]', 'v1.sealed', 'user-a', 1700000000000, 1700000001000);
    `);
    const sql = readFileSync(
      join(import.meta.dirname, "../src/db/migrations/tenant/0034_space_connection.sql"),
      "utf8",
    );
    for (const statement of sql.split("--> statement-breakpoint")) {
      await db.execute(statement.trim());
    }
    const moved = await db.execute("SELECT * FROM space_connection");
    expect(moved.rows).toHaveLength(1);
    expect(moved.rows[0]).toMatchObject({
      id: "pc1",
      space_id: "s1",
      connector_id: "google-calendar",
      plugin: "appointments",
      name: "kalender@firma.at",
      label: "kalender@firma.at",
      sign_in: "space",
      audience: "all",
      rules: JSON.stringify(RULES),
      actions: '["list_events","create_event"]',
      secret: "v1.sealed",
      set_up_by: "user-a",
      set_up_at: 1700000000000,
      last_used_at: null,
    });
    const tables = await db.execute("SELECT name FROM sqlite_master WHERE type = 'table'");
    const names = tables.rows.map((r) => r.name);
    expect(names).toContain("space_connection_sign_in");
    expect(names).not.toContain("plugin_connection");
  });
});

describe("a connection that signs in as the space", () => {
  let id = "";

  beforeAll(async () => {
    const row = await inTenant(() =>
      service.createSpaceConnection("user-a", space, {
        connectorId: "hubspot",
        name: "Vertrieb",
        signIn: "space",
        audience: "members",
        rules: RULES,
        actions: [],
      }),
    );
    id = row.id;
    expect(row).toMatchObject({ setUpBy: "user-a", label: null, secret: null, lastUsedAt: null });
  });

  const call = (
    who: typeof admin | typeof member | typeof guest,
    where: typeof memberRun | typeof memberChat,
    action: string,
    ctx?: Parameters<typeof broker.brokerCall>[0]["ctx"],
  ) =>
    inTenant(async () => {
      const row = await service.spaceConnectionById(id);
      const connector = await service.connectorOfRow(row);
      return broker.brokerCall({
        who,
        where,
        connection: { kind: "space_connection", row, connector },
        action: { id: action },
        input: { email: "a@b.at" },
        ctx,
      });
    });

  it("is nothing until an admin signs in; a wrong key is refused", async () => {
    expect(await call(admin, memberRun, "list_contacts")).toMatchObject({
      ok: false,
      refused: "not_connected",
    });
    await expect(
      inTenant(() =>
        service.signInWithCredentials(id, { as: "space" }, { access_token: "wrong" }),
      ),
    ).rejects.toMatchObject({ code: "refused" });
    const signedIn = await inTenant(() =>
      service.signInWithCredentials(id, { as: "space" }, { access_token: TOKEN }),
    );
    expect(signedIn.label).toBe("HubSpot 9");
    const [view] = await inTenant(() => service.spaceConnectionViews(space, "user-a"));
    expect(view).toMatchObject({
      id,
      name: "Vertrieb",
      signIn: "space",
      audience: "members",
      rules: RULES,
      account: { label: "HubSpot 9" },
      mySignIn: null,
      setUpBy: "user-a",
    });
    expect(JSON.stringify(view)).not.toContain(TOKEN);
  });

  it("lets a member read, and notes the use", async () => {
    const out = await call(member, memberRun, "list_contacts");
    expect(out.ok).toBe(true);
    expect(calls.at(-1)?.token).toContain(TOKEN);
    const row = await inTenant(() => service.spaceConnectionById(id));
    expect(row.lastUsedAt).toBeInstanceOf(Date);
    expect((await logOf(id)).at(-1)).toMatchObject({
      whoKind: "person",
      whoId: "user-m",
      kind: "read",
      outcome: "allow",
      result: "ok",
    });
  });

  it("refuses a guest outside the audience, and logs it", async () => {
    const out = await call(guest, guestRun, "list_contacts");
    expect(out).toMatchObject({ ok: false, refused: "denied" });
    expect(out.ok || out.reason).toMatch(/for the space's members/);
    expect((await logOf(id)).at(-1)).toMatchObject({ whoKind: "guest", outcome: "deny" });
  });

  it("asks the admins before a write („Mit Freigabe“): the caller holds it, an admin's yes runs it", async () => {
    calls.length = 0;
    const ask = vi.fn();
    const out = await call(member, memberChat, "create_contact", { ask, confirmed: true });
    expect(out).toMatchObject({ ok: false, refused: "needs_approval" });
    expect(out.ok || out.reason).toMatch(/asks the space's admins/);
    // The person's own yes does not stand in for the admins', and nobody else is asked.
    expect(ask).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect((await logOf(id)).at(-1)).toMatchObject({
      kind: "write",
      outcome: "ask",
      result: "needs_approval",
      critical: false,
    });
    const approved = await call(member, memberChat, "create_contact", { approved: true });
    expect(approved.ok).toBe(true);
    expect(calls.map((c) => c.action)).toEqual(["create_contact"]);
    expect((await logOf(id)).at(-1)).toMatchObject({
      outcome: "ask",
      reason: "An admin of the space approved it.",
      result: "ok",
    });
  });

  it("runs a write the rules allow, never a delete the rules deny", async () => {
    await inTenant(() =>
      service.updateSpaceConnection("user-a", id, {
        rules: { ...RULES, write: "allow" },
      }),
    );
    // In a Work chat (A7): an AI step never writes as the space (A4).
    const written = await call(member, memberChat, "create_contact");
    expect(written.ok).toBe(true);
    expect(calls.at(-1)?.action).toBe("create_contact");
    const deleted = await call(admin, memberChat, "delete_contact", {
      ask: async () => ({ type: "done" as const }),
    });
    expect(deleted).toMatchObject({ ok: false, refused: "denied" });
    expect(deleted.ok || deleted.reason).toMatch(/deleting never/);
  });

  it("never writes for a guest, whatever the rules say", async () => {
    calls.length = 0;
    await inTenant(() =>
      service.updateSpaceConnection("user-a", id, { audience: "all", rules: { ...RULES, write: "allow" } }),
    );
    expect((await call(guest, guestRun, "list_contacts")).ok).toBe(true);
    const out = await call(guest, guestRun, "create_contact", {
      ask: async () => ({ type: "done" as const }),
    });
    expect(out).toMatchObject({ ok: false, refused: "ai_step_writes" });
    expect(out.ok || out.reason).toMatch(/AI step only reads/);
    expect(calls.map((c) => c.action)).toEqual(["list_contacts"]);
  });

  it("is for the admins alone when its audience says so", async () => {
    await inTenant(() => service.updateSpaceConnection("user-a", id, { audience: "admins" }));
    expect((await call(member, memberRun, "list_contacts")).ok).toBe(false);
    expect((await call(admin, memberRun, "list_contacts")).ok).toBe(true);
  });

  it("decides the same with no side effect, and nothing after it is removed", async () => {
    const row = await inTenant(() => service.spaceConnectionById(id));
    const connection = { kind: "space_connection" as const, row, connector: {} as never };
    expect(
      broker.decide({ who: member, where: memberRun, connection, actionId: "x", kind: "read" }),
    ).toMatchObject({ outcome: "deny" });
    expect(
      broker.decide({ who: admin, where: memberChat, connection, actionId: "x", kind: "send" }),
    ).toMatchObject({ outcome: "ask", admins: true });
    await inTenant(() => service.removeSpaceConnection("user-a", id));
    await expect(inTenant(() => service.spaceConnectionById(id))).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("a connection in which each person signs in", () => {
  let id = "";

  beforeAll(async () => {
    id = (
      await inTenant(() =>
        service.createSpaceConnection("user-a", space, {
          connectorId: "hubspot",
          name: "Mein HubSpot",
          signIn: "person",
          audience: "members",
          rules: RULES,
          actions: [],
        }),
      )
    ).id;
  });

  const call = (who: typeof member | typeof guest, action: string, ask?: () => Promise<any>) =>
    inTenant(async () => {
      const row = await service.spaceConnectionById(id);
      const connector = await service.connectorOfRow(row);
      return broker.brokerCall({
        who,
        where: who.kind === "guest" ? guestRun : memberRun,
        connection: { kind: "space_connection", row, connector },
        action: { id: action },
        input: {},
        ctx: ask ? { ask } : undefined,
      });
    });

  it("is not connected for a person who has not signed in", async () => {
    const out = await call(member, "list_contacts");
    expect(out).toMatchObject({ ok: false, refused: "not_connected" });
    expect(out.ok || out.reason).toMatch(/not signed in/);
    // The space's admins cannot sign in for everyone here.
    await expect(
      inTenant(() => service.signInWithCredentials(id, { as: "space" }, { access_token: TOKEN })),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("works as the person once they signed in, and asks them before a write", async () => {
    await inTenant(() =>
      service.signInWithCredentials(
        id,
        { as: "person", userId: "user-m", role: "member" },
        { access_token: "pat-of-m-3" },
      ),
    );
    const [view] = await inTenant(() => service.spaceConnectionViews(space, "user-m"));
    expect(view.mySignIn).toMatchObject({ label: "HubSpot 3" });
    expect(view.account).toBeNull();
    const [asAdmin] = await inTenant(() => service.spaceConnectionViews(space, "user-a"));
    expect(asAdmin.mySignIn).toBeNull();

    calls.length = 0;
    expect((await call(member, "list_contacts")).ok).toBe(true);
    expect(calls.at(-1)?.token).toContain("pat-of-m-3");
    const ask = vi.fn(async () => ({ type: "done" as const }));
    expect((await call(member, "create_contact", ask)).ok).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
    // A guest has no sign-in of their own to a connection of the space.
    expect(await call(guest, "list_contacts")).toMatchObject({ ok: false, refused: "not_connected" });
    await inTenant(() => service.removeSignIn(id, { as: "person", userId: "user-m", role: "member" }));
    expect(await call(member, "list_contacts")).toMatchObject({ ok: false, refused: "not_connected" });
  });
});

describe("the studio's routes", () => {
  type App = { fetch: (req: Request) => Response | Promise<Response> };
  const url = (path: string) => `http://localhost:5181/api/studio${path}`;

  /** The routes as a signed-in person of the organization with this role sees them. */
  async function appAs(role: "owner" | "member"): Promise<App> {
    const { connectionRoutes } = await import("../src/routes/connections");
    const { ServiceError } = await import("../src/services/errors");
    const user = { id: role === "owner" ? "user-a" : "user-m", role, tenantId: TENANT };
    return new Hono<{ Variables: { user: typeof user } }>()
      .onError((err, c) =>
        err instanceof ServiceError
          ? c.json(err.toJSON(), err.status)
          : c.json({ error: String(err) }, 500),
      )
      .use("*", async (c, next) => {
        c.set("user", user);
        await client.withTenant(TENANT, () => access.asRole(role, next));
      })
      .route("/api/studio", connectionRoutes as never);
  }

  const send = (app: App, method: string, path: string, body?: unknown) =>
    app.fetch(
      new Request(url(path), {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );

  it("lets an admin set up, change, sign in and remove; a member reads, nothing more", async () => {
    const owner = await appAs("owner");
    const memberApp = await appAs("member");
    const made = await send(owner, "POST", `/spaces/${space}/connections`, {
      connectorId: "hubspot",
      name: "Bestellungen",
      signIn: "space",
    });
    expect(made.status).toBe(200);
    const view = await made.json();
    expect(view).toMatchObject({ name: "Bestellungen", audience: "members", rules: RULES });

    for (const [method, path, body] of [
      ["POST", `/spaces/${space}/connections`, { connectorId: "hubspot", name: "X", signIn: "space" }],
      ["PATCH", `/connections/${view.id}`, { name: "Y" }],
      ["POST", `/connections/${view.id}/sign-in`, { credentials: { access_token: TOKEN } }],
      ["DELETE", `/connections/${view.id}/sign-in`, undefined],
      ["DELETE", `/connections/${view.id}`, undefined],
    ] as const) {
      const res = await send(memberApp, method, path, body);
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    // A member signs in to a connection in which each person signs in; not to the space's.
    const mine = await send(memberApp, "POST", `/connections/${view.id}/my-sign-in`, {
      credentials: { access_token: TOKEN },
    });
    expect(mine.status).toBe(400);

    const listed = await send(memberApp, "GET", `/spaces/${space}/connections`);
    expect(listed.status).toBe(200);
    expect((await listed.json()).connections.map((c: any) => c.name)).toContain("Bestellungen");

    const changed = await send(owner, "PATCH", `/connections/${view.id}`, {
      audience: "all",
      rules: { ...RULES, destructive: "allow" },
    });
    expect(await changed.json()).toMatchObject({
      audience: "all",
      rules: { ...RULES, destructive: "allow" },
    });
    const signedIn = await send(owner, "POST", `/connections/${view.id}/sign-in`, {
      credentials: { access_token: TOKEN },
    });
    expect(await signedIn.json()).toEqual({ ok: true, label: "HubSpot 9" });
    expect((await send(owner, "DELETE", `/connections/${view.id}`)).status).toBe(200);
    expect((await send(owner, "DELETE", `/connections/${view.id}`)).status).toBe(404);
  });

  it("gives a member their own sign-in on a connection in which each person signs in", async () => {
    const owner = await appAs("owner");
    const memberApp = await appAs("member");
    const made = await send(owner, "POST", `/spaces/${space}/connections`, {
      connectorId: "hubspot",
      name: "Jede Person",
      signIn: "person",
      audience: "admins",
    });
    const view = await made.json();
    // Outside the audience: no sign-in either.
    const outside = await send(memberApp, "POST", `/connections/${view.id}/my-sign-in`, {
      credentials: { access_token: TOKEN },
    });
    expect(outside.status).toBe(403);
    await send(owner, "PATCH", `/connections/${view.id}`, { audience: "members" });
    const mine = await send(memberApp, "POST", `/connections/${view.id}/my-sign-in`, {
      credentials: { access_token: TOKEN },
    });
    expect(await mine.json()).toEqual({ ok: true, label: "HubSpot 9" });
    const listed = await (await send(memberApp, "GET", `/spaces/${space}/connections`)).json();
    expect(listed.connections.find((c: any) => c.id === view.id)).toMatchObject({
      mySignIn: { label: "HubSpot 9" },
      account: null,
    });
    expect((await send(memberApp, "DELETE", `/connections/${view.id}/my-sign-in`)).status).toBe(200);
  });
});

describe("a person's own sign-ins (menu › Verbindungen)", () => {
  type App = { fetch: (req: Request) => Response | Promise<Response> };
  const ids: Record<string, string> = {};

  /** The person's routes and the connections' routes, as this person sees them. */
  async function appAs(id: string, role: "owner" | "member"): Promise<App> {
    const { connectionRoutes } = await import("../src/routes/connections");
    const { personRoutes } = await import("../src/routes/person");
    const user = { id, role, tenantId: TENANT, name: id, email: `${id}@example.com` };
    return new Hono<{ Variables: { user: typeof user } }>()
      .use("*", async (c, next) => {
        c.set("user", user);
        await client.withTenant(TENANT, () => access.asRole(role, next));
      })
      .route("/api/studio/person", personRoutes as never)
      .route("/api/studio", connectionRoutes as never);
  }

  const send = (app: App, method: string, path: string, body?: unknown) =>
    app.fetch(
      new Request(`http://localhost:5181/api/studio${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );

  /** This describe's connections as this person's menu lists them, in the space. */
  async function listed(app: App) {
    const res = await send(app, "GET", "/person/sign-ins");
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text);
    const all = body.spaces.find((s: any) => s.id === space).connections as any[];
    return { text, rows: all.filter((r) => Object.values(ids).includes(r.id)) };
  }

  beforeAll(async () => {
    const make = (name: string, signIn: "space" | "person", audience: "admins" | "members") =>
      inTenant(() =>
        service.createSpaceConnection("user-a", space, {
          connectorId: "hubspot",
          name,
          signIn,
          audience,
          rules: RULES,
          actions: [],
        }),
      );
    ids.each = (await make("Kalender", "person", "members")).id;
    ids.space = (await make("Bestellungen", "space", "members")).id;
    ids.admins = (await make("Nur Admins", "person", "admins")).id;
    await inTenant(() =>
      service.signInWithCredentials(ids.space, { as: "space" }, { access_token: "space-key-5" }),
    );
  });

  it("shows an admin every connection of the space, a member those for members", async () => {
    const owner = await listed(await appAs("user-a", "owner"));
    expect(owner.rows.map((r) => r.name)).toEqual(["Kalender", "Bestellungen", "Nur Admins"]);
    const member = await listed(await appAs("user-m", "member"));
    expect(member.rows.map((r) => r.name)).toEqual(["Kalender", "Bestellungen"]);
    // The space's sign-in: which account, who set it up; the person signs in to nothing there.
    expect(member.rows[1]).toMatchObject({
      signIn: "space",
      account: { label: "HubSpot 5" },
      setUpBy: "Anna",
      mySignIn: null,
    });
    expect(member.text).not.toContain("space-key-5");
  });

  it("signs a member in and out, and shows each person only their own sign-in", async () => {
    const memberApp = await appAs("user-m", "member");
    const ownerApp = await appAs("user-a", "owner");
    const otherApp = await appAs("user-x", "member");
    const signedIn = await send(memberApp, "POST", `/connections/${ids.each}/my-sign-in`, {
      credentials: { access_token: "member-key-7" },
    });
    expect(await signedIn.json()).toEqual({ ok: true, label: "HubSpot 7" });

    const mine = await listed(memberApp);
    expect(mine.rows[0]).toMatchObject({ signIn: "person", mySignIn: { label: "HubSpot 7" } });
    expect(mine.text).not.toContain("member-key-7");
    // Nobody else sees the member's sign-in, the admin included.
    expect((await listed(ownerApp)).rows[0].mySignIn).toBeNull();
    expect((await listed(otherApp)).rows[0].mySignIn).toBeNull();

    expect((await send(memberApp, "DELETE", `/connections/${ids.each}/my-sign-in`)).status).toBe(
      200,
    );
    expect((await listed(memberApp)).rows[0].mySignIn).toBeNull();
  });
});
