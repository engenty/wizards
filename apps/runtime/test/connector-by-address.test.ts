import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * A server by its address (docs/plans/capabilities-next.md, piece 1): an admin adds an MCP server
 * or an OpenAPI description the registry does not list. Its sign-in is what the source describes
 * itself or what the admin chooses, its id comes from its host, „Aktionen neu laden“ asks with a
 * connection's sign-in, an admin says what each action does, and a private address is taken on a
 * computer of one's own and refused on a managed runtime. The servers are played here: three
 * names answered by a stubbed fetch, and one real server on this computer.
 */
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-connector-address-"));
process.env.APP_URL = "http://localhost:5181";

/** Whether the runtime is a managed one; a test changes it. */
const mode = vi.hoisted(() => ({ managed: false }));

vi.mock("../src/manage.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/manage.js")>();
  return {
    ...mod,
    get managed() {
      return mode.managed;
    },
    tenantInfo: async () => ({ limits: { build: true }, plan: { id: "pro", name: "Pro" } }),
    tenantMembers: async () => ({
      members: [
        { userId: "user-a", role: "owner", name: "Anna" },
        { userId: "user-m", role: "member", name: "Max" },
      ],
    }),
  };
});

// Names resolve here, not on the network.
const DNS: Record<string, string> = {
  "crm.example.com": "93.184.215.14",
  "auth.example.com": "93.184.215.15",
  "mcp.keys.example.org": "93.184.215.16",
  "open.example.net": "93.184.215.17",
  "api.shop.example.co.uk": "93.184.215.18",
  "intern.example.com": "10.0.0.5",
};
vi.mock("node:dns/promises", () => ({
  lookup: async (host: string) => {
    const address = DNS[host];
    if (!address) {
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    }
    return [{ address, family: 4 }];
  },
}));

interface Tool {
  name: string;
  description?: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  inputSchema: Record<string, unknown>;
}

