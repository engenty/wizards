import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BROKER_REFUSALS } from "@engenty/wizards-shared/connectors";
import { Hono } from "hono";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * Fähigkeiten › Protokoll (docs/plans/capabilities.md, B5): the log's filters the page has
 * (refused, held, a time range, a search over names), a page at a time by cursor, each line with
 * the names the page shows, one line with what its run was allowed, and what „Was darf …?“ picks
 * from. Admins only. HubSpot is played by a stub.
 */
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-broker-protocol-"));
process.env.APP_URL = "http://localhost:5181";

vi.mock("../src/engenty/connections-hubspot/connector", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/engenty/connections-hubspot/connector")>();
  const action = (id: string, group: "read" | "write" | "destructive", summary: string) => ({
    id,
    group,
    summary,
    description: summary,
    inputSchema: z.object({ email: z.string().optional() }),
    handler: async () => ({ done: id }),
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
        action("delete_contact", "destructive", "Delete a contact"),
      ],
    },
  };
});

vi.mock("../src/manage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/manage.js")>()),
  managed: true,
  tenantInfo: async () => ({ limits: { build: true } }),
  tenantMembers: async () => ({
    members: [
      { userId: "user-a", role: "owner", email: "a@firma.at", name: "Anna" },
      { userId: "user-j", role: "member", email: "j@firma.at", name: "Julia" },
    ],
    invitations: [],
    seats: { limit: null, taken: 2 },
  }),
  postBrokerReport: async () => ({ ok: true }),
}));

let client: typeof import("../src/db/client");
let log: typeof import("../src/broker/log");
let access: typeof import("../src/services/access");
let space: string;
let connection: string;
let wizardId: string;

const TENANT = "tenant-p";
const inTenant = <T>(fn: () => Promise<T>) => client.withTenant(TENANT, fn);
const owner = { id: "user-a", role: "owner" as const, tenantId: TENANT, name: "Anna", email: "a@firma.at" };
const member = { id: "user-j", role: "member" as const, tenantId: TENANT, name: "Julia", email: "j@firma.at" };

/** One millisecond, shared by several rows: the cursor must not lose or repeat one of them. */
const SAME = new Date("2026-10-30T10:00:00.000Z");

/** A line as the broker writes it, at a time of the test's choosing. */
function line(at: Date, row: Partial<Parameters<typeof log.writeLog>[0]> = {}) {
  return inTenant(() =>
    log.writeLog({
      at,
      durationMs: 3,
      whoKind: "person",
      whoId: "user-j",
      runId: null,
      stepId: null,
      chatId: null,
      wizardId: null,
      spaceId: space,
      connectionId: connection,
      actionId: "list_contacts",
      kind: "read",
      inputSummary: log.summarizeInput({ email: "kunde@firma.at" }),
      outcome: "allow",
      rule: "rules.read",
      reason: "The connection's rule: reading allowed.",
      result: "ok",
      resultSize: 12,
      ...row,
    }),
  );
}

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb(TENANT);
  log = await import("../src/broker/log");
  access = await import("../src/services/access");
  const spaces = await import("../src/services/spaces");
  const service = await import("../src/connectors/space-connections");
  const wizards = await import("../src/services/wizards");
  space = (await inTenant(() => spaces.createSpace("user-a", "Vertrieb"))).id;
  connection = (
    await inTenant(() =>
      service.createSpaceConnection("user-a", space, {
        connectorId: "hubspot",
        name: "HubSpot Vertrieb",
        signIn: "space",
        audience: "members",
        rules: { read: "allow", write: "ask", destructive: "deny", send: "deny" },
        actions: [],
      }),
    )
  ).id;
  const definition = {
    version: 1,
    title: "Torten-Anfrage",
    description: "Anfragen",
    avatar: "dome",
    steps: [
      { id: "start", type: "page", title: "Du", fields: [{ id: "email", kind: "text", label: "Mail" }] },
      { id: "done", type: "result", title: "Fertig", deliverables: [] },
    ],
  };
  wizardId = (await inTenant(() => wizards.createWizard("user-a", { definition } as never))).id;
  await inTenant(() =>
    client.db.insert(client.schema.run).values({
      id: "run-g",
      wizardId,
      tenantId: TENANT,
      definition: definition as never,
      files: [],
      grant: { connections: { hub: ["list_contacts"] }, hosts: ["api.example.org"], tools: [] },
      version: null,
      mode: "live",
      userId: null,
      visitorId: "visitor-1",
      status: "done",
      cursor: "done",
      state: { values: {}, outputs: {}, history: [], notes: {} },
    }),
  );

  // Seven lines of one millisecond, then older ones: allowed, refused, held, declined, a guest's.
  for (let i = 0; i < 7; i++) {
    await line(SAME);
  }
  await line(new Date("2026-10-29T09:00:00Z"), {
    whoKind: "guest",
    whoId: "visitor-1",
    runId: "run-g",
    wizardId: null,
    actionId: "create_contact",
    kind: "write",
    outcome: "deny",
    rule: "audience",
    reason: "The connection is for the space's members.",
    result: "denied",
  });
  await line(new Date("2026-10-29T08:00:00Z"), {
    actionId: "create_contact",
    kind: "write",
    outcome: "ask",
    rule: "rules.write",
    reason: "The connection's rule: writing asks the space's admins.",
    result: "needs_approval",
  });
  await line(new Date("2026-10-29T07:00:00Z"), {
    actionId: "create_contact",
    kind: "write",
    outcome: "ask",
    rule: "rules.write",
    result: "declined",
  });
  await line(new Date("2026-10-28T07:00:00Z"), {
    whoKind: "step",
    whoId: "call-hub",
    runId: "run-g",
    wizardId,
    connectionId: "hub",
    actionId: "list_contacts",
    rule: "grant",
  });
}, 60_000);

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

