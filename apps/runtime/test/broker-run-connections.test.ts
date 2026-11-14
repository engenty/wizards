import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * The broker under connections in a run (docs/plans/run-connections.md): a person's own account
 * is used under the space's rules for its service (decided 4), a connection of the space a run
 * uses for a wizard's need is bound by the run's grant, and a fixed step on a connection where
 * each person signs in uses the sign-in of the person its run is held for. HubSpot is played by
 * a stubbed connector that takes keys.
 */
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-broker-rc-"));
process.env.APP_URL = "http://localhost:5181";

const calls: string[] = [];

vi.mock("../src/engenty/connections-hubspot/connector", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/engenty/connections-hubspot/connector")>();
  const action = (id: string, group: "read" | "write" | "send" | "destructive") => ({
    id,
    group,
    summary: id,
    description: id,
    inputSchema: z.object({}).passthrough(),
    handler: async (_input: unknown, ctx: { accessToken: string }) => {
      calls.push(`${id}:${ctx.accessToken}`);
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
        action("list_contacts", "read"),
        action("create_contact", "write"),
        action("send_mail", "send"),
        action("delete_contact", "destructive"),
      ],
    },
  };
});

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
let own: typeof import("../src/connectors/person-connections");
let crypto: typeof import("../src/secrets/crypto");
let space = "";
let wizardId = "";

const TENANT = "tenant-broker-rc";
const inTenant = <T>(fn: () => Promise<T>) => client.withTenant(TENANT, fn);

const member = { kind: "person" as const, id: "user-m" };
const guest = { kind: "guest" as const, id: "visitor-1" };
const tokens = (token: string) => ({ accessToken: token, refreshToken: null, expiresAt: null, scopes: [] });

/** The wizard's need: HubSpot, read by its AI step; a write only where a test's definition says. */
const crm = { id: "crm", connector: "hubspot", actions: ["list_contacts"] };
const definition = {
  version: 1,
  title: "Leads",
  description: "Leads into HubSpot",
  avatar: "dome",
  connections: [crm],
  steps: [
    { id: "read", type: "agent", title: "Read", instructions: "Read.", tools: [], connections: ["crm"] },
    { id: "done", type: "result", title: "Done", deliverables: [] },
  ],
};

let runs = 0;
/** A run of the wizard, held for Max. */
async function runRow(): Promise<string> {
  const id = `run-${++runs}`;
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
      userId: "user-m",
      status: "running",
      cursor: "read",
      state: { values: {}, outputs: {}, history: [], notes: {} },
    }),
  );
  return id;
}

const where = (runId: string, stepId = "read") => ({
  runId,
  stepId,
  wizardId,
  spaceId: space,
  mode: "live" as const,
  guest: false,
});

let made = 0;
type Row = typeof import("../src/db/schema").spaceConnection.$inferInsert;
/** A connection of the space, HubSpot unless said otherwise, signed in as the space. */
async function spaceConnection(over: Partial<Row> = {}): Promise<string> {
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
      secret: crypto.seal(tokens(`space-${id}`)),
      setUpAt: new Date(Date.now() + made),
      ...over,
    }),
  );
  return id;
}

const scope = { wizardId: "", holder: "u:user-m" };
/** Max's own HubSpot, the wizard's choice for its need. */
async function maxsAccount() {
  scope.wizardId = wizardId;
  const row = await inTenant(() => own.saveConnection("u:user-m", "hubspot", "max@firma.at", tokens("max-own")));
  await inTenant(() => own.remember(wizardId, "crm", "u:user-m", { kind: "person", row }));
}

/** A call through the wizard's need, as an AI step for Max makes it. */
const callOwn = (runId: string, action: string, ask?: () => Promise<{ type: "done" }>) =>
  inTenant(() =>
    broker.brokerCall({
      who: member,
      where: where(runId),
      connection: { kind: "store_secret", def: crm, scope, spaceId: space },
      action: { id: action },
      input: {},
      ctx: ask ? { ask: ask as never } : {},
    }),
  );

const lastLine = async (connectionId: string) => {
  const lines = await inTenant(() =>
    client.db.query.brokerLog.findMany({
      where: (t, { eq }) => eq(t.connectionId, connectionId),
      orderBy: (t, { desc }) => [desc(t.at), desc(t.id)],
    }),
  );
  return lines[0];
};

