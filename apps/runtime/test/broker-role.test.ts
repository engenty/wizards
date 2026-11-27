import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * The broker as a role of its own (docs/plans/kernel.md, item 24): a runner of one tenant holds
 * no keys. Its connector calls go over the peer routes to the process in the role `broker`, which
 * reads the account and runs the action; its model calls reach the gateway through that process
 * too. And it opens no other tenant's database. One process plays both here: the runner while
 * `env.runner.tenant` is set, the broker inside the peer routes, which `fetch` is sent to.
 */
const DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-broker-role-"));
process.env.DATA_DIR = DATA_DIR;
process.env.APP_URL = "http://localhost:5181";
process.env.MARKETPLACE_URL = "off";
process.env.RUNTIME_ROLE = "runner";
process.env.BROKER_URL = "http://broker.test";
process.env.BROKER_SECRET = "the-broker-secret";

const TENANT = "tenant-own";
const OTHER = "tenant-other";
process.env.BROKER_KEY = createHmac("sha256", "the-broker-secret")
  .update(`broker:${TENANT}`)
  .digest("hex");

const calls: string[] = [];

vi.mock("../src/engenty/connections-hubspot/connector", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/engenty/connections-hubspot/connector")>();
  const action = (id: string, group: "read" | "write") => ({
    id,
    group,
    summary: id,
    description: id,
    inputSchema: z.object({}).passthrough(),
    handler: async (input: unknown, ctx: { accessToken: string }) => {
      calls.push(`${id}:${ctx.accessToken}:${JSON.stringify(input)}`);
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
      actions: [action("list_contacts", "read"), action("create_contact", "write")],
    },
  };
});

/** Which side opened a secret: the runner, or the broker inside its peer routes. */
let side: "runner" | "broker" = "runner";
const opened: string[] = [];
vi.mock("../src/secrets/crypto", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/secrets/crypto")>();
  return {
    ...mod,
    unseal: (sealed: string) => {
      opened.push(side);
      return mod.unseal(sealed);
    },
  };
});

let client: typeof import("../src/db/client");
let broker: typeof import("../src/broker/index");
let remote: typeof import("../src/broker/remote");
let crypto: typeof import("../src/secrets/crypto");
let tenants: typeof import("../src/tenants/tenant");
let env: typeof import("../src/env").env;
let routes: typeof import("../src/routes/broker-peer").brokerPeerRoutes;
let space = "";

const inTenant = <T>(fn: () => Promise<T>) => client.withTenant(TENANT, fn);
const tokens = (token: string) => ({
  accessToken: token,
  refreshToken: null,
  expiresAt: null,
  scopes: [],
});

let made = 0;
type Row = typeof import("../src/db/schema").spaceConnection.$inferInsert;
async function spaceConnection(over: Partial<Row> = {}) {
  const id = `sc-${++made}`;
  await inTenant(() =>
    client.db.insert(client.schema.spaceConnection).values({
      id,
      spaceId: space,
      connectorId: "hubspot",
      name: `HubSpot ${made}`,
      label: "crm@firma.at",
      signIn: "space",
      audience: "all",
      rules: { read: "allow", write: "allow", destructive: "deny", send: "allow" },
      secret: crypto.seal(tokens(`space-token-${id}`)),
      setUpAt: new Date(Date.now() + made),
      ...over,
    }),
  );
  const { spaceConnectionOf } = await import("../src/connectors/space-connections");
  const { resolveConnector } = await import("../src/connectors/external");
  const row = (await inTenant(() => spaceConnectionOf(space, id)))!;
  const resolved = (await inTenant(() => resolveConnector(space, "hubspot")))!;
  return { id, row, connector: resolved.connector };
}

/** What reached the gateway behind the broker. */
const atGateway: { url: string; headers: Headers }[] = [];
const sentToBroker: string[] = [];
const realFetch = globalThis.fetch;

beforeAll(async () => {
  env = (await import("../src/env")).env;
  client = await import("../src/db/client");
  await client.migrateControlDb();
  // The studio made the tenant and its space before; the runner of one tenant comes after.
  await client.openTenantDb(TENANT);
  await client.openTenantDb(OTHER);
  broker = await import("../src/broker/index");
  remote = await import("../src/broker/remote");
  crypto = await import("../src/secrets/crypto");
  tenants = await import("../src/tenants/tenant");
  routes = (await import("../src/routes/broker-peer")).brokerPeerRoutes;
  const spaces = await import("../src/services/spaces");
  space = (await inTenant(() => spaces.createSpace("user-a", "Vertrieb"))).id;

  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(env.broker.url)) {
      sentToBroker.push(String(init?.body ?? ""));
      side = "broker";
      try {
        return await routes.request(url.slice(env.broker.url.length).replace("/api/peer", ""), init);
      } finally {
        side = "runner";
      }
    }
    if (url.startsWith("http://gateway.test")) {
      atGateway.push({ url, headers: new Headers(init?.headers) });
      return Response.json({ markup: 1, classes: {}, webSearchCredits: 0 });
    }
    return realFetch(input, init);
  });
}, 60_000);

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  env.runner.tenant = TENANT;
  calls.length = 0;
  opened.length = 0;
  sentToBroker.length = 0;
});
afterEach(() => {
  env.runner.tenant = "";
});

