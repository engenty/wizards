import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Client, createClient } from "@libsql/client";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { env } from "../env.js";
import { currentTenant, inTenant } from "../tenants/tenant.js";
import * as control from "./control-schema.js";
import * as schema from "./schema.js";

mkdirSync(join(env.dataDir, "tenants"), { recursive: true });

const here = dirname(fileURLToPath(import.meta.url));

/** Migrations are SQL files next to this module; the build copies them next to the built one. */
function migrationsFolder(name: "tenant" | "control"): string {
  return join(here, "migrations", name);
}

/**
 * The tenant schema this release writes: the last migration's tag (`0022_sync`). The two-way
 * sync runs only between sides that have the same.
 */
export const tenantSchemaVersion: string = (() => {
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder("tenant"), "meta", "_journal.json"), "utf8"),
  ) as { entries: { tag: string }[] };
  return journal.entries.at(-1)?.tag ?? "";
})();

function open(url: string, authToken: string): Client {
  return createClient({ url, ...(authToken ? { authToken } : {}) });
}

async function prepare(client: Client, url: string) {
  if (url.startsWith("file:")) {
    // The wait first: studio, doors and runner share the files, and switching to WAL waits
    // too while another process recovers the log after a restart.
    await client.execute("PRAGMA busy_timeout = 5000");
    await client.execute("PRAGMA journal_mode = WAL");
  }
  await client.execute("PRAGMA foreign_keys = ON");
}

// --- control database --------------------------------------------------------

const controlUrl = env.databaseUrl || `file:${join(env.dataDir, "control.db")}`;
const controlClient = open(controlUrl, env.databaseAuthToken);

/** Links, the run index, sessions and settings: what is known before a tenant's database opens. */
export const controlDb = drizzle(controlClient, { schema: control });
export { control };

/**
 * `SELECT 1` on the control database: through the client every request uses, or through a new
 * one opened for this call alone. When the first fails and the second works, this process's
 * client is stuck, not the database (health.ts).
 */
export async function probeControl(fresh = false): Promise<void> {
  if (!fresh) {
    await controlClient.execute("SELECT 1");
    return;
  }
  const client = open(controlUrl, env.databaseAuthToken);
  try {
    await client.execute("SELECT 1");
  } finally {
    client.close();
  }
}

export async function migrateControlDb() {
  await prepare(controlClient, controlUrl);
  await migrate(controlDb, { migrationsFolder: migrationsFolder("control") });
}

// --- tenant databases --------------------------------------------------------

function makeTenantDb(client: Client) {
  return drizzle(client, { schema });
}
export type Db = ReturnType<typeof makeTenantDb>;

const opened = new Map<string, Promise<Db>>();
const clients = new Map<string, Client>();

/** Where a tenant's database lives: the URL the Manage-App handed out, else a file in the data folder. */
function tenantUrl(id: string, dbUrl: string | null): string {
  if (dbUrl) {
    return dbUrl;
  }
  if (env.tenantDbUrlTemplate) {
    return env.tenantDbUrlTemplate.replaceAll("{tenant}", id.toLowerCase());
  }
  return `file:${join(env.dataDir, "tenants", `${id}.db`)}`;
}

function isBusy(err: unknown): boolean {
  for (let e = err; e; e = (e as { cause?: unknown }).cause) {
    if (String((e as { code?: unknown }).code ?? "").startsWith("SQLITE_BUSY")) {
      return true;
    }
  }
  return false;
}

/** `fn` again while another process holds the database: 1, 2, 4, 8 and 16 seconds apart. */
async function whileBusy<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= 5 || !isBusy(err)) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
}

/** Tenant databases still opening, and since when: one that takes minutes is stuck (health.ts). */
const opening = new Map<string, number>();

export function openingTenants(): { id: string; since: number }[] {
  return [...opening].map(([id, since]) => ({ id, since }));
}

async function openTenant(id: string): Promise<Db> {
  opening.set(id, Date.now());
  try {
    return await openTenantNow(id);
  } finally {
    opening.delete(id);
  }
}

async function openTenantNow(id: string): Promise<Db> {
  let row = await controlDb.query.tenant.findFirst({ where: eq(control.tenant.id, id) });
  if (!row) {
    await controlDb.insert(control.tenant).values({ id }).onConflictDoNothing();
    row = (await controlDb.query.tenant.findFirst({ where: eq(control.tenant.id, id) }))!;
  }
  const url = tenantUrl(id, row.dbUrl);
  const client = open(url, url.startsWith("file:") ? "" : env.tenantDbAuthToken);
  clients.set(id, client);
  const db = makeTenantDb(client);
  // Every database is brought to the current schema when it is first opened.
  try {
    await whileBusy(async () => {
      await prepare(client, url);
      await migrate(db, { migrationsFolder: migrationsFolder("tenant") });
    });
  } catch (err) {
    // The next use opens it afresh (tenantDb forgets the failed attempt).
    clients.delete(id);
    client.close();
    throw err;
  }
  for (const hook of openHooks) {
    await hook(id, client);
  }
  return db;
}

