import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Connected accounts are sealed with a public key and opened with a private key only the broker
 * holds (docs/plans/runs-on-their-own.md, 7.1). A runtime alone derives the pair; a cloud sets
 * `ACCOUNTS_KEY` on the broker and `ACCOUNTS_PUBLIC_KEY` everywhere else. `wizards
 * reseal-accounts` seals once more what the store key sealed before.
 */
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-accounts-sealed-"));
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";

const tokens = { accessToken: "ya29", refreshToken: "1//r", expiresAt: null, scopes: ["mail"] };

/** secrets/accounts.ts loaded afresh with these keys in the env. */
async function withKeys(keys: { ACCOUNTS_KEY?: string; ACCOUNTS_PUBLIC_KEY?: string }) {
  vi.resetModules();
  process.env.ACCOUNTS_KEY = keys.ACCOUNTS_KEY ?? "";
  process.env.ACCOUNTS_PUBLIC_KEY = keys.ACCOUNTS_PUBLIC_KEY ?? "";
  return import("../src/secrets/accounts");
}

afterEach(() => {
  process.env.ACCOUNTS_KEY = "";
  process.env.ACCOUNTS_PUBLIC_KEY = "";
});

describe("sealing a connected account", () => {
  it("opens what it sealed, and nothing it didn't", async () => {
    const accounts = await withKeys({});
    const sealed = accounts.sealAccount(tokens);
    expect(sealed.startsWith("v2.")).toBe(true);
    expect(sealed.split(".")).toHaveLength(5);
    expect(accounts.sealAccount(tokens)).not.toBe(sealed);
    expect(accounts.unsealAccount(sealed)).toEqual(tokens);
    const [v, epk, iv, tag, body] = sealed.split(".");
    const changed = `${body.slice(0, -2)}${body.endsWith("AA") ? "BB" : "AA"}`;
    expect(accounts.unsealAccount([v, epk, iv, tag, changed].join("."))).toBeNull();
    const { seal } = await import("../src/secrets/crypto");
    expect(accounts.unsealAccount(seal(tokens))).toBeNull();
  });

  it("a process with the public key alone seals, and only the broker opens", async () => {
    const pair = (await withKeys({})).newAccountsKey();
    const runner = await withKeys({ ACCOUNTS_PUBLIC_KEY: pair.publicKey });
    expect(runner.opensAccounts()).toBe(false);
    const sealed = runner.sealAccount(tokens);
    expect(() => runner.unsealAccount(sealed)).toThrow(/opened by the broker/);
    const broker = await withKeys({ ACCOUNTS_KEY: pair.key });
    expect(broker.opensAccounts()).toBe(true);
    expect(broker.unsealAccount(sealed)).toEqual(tokens);
    // A runtime alone has a pair of its own: it can't open the cloud's.
    expect((await withKeys({})).unsealAccount(sealed)).toBeNull();
  });

  it("refuses a public key that is not the private key's", async () => {
    const one = (await withKeys({})).newAccountsKey();
    const other = (await withKeys({})).newAccountsKey();
    await expect(
      withKeys({ ACCOUNTS_KEY: one.key, ACCOUNTS_PUBLIC_KEY: other.publicKey }),
    ).rejects.toThrow(/not the public key/);
    expect(
      (await withKeys({ ACCOUNTS_KEY: one.key, ACCOUNTS_PUBLIC_KEY: one.publicKey })).opensAccounts(),
    ).toBe(true);
  });
});

describe("wizards reseal-accounts", () => {
  const TENANT = "local";
  let client: typeof import("../src/db/client");
  let crypto: typeof import("../src/secrets/crypto");
  let wizardId = "";
  let connection = "";

  beforeAll(async () => {
    vi.resetModules();
    client = await import("../src/db/client");
    crypto = await import("../src/secrets/crypto");
    await client.migrateControlDb();
    await client.openTenantDb(TENANT);
    const spaces = await import("../src/services/spaces");
    const wizards = await import("../src/services/wizards");
    const connections = await import("../src/connectors/space-connections");
    await client.withTenant(TENANT, async () => {
      const space = (await spaces.createSpace("local", "Vertrieb")).id;
      wizardId = (
        await wizards.createWizard("local", {
          definition: {
            version: 1,
            title: "Post",
            description: "",
            avatar: "round",
            steps: [{ id: "done", type: "result", title: "Done", deliverables: [] }],
          } as never,
          spaceId: space,
        })
      ).id;
      connection = (
        await connections.createSpaceConnection("local", space, {
          connectorId: "slack",
          name: "Team",
          signIn: "space",
          audience: "all",
          rules: { read: "allow", write: "ask", destructive: "deny", send: "allow" },
          actions: [],
        })
      ).id;
      // What the store key sealed before this update.
      await client.db
        .update(client.schema.spaceConnection)
        .set({ secret: crypto.seal(tokens) })
        .where(eq(client.schema.spaceConnection.id, connection));
      await client.db.insert(client.schema.spaceConnectionSignIn).values({
        connectionId: connection,
        userId: "local",
        label: "kim@example.com",
        secret: crypto.seal({ ...tokens, accessToken: "own" }),
      });
      await client.db.insert(client.schema.storeSecret).values({
        id: "secret-1",
        wizardId,
        holder: "u:local",
        slot: "conn:team",
        provider: "google-mail",
        label: "kim@example.com",
        data: crypto.seal({ ...tokens, accessToken: "store" }),
      });
    });
  }, 60_000);

  const rows = () =>
    client.withTenant(TENANT, async () => ({
      space: await client.db.query.spaceConnection.findFirst({
        where: eq(client.schema.spaceConnection.id, connection),
      }),
      own: await client.db.query.spaceConnectionSignIn.findFirst({
        where: eq(client.schema.spaceConnectionSignIn.connectionId, connection),
      }),
      store: await client.db.query.storeSecret.findFirst({
        where: eq(client.schema.storeSecret.id, "secret-1"),
      }),
    }));

  it("seals every account again, its rights beside a space's, and twice changes nothing", async () => {
    const { resealAccounts } = await import("../src/cli/reseal-accounts");
    const { unsealAccount } = await import("../src/secrets/accounts");
    const { getSecret } = await import("../src/store/index");
    const { grantedScopes } = await import("../src/broker/account");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await resealAccounts()).toBe(0);
    const after = await rows();
    expect(unsealAccount(after.space?.secret ?? "")).toEqual(tokens);
    expect(after.space?.grantedScopes).toEqual(["mail"]);
    expect(grantedScopes(after.space as never)).toEqual(["mail"]);
    expect(unsealAccount(after.own?.secret ?? "")).toMatchObject({ accessToken: "own" });
    const kept = await client.withTenant(TENANT, () =>
      getSecret<typeof tokens>({ wizardId, holder: "u:local" }, "conn:team"),
    );
    expect(kept?.data.accessToken).toBe("store");
    expect(await resealAccounts()).toBe(0);
    expect((await rows()).space?.secret).toBe(after.space?.secret);
  });

  it("leaves what it can't open as it was, and says so", async () => {
    const { resealAccounts } = await import("../src/cli/reseal-accounts");
    const said = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const broken = "v1.AAAA.BBBB.CCCC";
    await client.withTenant(TENANT, () =>
      client.db
        .update(client.schema.storeSecret)
        .set({ data: broken })
        .where(eq(client.schema.storeSecret.id, "secret-1")),
    );
    expect(await resealAccounts()).toBe(1);
    expect((await rows()).store?.data).toBe(broken);
    expect(said.mock.calls.flat().join("\n")).toContain("store_secret secret-1 could not be opened");
  });
});