describe("the Protokoll's log", () => {
  it("goes page by page by its cursor, through rows of one millisecond, none lost or twice", async () => {
    const app = await appAs("owner");
    const all = await get(app, `/spaces/${space}/broker/log`);
    expect(all.body.next).toBeNull();
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const res: { body: { lines: { id: string }[]; next: string | null } } = await get(
        app,
        `/spaces/${space}/broker/log?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      seen.push(...res.body.lines.map((l) => l.id));
      cursor = res.body.next;
      if (!cursor) {
        break;
      }
    }
    expect(seen).toEqual(all.body.lines.map((l: { id: string }) => l.id));
    expect(new Set(seen).size).toBe(11);
    expect(seen.length).toBe(11);
  });

  it("filters refused, held, a time range and a text", async () => {
    const app = await appAs("owner");
    const refused = await get(app, `/spaces/${space}/broker/log?refused=true`);
    expect(refused.body.lines.map((l: any) => l.result).sort()).toEqual(["declined", "denied"]);
    const notRefused = await get(app, `/spaces/${space}/broker/log?refused=false`);
    expect(notRefused.body.lines.length).toBe(9);
    const held = await get(app, `/spaces/${space}/broker/log?result=needs_approval`);
    expect(held.body.lines).toHaveLength(1);
    expect(held.body.lines[0].outcome).toBe("ask");
    const day = await get(
      app,
      `/spaces/${space}/broker/log?since=2026-10-29T00:00:00Z&until=2026-10-29T08:30:00Z`,
    );
    expect(day.body.lines.map((l: any) => l.result).sort()).toEqual(["declined", "needs_approval"]);
    // In the sample of the input, by the person's name, by the connection's, by the wizard's.
    expect((await get(app, `/spaces/${space}/broker/log?q=kunde@`)).body.lines).toHaveLength(11);
    expect((await get(app, `/spaces/${space}/broker/log?q=julia`)).body.lines).toHaveLength(9);
    expect((await get(app, `/spaces/${space}/broker/log?q=HubSpot%20Vert`)).body.lines).toHaveLength(10);
    expect((await get(app, `/spaces/${space}/broker/log?q=Torten`)).body.lines).toHaveLength(1);
    // `%` is a percent sign, not "anything".
    expect((await get(app, `/spaces/${space}/broker/log?q=%25`)).body.lines).toHaveLength(0);
    // The filters of before still hold.
    const guests = await get(app, `/spaces/${space}/broker/log?who=guest&outcome=deny`);
    expect(guests.body.lines).toHaveLength(1);
  });

  it("names who, the connection, the action and the wizard; a fixed step is held for a guest", async () => {
    const app = await appAs("owner");
    const { lines } = (await get(app, `/spaces/${space}/broker/log`)).body;
    const julia = lines[0];
    expect(julia).toMatchObject({
      who: { kind: "person", id: "user-j", name: "Julia" },
      connectionName: "HubSpot Vertrieb",
      connectorName: "HubSpot",
      actionName: "List contacts",
    });
    const step = lines.find((l: any) => l.who.kind === "step");
    expect(step).toMatchObject({
      who: { for: { kind: "guest" } },
      wizardName: "Torten-Anfrage",
      runMode: "live",
    });
  });

  it("opens one line with what its run was allowed", async () => {
    const app = await appAs("owner");
    const { lines } = (await get(app, `/spaces/${space}/broker/log?who=step`)).body;
    const detail = await get(app, `/spaces/${space}/broker/log/${lines[0].id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.run).toMatchObject({
      id: "run-g",
      wizardId,
      grant: { actions: ["list_contacts"], hosts: ["api.example.org"] },
    });
    expect((await get(app, `/spaces/${space}/broker/log/nope`)).status).toBe(404);
  });

  it("offers the people and the connections with their actions to „Was darf …?“", async () => {
    const app = await appAs("owner");
    const choices = await get(app, `/spaces/${space}/broker/choices`);
    expect(choices.body.people).toEqual([
      { id: "user-a", name: "Anna", role: "owner" },
      { id: "user-j", name: "Julia", role: "member" },
    ]);
    expect(choices.body.connections[0]).toMatchObject({
      id: connection,
      name: "HubSpot Vertrieb",
      audience: "members",
      actions: [
        { id: "list_contacts", name: "List contacts", kind: "read" },
        { id: "create_contact", name: "Create a contact", kind: "write" },
        { id: "delete_contact", name: "Delete a contact", kind: "destructive" },
      ],
    });
  });

  it("answers a mail over SMTP with the connection's send rule, not its delete rule", async () => {
    const service = await import("../src/connectors/space-connections");
    const { DEFAULT_CONNECTION_RULES } = await import("@engenty/wizards-shared/connectors");
    const smtp = await inTenant(() =>
      service.createSpaceConnection("user-a", space, {
        connectorId: "smtp",
        name: "Postfach",
        signIn: "space",
        audience: "all",
        rules: DEFAULT_CONNECTION_RULES,
        actions: [],
      }),
    );
    const app = await appAs("owner");
    const asked = await get(
      app,
      `/spaces/${space}/broker/ask?who=admin&in=chat&resource=${smtp.id}&action=send_message`,
    );
    expect(asked.body).toMatchObject({
      action: { id: "send_message", kind: "send", known: true },
      outcome: "ask",
      rule: "rules.send",
      admins: true,
    });
    expect(asked.body.reason).toMatch(/sending asks/);
    const choices = await get(app, `/spaces/${space}/broker/choices`);
    const listed = choices.body.connections.find((c: { id: string }) => c.id === smtp.id);
    expect(listed.actions).toEqual([{ id: "send_message", name: "Send an e-mail", kind: "send" }]);
    await inTenant(() => service.removeSpaceConnection("user-a", smtp.id));
  });

  it("is for the admins: a member gets 403", async () => {
    const app = await appAs("member");
    for (const path of ["broker/log", "broker/choices", "broker/log/x"]) {
      expect((await get(app, `/spaces/${space}/${path}`)).status).toBe(403);
    }
  });
});

describe("every refusal the broker writes is one the Protokoll knows", () => {
  it("the refusals of call.ts, send.ts and host.ts are in BROKER_REFUSALS", async () => {
    const { readFileSync } = await import("node:fs");
    const known = new Set<string>(BROKER_REFUSALS);
    for (const file of ["call.ts", "send.ts", "host.ts"]) {
      const text = readFileSync(join(import.meta.dirname, "../src/broker", file), "utf8");
      for (const [, refused] of text.matchAll(/refused: "([a-z_]+)"/g)) {
        expect(known, `${file}: ${refused}`).toContain(refused);
      }
      for (const [, refused] of text.matchAll(/refuse\("([a-z_]+)"/g)) {
        expect(known, `${file}: ${refused}`).toContain(refused);
      }
    }
  });
});