const TOOLS: Tool[] = [
  {
    name: "search_customers",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
  },
  {
    name: "export_report",
    description: "Builds the report and hands it to someone.",
    inputSchema: {
      type: "object",
      properties: { email: { type: "string" }, text: { type: "string" } },
    },
  },
  {
    name: "delete_customer",
    annotations: { destructiveHint: true },
    inputSchema: { type: "object", properties: { id: { type: "string" } } },
  },
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** What each played server was called with. */
const called: { host: string; tool: string; args: unknown }[] = [];

/** An MCP server over streamable HTTP, as far as listing and calling tools goes. */
function mcpServer(
  allowed: (req: Request) => boolean = () => true,
  /** What it calls itself in its handshake. */
  info: { name: string; title?: string } = { name: "played" },
) {
  return async (req: Request): Promise<Response> => {
    if (!allowed(req)) {
      return new Response("unauthorized", {
        status: 401,
        headers: { "www-authenticate": "Bearer" },
      });
    }
    if (req.method === "GET") {
      return new Response(null, { status: 405 });
    }
    if (req.method === "DELETE") {
      return new Response(null, { status: 200 });
    }
    const message = (await req.json()) as {
      id?: number;
      method: string;
      params?: { protocolVersion?: string; name?: string; arguments?: unknown };
    };
    const result = (value: unknown) => json({ jsonrpc: "2.0", id: message.id, result: value });
    if (message.method === "initialize") {
      return result({
        protocolVersion: message.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { ...info, version: "1.0.0" },
      });
    }
    if (message.id === undefined) {
      return new Response(null, { status: 202 });
    }
    if (message.method === "tools/list") {
      return result({ tools: TOOLS });
    }
    if (message.method === "tools/call") {
      called.push({
        host: new URL(req.url).host,
        tool: message.params?.name ?? "",
        args: message.params?.arguments,
      });
      return result({ content: [{ type: "text", text: "done" }] });
    }
    return json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown" } });
  };
}

const SPEC = {
  openapi: "3.0.3",
  info: { title: "Shop", version: "1" },
  servers: [{ url: "https://api.shop.example.co.uk/v1" }],
  components: { securitySchemes: { token: { type: "http", scheme: "bearer" } } },
  paths: {
    "/orders": {
      get: { operationId: "listOrders", summary: "List orders", responses: { 200: {} } },
    },
    "/receipts": {
      post: {
        operationId: "mailReceipt",
        summary: "Mail a receipt",
        requestBody: {
          content: {
            "application/json": {
              schema: { type: "object", properties: { customer: { type: "string" } } },
            },
          },
        },
        responses: { 200: {} },
      },
    },
  },
};

const servers: Record<string, (req: Request) => Promise<Response> | Response> = {
  // Asks for a sign-in and describes it: OAuth, with a client it registers itself.
  "crm.example.com": (req) => {
    const { pathname } = new URL(req.url);
    if (pathname === "/.well-known/oauth-protected-resource/mcp") {
      return json({
        resource: "https://crm.example.com/mcp",
        authorization_servers: ["https://auth.example.com"],
      });
    }
    return pathname === "/mcp"
      ? mcpServer(() => false)(req)
      : new Response("not found", { status: 404 });
  },
  "auth.example.com": (req) =>
    new URL(req.url).pathname === "/.well-known/oauth-authorization-server"
      ? json({
          issuer: "https://auth.example.com",
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
          registration_endpoint: "https://auth.example.com/register",
          grant_types_supported: ["authorization_code", "refresh_token"],
          scopes_supported: ["crm.read"],
        })
      : new Response("not found", { status: 404 }),
  // Asks for a key in a header and describes nothing.
  "mcp.keys.example.org": (req) =>
    new URL(req.url).pathname === "/mcp"
      ? mcpServer((r) => r.headers.get("x-api-key") === "k-1")(req)
      : new Response("not found", { status: 404 }),
  // Answers anybody.
  "open.example.net": (req) =>
    new URL(req.url).pathname === "/mcp"
      ? mcpServer(() => true, { name: "open-list", title: "Offene Kundenliste" })(req)
      : new Response("no", { status: 404 }),
  "api.shop.example.co.uk": (req) =>
    new URL(req.url).pathname === "/openapi.json" ? json(SPEC) : new Response("no", { status: 404 }),
};

let client: typeof import("../src/db/client");
let external: typeof import("../src/connectors/external");
let reload: typeof import("../src/connectors/reload");
let connections: typeof import("../src/connectors/space-connections");
let broker: typeof import("../src/broker/index");
let access: typeof import("../src/services/access");
let guard: typeof import("../src/engenty/connections-external/net/guarded-fetch");
let space: string;
let local: Server;
let localUrl: string;

const TENANT = "tenant-address";
const inTenant = <T>(fn: () => Promise<T>) => client.withTenant(TENANT, fn);
const asAdmin = <T>(fn: () => Promise<T>) => inTenant(() => access.asRole("owner", fn));
const asMember = <T>(fn: () => Promise<T>) => inTenant(() => access.asRole("member", fn));
const realFetch = globalThis.fetch;

beforeAll(async () => {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : String(input));
    // This computer: the real server below answers.
    if (url.hostname === "127.0.0.1") {
      return realFetch(input, init);
    }
    const server = servers[url.hostname];
    if (!server) {
      throw new TypeError(`fetch failed: nothing plays ${url.hostname}`);
    }
    return server(new Request(url, init));
  });
  // A real MCP server on this computer, for the private address.
  const play = mcpServer();
  local = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const answer = await play(
      new Request(`http://127.0.0.1${req.url}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: chunks.length ? Buffer.concat(chunks) : undefined,
      }),
    );
    res.writeHead(answer.status, Object.fromEntries(answer.headers));
    res.end(Buffer.from(await answer.arrayBuffer()));
  });
  await new Promise<void>((done) => local.listen(0, "127.0.0.1", done));
  localUrl = `http://127.0.0.1:${(local.address() as AddressInfo).port}/mcp`;

  client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb(TENANT);
  external = await import("../src/connectors/external");
  reload = await import("../src/connectors/reload");
  connections = await import("../src/connectors/space-connections");
  broker = await import("../src/broker/index");
  access = await import("../src/services/access");
  guard = await import("../src/engenty/connections-external/net/guarded-fetch");
  const spaces = await import("../src/services/spaces");
  space = (await inTenant(() => spaces.createSpace("user-a", "Vertrieb"))).id;
}, 60_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await new Promise((done) => local.close(done));
});

