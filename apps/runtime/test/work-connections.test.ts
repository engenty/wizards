import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * Work chats and Goose call the broker (docs/plans/capabilities.md, A7). A Work chat's AI gets
 * the space's connections open to the person's role: reads as tools, writes as confirmed actions
 * that „Mit Freigabe“ holds again for the admins. Goose gets its person's own sign-ins alone and
 * asks them before a write. HubSpot is played by a stubbed connector with a read, a write and a
 * delete.
 */
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-work-connections-"));
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
          verify: async (keys: Record<string, string>) => ({
            label: `HubSpot ${keys.access_token.slice(-1)}`,
          }),
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

// An organization with roles: the Manage-App says who is who.
vi.mock("../src/manage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/manage.js")>()),
  managed: true,
  tenantInfo: async () => ({ limits: { build: true } }),
  tenantMembers: async () => ({
    members: [
      { userId: "user-a", role: "owner" },
      { userId: "user-m", role: "member" },
    ],
  }),
}));

let client: typeof import("../src/db/client");
let service: typeof import("../src/connectors/space-connections");
let work: typeof import("../src/services/work-connections");
let ai: typeof import("../src/services/work-ai");
let approvals: typeof import("../src/services/work-approvals");
let goose: typeof import("../src/agents/goose-connections");
let space: { id: string; name: string };
let chatId = "";

const TENANT = "tenant-d";
const inTenant = <T>(fn: () => Promise<T>) => client.withTenant(TENANT, fn);
const owner = { id: "user-a", role: "owner" as const, tenantId: TENANT };
const member = { id: "user-m", role: "member" as const, tenantId: TENANT };
const RULES = { read: "allow", write: "ask", destructive: "deny", send: "ask" } as const;

type Tool = { execute: (input: unknown) => Promise<unknown>; description: string };

async function logOf(connectionId: string) {
  return inTenant(() =>
    client.db.query.brokerLog.findMany({
      where: (t, { eq }) => eq(t.connectionId, connectionId),
      orderBy: (t, { asc }) => [asc(t.at)],
    }),
  );
}

async function connection(name: string, input: Partial<Parameters<typeof service.createSpaceConnection>[2]>) {
  const row = await inTenant(() =>
    service.createSpaceConnection("user-a", space.id, {
      connectorId: "hubspot",
      name,
      signIn: "space",
      audience: "members",
      rules: RULES,
      actions: [],
      ...input,
    }),
  );
  if (row.signIn === "space") {
    await inTenant(() =>
      service.signInWithCredentials(row.id, { as: "space" }, { access_token: "pat-space-5" }),
    );
  }
  return row;
}

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb(TENANT);
  service = await import("../src/connectors/space-connections");
  work = await import("../src/services/work-connections");
  ai = await import("../src/services/work-ai");
  approvals = await import("../src/services/work-approvals");
  goose = await import("../src/agents/goose-connections");
  const spaces = await import("../src/services/spaces");
  const chats = await import("../src/services/work-chats");
  const id = (await inTenant(() => spaces.createSpace("user-a", "Vertrieb"))).id;
  space = { id, name: "Vertrieb" };
  chatId = (await inTenant(() => chats.createChat(owner as never, { spaceId: id }))).id;
}, 60_000);

