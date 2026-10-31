import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noteText } from "@engenty/wizards-shared/run";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * The broker (docs/plans/broker.md): every connector call goes through `brokerCall`, which knows
 * who calls, decides by the rules the code had before it, runs the action and logs the call.
 * HubSpot is played by a stubbed connector that takes keys and has a read, a write and a delete.
 */
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-broker-"));
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

// A run starts whatever model this test machine lacks: the grant is what is under test.
vi.mock("../src/engine/requirements", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/engine/requirements")>()),
  missingModelsSaid: async () => [],
  stepsWithoutModel: async () => new Set<string>(),
}));

let client: typeof import("../src/db/client");
let broker: typeof import("../src/broker/index");
let connections: typeof import("../src/connectors/plugin-connections");
let runner: typeof import("../src/engine/runner");
let space: string;
let wizardId: string;

const TENANT = "tenant-b";
const inTenant = <T>(fn: () => Promise<T>) => client.withTenant(TENANT, fn);
const TOKEN = "pat-secret-7";

const definition = {
  version: 1,
  title: "Leads",
  description: "Leads into HubSpot",
  avatar: "dome",
  steps: [
    { id: "start", type: "page", title: "You", fields: [{ id: "email", kind: "text", label: "Mail" }] },
    { id: "done", type: "result", title: "Done", deliverables: [] },
  ],
};

/** The wizard's connection to HubSpot, as its definition would declare it. */
const hub = (policy?: Record<string, "allow" | "ask">) => ({
  id: "hub",
  connector: "hubspot",
  actions: ["list_contacts", "create_contact", "delete_contact"],
  ...(policy ? { policy } : {}),
});

const member = { wizardId: "", holder: "u:user-b" };

/** The definition a run holds: the page, an agent step on HubSpot, the result. */
const withStep = (actions?: string[], tools: string[] = []) => ({
  ...definition,
  connections: [{ id: "hub", connector: "hubspot", ...(actions ? { actions } : {}) }],
  steps: [
    definition.steps[0],
    { id: "sync", type: "agent", title: "Sync", instructions: "Sync the lead.", tools, connections: ["hub"] },
    definition.steps[1],
  ],
});

/** A run row as `createRun` leaves it, with this grant (null: from before grants were kept). */
async function runRow(id: string, def: Record<string, unknown>, grant: unknown) {
  await inTenant(() =>
    client.db.insert(client.schema.run).values({
      id,
      wizardId,
      tenantId: TENANT,
      definition: def as never,
      files: [],
      grant: grant as never,
      version: null,
      mode: "live",
      userId: "user-b",
      status: "waiting_input",
      cursor: "start",
      state: { values: {}, outputs: {}, history: [], notes: {} },
    }),
  );
}

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
  connections = await import("../src/connectors/plugin-connections");
  runner = await import("../src/engine/runner");
  const spaces = await import("../src/services/spaces");
  const wizards = await import("../src/services/wizards");
  space = (await inTenant(() => spaces.createSpace("user-b", "Vertrieb"))).id;
  wizardId = (await inTenant(() => wizards.createWizard("user-b", { definition }))).id;
  member.wizardId = wizardId;
  const { putSecret } = await import("../src/store/index");
  await inTenant(() =>
    putSecret(member, "connection:hub", "hubspot", "HubSpot", {
      accessToken: JSON.stringify({ access_token: TOKEN }),
      refreshToken: null,
      expiresAt: null,
      scopes: [],
    }),
  );
  // The member's run: its step may call every action of the wizard's HubSpot connection.
  await runRow("run-m", withStep(["list_contacts", "create_contact", "delete_contact"]), null);
}, 60_000);

