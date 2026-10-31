import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunView, ShareView } from "@engenty/wizards-shared/run";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * Ways out for guests (docs/plans/capabilities.md, A6): a guest's run reaches only the hosts its
 * grant lists, sends mail only to its own address or the space's domains and only a few times,
 * and what a step made from a connection the space keeps for its members stays in the space.
 * A member's run goes on as before while the `broker` switch is off.
 */
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-ways-out-"));
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";

const calls: { action: string; input: unknown }[] = [];

vi.mock("../src/engenty/connections-hubspot/connector", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/engenty/connections-hubspot/connector")>();
  const action = (id: string, group: "read" | "write", summary: string) => ({
    id,
    group,
    summary,
    description: summary,
    inputSchema: z.object({ email: z.string().optional() }),
    handler: async (input: unknown) => {
      calls.push({ action: id, input });
      return { contacts: [{ id: "7", email: "a@b.at" }] };
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
      ],
    },
  };
});

let client: typeof import("../src/db/client");
let broker: typeof import("../src/broker/index");
let connections: typeof import("../src/connectors/space-connections");
let app: typeof import("../src/app").default;
let space = "";
let wizardId = "";

const TENANT = "local";
const ORIGIN = "http://localhost:5181";
const VISITOR = "wz_vid=visitor-7";
const inTenant = <T>(fn: () => Promise<T>) => client.withTenant(TENANT, fn);

const definition = {
  version: 1,
  title: "Angebot",
  description: "Ein Angebot für dich",
  avatar: "dome",
  steps: [
    {
      id: "start",
      type: "page",
      title: "Du",
      fields: [{ id: "email", kind: "email", label: "E-Mail" }],
    },
    {
      id: "fetch",
      type: "agent",
      title: "Preise holen",
      instructions: "Hole die Preise.",
      tools: ["http"],
      hosts: ["api.example.com", "*.prices.example.org"],
      connections: ["crm"],
      output: { format: "markdown" },
    },
    {
      id: "write",
      type: "agent",
      title: "Angebot schreiben",
      instructions: "Schreibe das Angebot.",
      tools: [],
      output: { format: "markdown" },
    },
    {
      id: "done",
      type: "result",
      title: "Fertig",
      deliverables: [
        { from: "fetch", label: "Preise", formats: ["md"] },
        { from: "write", label: "Angebot", formats: ["md"] },
      ],
    },
  ],
};

const guest = { kind: "guest" as const, id: "visitor-7" };
const member = { kind: "person" as const, id: "local" };

/** A finished run with the step outputs in place: a guest's, or a member's. */
async function runRow(id: string, who: "guest" | "member", grant: unknown = null) {
  await inTenant(async () => {
    await client.db.insert(client.schema.run).values({
      id,
      wizardId,
      tenantId: TENANT,
      definition: definition as never,
      files: [],
      grant: grant as never,
      version: null,
      mode: "live",
      ...(who === "guest" ? { visitorId: "visitor-7" } : { userId: "local" }),
      status: "done",
      cursor: "done",
      state: {
        values: { email: "Kundin@Example.com" },
        outputs: {
          fetch: { text: "Preise: 10 €", at: new Date().toISOString() },
          write: { text: "Dein Angebot", at: new Date().toISOString() },
        },
        history: ["start"],
        notes: {},
      },
    });
    const control = await import("../src/tenants/control");
    await control.indexRun({ runId: id, visitorId: who === "guest" ? "visitor-7" : null });
  });
}

const where = (runId: string, who: "guest" | "member", stepId?: string) => ({
  runId,
  stepId,
  wizardId,
  spaceId: space,
  mode: "live" as const,
  guest: who === "guest",
});

async function logOf(connectionId: string) {
  return inTenant(() =>
    client.db.query.brokerLog.findMany({
      where: (t, { eq }) => eq(t.connectionId, connectionId),
      orderBy: (t, { asc }) => [asc(t.at)],
    }),
  );
}

