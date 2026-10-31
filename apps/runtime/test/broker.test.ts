import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

let client: typeof import("../src/db/client");
let broker: typeof import("../src/broker/index");
let connections: typeof import("../src/connectors/plugin-connections");
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

  it("refuses a write from a guest's run, and logs the refusal as critical", async () => {
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
      result: "denied",
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
      kind: "plugin_connection" as const,
      row: { id: "p1" } as never,
      connector: {} as never,
    };
    expect(
      broker.decide({ who: guest, where: { guest: true }, connection: plugin, actionId: "x", kind: "write" })
        .outcome,
    ).toBe("deny");
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