const switchOn = () => {
  process.env.FEATURES = "runConnections=on";
};

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb(TENANT);
  broker = await import("../src/broker/index");
  own = await import("../src/connectors/person-connections");
  crypto = await import("../src/secrets/crypto");
  const spaces = await import("../src/services/spaces");
  const wizards = await import("../src/services/wizards");
  space = (await inTenant(() => spaces.createSpace("user-a", "Vertrieb"))).id;
  wizardId = (await inTenant(() => wizards.createWizard("user-a", { definition, spaceId: space }))).id;
  await maxsAccount();
}, 60_000);

/** Each test starts with a space that has no HubSpot of its own. */
beforeEach(async () => {
  await inTenant(() => client.db.delete(client.schema.spaceConnection));
  calls.length = 0;
});
afterEach(() => {
  delete process.env.FEATURES;
});

/** Everything the wizard's need may do, so the grant lets each call through to the rules. */
const grantsAll = () => {
  beforeEach(() => {
    crm.actions = ["list_contacts", "create_contact", "send_mail", "delete_contact"];
  });
  afterEach(() => {
    crm.actions = ["list_contacts"];
  });
};

describe("a person's own account in a space without rules for its service", () => {
  grantsAll();

  it("follows the wizard's policy: reads run, a write asks the person", async () => {
    switchOn();
    const run = await runRow();
    const read = await callOwn(run, "list_contacts");
    expect(read).toMatchObject({ ok: true, account: { label: "max@firma.at" } });
    expect(await lastLine("crm")).toMatchObject({ rule: "read", outcome: "allow" });
    expect(await callOwn(run, "create_contact")).toMatchObject({ ok: false, refused: "nobody" });
    expect(await lastLine("crm")).toMatchObject({ rule: "policy", outcome: "ask" });
  });
});

describe("a person's own account under the space's rules", () => {
  grantsAll();

  it("is refused what the space says never, naming the connection that decided", async () => {
    switchOn();
    const id = await spaceConnection({
      rules: { read: "allow", write: "deny", destructive: "deny", send: "ask" },
      // The audience does not count: the account is Max's own.
      audience: "admins",
    });
    const run = await runRow();
    expect(await callOwn(run, "list_contacts")).toMatchObject({ ok: true, account: { label: "max@firma.at" } });
    expect(calls).toEqual(["list_contacts:max-own"]);
    expect(await lastLine("crm")).toMatchObject({ outcome: "allow", rule: `rules.read@${id}` });
    expect(await callOwn(run, "create_contact")).toMatchObject({ ok: false, refused: "denied" });
    const line = await lastLine("crm");
    expect(line).toMatchObject({ outcome: "deny", rule: `rules.write@${id}`, result: "denied" });
    expect(line.reason).toContain("HubSpot");
  });

  it("asks the person where the space says with approval, and runs where it allows", async () => {
    switchOn();
    const id = await spaceConnection({ rules: { read: "allow", write: "allow", destructive: "ask", send: "ask" } });
    const run = await runRow();
    // The wizard's rules would ask before a write; the space allows it.
    expect(await callOwn(run, "create_contact")).toMatchObject({ ok: true });
    expect(await lastLine("crm")).toMatchObject({ outcome: "allow", rule: `rules.write@${id}` });
    expect(await callOwn(run, "send_mail")).toMatchObject({ ok: false, refused: "nobody" });
    expect(await lastLine("crm")).toMatchObject({ outcome: "ask", rule: `rules.send@${id}` });
    const yes = vi.fn(async () => ({ type: "done" as const }));
    expect(await callOwn(run, "send_mail", yes)).toMatchObject({ ok: true });
    expect(yes).toHaveBeenCalledTimes(1);
  });

  it("takes the strictest of the space's connections of the same service", async () => {
    switchOn();
    await spaceConnection({ rules: { read: "allow", write: "allow", destructive: "deny", send: "allow" } });
    const strict = await spaceConnection({
      rules: { read: "allow", write: "deny", destructive: "deny", send: "allow" },
      signIn: "person",
      secret: null,
    });
    const run = await runRow();
    expect(await callOwn(run, "create_contact")).toMatchObject({ ok: false, refused: "denied" });
    expect(await lastLine("crm")).toMatchObject({ rule: `rules.write@${strict}` });
  });

  it("is paused while a connection of the space for the service pauses", async () => {
    switchOn();
    const id = await spaceConnection({ pausedAt: new Date(), pausedBy: "user-a" });
    const run = await runRow();
    expect(await callOwn(run, "list_contacts")).toMatchObject({ ok: false, refused: "paused" });
    expect(await lastLine("crm")).toMatchObject({ outcome: "deny", rule: `paused@${id}`, result: "paused" });
    expect(calls).toEqual([]);
  });

  it("counts under the space's limits, with the connection's own calls", async () => {
    switchOn();
    const id = await spaceConnection({ callsPerRun: 2 });
    const run = await runRow();
    expect(await callOwn(run, "list_contacts")).toMatchObject({ ok: true });
    // A call through the space's own connection in the same run counts too.
    const row = await inTenant(() =>
      client.db.query.spaceConnection.findFirst({ where: (t, { eq }) => eq(t.id, id) }),
    );
    const { hubspotConnector } = await import("../src/engenty/connections-hubspot/connector");
    expect(
      await inTenant(() =>
        broker.brokerCall({
          who: { kind: "step", id: "read", for: member },
          where: where(run),
          connection: { kind: "space_connection", row: row as never, connector: hubspotConnector as never },
          action: { id: "list_contacts" },
          input: {},
        }),
      ),
    ).toMatchObject({ ok: true });
    expect(await callOwn(run, "list_contacts")).toMatchObject({ ok: false, refused: "calls_per_run" });
    expect(await lastLine("crm")).toMatchObject({ rule: `limits.run@${id}`, result: "calls_per_run" });
    // Another run has its own.
    expect(await callOwn(await runRow(), "list_contacts")).toMatchObject({ ok: true });
  });

  it("follows the wizard's policy with runConnections off", async () => {
    await spaceConnection({ rules: { read: "deny", write: "deny", destructive: "deny", send: "deny" } });
    const run = await runRow();
    expect(await callOwn(run, "list_contacts")).toMatchObject({ ok: true });
    expect(await lastLine("crm")).toMatchObject({ rule: "read" });
  });
});