const get = async <T>(path: string, cookie: string) => {
  const res = await app.fetch(new Request(`${ORIGIN}${path}`, { headers: { cookie } }));
  return { status: res.status, body: (await res.json()) as T };
};

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb(TENANT);
  broker = await import("../src/broker/index");
  connections = await import("../src/connectors/space-connections");
  app = (await import("../src/app")).default;
  const spaces = await import("../src/services/spaces");
  const wizards = await import("../src/services/wizards");
  space = (await inTenant(() => spaces.createSpace("local", "Vertrieb"))).id;
  wizardId = (await inTenant(() => wizards.createWizard("local", { definition, spaceId: space })))
    .id;
  await runRow("run-g", "guest", broker.grantOf(definition as never));
  await runRow("run-m", "member", broker.grantOf(definition as never));
}, 60_000);

describe("hosts in the grant", () => {
  it("collects the steps' hosts, and matches a name or what is below a wildcard", () => {
    const grant = broker.grantOf(definition as never);
    expect(grant.hosts).toEqual(["*.prices.example.org", "api.example.com"]);
    expect(broker.hostInGrant(grant, "api.example.com")).toBe(true);
    expect(broker.hostInGrant(grant, "API.Example.com")).toBe(true);
    expect(broker.hostInGrant(grant, "eu.prices.example.org")).toBe(true);
    expect(broker.hostInGrant(grant, "prices.example.org")).toBe(false);
    expect(broker.hostInGrant(grant, "example.com")).toBe(false);
    expect(broker.hostInGrant(grant, "evil.com")).toBe(false);
  });

  it("refuses a guest's request to a host not in the grant, and logs it as critical", async () => {
    const handler = vi.fn(async () => ({ status: 200 }));
    const out = await inTenant(() =>
      broker.brokerHost({
        who: guest,
        where: where("run-g", "guest", "fetch"),
        url: new URL("https://evil.com/collect?secret=1"),
        method: "POST",
        handler,
      }),
    );
    expect(out).toMatchObject({ ok: false, refused: "not_in_grant" });
    expect(handler).not.toHaveBeenCalled();
    const [row] = await logOf("host:evil.com");
    expect(row).toMatchObject({
      whoKind: "guest",
      runId: "run-g",
      stepId: "fetch",
      actionId: "http_request",
      kind: "send",
      outcome: "deny",
      result: "not_in_grant",
      critical: true,
    });
    // The query never reaches the log.
    expect(row.inputSummary).not.toContain("secret");
  });

  it("lets a guest's request to a host in the grant through", async () => {
    const handler = vi.fn(async () => ({ status: 200 }));
    const out = await inTenant(() =>
      broker.brokerHost({
        who: guest,
        where: where("run-g", "guest", "fetch"),
        url: new URL("https://eu.prices.example.org/v1/prices"),
        method: "GET",
        handler,
      }),
    );
    expect(out).toEqual({ ok: true, result: { status: 200 } });
    expect(handler).toHaveBeenCalledTimes(1);
    expect((await logOf("host:eu.prices.example.org")).at(-1)).toMatchObject({
      outcome: "allow",
      result: "ok",
      critical: false,
    });
  });

  it("lets a member's run reach any public host while the switch is off", async () => {
    const handler = vi.fn(async () => ({ status: 200 }));
    const out = await inTenant(() =>
      broker.brokerHost({
        who: member,
        where: where("run-m", "member", "fetch"),
        url: new URL("https://anywhere.example.net/"),
        method: "GET",
        handler,
      }),
    );
    expect(out.ok).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect((await logOf("host:anywhere.example.net")).at(-1)).toMatchObject({
      whoKind: "person",
      outcome: "allow",
    });
  });
});

