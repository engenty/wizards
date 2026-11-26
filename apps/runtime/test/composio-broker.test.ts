import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { STAND_IN_KEY, startComposioStandIn } from "./composio-stand-in.shared";

/**
 * A connection of the space on a Composio toolkit (docs/plans/composio.md, steps 3 and 4): the
 * sign-in keeps only the connected account's id, every call goes through `brokerCall` (rules, ask,
 * log), and removing it signs out at Composio. With a key of one's own and through the
 * Manage-App, both against a stand-in.
 */
const composio = await startComposioStandIn();

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-composio-broker-"));
process.env.APP_URL = "http://localhost:5181";
process.env.ACCOUNT_URL = composio.origin;
process.env.COMPOSIO_URL = composio.origin;
delete process.env.COMPOSIO_API_KEY;
delete process.env.MANAGE_URL;
const outside = (process.env.FEATURES ?? "").split(",").filter((f) => f && !f.startsWith("composio"));
process.env.FEATURES = [...outside, "composio=on"].join(",");

vi.mock("../src/auth/account.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/auth/account.js")>()),
  accountToken: async () => "linked-account-token",
}));

let db: typeof import("../src/db/client");
let broker: typeof import("../src/broker/index");
let service: typeof import("../src/connectors/space-connections");
let external: typeof import("../src/connectors/external");
let client: typeof import("../src/connectors/composio");
let crypto: typeof import("../src/secrets/crypto");
let callback: typeof import("../src/routes/runs")["connectCallback"];
let space = "";

const TENANT = "tenant-composio-broker";
const inTenant = <T>(fn: () => Promise<T>) => db.withTenant(TENANT, fn);
const admin = { kind: "admin" as const, id: "user-a" };
const member = { kind: "person" as const, id: "user-m" };

beforeAll(async () => {
  db = await import("../src/db/client");
  await db.migrateControlDb();
  await db.openTenantDb(TENANT);
  broker = await import("../src/broker/index");
  service = await import("../src/connectors/space-connections");
  external = await import("../src/connectors/external");
  client = await import("../src/connectors/composio");
  crypto = await import("../src/secrets/crypto");
  callback = (await import("../src/routes/runs")).connectCallback;
  const spaces = await import("../src/services/spaces");
  space = (await inTenant(() => spaces.createSpace("user-a", "Vertrieb"))).id;
}, 60_000);
afterAll(() => composio.close());
beforeEach(() => {
  composio.seen.length = 0;
  composio.answer.execute = undefined;
  client.forgetComposioWay();
});

/** Follows the stand-in's sign-in page back to our callback, as the person's browser would. */
async function comeBack(signInUrl: string): Promise<string> {
  const back = new URL(decodeURIComponent(new URL(signInUrl).searchParams.get("next") ?? ""));
  const res = await callback.fetch(new Request(`http://localhost/callback${back.search}`));
  return res.text();
}

async function connection(name: string, signIn: "space" | "person", rules: Record<string, string>) {
  return inTenant(() =>
    service.createSpaceConnection("user-a", space, {
      connectorId: "composio-gmail",
      name,
      signIn,
      audience: "members",
      rules: rules as never,
      actions: [],
    }),
  );
}

const held = (id: string) =>
  inTenant(async () => {
    const row = await service.spaceConnectionById(id);
    return { kind: "space_connection" as const, row, connector: await service.connectorOfRow(row) };
  });

const call = async (id: string, who: typeof admin | typeof member, action: string, input: object = {}) =>
  inTenant(async () =>
    broker.brokerCall({
      who,
      where: { chatId: "chat-1", spaceId: space },
      connection: await held(id),
      action: { id: action },
      input,
      ctx: { confirmed: true },
    }),
  );

const logOf = (id: string) =>
  inTenant(() =>
    db.db.query.brokerLog.findMany({ where: (t, { eq: is }) => is(t.connectionId, id), orderBy: (t, { asc }) => [asc(t.at)] }),
  );

