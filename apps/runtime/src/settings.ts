import { eq } from "drizzle-orm";
import { control, controlDb, schema, tenantDb } from "./db/client.js";

/** Settings of a runtime that runs alone, kept in the control database. Never secrets. */
export async function readSetting<T>(key: string): Promise<T | null> {
  const row = await controlDb.query.setting.findFirst({ where: eq(control.setting.key, key) });
  return (row?.value as T | undefined) ?? null;
}

export async function writeSetting(key: string, value: unknown): Promise<void> {
  await controlDb
    .insert(control.setting)
    .values({ key, value })
    .onConflictDoUpdate({ target: control.setting.key, set: { value } });
}

export async function deleteSetting(key: string): Promise<void> {
  await controlDb.delete(control.setting).where(eq(control.setting.key, key));
}

/** An organization's own settings, kept in its tenant database. */
export async function readTenantSetting<T>(tenant: string, key: string): Promise<T | null> {
  const tdb = await tenantDb(tenant);
  const row = await tdb.query.setting.findFirst({ where: eq(schema.setting.key, key) });
  return (row?.value as T | undefined) ?? null;
}

export async function writeTenantSetting(
  tenant: string,
  key: string,
  value: unknown,
): Promise<void> {
  const tdb = await tenantDb(tenant);
  await tdb
    .insert(schema.setting)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.setting.key, set: { value } });
}

export async function deleteTenantSetting(tenant: string, key: string): Promise<void> {
  const tdb = await tenantDb(tenant);
  await tdb.delete(schema.setting).where(eq(schema.setting.key, key));
}