describe("a runner of one tenant calls a connector", () => {
  it("through the broker, which reads the secret and runs the action; the runner never does", async () => {
    env.runner.tenant = "";
    const held = await spaceConnection();
    env.runner.tenant = TENANT;
    const kept: unknown[] = [];
    const out = await inTenant(() =>
      broker.brokerCall({
        who: { kind: "step", for: { kind: "admin", id: "user-a" } },
        where: { spaceId: space },
        connection: { kind: "space_connection", row: held.row, connector: held.connector },
        action: { id: "list_contacts" },
        input: { q: "file:offer.pdf" },
        prepare: async (input) => ({ ...(input as object), prepared: true }),
        after: async (result) => {
          kept.push(result);
          return { kept: result };
        },
      }),
    );
    expect(out).toMatchObject({ ok: true, result: { kept: { done: "list_contacts" } } });
    expect(calls).toEqual([
      `list_contacts:space-token-${held.id}:{"q":"file:offer.pdf","prepared":true}`,
    ]);
    // The call went to the broker, and the secret was opened there alone.
    expect(sentToBroker).toHaveLength(1);
    expect(sentToBroker[0]).not.toContain("space-token");
    expect(opened.length).toBeGreaterThan(0);
    expect(opened.every((at) => at === "broker")).toBe(true);
    expect(kept).toEqual([{ done: "list_contacts" }]);
    // The broker logged it, in the tenant's own log.
    const line = await inTenant(() =>
      client.db.query.brokerLog.findFirst({ where: (t, { eq }) => eq(t.connectionId, held.id) }),
    );
    expect(line).toMatchObject({ outcome: "allow", result: "ok", actionId: "list_contacts" });
  });

  it("asks the person on the runner where the rules ask, and the broker acts on the answer", async () => {
    env.runner.tenant = "";
    const held = await spaceConnection({
      signIn: "person",
      secret: null,
      rules: { read: "allow", write: "ask", destructive: "deny", send: "deny" },
    });
    await inTenant(() =>
      client.db.insert(client.schema.spaceConnectionSignIn).values({
        connectionId: held.id,
        userId: "user-m",
        label: "max@firma.at",
        secret: crypto.seal(tokens("max-token")),
      }),
    );
    env.runner.tenant = TENANT;
    const ask = vi.fn(async () => ({ type: "done" as const, remember: true }));
    const allowed = new Set<string>();
    const out = await inTenant(() =>
      broker.brokerCall({
        who: { kind: "person", id: "user-m" },
        where: { spaceId: space },
        connection: { kind: "space_connection", row: held.row, connector: held.connector },
        action: { id: "create_contact" },
        input: {},
        ctx: { ask: ask as never, allowed },
      }),
    );
    expect(out).toMatchObject({ ok: true, account: { label: "max@firma.at" } });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0]).toMatchObject([{ kind: "confirm", service: "max@firma.at" }]);
    expect(calls).toEqual(["create_contact:max-token:{}"]);
    // Allowed for the rest of the run: the runner keeps it, as in its own process.
    expect([...allowed]).toEqual([`${held.id}:create_contact`]);
    expect(opened.every((at) => at === "broker")).toBe(true);
  });

  it("is refused a call that brings its own handler: that needs the account here", async () => {
    env.runner.tenant = "";
    const held = await spaceConnection();
    env.runner.tenant = TENANT;
    const handler = vi.fn(async () => "token");
    const out = await inTenant(() =>
      broker.brokerCall({
        who: { kind: "admin", id: "user-a" },
        where: { spaceId: space },
        connection: { kind: "space_connection", row: held.row, connector: held.connector },
        action: { id: "list_tools", kind: "read" },
        input: {},
        handler,
      }),
    );
    expect(out).toMatchObject({ ok: false, refused: "denied" });
    expect(handler).not.toHaveBeenCalled();
    expect(opened).toEqual([]);
    expect(sentToBroker).toEqual([]);
  });

  it("says whether a connection holds an account through the broker, never its secret", async () => {
    env.runner.tenant = "";
    const held = await spaceConnection();
    env.runner.tenant = TENANT;
    const found = await inTenant(() =>
      broker.brokerConnected({
        kind: "space_connection",
        row: held.row,
        connector: held.connector,
      }),
    );
    expect(found).toMatchObject({ label: "crm@firma.at", connector: { id: "hubspot" } });
    expect(opened.every((at) => at === "broker")).toBe(true);
  });

  it("calls in its own process where it serves every tenant", async () => {
    env.runner.tenant = "";
    const held = await spaceConnection();
    const out = await inTenant(() =>
      broker.brokerCall({
        who: { kind: "admin", id: "user-a" },
        where: { spaceId: space },
        connection: { kind: "space_connection", row: held.row, connector: held.connector },
        action: { id: "list_contacts" },
        input: {},
      }),
    );
    expect(out).toMatchObject({ ok: true });
    expect(sentToBroker).toEqual([]);
    expect(opened.every((at) => at === "runner")).toBe(true);
  });

  it("calls nothing without a broker to call", async () => {
    env.runner.tenant = "";
    const held = await spaceConnection();
    env.runner.tenant = TENANT;
    const url = env.broker.url;
    env.broker.url = "";
    try {
      await expect(
        inTenant(() =>
          broker.brokerCall({
            who: { kind: "admin", id: "user-a" },
            where: { spaceId: space },
            connection: { kind: "space_connection", row: held.row, connector: held.connector },
            action: { id: "list_contacts" },
            input: {},
          }),
        ),
      ).rejects.toThrow(/no broker is set/);
    } finally {
      env.broker.url = url;
    }
    expect(calls).toEqual([]);
  });
});