describe("with a key of one's own", () => {
  beforeAll(() => client.setComposioKey(STAND_IN_KEY));
  afterAll(() => client.setComposioKey(""));

  it("signs the space in at Composio and keeps only the connected account's id", async () => {
    const row = await connection("Gmail über Composio", "space", {
      read: "allow",
      write: "deny",
      destructive: "deny",
      send: "deny",
    });
    const url = await inTenant(() => service.startSpaceConnectionOAuth(row.id, { as: "space" }));
    expect(url).toMatch(/^https:\/\/connect\.composio\.test\//);
    expect(await comeBack(url)).toContain("Connected");

    const after = await inTenant(() => service.spaceConnectionById(row.id));
    const kept = crypto.unseal<{ accessToken: string; refreshToken: unknown; via: string }>(after.secret ?? "");
    expect(kept?.via).toBe("composio");
    expect(kept?.refreshToken).toBeNull();
    const secret = JSON.parse(kept?.accessToken ?? "{}");
    expect(secret).toEqual({ composio: expect.stringMatching(/^ca_own_/), way: "own", holder: `s:${space}`, toolkit: "gmail" });
    expect(composio.accounts.get(secret.composio)?.user_id).toBe(`s:${space}`);

    // The space lists the connector now that a connection is on it.
    const listed = await inTenant(() => external.listConnectors(space));
    expect(listed.find((c) => c.id === "composio-gmail")?.sourceKind).toBe("composio");
  });

  it("refuses an account in the address that isn't the one this sign-in made", async () => {
    const row = await connection("Gmail zwei", "space", { read: "allow", write: "deny", destructive: "deny", send: "deny" });
    const url = await inTenant(() => service.startSpaceConnectionOAuth(row.id, { as: "space" }));
    const back = new URL(decodeURIComponent(new URL(url).searchParams.get("next") ?? ""));
    // Someone else's account at the same Composio project.
    composio.accounts.set("ca_other", { user_id: "s:another-space", toolkit: "gmail", status: "ACTIVE" });
    back.searchParams.set("connected_account_id", "ca_other");
    const page = await (await callback.fetch(new Request(`http://localhost/callback${back.search}`))).text();
    expect(page).not.toContain("Connected");
    expect((await inTenant(() => service.spaceConnectionById(row.id))).secret).toBeNull();
  });

  it("runs a read through the broker and Composio, and refuses a send its rule forbids before Composio hears of it", async () => {
    const [row] = await inTenant(() =>
      db.db.query.spaceConnection.findMany({ where: (t, { eq: is }) => is(t.name, "Gmail über Composio") }),
    );
    const id = row?.id as string;
    const read = await call(id, admin, "fetch_emails", { query: "is:unread" });
    expect(read).toMatchObject({ ok: true, result: { ran: "GMAIL_FETCH_EMAILS", input: { query: "is:unread" } } });
    const ran = composio.seen.filter((s) => s.path.startsWith("/api/v3/tools/execute/"));
    expect(ran).toHaveLength(1);
    expect(ran[0]?.body).toMatchObject({ user_id: `s:${space}`, connected_account_id: expect.stringMatching(/^ca_own_/) });

    composio.seen.length = 0;
    const send = await call(id, admin, "send_email", { recipient_email: "kundin@example.com" });
    expect(send).toMatchObject({ ok: false, refused: "denied" });
    expect(composio.seen.some((s) => s.path.startsWith("/api/v3/tools/execute/"))).toBe(false);

    const lines = await logOf(id);
    expect(lines.map((l) => [l.actionId, l.kind, l.outcome])).toEqual([
      ["fetch_emails", "read", "allow"],
      ["send_email", "send", "deny"],
    ]);
  });

  it("a failure Composio reports reaches the caller and the log", async () => {
    const [row] = await inTenant(() =>
      db.db.query.spaceConnection.findMany({ where: (t, { eq: is }) => is(t.name, "Gmail über Composio") }),
    );
    composio.answer.execute = () => ({ status: 200, body: { successful: false, error: "Gmail said no" } });
    await expect(call(row?.id as string, admin, "fetch_emails")).rejects.toThrow(/Gmail said no/);
    expect((await logOf(row?.id as string)).at(-1)?.result).toBe("ComposioError");
  });

  it("removing the connection signs out at Composio", async () => {
    const [row] = await inTenant(() =>
      db.db.query.spaceConnection.findMany({ where: (t, { eq: is }) => is(t.name, "Gmail über Composio") }),
    );
    const kept = crypto.unseal<{ accessToken: string }>(row?.secret ?? "");
    const accountId = JSON.parse(kept?.accessToken ?? "{}").composio;
    expect(composio.accounts.has(accountId)).toBe(true);
    await inTenant(() => service.removeSpaceConnection("user-a", row?.id as string));
    expect(composio.accounts.has(accountId)).toBe(false);
  });
});

describe("through the Manage-App", () => {
  it("signs each person in with a ticket, calls through Manage, and signs out when the person does", async () => {
    expect(await client.composioWay()).toBe("account");
    const row = await connection("Gmail je Person", "person", {
      read: "allow",
      write: "ask",
      destructive: "deny",
      send: "ask",
    });
    const url = await inTenant(() =>
      service.startSpaceConnectionOAuth(row.id, { as: "person", userId: "user-m", role: "member" }),
    );
    expect(await comeBack(url)).toContain("Connected");
    const started = composio.seen.find((s) => s.path === "/v1/connect/composio/start");
    expect(started?.body).toMatchObject({ toolkit: "gmail", holder: "u:user-m" });
    expect(started?.headers.authorization).toBe("Bearer linked-account-token");

    // The admin has not signed in to it: nothing to call with.
    expect(await call(row.id, admin, "fetch_emails")).toMatchObject({ ok: false, refused: "not_connected" });
    const read = await call(row.id, member, "fetch_emails", { query: "x" });
    expect(read).toMatchObject({ ok: true, result: { ran: "GMAIL_FETCH_EMAILS" } });
    const executed = composio.seen.filter((s) => s.path === "/v1/connect/composio/execute");
    expect(executed).toHaveLength(1);
    expect(executed[0]?.body).toMatchObject({ tool: "GMAIL_FETCH_EMAILS", input: { query: "x" } });
    // Nothing reached Composio's own API: the runtime has no key.
    expect(composio.seen.some((s) => s.path.startsWith("/api/v3/"))).toBe(false);

    const signIn = await inTenant(() =>
      db.db.query.spaceConnectionSignIn.findFirst({
        where: (t, { and, eq: is }) => and(is(t.connectionId, row.id), is(t.userId, "user-m")),
      }),
    );
    const accountId = JSON.parse(crypto.unseal<{ accessToken: string }>(signIn?.secret ?? "")?.accessToken ?? "{}").composio;
    expect(accountId).toMatch(/^ca_manage_/);
    await inTenant(() => service.removeSignIn(row.id, { as: "person", userId: "user-m", role: "member" }));
    expect(composio.accounts.has(accountId)).toBe(false);
    expect(composio.seen.some((s) => s.method === "DELETE" && s.path === `/v1/connect/composio/accounts/${accountId}`)).toBe(true);
  });

  it("can't start where the Manage-App offers no Composio and no key is there", async () => {
    composio.offers.composio = false;
    client.forgetComposioWay();
    try {
      const rows = await inTenant(() =>
        db.db.select().from(db.schema.spaceConnection).where(eq(db.schema.spaceConnection.name, "Gmail je Person")),
      );
      // Without either way Composio's connectors can't be made: the connection's connector is gone.
      await expect(
        inTenant(() => service.startSpaceConnectionOAuth(rows[0]?.id as string, { as: "person", userId: "user-m", role: "member" })),
      ).rejects.toThrow();
    } finally {
      composio.offers.composio = true;
    }
  });
});
