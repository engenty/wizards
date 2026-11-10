import { sql } from "drizzle-orm";
import { db, knownTenants, migrateControlDb, withTenant } from "../db/client.js";
import { currentTenant } from "../tenants/tenant.js";

/**
 * `wizards drop-turn-snapshots` — once, after the update that saves agent turns in `run_turn`
 * (docs/plans/runs-on-their-own.md, package 2.5): drops the tables Mastra kept a durable step's
 * turn in, in every tenant's database. Not in the help. Run it with the runtime stopped: the
 * Work chats' Mastra store makes the tables again, empty, when it starts.
 */
const TABLES = [
  "mastra_workflow_snapshot",
  "mastra_workflow_run_owners",
  "mastra_workflow_definitions",
] as const;

export async function dropTurnSnapshots(): Promise<number> {
  await migrateControlDb();
  let failed = 0;
  for (const tenant of await knownTenants()) {
    failed += await withTenant(tenant, dropTenantTables);
  }
  console.log(failed ? "Done; the tenants listed kept their tables." : "Done.");
  return failed ? 1 : 0;
}

async function dropTenantTables(): Promise<number> {
  const tenant = currentTenant();
  try {
    for (const table of TABLES) {
      await db.run(sql.raw(`DROP TABLE IF EXISTS ${table}`));
    }
    console.log(`${tenant}: dropped.`);
    return 0;
  } catch (err) {
    console.log(`${tenant}: ${(err as Error).message}`);
    return 1;
  }
}