describe("a plugin's connection", () => {
  const shop = () => connections.pluginConnections("shop");
  let id = "";

  beforeAll(async () => {
    id = (
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

  it("refuses a write from a guest's run (the space's sign-in never writes for a guest), and logs it as critical", async () => {
    const guest = {
      who: { kind: "guest" as const, id: "visitor-1" },
      where: { runId: "run-g", wizardId, spaceId: space, mode: "live" as const, guest: true },
    };
    await expect(
      inTenant(() =>
        broker.withCaller(guest, () => shop().call(id, "create_contact", { email: "a@b.at" })),
      ),
    ).rejects.toThrow(/only reads/);
    const [row] = await logOf(id);
    expect(row).toMatchObject({
      whoKind: "guest",
      whoId: "visitor-1",
      runId: "run-g",
      wizardId,
      spaceId: space,
      actionId: "create_contact",
      kind: "write",
      outcome: "deny",
      result: "ai_step_writes",
      critical: true,
    });
    expect(calls).toEqual([]);
  });

  it("lets a guest's run read, and logs the read", async () => {
    const guest = {
      who: { kind: "guest" as const, id: "visitor-1" },
      where: { runId: "run-g", wizardId, spaceId: space, mode: "live" as const, guest: true },
    };
    const listed = await inTenant(() =>
      broker.withCaller(guest, () => shop().call<{ contacts: unknown[] }>(id, "list_contacts", {})),
    );
    expect(listed.contacts).toHaveLength(1);
    const rows = await logOf(id);
    expect(rows.at(-1)).toMatchObject({
      whoKind: "guest",
      actionId: "list_contacts",
      kind: "read",
      outcome: "allow",
      result: "ok",
      critical: false,
    });
    expect(rows.at(-1)?.resultSize).toBeGreaterThan(0);
  });

  it("runs the plugin's own writes (a job with no run) as the plugin", async () => {
    calls.length = 0;
    await inTenant(() => shop().call(id, "create_contact", { email: "job@b.at" }));
    expect(calls).toHaveLength(1);
    expect(calls[0].token).toContain(TOKEN);
    const rows = await logOf(id);
    expect(rows.at(-1)).toMatchObject({
      whoKind: "plugin",
      whoId: "shop",
      runId: null,
      spaceId: space,
      kind: "write",
      outcome: "allow",
    });
    expect(await inTenant(() => broker.lastUseOf(id))).toMatchObject({
      who: { kind: "plugin", id: "shop" },
      actionId: "create_contact",
      outcome: "allow",
    });
  });

  it("keeps no secret in the log", async () => {
    const rows = await logOf(id);
    for (const row of rows) {
      expect(JSON.stringify(row)).not.toContain(TOKEN);
      const summary = JSON.parse(row.inputSummary);
      expect(summary.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    const written = rows.find((r) => r.actionId === "create_contact" && r.whoKind === "plugin");
    expect(JSON.parse(written?.inputSummary ?? "{}")).toMatchObject({
      fields: { email: 8 },
      sample: "email: job@b.at",
    });
  });
});

describe("a wizard's connection, as the person running it", () => {
  const held = (policy?: Record<string, "allow" | "ask">) =>
    ({ kind: "store_secret", def: hub(policy), scope: member, spaceId: space }) as const;
  const who = { kind: "person" as const, id: "user-b" };
  const where = { runId: "run-m", wizardId, spaceId: space, mode: "live" as const, guest: false };

  it("reads without asking, and logs it", async () => {
    const ask = vi.fn();
    const out = await inTenant(() =>
      broker.brokerCall({
        who,
        where,
        connection: held(),
        action: { id: "list_contacts" },
        input: {},
        ctx: { ask },
      }),
    );
    expect(out.ok).toBe(true);
    expect(ask).not.toHaveBeenCalled();
    const rows = await logOf("hub");
    expect(rows.at(-1)).toMatchObject({
      whoKind: "person",
      whoId: "user-b",
      runId: "run-m",
      kind: "read",
      outcome: "allow",
      result: "ok",
    });
  });

  it("asks before a write, remembers a yes for the run, and logs the ask", async () => {
    calls.length = 0;
    const ask = vi.fn(async () => ({ type: "done" as const, remember: true }));
    const allowed = new Set<string>();
    const out = await inTenant(() =>
      broker.brokerCall({
        who,
        where,
        connection: held(),
        action: { id: "create_contact" },
        input: { email: "x@y.at" },
        ctx: { ask, allowed },
      }),
    );
    expect(out.ok).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toMatchObject({
      kind: "confirm",
      service: "HubSpot",
      action: { id: "create_contact", destructive: false },
    });
    expect(allowed.has("hub:create_contact")).toBe(true);
    expect(calls.map((c) => c.action)).toEqual(["create_contact"]);
    expect((await logOf("hub")).at(-1)).toMatchObject({
      kind: "write",
      outcome: "ask",
      result: "ok",
    });
    // Allowed for the rest of the run: the next one runs without a question.
    await inTenant(() =>
      broker.brokerCall({
        who,
        where,
        connection: held(),
        action: { id: "create_contact" },
        input: { email: "z@y.at" },
        ctx: { ask, allowed },
      }),
    );
    expect(ask).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
  });

  it("refuses a write the person declines, or that nobody can be asked about", async () => {
    calls.length = 0;
    const declined = await inTenant(() =>
      broker.brokerCall({
        who,
        where,
        connection: held(),
        action: { id: "create_contact" },
        input: { email: "x@y.at" },
        ctx: { ask: async () => ({ type: "skip" as const }) },
      }),
    );
    expect(declined).toMatchObject({ ok: false, refused: "declined" });
    const nobody = await inTenant(() =>
      broker.brokerCall({
        who,
        where,
        connection: held(),
        action: { id: "create_contact" },
        input: { email: "x@y.at" },
      }),
    );
    expect(nobody).toMatchObject({ ok: false, refused: "nobody" });
    expect(calls).toEqual([]);
    const rows = await logOf("hub");
    expect(rows.slice(-2).map((r) => [r.outcome, r.result])).toEqual([
      ["ask", "declined"],
      ["ask", "nobody"],
    ]);
  });

  it("runs a write the wizard's policy allows, and always asks before a delete", async () => {
    const ask = vi.fn(async () => ({ type: "done" as const }));
    const allowed = await inTenant(() =>
      broker.brokerCall({
        who,
        where,
        connection: held({ create_contact: "allow" }),
        action: { id: "create_contact" },
        input: { email: "x@y.at" },
        ctx: { ask },
      }),
    );
    expect(allowed.ok).toBe(true);
    expect(ask).not.toHaveBeenCalled();
    // Even what the person asked for themselves (a share) asks again before deleting.
    const deleted = await inTenant(() =>
      broker.brokerCall({
        who,
        where,
        connection: held({ delete_contact: "allow" }),
        action: { id: "delete_contact" },
        input: { id: "7" },
        ctx: { ask, confirmed: true },
      }),
    );
    expect(deleted.ok).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toMatchObject({ action: { destructive: true } });
  });

  it("runs a confirmed write without asking (a share the person sent)", async () => {
    const ask = vi.fn();
    const out = await inTenant(() =>
      broker.brokerCall({
        who,
        where,
        connection: held(),
        action: { id: "create_contact" },
        input: { email: "x@y.at" },
        ctx: { ask, confirmed: true },
      }),
    );
    expect(out.ok).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it("says what is connected without handing out the secret", async () => {
    const found = await inTenant(() => broker.brokerConnected(held()));
    expect(found).toEqual({ connector: expect.objectContaining({ id: "hubspot" }), label: "HubSpot" });
    expect(found && "ctx" in found).toBe(false);
    const none = await inTenant(() =>
      broker.brokerCall({
        who,
        where,
        connection: { ...held(), scope: { wizardId, holder: "v:stranger" } },
        action: { id: "list_contacts" },
        input: {},
      }),
    );
    expect(none).toMatchObject({ ok: false, refused: "not_connected" });
  });

  it("decides the same with no side effect", () => {
    const guest = { kind: "guest" as const, id: "v" };
    const plugin = {
      kind: "space_connection" as const,
      row: {
        id: "p1",
        plugin: "shop",
        signIn: "space",
        audience: "all",
        rules: { read: "allow", write: "ask", destructive: "deny", send: "ask" },
        actions: [],
      } as never,
      connector: {} as never,
    };
    // A guest's AI step: a write as the space is denied before any rule (A4).
    expect(
      broker.decide({
        who: guest,
        where: { guest: true, runId: "run-g" },
        connection: plugin,
        actionId: "x",
        kind: "write",
      }).outcome,
    ).toBe("deny");
    // In a Work chat the same write is a confirmed action: „Mit Freigabe“ asks the admins (A7).
    expect(
      broker.decide({ who: { kind: "person", id: "m" }, where: { chatId: "c" }, connection: plugin, actionId: "x", kind: "write" }),
    ).toMatchObject({ outcome: "ask", admins: true });
    expect(
      broker.decide({ who: guest, where: { guest: true }, connection: plugin, actionId: "x", kind: "read" })
        .outcome,
    ).toBe("allow");
    expect(
      broker.decide({ who, where, connection: held(), actionId: "delete_contact", kind: "destructive" })
        .outcome,
    ).toBe("ask");
  });
});

describe("the run's grant, fixed at start", () => {
  const who = { kind: "person" as const, id: "user-b" };
  const held = (def: Record<string, unknown>) =>
    ({ kind: "store_secret", def: def as never, scope: member, spaceId: space }) as const;

  it("comes from the steps: their connections with the actions they may use, their tools", () => {
    const def = {
      ...definition,
      connections: [
        { id: "hub", connector: "hubspot", actions: ["create_contact"] },
        { id: "inbox", kind: "mail" },
        { id: "unused", connector: "hubspot" },
      ],
      steps: [
        definition.steps[0],
        { id: "read", type: "agent", title: "Read", instructions: "", tools: ["web_search", "shop.find"], connections: ["inbox"] },
        { id: "write", type: "agent", title: "Write", instructions: "", tools: ["web_search", "http"], connections: ["hub", "inbox"] },
        definition.steps[1],
      ],
    };
    expect(broker.grantOf(def as never)).toEqual({
      connections: { hub: ["create_contact"], inbox: ["read"] },
      hosts: [],
      tools: ["http", "shop.find", "web_search"],
    });
    expect(broker.grantOf(definition as never)).toEqual({ connections: {}, hosts: [], tools: [] });
  });

  it("says what the run may do, in the person's language", () => {
    const def = withStep(undefined, ["web_search", "sandbox", "shop.find"]);
    const said = broker.grantNote(broker.grantOf(def as never), def as never);
    expect(said && noteText(said, "de")).toBe(
      "Dieser Lauf darf: in hubspot lesen, im Web suchen, Code ausführen, das Plugin shop nutzen",
    );
    const named = { ...def, connections: [{ id: "hub", connector: "hubspot", title: "HubSpot", actions: ["create_contact", "list_contacts"] }] };
    const known = { hub: { name: "HubSpot", kinds: { create_contact: "write" as const, list_contacts: "read" as const } } };
    const line = broker.grantNote(broker.grantOf(named as never), named as never, known);
    expect(line && noteText(line, "en")).toBe(
      "This run may: read in HubSpot, write in HubSpot, search the web, run code, use the plugin shop",
    );
    expect(broker.grantNote(broker.grantOf(definition as never), definition as never)).toBeNull();
  });

  it("refuses an action outside the grant before any rule, and logs it as critical", async () => {
    calls.length = 0;
    await runRow("run-r", withStep(), { connections: { hub: ["read"] }, hosts: [], tools: [] });
    const where = { runId: "run-r", wizardId, spaceId: space, mode: "live" as const, guest: false };
    const ask = vi.fn(async () => ({ type: "done" as const }));
    const denied = await inTenant(() =>
      broker.brokerCall({
        who,
        where,
        connection: held(hub()),
        action: { id: "create_contact" },
        input: { email: "x@y.at" },
        ctx: { ask },
      }),
    );
    expect(denied).toMatchObject({ ok: false, refused: "not_in_grant" });
    expect(ask).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect((await logOf("hub")).at(-1)).toMatchObject({
      runId: "run-r",
      actionId: "create_contact",
      outcome: "deny",
      result: "not_in_grant",
      critical: true,
    });
    // What the grant names by kind runs.
    const read = await inTenant(() =>
      broker.brokerCall({ who, where, connection: held(hub()), action: { id: "list_contacts" }, input: {} }),
    );
    expect(read.ok).toBe(true);
    // A connection no step lists is outside the grant too.
    const other = await inTenant(() =>
      broker.brokerCall({
        who,
        where,
        connection: held({ ...hub(), id: "other" }),
        action: { id: "list_contacts" },
        input: {},
      }),
    );
    expect(other).toMatchObject({ ok: false, refused: "not_in_grant" });
    // A run this tenant does not know has no grant: nothing runs for it.
    const unknown = await inTenant(() =>
      broker.brokerCall({
        who,
        where: { ...where, runId: "run-nowhere" },
        connection: held(hub()),
        action: { id: "list_contacts" },
        input: {},
      }),
    );
    expect(unknown).toMatchObject({ ok: false, refused: "not_in_grant" });
  });

  it("does not bind a share target's connection: the person's own request after the run", async () => {
    const where = { runId: "run-r", wizardId, spaceId: space, mode: "live" as const, guest: false };
    const target = { ...hub(), target: { connectors: ["hubspot"] } };
    const out = await inTenant(() =>
      broker.brokerCall({
        who,
        where,
        connection: held(target),
        action: { id: "create_contact" },
        input: { email: "share@y.at" },
        ctx: { confirmed: true },
      }),
    );
    expect(out.ok).toBe(true);
  });

  it("is computed when the run starts – a test run from the draft – and an edit never widens it", async () => {
    const draft = withStep(["create_contact"], ["web_search"]);
    const runId = await inTenant(() =>
      runner.createRun({
        wizardId,
        definition: draft as never,
        files: [],
        version: null,
        mode: "test",
        userId: "user-b",
      }),
    );
    const row = () =>
      inTenant(() => client.db.query.run.findFirst({ where: (t, { eq }) => eq(t.id, runId) }));
    expect((await row())?.grant).toEqual({
      connections: { hub: ["create_contact"] },
      hosts: [],
      tools: ["web_search"],
    });
    const events = await inTenant(() =>
      client.db.query.runEvent.findMany({ where: (t, { eq }) => eq(t.runId, runId) }),
    );
    expect(events.map((e) => e.note?.code)).toEqual(["grant"]);
    expect(events[0].message).toBe("This run may: write in HubSpot, search the web");
    // The wizard is edited while the run is under way: the run keeps the grant it started with.
    const wider = withStep(["create_contact", "delete_contact"], ["web_search", "http"]);
    await inTenant(() =>
      client.db
        .update(client.schema.wizard)
        .set({ draft: wider as never })
        .where(eq(client.schema.wizard.id, wizardId)),
    );
    expect(await inTenant(() => broker.runGrant(runId))).toEqual({
      connections: { hub: ["create_contact"] },
      hosts: [],
      tools: ["web_search"],
    });
    const where = { runId, wizardId, spaceId: space, mode: "test" as const, guest: false };
    const out = await inTenant(() =>
      broker.brokerCall({ who, where, connection: held(hub()), action: { id: "delete_contact" }, input: { id: "7" } }),
    );
    expect(out).toMatchObject({ ok: false, refused: "not_in_grant" });
  });

  it("gives a run from before grants were kept one from its definition, once", async () => {
    await runRow("run-old", withStep(["list_contacts"]), null);
    const grant = { connections: { hub: ["list_contacts"] }, hosts: [], tools: [] };
    expect(await inTenant(() => broker.runGrant("run-old"))).toEqual(grant);
    const row = await inTenant(() =>
      client.db.query.run.findFirst({ where: (t, { eq }) => eq(t.id, "run-old") }),
    );
    expect(row?.grant).toEqual(grant);
    expect(await inTenant(() => broker.runGrant("run-old"))).toEqual(grant);
  });
});

describe("fixed steps write, AI steps on space connections read", () => {
  let crm = "";
  /** The wizard's entry for the space's connection. */
  const viaSpace = (actions?: string[]) => ({
    id: "crm",
    spaceConnection: crm,
    title: "CRM",
    ...(actions ? { actions } : {}),
  });
  /** A step with a fixed `call`: the action and the fields are the wizard's. */
  const fixed = (connection: string, action = "create_contact") => ({
    id: "save",
    type: "agent",
    title: "Save",
    instructions: "",
    tools: [],
    call: { connection, action, input: { email: "{{email}}", id: "{{steps.read.id}}" } },
    output: { format: "json" },
  });
  /** The step that reads the id the fixed step sends along. */
  const read = {
    id: "read",
    type: "agent",
    title: "Read",
    instructions: "Find the contact's id.",
    tools: [],
    output: { format: "json", fields: [{ id: "id", kind: "text", description: "The id" }] },
  };
  const withFixed = (connection: Record<string, unknown>, step = fixed(connection.id as string)) => ({
    ...definition,
    connections: [connection],
    steps: [definition.steps[0], read, step, definition.steps[1]],
  });

  /** A step's context as far as a fixed step and the connector tools read it. */
  function contextOf(
    def: Record<string, unknown>,
    runId: string,
    holder: { kind: "guest"; id: string } | { kind: "person"; id: string; role: "member" },
    ask: (ask: unknown) => Promise<unknown>,
  ) {
    const state = {
      values: { email: "lead@b.at" },
      outputs: { read: { json: { id: "c-42" }, at: "" } },
      history: [],
      notes: {},
    };
    return {
      runId,
      tenantId: TENANT,
      holder,
      test: false,
      stepId: "save",
      store: { wizardId, holder: holder.kind === "guest" ? `v:${holder.id}` : `u:${holder.id}` },
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
      ask,
      call: {},
    } as unknown as import("../src/engine/types").StepContext;
  }

  beforeAll(async () => {
    // The space's CRM: signs in as the space, open to everyone, writes allowed.
    crm = (
      await inTenant(() =>
        connections.pluginConnections("crm").connect({
          space,
          connector: "hubspot",
          actions: [],
          credentials: { access_token: TOKEN },
        }),
      )
    ).id;
    await inTenant(() =>
      client.db
        .update(client.schema.spaceConnection)
        .set({ rules: { read: "allow", write: "allow", destructive: "deny", send: "allow" } })
        .where(eq(client.schema.spaceConnection.id, crm)),
    );
  });

  it("a fixed step writes as the space with the run's fields, asking nobody, and the log says the step", async () => {
    calls.length = 0;
    const def = withFixed(viaSpace());
    const ask = vi.fn();
    const steps = await import("../src/engine/steps");
    const out = await inTenant(() =>
      steps.runAgentStep(
        def.steps[2] as never,
        contextOf(def, "run-f", { kind: "guest", id: "visitor-9" }, ask),
      ),
    );
    expect(out.json).toEqual({ done: "create_contact", contacts: [{ id: "7" }] });
    expect(ask).not.toHaveBeenCalled();
    expect(calls).toEqual([
      { action: "create_contact", input: { email: "lead@b.at", id: "c-42" }, token: expect.stringContaining(TOKEN) },
    ]);
    expect((await logOf(crm)).at(-1)).toMatchObject({
      whoKind: "step",
      whoId: "save",
      runId: "run-f",
      wizardId,
      actionId: "create_contact",
      kind: "write",
      outcome: "allow",
      result: "ok",
      critical: false,
    });
  });

  it("refuses a write from an AI step on a connection that signs in as the space, whatever the wizard says, and logs it", async () => {
    calls.length = 0;
    const held = {
      kind: "space_connection" as const,
      row: (await inTenant(() =>
        client.db.query.spaceConnection.findFirst({ where: (t, { eq }) => eq(t.id, crm) }),
      )) as never,
      connector: (await import("../src/engenty/connections-hubspot/connector")).hubspotConnector,
    };
    const where = { runId: "run-f", wizardId, spaceId: space, mode: "live" as const, guest: false };
    const ask = vi.fn(async () => ({ type: "done" as const }));
    for (const who of [
      { kind: "person" as const, id: "user-b" },
      { kind: "admin" as const, id: "user-a" },
      { kind: "guest" as const, id: "visitor-9" },
    ]) {
      const out = await inTenant(() =>
        broker.brokerCall({
          who,
          where,
          connection: held,
          action: { id: "create_contact" },
          input: { email: "x@y.at" },
          ctx: { ask, allowed: new Set(["crm:create_contact"]), confirmed: true },
        }),
      );
      expect(out).toMatchObject({ ok: false, refused: "ai_step_writes" });
    }
    expect(ask).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect((await logOf(crm)).at(-1)).toMatchObject({
      whoKind: "guest",
      actionId: "create_contact",
      kind: "write",
      outcome: "deny",
      result: "ai_step_writes",
      critical: true,
    });
    // Reading is what an AI step does there.
    const read = await inTenant(() =>
      broker.brokerCall({ who: { kind: "person", id: "user-b" }, where, connection: held, action: { id: "list_contacts" }, input: {} }),
    );
    expect(read.ok).toBe(true);
    // A Work chat is no AI step of a run: the connection's rule decides (A7 puts it on the broker).
    const chat = broker.decide({
      who: { kind: "person", id: "user-b" },
      where: { chatId: "chat-1", spaceId: space },
      connection: held,
      actionId: "create_contact",
      kind: "write",
    });
    expect(chat.outcome).toBe("allow");
  });

  it("offers an AI step only the read actions of a connection that signs in as the space", async () => {
    const { toolsOf } = await import("../src/tools/connector");
    const def = withFixed(viaSpace(["list_contacts", "create_contact", "delete_contact"]));
    const ctx = contextOf(def, "run-f", { kind: "person", id: "user-b", role: "member" }, vi.fn());
    const tools = await inTenant(() => toolsOf(def.connections[0] as never, ctx, {} as never));
    expect(Object.keys(tools)).toEqual(["hubspot_list_contacts"]);
  });

  it("asks the person before a fixed step writes on their own connection", async () => {
    calls.length = 0;
    const def = withFixed(hub());
    await runRow("run-p", def, broker.grantOf(def as never));
    const ask = vi.fn(async () => ({ type: "done" as const }));
    const steps = await import("../src/engine/steps");
    const out = await inTenant(() =>
      steps.runAgentStep(
        def.steps[2] as never,
        contextOf(def, "run-p", { kind: "person", id: "user-b", role: "member" }, ask),
      ),
    );
    expect(out.json).toMatchObject({ done: "create_contact" });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toMatchObject({
      kind: "confirm",
      service: "HubSpot",
      action: { id: "create_contact", destructive: false },
    });
    expect(calls.map((c) => c.input)).toEqual([{ email: "lead@b.at", id: "c-42" }]);
    expect((await logOf("hub")).at(-1)).toMatchObject({
      whoKind: "step",
      whoId: "save",
      runId: "run-p",
      kind: "write",
      outcome: "ask",
      result: "ok",
    });
    // Declined: the step fails, in the person's words.
    await expect(
      inTenant(() =>
        steps.runAgentStep(
          def.steps[2] as never,
          contextOf(def, "run-p", { kind: "person", id: "user-b", role: "member" }, async () => ({ type: "skip" })),
        ),
      ),
    ).rejects.toThrow(/wasn’t allowed/);
  });

  it("puts a fixed step's connection and action into the run's grant", () => {
    const def = withFixed(hub());
    expect(broker.grantOf(def as never).connections).toEqual({ hub: ["create_contact"] });
    const both = {
      ...def,
      steps: [
        def.steps[0],
        { ...read, connections: ["hub"] },
        { ...def.steps[2], call: { connection: "hub", action: "delete_contact", input: {} } },
        def.steps[3],
      ],
    };
    expect(broker.grantOf(both as never).connections).toEqual({
      hub: ["create_contact", "delete_contact", "list_contacts"],
    });
  });

  it("the validator refuses an AI step that would write as the space, and a call to an action the connector lacks", async () => {
    const wizards = await import("../src/services/wizards");
    const { validateWizard } = await import("@engenty/wizards-shared/definition");
    const aiWrites = {
      ...definition,
      connections: [viaSpace(["list_contacts", "create_contact"])],
      steps: [
        definition.steps[0],
        { id: "sync", type: "agent", title: "Sync", instructions: "Sync it.", tools: [], connections: ["crm"], output: { format: "text" } },
        definition.steps[1],
      ],
    };
    const issues = await inTenant(() => wizards.checkDraft(space, aiWrites as never));
    expect(issues.map((i) => i.message)).toEqual([
      expect.stringMatching(/"create_contact" writes in CRM, which signs in as the space\. An AI step only reads there; put the write in a step with "call"/),
    ]);
    // A fixed step may write there.
    expect(await inTenant(() => wizards.checkDraft(space, withFixed(viaSpace()) as never))).toEqual([]);
    const noSuchAction = withFixed(viaSpace(), fixed("crm", "nope"));
    expect(
      (await inTenant(() => wizards.checkDraft(space, noSuchAction as never))).map((i) => i.message),
    ).toEqual([expect.stringMatching(/CRM has no action "nope"/)]);
    const gone = withFixed({ ...viaSpace(), spaceConnection: "sc-gone" });
    expect((await inTenant(() => wizards.checkDraft(space, gone as never))).map((i) => i.message)).toEqual([
      expect.stringMatching(/"sc-gone", which this space does not have/),
    ]);
    // The shared validator: the call names a connection the wizard has, and not a mailbox.
    expect(validateWizard(withFixed(hub(), fixed("nowhere")) as never).map((i) => i.message)).toEqual([
      'Step calls unknown connection "nowhere".',
    ]);
    expect(
      validateWizard(withFixed({ id: "inbox", kind: "mail" }, fixed("inbox", "send")) as never).map((i) => i.message),
    ).toEqual([expect.stringMatching(/is of kind "mail"/)]);
  });
});