describe("the broker's peer routes", () => {
  const signedPost = async (tenant: string, signedFor: string, body: string) => {
    const { brokerTicket } = await import("../src/secrets/signing");
    return routes.request("/broker/call", {
      method: "POST",
      headers: {
        authorization: `Bearer ${brokerTicket("call", signedFor, body)}`,
        "content-type": "application/json",
        "x-wizards-tenant": tenant,
      },
      body,
    });
  };

  it("answer a runner's ticket for its own tenant alone", async () => {
    const body = JSON.stringify({ who: { kind: "admin" }, where: {}, connection: {}, action: {} });
    // The runner's key signs for its tenant; a ticket it signs for another is no good.
    expect((await signedPost(OTHER, OTHER, body)).status).toBe(401);
    expect((await signedPost(OTHER, TENANT, body)).status).toBe(401);
    // Nor a body other than the one signed.
    const { brokerTicket } = await import("../src/secrets/signing");
    const res = await routes.request("/broker/call", {
      method: "POST",
      headers: {
        authorization: `Bearer ${brokerTicket("call", TENANT, body)}`,
        "x-wizards-tenant": TENANT,
      },
      body: body.replace("admin", "person"),
    });
    expect(res.status).toBe(401);
  });

  it("send a model call to the gateway with the runtime's key, booked on the runner's tenant", async () => {
    const before = { url: env.manage.gatewayUrl, key: env.manage.serviceKey };
    env.manage.gatewayUrl = "http://gateway.test";
    env.manage.serviceKey = "the-runtime-key";
    try {
      const access = remote.gatewayViaBroker();
      expect(access.baseUrl).toBe("http://broker.test/api/peer/gateway");
      expect(access.token).not.toContain("the-runtime-key");
      const res = await fetch(`${access.baseUrl}/v1/models`, {
        headers: { authorization: `Bearer ${access.token}`, "x-wizards-tenant": access.tenant },
      });
      expect(res.status).toBe(200);
      expect(atGateway.at(-1)?.url).toBe("http://gateway.test/v1/models");
      expect(atGateway.at(-1)?.headers.get("authorization")).toBe("Bearer the-runtime-key");
      expect(atGateway.at(-1)?.headers.get("x-wizards-tenant")).toBe(TENANT);
      // Another tenant's header with this runner's ticket books nothing.
      const other = await fetch(`${access.baseUrl}/v1/models`, {
        headers: { authorization: `Bearer ${access.token}`, "x-wizards-tenant": OTHER },
      });
      expect(other.status).toBe(401);
    } finally {
      env.manage.gatewayUrl = before.url;
      env.manage.serviceKey = before.key;
    }
  });
});

describe("a runner of one tenant and the tenant databases", () => {
  it("opens its own tenant's database and no other", async () => {
    await expect(client.tenantDb(TENANT)).resolves.toBeDefined();
    await expect(client.tenantDb(OTHER)).rejects.toBeInstanceOf(tenants.OtherTenantError);
    expect(() => tenants.inTenant(OTHER, () => 1)).toThrow(tenants.OtherTenantError);
    await expect(client.withTenant(OTHER, async () => 1)).rejects.toThrow(/serves the tenant/);
  });

  it("does not open another tenant's file it was never given", async () => {
    await client.controlDb
      .insert(client.control.tenant)
      .values({ id: "tenant-third" })
      .onConflictDoNothing();
    await expect(client.tenantDb("tenant-third")).rejects.toBeInstanceOf(tenants.OtherTenantError);
    expect(existsSync(join(DATA_DIR, "tenants", "tenant-third.db"))).toBe(false);
    // Its sweeps and its minute's work know its own tenant alone.
    expect(await client.knownTenants()).toEqual([TENANT]);
    expect(await client.activeTenants()).toEqual([TENANT]);
  });

  it("makes no database for its tenant where none was mounted", async () => {
    env.runner.tenant = "tenant-new";
    await expect(client.tenantDb("tenant-new")).rejects.toThrow(/not where this runner looks/);
    expect(existsSync(join(DATA_DIR, "tenants", "tenant-new.db"))).toBe(false);
  });
});
