import { and, eq, like } from "drizzle-orm";
import { db, knownTenants, migrateControlDb, schema, withTenant } from "../db/client.js";
import { newAccountsKey, sealAccount } from "../secrets/accounts.js";
import { unseal } from "../secrets/crypto.js";
import { currentTenant } from "../tenants/tenant.js";

/**
 * `wizards reseal-accounts` — once, after the update that seals connected accounts with a public
 * key (docs/plans/runs-on-their-own.md, 7.1): opens every account `seal()` sealed and seals it
 * with `sealAccount()`, in every tenant's database: `store_secret`, a space connection's
 * `secret` (its granted rights beside it) and people's sign-ins. Run it where `STORE_ENC_KEY`
 * is what it was; it needs the public key only. Not in the help. Twice is harmless: what is
 * sealed already stays.
 */
export async function resealAccounts(): Promise<number> {
  await migrateControlDb();
  let failed = 0;
  for (const tenant of await knownTenants()) {
    failed += await withTenant(tenant, resealTenant);
  }
  console.log(
    failed ? "Done; the accounts listed could not be opened and stay as they were." : "Done.",
  );
  return failed ? 1 : 0;
}

/** Sealed by `seal()`: `v1.` and three parts. */
const OLD = "v1.%";

async function resealTenant(): Promise<number> {
  const tenant = currentTenant();
  let moved = 0;
  const lost: string[] = [];
  const open = <T>(sealed: string, what: string): T | null => {
    const data = unseal<T>(sealed);
    if (data === null) {
      lost.push(what);
    }
    return data;
  };

  for (const row of await db.query.storeSecret.findMany({
    where: like(schema.storeSecret.data, OLD),
  })) {
    const data = open<unknown>(row.data, `store_secret ${row.id}`);
    if (data !== null) {
      await db
        .update(schema.storeSecret)
        .set({ data: sealAccount(data) })
        .where(eq(schema.storeSecret.id, row.id));
      moved++;
    }
  }

  for (const row of await db.query.spaceConnection.findMany({
    where: like(schema.spaceConnection.secret, OLD),
  })) {
    const data = open<{ scopes?: string[] }>(row.secret ?? "", `space_connection ${row.id}`);
    if (data !== null) {
      await db
        .update(schema.spaceConnection)
        .set({ secret: sealAccount(data), grantedScopes: data.scopes ?? [] })
        .where(eq(schema.spaceConnection.id, row.id));
      moved++;
    }
  }

  for (const row of await db.query.spaceConnectionSignIn.findMany({
    where: like(schema.spaceConnectionSignIn.secret, OLD),
  })) {
    const what = `space_connection_sign_in ${row.connectionId} ${row.userId}`;
    const data = open<unknown>(row.secret, what);
    if (data !== null) {
      await db
        .update(schema.spaceConnectionSignIn)
        .set({ secret: sealAccount(data) })
        .where(
          and(
            eq(schema.spaceConnectionSignIn.connectionId, row.connectionId),
            eq(schema.spaceConnectionSignIn.userId, row.userId),
          ),
        );
      moved++;
    }
  }

  console.log(`${tenant}: ${moved} sealed again.`);
  for (const what of lost) {
    console.log(`${tenant}: ${what} could not be opened.`);
  }
  return lost.length ? 1 : 0;
}

/** `wizards new-accounts-key` — a key pair for a cloud's env. Not in the help. */
export function printNewAccountsKey(): number {
  const { key, publicKey } = newAccountsKey();
  console.log(`# The broker only:\nACCOUNTS_KEY=${key}`);
  console.log(`# Every other process:\nACCOUNTS_PUBLIC_KEY=${publicKey}`);
  return 0;
}