describe("a Work chat's connections", () => {
  let members = "";
  let adminsOnly = "";

  beforeAll(async () => {
    members = (await connection("Vertrieb", {})).id;
    adminsOnly = (await connection("Buchhaltung", { audience: "admins" })).id;
  });

  it("gives a member the connections open to members, their reads as tools and their writes as confirmed actions", async () => {
    const made = await inTenant(() =>
      work.workConnectionTools({ space, userId: "user-m", chatId }),
    );
    const names = Object.keys(made.tools);
    expect(names).toContain(`hubspot_${members}_list_contacts`);
    expect(names).toContain(`hubspot_${members}_create_contact`);
    expect(names.some((n) => n.includes(adminsOnly))).toBe(false);
    // The writes wait at the gate; the reads run.
    expect(ai.asksFirst(made.tools[`hubspot_${members}_create_contact`])).toBe(true);
    expect(ai.asksFirst(made.tools[`hubspot_${members}_list_contacts`])).toBe(false);
    expect((made.tools[`hubspot_${members}_create_contact`] as Tool).description).toContain(
      "admins approve it after them",
    );
    expect(made.labels[`hubspot_${members}_create_contact`]).toEqual({
      plugin: "Vertrieb",
      tool: "Create a contact",
      label: null,
    });
    // An admin reaches both.
    const asAdmin = await inTenant(() =>
      work.workConnectionTools({ space, userId: "user-a", chatId }),
    );
    expect(Object.keys(asAdmin.tools).some((n) => n.includes(adminsOnly))).toBe(true);
  });

  it("reads through the broker as the person, in the chat", async () => {
    calls.length = 0;
    const made = await inTenant(() =>
      work.workConnectionTools({ space, userId: "user-m", chatId }),
    );
    const out = await inTenant(() =>
      (made.tools[`hubspot_${members}_list_contacts`] as Tool).execute({}),
    );
    expect(out).toMatchObject({ result: expect.stringContaining("contacts") });
    expect(calls.at(-1)).toMatchObject({ action: "list_contacts", token: expect.stringContaining("pat-space-5") });
    expect((await logOf(members)).at(-1)).toMatchObject({
      whoKind: "person",
      whoId: "user-m",
      chatId,
      runId: null,
      kind: "read",
      outcome: "allow",
      result: "ok",
    });
  });

  it("holds a confirmed write for the admins when the rule says „Mit Freigabe“, and an admin's yes runs it", async () => {
    calls.length = 0;
    // The person confirmed the call on its card: the approved call runs for the chat.
    const confirmed = await inTenant(() =>
      ai.toolToRun(space, "user-m", `hubspot_${members}_create_contact`, new AbortController().signal, {
        chatId,
        byAdmin: false,
      }),
    );
    const held = (await inTenant(() => confirmed?.execute?.({ email: "a@b.at" }))) as {
      approval: string;
      status: string;
    };
    expect(held).toMatchObject({ approval: expect.any(String), status: "waiting" });
    expect(calls).toEqual([]);
    expect((await logOf(members)).at(-1)).toMatchObject({
      kind: "write",
      outcome: "ask",
      result: "needs_approval",
      critical: false,
    });
    const [row] = await inTenant(() => approvals.approvalsOf(chatId));
    expect(row).toMatchObject({
      id: held.approval,
      toolName: `hubspot_${members}_create_contact`,
      input: { email: "a@b.at" },
      askedBy: "user-m",
      heldFor: "admins",
      state: "pending",
    });
    // The asker is no admin: not theirs to decide. The owner sees it under the bell.
    expect(approvals.mayDecide(member as never, row)).toBe(false);
    expect(approvals.mayDecide(owner as never, row)).toBe(true);
    await expect(
      inTenant(() => approvals.takeDecision(member as never, chatId, held.approval, true)),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect((await inTenant(() => approvals.waitingFor(member as never, [chatId]))).length).toBe(0);
    expect((await inTenant(() => approvals.waitingFor(owner as never, [chatId]))).map((a) => a.id)).toEqual([
      held.approval,
    ]);
    const taken = await inTenant(() => approvals.takeDecision(owner as never, chatId, held.approval, true));
    expect(taken.heldFor).toBe("admins");

    const approved = await inTenant(() =>
      ai.toolToRun(space, "user-m", `hubspot_${members}_create_contact`, new AbortController().signal, {
        chatId,
        byAdmin: true,
      }),
    );
    const out = await inTenant(() => approved?.execute?.({ email: "a@b.at" }));
    expect(out).toMatchObject({ result: expect.stringContaining("create_contact") });
    expect(calls.map((c) => c.action)).toEqual(["create_contact"]);
    expect((await logOf(members)).at(-1)).toMatchObject({
      whoKind: "person",
      whoId: "user-m",
      kind: "write",
      outcome: "ask",
      reason: "An admin of the space approved it.",
      result: "ok",
    });
  });

  it("runs a confirmed write at once where the rule allows it, and refuses one the rule denies", async () => {
    calls.length = 0;
    await inTenant(() =>
      service.updateSpaceConnection("user-a", members, { rules: { ...RULES, write: "allow" } }),
    );
    const run = async () => {
      const tool = await inTenant(() =>
        ai.toolToRun(space, "user-m", `hubspot_${members}_create_contact`, new AbortController().signal, {
          chatId,
          byAdmin: false,
        }),
      );
      return inTenant(() => tool?.execute?.({ email: "c@d.at" }));
    };
    expect(await run()).toMatchObject({ result: expect.stringContaining("create_contact") });
    expect(calls.map((c) => c.action)).toEqual(["create_contact"]);
    await inTenant(() =>
      service.updateSpaceConnection("user-a", members, { rules: { ...RULES, write: "deny" } }),
    );
    await expect(run()).rejects.toThrow(/do not allow this action/);
    expect(calls.map((c) => c.action)).toEqual(["create_contact"]);
    expect((await logOf(members)).at(-1)).toMatchObject({ outcome: "deny", critical: true });
  });
});

describe("Goose's connections", () => {
  let own = "";
  const browser = { calls: [] as { toolCallName: string; args: unknown }[], confirmed: true };
  const input = (confirm: boolean) =>
    ({
      user: member,
      chat: { id: "goose-chat-1" },
      browserTools: confirm ? [{ name: "confirm_action", description: "", parameters: {} }] : [],
      onToolCall: () => undefined,
      onToolResult: () => undefined,
      callBrowser: async (call: { toolCallName: string; args: unknown }) => {
        browser.calls.push(call);
        return { confirmed: browser.confirmed };
      },
    }) as never;

  beforeAll(async () => {
    own = (await connection("Mein HubSpot", { signIn: "person" })).id;
  });

  it("has nothing before the person signed in, and never a connection that signs in as the space", async () => {
    expect(await inTenant(() => goose.gooseConnectionTools(input(true)))).toEqual({});
    await inTenant(() =>
      service.signInWithCredentials(
        own,
        { as: "person", userId: "user-m", role: "member" },
        { access_token: "pat-of-m-3" },
      ),
    );
    const tools = await inTenant(() => goose.gooseConnectionTools(input(true)));
    const names = Object.keys(tools);
    expect(names).toContain(`hubspot_${own}_list_contacts`);
    expect(names.every((n) => n.includes(own))).toBe(true);
  });

  it("reads with the person's own sign-in, as Goose for them", async () => {
    calls.length = 0;
    const tools = await inTenant(() => goose.gooseConnectionTools(input(true)));
    const out = await inTenant(() => (tools[`hubspot_${own}_list_contacts`] as Tool).execute({}));
    expect(out).toMatchObject({ result: expect.stringContaining("contacts") });
    expect(calls.at(-1)?.token).toContain("pat-of-m-3");
    expect((await logOf(own)).at(-1)).toMatchObject({
      whoKind: "goose",
      whoId: "user-m",
      chatId: "goose-chat-1",
      spaceId: space.id,
      outcome: "allow",
    });
  });

  it("asks the person on a card before a write, and runs it on their yes alone", async () => {
    calls.length = 0;
    browser.calls.length = 0;
    const tools = await inTenant(() => goose.gooseConnectionTools(input(true)));
    const create = tools[`hubspot_${own}_create_contact`] as Tool;
    expect(create.description).toContain("The person is asked before this runs");
    browser.confirmed = false;
    const declined = await inTenant(() => create.execute({ email: "e@f.at" }));
    expect(declined).toMatchObject({ error: expect.stringContaining("did not allow") });
    expect(browser.calls.at(-1)).toMatchObject({
      toolCallName: "confirm_action",
      args: { service: "HubSpot 3", action: "Create a contact", destructive: false },
    });
    expect(calls).toEqual([]);
    browser.confirmed = true;
    const done = await inTenant(() => create.execute({ email: "e@f.at" }));
    expect(done).toMatchObject({ result: expect.stringContaining("create_contact") });
    expect(calls.map((c) => c.action)).toEqual(["create_contact"]);
    expect((await logOf(own)).at(-1)).toMatchObject({ whoKind: "goose", kind: "write", outcome: "ask", result: "ok" });
    // Nothing waits for the admins: it is the person's own account.
    expect(await inTenant(() => approvals.approvalsOf(chatId))).not.toContainEqual(
      expect.objectContaining({ toolName: `hubspot_${own}_create_contact` }),
    );
  });

  it("makes no change where nobody can be asked (a client without the card)", async () => {
    calls.length = 0;
    const tools = await inTenant(() => goose.gooseConnectionTools(input(false)));
    const out = await inTenant(() => (tools[`hubspot_${own}_create_contact`] as Tool).execute({ email: "g@h.at" }));
    expect(out).toMatchObject({ error: expect.stringContaining("Nobody can confirm") });
    expect(calls).toEqual([]);
  });
});