describe("the names an address suggests", () => {
  it("takes the host without www, mcp or api in front and without its ending", () => {
    expect(external.namesFromHost("crm.baeckerei-wagner.at")).toEqual({
      id: "crm-baeckerei-wagner",
      toolPrefix: "crm_baeckerei_wagner",
    });
    expect(external.namesFromHost("mcp.linear.app").id).toBe("linear");
    expect(external.namesFromHost("api.shop.example.co.uk").id).toBe("shop-example");
    expect(external.namesFromHost("www.example.com:8443").id).toBe("example");
    expect(external.namesFromHost("localhost:3000").id).toBe("localhost");
    expect(external.namesFromHost("192.168.1.20:8080")).toEqual({
      id: "server-192-168-1-20",
      toolPrefix: "server_192_168_1_20",
    });
    expect(external.namesFromHost("[::1]:9000").id).toBe("server-1");
    expect(external.namesFromHost("x.io").id).toBe("server-x");
  });
});

describe("a pasted MCP address that describes its sign-in", () => {
  const sourceUrl = "https://crm.example.com/mcp";

  it("reads the server's own OAuth documents where the registry knows nothing", async () => {
    const preview = await asAdmin(() => external.previewSource(space, { sourceUrl }));
    expect(preview).toMatchObject({
      sourceKind: "mcp",
      host: "crm.example.com",
      suggestedId: "crm-example",
      suggestedToolPrefix: "crm_example",
      toolsPending: true,
      fromAddress: true,
      privateAddress: false,
      signIn: { described: "oauth2", needsOAuthClient: false, keyIn: null },
      // It answers nobody without a sign-in, its name included.
      title: null,
    });
  });

  it("imports it without a domain, an id or a prefix, and marks where it came from", async () => {
    const { connector } = await asAdmin(() =>
      external.importConnector("user-a", space, { sourceKind: "mcp", sourceUrl }),
    );
    expect(connector).toMatchObject({
      id: "crm-example",
      toolPrefix: "crm_example",
      domain: "crm.example.com",
      auth: "oauth2",
      needsOAuthClient: false,
      toolsPending: true,
      fromAddress: true,
    });
    // The next address of that host gets a free name.
    const again = await asAdmin(() => external.previewSource(space, { sourceUrl }));
    expect(again).toMatchObject({ suggestedId: "crm-example-2", suggestedToolPrefix: "crm_example_2" });
    await expect(
      asAdmin(() => external.importConnector("user-a", space, { sourceKind: "mcp", sourceUrl })),
    ).rejects.toThrow(/already exists/);
  });

  it("starts a new connection on it for the admins", async () => {
    const row = await asAdmin(() =>
      connections.createSpaceConnection(
        "user-a",
        space,
        connections.newConnectionSchema.parse({
          connectorId: "crm-example",
          name: "CRM",
          signIn: "space",
        }),
      ),
    );
    expect(row.audience).toBe("admins");
    // The lists of connections mark it: its view says where the connector came from.
    const views = await asAdmin(() => connections.spaceConnectionViews(space, "user-a"));
    expect(views.find((v) => v.id === row.id)?.connector).toMatchObject({
      id: "crm-example",
      fromAddress: true,
    });
    // One from the product keeps the members.
    const builtin = await asAdmin(() =>
      connections.createSpaceConnection(
        "user-a",
        space,
        connections.newConnectionSchema.parse({
          connectorId: "hubspot",
          name: "HubSpot",
          signIn: "space",
        }),
      ),
    );
    expect(builtin.audience).toBe("members");
  });
});

