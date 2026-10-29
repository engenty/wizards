import { existsSync } from "node:fs";
import { cp } from "node:fs/promises";
import { join } from "node:path";
import { upgradeDefinition } from "@engenty/wizards-shared/definition";
import { createClient, type InStatement } from "@libsql/client";
import { env } from "../env.js";
import { readSetting, writeSetting } from "../settings.js";
import { LOCAL_TENANT } from "../tenants/tenant.js";
import { control, controlDb, openTenantDb } from "./client.js";

/**
 * A data folder from before tenants had their own database holds everything in `wizards.db`,
 * owned by a user. Its wizards, runs and files become the local tenant's, once. The old file
 * and folders stay where they are.
 */
const TABLES = [
  "space",
  "wizard",
  "wizard_version",
  "wizard_file",
  "wizard_message",
  "run",
  "run_event",
  "asset",
  "space_connector",
  "store_holder",
  "store_row",
  "store_file",
  "store_secret",
];

const CLASS_OF: Record<string, string> = { fast: "low", smart: "standard" };

/** Steps named a model speed before they named a model class; then classes of version 1. */
function withClasses(json: unknown): unknown {
  if (typeof json !== "string") {
    return json;
  }
  try {
    const def = upgradeDefinition(JSON.parse(json)) as { steps?: { model?: string }[] };
    for (const step of def.steps ?? []) {
      if (step.model && CLASS_OF[step.model]) {
        step.model = CLASS_OF[step.model];
      }
    }
    return JSON.stringify(def);
  } catch {
    return json;
  }
}

const personOf = (holder: unknown) =>
  typeof holder === "string" && holder.startsWith("u:") ? "u:local" : holder;

export async function adoptLegacyData(): Promise<void> {
  const legacyFile = join(env.dataDir, "wizards.db");
  const targetFile = join(env.dataDir, "tenants", `${LOCAL_TENANT}.db`);
  if (!existsSync(legacyFile) || existsSync(targetFile) || (await readSetting("adopted"))) {
    return;
  }
  const legacy = createClient({ url: `file:${legacyFile}` });
  const hasOwner = (await legacy.execute("PRAGMA table_info(space)")).rows.some(
    (r) => r.name === "owner_id",
  );
  if (!hasOwner) {
    return;
  }
  await openTenantDb(LOCAL_TENANT);
  const target = createClient({ url: `file:${targetFile}` });
  const statements: InStatement[] = [];
  const links: (typeof control.link.$inferInsert)[] = [];
  const runs: (typeof control.runIndex.$inferInsert)[] = [];

  for (const table of TABLES) {
    const targetColumns = new Set(
      (await target.execute(`PRAGMA table_info(${table})`)).rows.map((r) => String(r.name)),
    );
    const rows = (await legacy.execute(`SELECT * FROM ${table}`).catch(() => ({ rows: [] }))).rows;
    for (const row of rows) {
      const values: Record<string, unknown> = {};
      for (const [column, value] of Object.entries(row)) {
        const name = column === "owner_id" ? "tenant_id" : column;
        if (targetColumns.has(name)) {
          values[name] = value;
        }
      }
      if ("tenant_id" in values) {
        values.tenant_id = LOCAL_TENANT;
      }
      if ("holder" in values) {
        values.holder = personOf(values.holder);
      }
      if (table === "wizard") {
        values.draft = withClasses(values.draft);
        links.push({
          token: String(values.share_token),
          tenantId: LOCAL_TENANT,
          kind: "wizard",
          ref: String(values.id),
        });
      }
      if (table === "wizard_version" || table === "run") {
        values.definition = withClasses(values.definition);
      }
      if (table === "run") {
        values.user_id = values.user_id ? "local" : null;
        runs.push({
          runId: String(values.id),
          tenantId: LOCAL_TENANT,
          visitorId: (values.visitor_id as string | null) ?? null,
          ipHash: (values.ip_hash as string | null) ?? null,
          active: values.status === "running",
          createdAt: new Date(Number(values.created_at)),
        });
        if (values.share_token) {
          links.push({
            token: String(values.share_token),
            tenantId: LOCAL_TENANT,
            kind: "result",
            ref: String(values.id),
          });
        }
      }
      if (table === "asset" && values.kind === "logo") {
        links.push({
          token: String(values.id),
          tenantId: LOCAL_TENANT,
          kind: "logo",
          ref: String(values.id),
        });
      }
      const columns = Object.keys(values);
      statements.push({
        sql: `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
        args: columns.map((c) => values[c] as never),
      });
    }
  }
  await target.batch(statements, "write");
  for (let i = 0; i < links.length; i += 100) {
    await controlDb
      .insert(control.link)
      .values(links.slice(i, i + 100))
      .onConflictDoNothing();
  }
  for (let i = 0; i < runs.length; i += 100) {
    await controlDb
      .insert(control.runIndex)
      .values(runs.slice(i, i + 100))
      .onConflictDoNothing();
  }
  for (const folder of ["assets", "blobs"]) {
    const from = join(env.dataDir, folder);
    if (existsSync(from)) {
      await cp(from, join(env.dataDir, "objects", "t", LOCAL_TENANT, folder), { recursive: true });
    }
  }
  await writeSetting("adopted", new Date().toISOString());
  console.log(`Adopted ${statements.length} rows from ${legacyFile} into the local tenant.`);
}