describe("sends from a guest's run", () => {
  const send = (
    who: "guest" | "member",
    recipients: string[],
    handler = vi.fn(async () => "sent"),
  ) =>
    inTenant(() =>
      broker.brokerSend({
        who: who === "guest" ? guest : member,
        where: where(who === "guest" ? "run-g" : "run-m", who),
        recipients,
        input: { to: recipients, subject: "Dein Angebot" },
        handler,
      }),
    ).then((out) => ({ out, handler }));

  it("refuses a foreign address, and logs it as critical", async () => {
    const { out, handler } = await send("guest", ["stranger@elsewhere.net"]);
    expect(out).toMatchObject({ ok: false, refused: "not_allowed_recipient" });
    expect(handler).not.toHaveBeenCalled();
    expect((await logOf("mail:server")).at(-1)).toMatchObject({
      whoKind: "guest",
      kind: "send",
      outcome: "deny",
      result: "not_allowed_recipient",
      critical: true,
    });
  });

  it("sends to the address the run collected, three times, and refuses the fourth", async () => {
    for (let i = 0; i < 3; i++) {
      const { out, handler } = await send("guest", ["kundin@example.com"]);
      expect(out).toEqual({ ok: true, result: "sent" });
      expect(handler).toHaveBeenCalledTimes(1);
    }
    const { out, handler } = await send("guest", ["kundin@example.com"]);
    expect(out).toMatchObject({ ok: false, refused: "run_limit" });
    expect(handler).not.toHaveBeenCalled();
    expect((await logOf("mail:server")).at(-1)).toMatchObject({
      outcome: "deny",
      result: "run_limit",
      critical: true,
    });
  });

  it("sends to an address in the space's own domains, under the wizard's daily cap", async () => {
    await runRow("run-g2", "guest");
    const spaces = await import("../src/services/spaces");
    await inTenant(() => spaces.updateSpace("local", space, { mailDomains: ["Firma.AT"] }));
    const sendFrom = (recipients: string[]) =>
      inTenant(() =>
        broker.brokerSend({
          who: guest,
          where: where("run-g2", "guest"),
          recipients,
          input: { to: recipients },
          handler: async () => "sent",
        }),
      );
    expect(await sendFrom(["chef@firma.at", "team@buero.firma.at"])).toEqual({
      ok: true,
      result: "sent",
    });
    expect(await sendFrom(["chef@firma.at.evil.net"])).toMatchObject({
      ok: false,
      refused: "not_allowed_recipient",
    });
    // The wizard's guests have sent today's mails: four so far, the cap is set to four.
    await inTenant(() =>
      client.db
        .update(client.schema.wizard)
        .set({ dailyMailLimit: 4 })
        .where(eq(client.schema.wizard.id, wizardId)),
    );
    expect(await sendFrom(["chef@firma.at"])).toMatchObject({ ok: false, refused: "day_limit" });
    await inTenant(() =>
      client.db
        .update(client.schema.wizard)
        .set({ dailyMailLimit: 50 })
        .where(eq(client.schema.wizard.id, wizardId)),
    );
  });

  it("holds a send through a connection to the same rule", async () => {
    const row = await inTenant(() =>
      connections.createSpaceConnection("local", space, {
        connectorId: "hubspot",
        name: "Vertrieb",
        signIn: "space",
        audience: "all",
        rules: { read: "allow", write: "allow", destructive: "deny", send: "allow" },
        actions: [],
      }),
    );
    await inTenant(() =>
      connections.signInWithCredentials(row.id, { as: "space" }, { access_token: "pat-7" }),
    );
    const connection = {
      kind: "space_connection" as const,
      row: await inTenant(() => connections.spaceConnectionById(row.id)),
      connector: await inTenant(() => connections.connectorOfRow(row)),
    };
    // A fixed send step (A4) of a member's run: not bound.
    const handler = vi.fn(async () => "sent");
    const member$ = await inTenant(() =>
      broker.brokerCall({
        who: { kind: "step", id: "send", for: member },
        where: where("run-m", "member", "send"),
        connection,
        action: { id: "send_message", kind: "send" },
        input: { to: "stranger@elsewhere.net" },
        handler,
      }),
    );
    expect(member$.ok).toBe(true);
    // The same step in a guest's run: the recipient rule, before anything runs.
    const refused = await inTenant(() =>
      broker.brokerCall({
        who: { kind: "step", id: "send", for: guest },
        where: where("run-g2", "guest", "send"),
        connection,
        action: { id: "send_message", kind: "send" },
        input: { to: "stranger@elsewhere.net" },
        handler,
      }),
    );
    expect(refused).toMatchObject({ ok: false, refused: "not_allowed_recipient" });
    expect(handler).toHaveBeenCalledTimes(1);
    expect((await logOf(row.id)).at(-1)).toMatchObject({ outcome: "deny", critical: true });
  });

  it("knows a mail over SMTP as a send by its connector: the send rule and the recipient rule", async () => {
    const { smtpConnector } = await import("../src/connectors/smtp");
    const { DEFAULT_CONNECTION_RULES } = await import("@engenty/wizards-shared/connectors");
    const apiKey = (smtpConnector.auth as { apiKey: { verify: unknown } }).apiKey;
    const verify = apiKey.verify;
    apiKey.verify = async () => ({ label: "post@firma.at" });
    const row = await inTenant(() =>
      connections.createSpaceConnection("local", space, {
        connectorId: "smtp",
        name: "Postfach",
        signIn: "space",
        audience: "all",
        rules: DEFAULT_CONNECTION_RULES,
        actions: [],
      }),
    );
    await inTenant(() =>
      connections.signInWithCredentials(row.id, { as: "space" }, { email: "post@firma.at", password: "pw" }),
    );
    apiKey.verify = verify;
    const connection = {
      kind: "space_connection" as const,
      row: await inTenant(() => connections.spaceConnectionById(row.id)),
      connector: await inTenant(() => connections.connectorOfRow(row)),
    };
    await runRow("run-g-smtp", "guest", broker.grantOf(definition as never));
    // No kind given: the connector's group says it, as for any tool or step.
    const sendAs = (who: Parameters<typeof broker.brokerCall>[0]["who"], at: ReturnType<typeof where>, to: string) =>
      inTenant(() =>
        broker.brokerCall({
          who,
          where: at,
          connection,
          action: { id: "send_message" },
          input: { to: [to], subject: "Angebot", body_text: "Hallo" },
          handler: async () => "sent",
        }),
      );
    // An admin in a Work chat: the default rule for sending asks the space's admins, it is no delete.
    const admin = await sendAs({ kind: "admin", id: "local" }, { spaceId: space, chatId: "chat-1" } as never, "x@elsewhere.net");
    expect(admin).toMatchObject({ ok: false, refused: "needs_approval" });
    expect(admin.ok || admin.reason).toMatch(/sending asks the space's admins/);
    expect((await logOf(row.id)).at(-1)).toMatchObject({ kind: "send", rule: "rules.send" });
    // A fixed step of a guest's run: a stranger is refused before the rule asks anyone.
    const step = { kind: "step" as const, id: "send", for: guest };
    expect(await sendAs(step, where("run-g-smtp", "guest", "send"), "stranger@elsewhere.net")).toMatchObject({
      ok: false,
      refused: "not_allowed_recipient",
    });
    // The run's own address passes the recipient rule and waits for the admins, as the rule says.
    expect(await sendAs(step, where("run-g-smtp", "guest", "send"), "kundin@example.com")).toMatchObject({
      ok: false,
      refused: "needs_approval",
    });
  });

  it("lets a member's run send anywhere", async () => {
    const { out, handler } = await send("member", ["stranger@elsewhere.net"]);
    expect(out).toEqual({ ok: true, result: "sent" });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("results that stay in the space", () => {
  let connectionId = "";
  let memberCookie = "";

  beforeAll(async () => {
    const row = await inTenant(() =>
      connections.createSpaceConnection("local", space, {
        connectorId: "hubspot",
        name: "Kunden",
        signIn: "space",
        audience: "all",
        rules: { read: "allow", write: "ask", destructive: "deny", send: "ask" },
        actions: [],
      }),
    );
    connectionId = row.id;
    await inTenant(() =>
      connections.signInWithCredentials(row.id, { as: "space" }, { access_token: "pat-8" }),
    );
    // The step of the guest's run reads the connection, as a step would: logged with its step.
    const out = await inTenant(async () =>
      broker.brokerCall({
        who: guest,
        where: where("run-g", "guest", "fetch"),
        connection: {
          kind: "space_connection",
          row: await connections.spaceConnectionById(row.id),
          connector: await connections.connectorOfRow(row),
        },
        action: { id: "list_contacts" },
        input: {},
      }),
    );
    expect(out.ok).toBe(true);
    expect((await logOf(row.id)).at(-1)).toMatchObject({ stepId: "fetch", outcome: "allow" });
    const entered = await app.fetch(new Request(`${ORIGIN}/api/local/enter?k=test-key`));
    memberCookie = entered.headers.get("set-cookie")?.split(";")[0] ?? "";
  });

  it("shows the guest everything while the connection is open to everyone", async () => {
    expect(await inTenant(() => broker.keptStepIds({ id: "run-g", mode: "live", userId: null }))).toEqual(
      new Set(),
    );
    const { body } = await get<RunView>("/api/runs/run-g", VISITOR);
    expect(body.shown.map((s) => [s.step.id, s.output?.text, s.kept ?? false])).toEqual([
      ["fetch", "Preise: 10 €", false],
      ["write", "Dein Angebot", false],
    ]);
  });

  it("keeps the step's output in the space once the connection is for members, and says so", async () => {
    await inTenant(() =>
      connections.updateSpaceConnection("local", connectionId, { audience: "members" }),
    );
    expect(await inTenant(() => broker.keptStepIds({ id: "run-g", mode: "live", userId: null }))).toEqual(
      new Set(["fetch"]),
    );
    const { body } = await get<RunView>("/api/runs/run-g", VISITOR);
    expect(body.shown.map((s) => [s.step.id, s.output?.text ?? null, s.kept ?? false])).toEqual([
      ["fetch", null, true],
      ["write", "Dein Angebot", false],
    ]);
    expect(Object.keys(body.outputs)).toEqual(["write"]);
    expect(JSON.stringify(body)).not.toContain("Preise: 10");
    // Its download is not the guest's either.
    const download = await app.fetch(
      new Request(`${ORIGIN}/api/runs/run-g/steps/fetch/download?format=md`, {
        headers: { cookie: VISITOR },
      }),
    );
    expect(download.status).toBe(404);
  });

  it("hides it on the share link too", async () => {
    const shares = await import("../src/services/shares");
    const run = await inTenant(() =>
      client.db.query.run.findFirst({ where: eq(client.schema.run.id, "run-g") }),
    );
    const { url } = await inTenant(() => shares.shareRun(run as never));
    const token = url.split("/s/")[1];
    const { body } = await get<ShareView>(`/api/shares/${token}`, "");
    expect(body.shown.map((s) => [s.step.id, s.output, s.kept ?? false])).toEqual([
      ["fetch", null, true],
      ["write", expect.objectContaining({ text: "Dein Angebot" }), false],
    ]);
    const download = await app.fetch(
      new Request(`${ORIGIN}/api/shares/${token}/steps/fetch/download?format=md`),
    );
    expect(download.status).toBe(404);
  });

  it("shows a member of the team the whole run (Ergebnisse)", async () => {
    const { status, body } = await get<RunView>("/api/runs/run-g", memberCookie);
    expect(status).toBe(200);
    expect(body.shown.map((s) => [s.step.id, s.output?.text ?? null])).toEqual([
      ["fetch", "Preise: 10 €"],
      ["write", "Dein Angebot"],
    ]);
  });

  it("keeps nothing of a member's own run", async () => {
    expect(
      await inTenant(() => broker.keptStepIds({ id: "run-m", mode: "live", userId: "local" })),
    ).toEqual(new Set());
  });
});