type OpenHook = (tenantId: string, client: Client) => Promise<void>;
const openHooks: OpenHook[] = [];

/** Runs for every tenant database right after it was opened and migrated (plugins' own tables). */
export function onTenantOpen(hook: OpenHook) {
  openHooks.push(hook);
}

/** The tenant databases this process has open, once each of them finished opening. */
export async function openTenantClients(): Promise<[string, Client][]> {
  await Promise.allSettled(opened.values());
  return [...clients.entries()];
}

/** The only way to a tenant's tables. Opens the database once per process and migrates it then. */
export function tenantDb(id: string): Promise<Db> {
  let db = opened.get(id);
  if (!db) {
    db = openTenant(id).catch((err) => {
      opened.delete(id);
      throw err;
    });
    opened.set(id, db);
  }
  return db;
}

const ready = new Map<string, Db>();

/** Closes and forgets an open tenant database (the tenant was deleted or moved). */
export function closeTenantDb(id: string) {
  opened.delete(id);
  ready.delete(id);
  clients.get(id)?.close();
  clients.delete(id);
}

/** Opens the current tenant's database; `db` works synchronously afterwards. */
export async function openTenantDb(id: string): Promise<void> {
  if (!ready.has(id)) {
    ready.set(id, await tenantDb(id));
  }
}

/** Runs `fn` for one tenant: opens its database, then sets the context `db` resolves from. */
export async function withTenant<T>(id: string, fn: () => T | Promise<T>): Promise<T> {
  await openTenantDb(id);
  return inTenant(id, fn);
}

/** The transaction the current context writes in, while `inTransaction()` runs. */
const transactions = new AsyncLocalStorage<Db>();

/**
 * Runs `fn` as one transaction of the current tenant's database: inside it, `db` is the
 * transaction, so every write of the services called there stands or falls with the others.
 * Already inside one, `fn` just joins it. Only this database takes part: the object store and
 * the control database are written as before, so do those first or after.
 */
export async function inTransaction<T>(fn: () => Promise<T>): Promise<T> {
  if (transactions.getStore()) {
    return fn();
  }
  const id = currentTenant();
  const target = ready.get(id);
  if (!target) {
    throw new Error(`Tenant database "${id}" is not open: enter it with withTenant().`);
  }
  return target.transaction((tx) => transactions.run(tx as unknown as Db, fn));
}

/**
 * The current tenant's database, resolved from the context `inTenant()` set — or the
 * transaction `inTransaction()` opened there. Code that reads or writes wizards, runs or files
 * never names a tenant itself.
 */
export const db: Db = new Proxy({} as Db, {
  get(_target, prop) {
    const id = currentTenant();
    const target = transactions.getStore() ?? ready.get(id);
    if (!target) {
      throw new Error(`Tenant database "${id}" is not open: enter it with withTenant().`);
    }
    const value = Reflect.get(target as object, prop);
    return typeof value === "function" ? value.bind(target) : value;
  },
});

export { schema };

/**
 * Runs `fn` again after each wait in `waits` (milliseconds) while it fails: a remote database
 * drops a connection now and then. The last failure is thrown.
 */
export async function retried<T>(
  label: string,
  fn: () => Promise<T>,
  waits: number[] = [1_000, 3_000, 10_000],
): Promise<T> {
  for (const wait of waits) {
    try {
      return await fn();
    } catch (err) {
      console.warn(`[${label}] failed, trying again in ${wait / 1000}s:`, (err as Error).message);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  return fn();
}

/** Brings every known tenant database to the current schema (after a release). */
export async function migrateAllTenants(
  waits?: number[],
): Promise<{ migrated: number; failed: string[] }> {
  const tenants = await retried(
    "migrate",
    () => controlDb.select({ id: control.tenant.id }).from(control.tenant),
    waits,
  );
  const failed: string[] = [];
  let migrated = 0;
  const queue = [...tenants];
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let t = queue.shift(); t; t = queue.shift()) {
        try {
          const id = t.id;
          await retried(`migrate ${id}`, () => openTenantDb(id), waits);
          migrated++;
        } catch (err) {
          console.error(`[migrate ${t.id}]`, err);
          failed.push(t.id);
        }
      }
    }),
  );
  return { migrated, failed };
}

export async function knownTenants(): Promise<string[]> {
  const rows = await controlDb.select({ id: control.tenant.id }).from(control.tenant);
  return rows.map((r) => r.id);
}