describe("a pasted MCP address that wants a key in a header", () => {
  const sourceUrl = "https://mcp.keys.example.org/mcp";
  const header = { kind: "header" as const, name: "X-Api-Key" };
  let connection = "";

  it("says that it asks for a sign-in and describes none", async () => {
    const preview = await asAdmin(() => external.previewSource(space, { sourceUrl }));
    expect(preview).toMatchObject({
      sourceKind: "mcp",
      suggestedId: "keys-example",
      toolsPending: true,
      signIn: { described: null, needsOAuthClient: false },
    });
    // Without a choice the import says what it could not work out.
    await expect(
      asAdmin(() => external.importConnector("user-a", space, { sourceKind: "mcp", sourceUrl })),
    ).rejects.toThrow(/mcp\.keys\.example\.org asks for a sign-in and doesn’t describe one/);
  });

  it("lists the actions with the key the admin typed, and says when it is refused", async () => {
    const preview = await asAdmin(() =>
      external.previewSource(space, { sourceUrl, signIn: { ...header, value: "k-1" } }),
    );
    expect(preview.toolsPending).toBe(false);
    // With the key it says what it calls itself: a name where it has no title.
    expect(preview.title).toBe("played");
    expect(preview.actions.map((a) => [a.id, a.group])).toEqual([
      ["search_customers", "read"],
      ["export_report", "write"],
      ["delete_customer", "destructive"],
    ]);
    expect(preview.actions[1].fields).toEqual(["email", "text"]);
    await expect(
      asAdmin(() =>
        external.previewSource(space, { sourceUrl, signIn: { ...header, value: "wrong" } }),
      ),
    ).rejects.toThrow(/didn’t accept the key/);
  });

  it("keeps the header, not the key", async () => {
    const { connector } = await asAdmin(() =>
      external.importConnector("user-a", space, { sourceKind: "mcp", sourceUrl, signIn: header }),
    );
    expect(connector).toMatchObject({
      id: "keys-example",
      auth: "api_key",
      toolsPending: true,
      fromAddress: true,
    });
    const row = await inTenant(() =>
      client.db.query.spaceConnector.findFirst({ where: (t, { eq }) => eq(t.id, "keys-example") }),
    );
    expect(row?.record.auth_config).toEqual({
      kind: "api_key",
      fields: [{ key: "api_key", label: "API key", required: true, secret: true }],
      placement: { in: "header", name: "X-Api-Key", value_template: "{{api_key}}" },
    });
    expect(JSON.stringify(row?.record)).not.toContain("k-1");
  });

  it("reloads the actions with the sign-in of a signed-in connection", async () => {
    // Nothing is signed in yet: the reload says what is missing.
    await expect(
      asAdmin(() => reload.reloadConnector("user-a", space, "keys-example")),
    ).rejects.toThrow(/lists its actions only to a signed-in account/);
    const row = await asAdmin(() =>
      connections.createSpaceConnection(
        "user-a",
        space,
        connections.newConnectionSchema.parse({
          connectorId: "keys-example",
          name: "Keys",
          signIn: "space",
        }),
      ),
    );
    connection = row.id;
    await asAdmin(() =>
      connections.signInWithCredentials(connection, { as: "space" }, { api_key: "k-1" }),
    );
    const view = await asAdmin(() => reload.reloadConnector("user-a", space, "keys-example"));
    expect(view.toolsPending).toBe(false);
    expect(view.actions.map((a) => a.id)).toEqual([
      "search_customers",
      "export_report",
      "delete_customer",
    ]);
    // The broker read the sign-in, so the reload is a line of the audit.
    const lines = await inTenant(() =>
      client.db.query.brokerLog.findMany({
        where: (t, { eq }) => eq(t.connectionId, connection),
      }),
    );
    expect(lines.map((l) => [l.whoKind, l.actionId, l.kind, l.result])).toEqual([
      ["admin", "list_tools", "read", "ok"],
    ]);
  });
});