describe("a connection of the space the run uses for a wizard's need", () => {
  it("is bound by the run's grant", async () => {
    switchOn();
    // Max may use the space's HubSpot; his own is forgotten, so the space's is the only one.
    await inTenant(() => own.forget(wizardId, "u:user-m", "crm"));
    const id = await spaceConnection({ audience: "members" });
    try {
      const run = await runRow();
      const connection = { kind: "store_secret" as const, def: crm, scope, spaceId: space };
      const step = { kind: "step" as const, id: "read", for: member };
      const read = await inTenant(() =>
        broker.brokerCall({ who: step, where: where(run), connection, action: { id: "list_contacts" }, input: {} }),
      );
      expect(read).toMatchObject({ ok: true, account: { label: "crm@firma.at" } });
      expect(calls).toEqual([`list_contacts:space-${id}`]);
      // The space allows writing; the run's grant does not.
      const write = await inTenant(() =>
        broker.brokerCall({ who: step, where: where(run), connection, action: { id: "create_contact" }, input: {} }),
      );
      expect(write).toMatchObject({ ok: false, refused: "not_in_grant" });
      expect(await lastLine(id)).toMatchObject({ outcome: "deny", rule: "grant", result: "not_in_grant" });
      expect(calls).toHaveLength(1);
    } finally {
      await inTenant(() => client.db.delete(client.schema.spaceConnection));
      await maxsAccount();
    }
  });
});

describe("a fixed step on a connection where each person signs in", () => {
  async function eachSignsIn(): Promise<string> {
    const id = await spaceConnection({ signIn: "person", secret: null, label: null });
    await inTenant(() =>
      client.db.insert(client.schema.spaceConnectionSignIn).values({
        connectionId: id,
        userId: "user-m",
        label: "max@hubspot",
        secret: crypto.seal(tokens("max-sign-in")),
      }),
    );
    return id;
  }
  const stepCall = async (id: string, forWho: { kind: "person" | "guest"; id: string }, runId: string) => {
    const row = await inTenant(() =>
      client.db.query.spaceConnection.findFirst({ where: (t, { eq }) => eq(t.id, id) }),
    );
    const { hubspotConnector } = await import("../src/engenty/connections-hubspot/connector");
    return inTenant(() =>
      broker.brokerCall({
        who: { kind: "step", id: "save", for: forWho },
        where: where(runId, "save"),
        connection: { kind: "space_connection", row: row as never, connector: hubspotConnector as never },
        action: { id: "create_contact" },
        input: {},
      }),
    );
  };

  it("uses the sign-in of the person its run is held for", async () => {
    const id = await eachSignsIn();
    const result = await stepCall(id, member, await runRow());
    expect(result).toMatchObject({ ok: true, account: { label: "max@hubspot" } });
    expect(calls).toEqual(["create_contact:max-sign-in"]);
  });

  it("finds none for a guest", async () => {
    const id = await eachSignsIn();
    const result = await stepCall(id, guest, await runRow());
    expect(result).toMatchObject({ ok: false, refused: "not_connected" });
    expect(calls).toEqual([]);
  });
});