describe("a pasted MCP address that answers without a sign-in", () => {
  const sourceUrl = "https://open.example.net/mcp";

  it("needs none, and takes what the admin says each action does", async () => {
    const preview = await asAdmin(() => external.previewSource(space, { sourceUrl }));
    expect(preview).toMatchObject({
      sourceKind: "mcp",
      suggestedId: "open-example",
      toolsPending: false,
      signIn: { described: "none" },
      // The server's own title is the name to suggest; its id still comes from its host.
      title: "Offene Kundenliste",
    });
    const { connector } = await asAdmin(() =>
      external.importConnector("user-a", space, {
        sourceKind: "mcp",
        sourceUrl,
        name: "Offen",
        actionKinds: {
          export_report: { kind: "send", recipientField: "email" },
          // What the importer read anyway is not kept.
          search_customers: { kind: "read" },
          not_there: { kind: "send" },
        },
      }),
    );
    expect(connector).toMatchObject({ id: "open-example", auth: "none", name: "Offen" });
    expect(connector.actions.map((a) => [a.id, a.group, a.recipientField])).toEqual([
      ["search_customers", "read", undefined],
      ["export_report", "send", "email"],
      ["delete_customer", "destructive", undefined],
    ]);
    const row = await inTenant(() =>
      client.db.query.spaceConnector.findFirst({ where: (t, { eq }) => eq(t.id, "open-example") }),
    );
    expect(row?.record.action_kinds).toEqual({
      export_report: { kind: "send", recipient_field: "email" },
    });
  });

  it("refuses a recipient's field the action does not have", async () => {
    await expect(
      asAdmin(() =>
        external.setActionKinds("user-a", space, "open-example", {
          export_report: { kind: "send", recipientField: "nobody" },
        }),
      ),
    ).rejects.toThrow(/has no field “nobody”/);
    await expect(
      asAdmin(() =>
        external.setActionKinds("user-a", space, "open-example", { nope: { kind: "read" } }),
      ),
    ).rejects.toThrow(/has no action “nope”/);
  });
});

describe("what an admin says an action does, at the broker", () => {
  const RULES = { read: "allow", write: "deny", destructive: "deny", send: "allow" } as const;
  let connection = "";
  let wizardId = "";

  const definition = {
    version: 1,
    title: "Bericht",
    description: "Ein Bericht per Mail",
    avatar: "dome",
    steps: [
      {
        id: "start",
        type: "form",
        title: "Du",
        fields: [{ id: "email", kind: "email", label: "E-Mail" }],
      },
      { id: "done", type: "result", title: "Fertig", deliverables: [] },
    ],
  };

  /** A fixed step of a guest's run calls the action with this input. */
  const call = (input: Record<string, unknown>, action = "export_report") =>
    inTenant(async () => {
      const row = await connections.spaceConnectionById(connection);
      const connector = await connections.connectorOfRow(row);
      const found = connector.actions.find((a) => a.id === action);
      return broker.brokerCall({
        who: { kind: "step", id: "tell", for: { kind: "guest", id: "visitor-1" } },
        where: {
          runId: "run-guest",
          stepId: "tell",
          wizardId,
          spaceId: space,
          mode: "live",
          guest: true,
        },
        connection: { kind: "space_connection", row, connector },
        action: { id: action, kind: found ? broker.kindOf(found.group) : undefined },
        input,
      });
    });

  beforeAll(async () => {
    const wizards = await import("../src/services/wizards");
    wizardId = (
      await asAdmin(() => wizards.createWizard("user-a", { definition, spaceId: space } as never))
    ).id;
    await inTenant(() =>
      client.db.insert(client.schema.run).values({
        id: "run-guest",
        wizardId,
        tenantId: TENANT,
        definition: definition as never,
        files: [],
        grant: broker.grantOf(definition as never),
        version: null,
        mode: "live",
        visitorId: "visitor-1",
        status: "running",
        cursor: "done",
        state: {
          values: { email: "kundin@example.com" },
          outputs: {},
          history: ["start"],
          notes: {},
        },
      }),
    );
    const row = await asAdmin(() =>
      connections.createSpaceConnection("user-a", space, {
        connectorId: "open-example",
        name: "Offen",
        signIn: "space",
        audience: "all",
        rules: RULES,
        actions: [],
      }),
    );
    connection = row.id;
    await asAdmin(() => connections.signInWithCredentials(connection, { as: "space" }, {}));
    // Back to what the importer read: a write.
    await asAdmin(() =>
      external.setActionKinds("user-a", space, "open-example", { export_report: null }),
    );
  });

  it("decides by the importer's guess until an admin says otherwise", async () => {
    called.length = 0;
    expect(await call({ email: "kundin@example.com", text: "Hallo" })).toMatchObject({
      ok: false,
      refused: "denied",
      reason: "The connection's rule: writing never.",
    });
    expect(called).toEqual([]);
  });

  it("decides by the admin's kind, and hears of the change", async () => {
    const view = await asAdmin(() =>
      external.setActionKinds("user-a", space, "open-example", {
        export_report: { kind: "send" },
      }),
    );
    expect(view.actions.find((a) => a.id === "export_report")?.group).toBe("send");
    // A send now, but the importer's fields name no recipient: a guest's send names none.
    expect(await call({ email: "kundin@example.com", text: "Hallo" })).toMatchObject({
      ok: false,
      refused: "not_allowed_recipient",
      reason: "The send names no recipient.",
    });
    const lines = await inTenant(() =>
      client.db.query.brokerLog.findMany({
        where: (t, { and, eq }) =>
          and(eq(t.connectionId, connection), eq(t.actionId, "change_rules")),
      }),
    );
    expect(lines.map((l) => l.reason)).toEqual([
      "What Offen's actions do was changed: export_report: send → write.",
      "What Offen's actions do was changed: export_report: write → send.",
    ]);
  });

  it("reads a guest's recipient in the field the admin named", async () => {
    await asAdmin(() =>
      external.setActionKinds("user-a", space, "open-example", {
        export_report: { kind: "send", recipientField: "email" },
      }),
    );
    called.length = 0;
    // The run's own address goes out.
    expect(await call({ email: "kundin@example.com", text: "Hallo" })).toMatchObject({ ok: true });
    expect(called).toEqual([
      {
        host: "open.example.net",
        tool: "export_report",
        args: { email: "kundin@example.com", text: "Hallo" },
      },
    ]);
    // Another one does not, and neither does one beside it in a field the broker knows itself.
    expect(await call({ email: "fremd@anderswo.com", text: "Hallo" })).toMatchObject({
      ok: false,
      refused: "not_allowed_recipient",
    });
    expect(
      await call({ email: "kundin@example.com", cc: "fremd@anderswo.com", text: "Hallo" }),
    ).toMatchObject({ ok: false, refused: "not_allowed_recipient" });
    expect(called).toHaveLength(1);
    expect(broker.recipientsOf({ body: { an: "a@x.at" }, to: "b@x.at" }, "body.an")).toEqual([
      "a@x.at",
      "b@x.at",
    ]);
  });

  it("keeps what the admin said when the actions are reloaded", async () => {
    const view = await asAdmin(() => reload.reloadConnector("user-a", space, "open-example"));
    expect(view.actions.find((a) => a.id === "export_report")).toMatchObject({
      group: "send",
      recipientField: "email",
    });
  });
});

describe("an OpenAPI description by its address", () => {
  const sourceUrl = "https://api.shop.example.co.uk/openapi.json";

  it("is found as one, with the sign-in it describes and the fields of its bodies", async () => {
    const preview = await asAdmin(() => external.previewSource(space, { sourceUrl }));
    expect(preview).toMatchObject({
      sourceKind: "openapi",
      title: "Shop",
      suggestedId: "shop-example",
      fromAddress: true,
      signIn: { described: "api_key", keyIn: "Authorization" },
    });
    expect(preview.actions.map((a) => [a.id, a.group, a.fields])).toEqual([
      ["list_orders", "read", []],
      ["mail_receipt", "send", ["body.customer"]],
    ]);
    const { connector } = await asAdmin(() =>
      external.importConnector("user-a", space, {
        sourceKind: "openapi",
        sourceUrl,
        actionKinds: { mail_receipt: { kind: "send", recipientField: "body.customer" } },
      }),
    );
    expect(connector).toMatchObject({ id: "shop-example", auth: "api_key", fromAddress: true });
    expect(connector.actions[1]).toMatchObject({ group: "send", recipientField: "body.customer" });
  });

  it("says in words when nothing answers as either", async () => {
    await expect(
      asAdmin(() =>
        external.previewSource(space, { sourceUrl: "https://open.example.net/nothing" }),
      ),
    ).rejects.toThrow(
      /Neither an MCP server nor an OpenAPI description answered at open\.example\.net/,
    );
  });
});

describe("a private address", () => {
  it("is taken on a computer of one's own, for this path alone", async () => {
    const preview = await asAdmin(() => external.previewSource(space, { sourceUrl: localUrl }));
    expect(preview).toMatchObject({
      sourceKind: "mcp",
      privateAddress: true,
      fromAddress: true,
      toolsPending: false,
      signIn: { described: "none" },
    });
    expect(preview.suggestedId).toBe("server-127-0-0-1");
    const { connector } = await asAdmin(() =>
      external.importConnector("user-a", space, { sourceKind: "mcp", sourceUrl: localUrl }),
    );
    expect(connector.actions).toHaveLength(3);
    // Its calls reach the server on this computer.
    called.length = 0;
    const resolved = await inTenant(() => external.resolveConnector(space, connector.id));
    const action = resolved?.connector.actions.find((a) => a.id === "search_customers");
    await action?.handler({ query: "Wagner" }, { accessToken: "{}", fetchImpl: fetch } as never);
    expect(called).toEqual([
      { host: "127.0.0.1", tool: "search_customers", args: { query: "Wagner" } },
    ]);
    // Everything else keeps the guard, here too.
    await expect(guard.createGuardedFetch()(localUrl)).rejects.toThrow(/not allowed/);
    // A name that resolves into a private network counts as one.
    await expect(
      asAdmin(() =>
        external.previewSource(space, { sourceUrl: "https://intern.example.com/mcp" }),
      ),
    ).rejects.toThrow(/fetch failed: nothing plays intern\.example\.com|Neither an MCP server/);
  });

  it("stays out of the link-local range, the cloud's metadata service", async () => {
    await expect(
      guard.createGuardedFetch({ allowPrivate: true })("http://169.254.169.254/latest/meta-data"),
    ).rejects.toThrow(/not allowed/);
    await expect(
      guard.createGuardedFetch({ allowPrivate: true })("ftp://127.0.0.1/file"),
    ).rejects.toThrow(/Only http and https/);
  });

  it("is refused on a managed runtime, in the person's language", async () => {
    mode.managed = true;
    try {
      const { ServiceError } = await import("../src/services/errors");
      for (const sourceUrl of [localUrl, "https://intern.example.com/mcp"]) {
        const refused = await asAdmin(() => external.previewSource(space, { sourceUrl })).catch(
          (err) => err,
        );
        expect(refused).toBeInstanceOf(ServiceError);
        expect(refused.toJSON("de")).toMatchObject({
          code: "invalid",
          error: expect.stringMatching(
            /liegt in einem privaten Netz\. Ein Connector erreicht so eine Adresse nur auf deinem eigenen Computer/,
          ),
        });
        await expect(
          asAdmin(() =>
            external.importConnector("user-a", space, {
              sourceKind: "mcp",
              sourceUrl,
              id: "intern",
              toolPrefix: "intern",
            }),
          ),
        ).rejects.toThrow(/is in a private network/);
      }
      // One imported on a computer and carried here: its calls and its reload stay behind the guard.
      const resolved = await inTenant(() => external.resolveConnector(space, "server-127-0-0-1"));
      const action = resolved?.connector.actions.find((a) => a.id === "search_customers");
      called.length = 0;
      await expect(
        Promise.resolve(
          action?.handler({ query: "x" }, { accessToken: "{}", fetchImpl: fetch } as never),
        ),
      ).rejects.toThrow(/not allowed/);
      expect(called).toEqual([]);
      await expect(
        asAdmin(() => reload.reloadConnector("user-a", space, "server-127-0-0-1")),
      ).rejects.toThrow(/is in a private network/);
    } finally {
      mode.managed = false;
    }
  });
});

describe("who may read an address and reload a connector", () => {
  it("refuses a member, on both", async () => {
    mode.managed = true;
    try {
      await expect(
        asMember(() =>
          external.previewSource(space, { sourceUrl: "https://open.example.net/mcp" }),
        ),
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(
        asMember(() => reload.reloadConnector("user-m", space, "open-example")),
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(
        asMember(() =>
          external.setActionKinds("user-m", space, "open-example", {
            delete_customer: { kind: "read" },
          }),
        ),
      ).rejects.toMatchObject({ code: "forbidden" });
      // An admin of the organization may.
      const view = await asAdmin(() => reload.reloadConnector("user-a", space, "open-example"));
      expect(view.actions).toHaveLength(3);
    } finally {
      mode.managed = false;
    }
  });
});
