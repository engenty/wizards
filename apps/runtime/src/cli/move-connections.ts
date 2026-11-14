import { and, eq, inArray, like } from "drizzle-orm";
import { nanoid } from "nanoid";
import { sameService } from "../connectors/person-connections.js";
import {
  db,
  inTransaction,
  knownTenants,
  migrateControlDb,
  schema,
  withTenant,
} from "../db/client.js";
import { currentTenant } from "../tenants/tenant.js";

/*
 * `wizards move-connections [--dry-run]` — once, after the update that brought a person's own
 * connections (docs/plans/run-connections.md, step 1): every account a wizard kept in its store
 * (`store_secret`, slot `connection:<need>`) becomes a connection of its holder, one per holder,
 * service and address, and the wizard remembers it as its choice for that need. The store's rows
 * go. The sealed secret moves as it is: nothing is unsealed. Each tenant converts in one
 * transaction; a second run finds nothing left.
 */

const PREFIX = "connection:";

interface Counts {
  accounts: number;
  reused: number;
  choices: number;
}

export async function moveConnections(options: { dryRun: boolean }): Promise<number> {
  await migrateControlDb();
  let total = 0;
  for (const tenant of await knownTenants()) {
    const counts = await withTenant(tenant, () =>
      options.dryRun
        ? moveTenantConnections(true)
        : inTransaction(() => moveTenantConnections(false)),
    );
    total += counts.choices;
  }
  console.log(
    options.dryRun
      ? `Nothing was changed (--dry-run). ${total} kept accounts would move.`
      : `Done. ${total} kept accounts moved.`,
  );
  return 0;
}

/** Converts the current tenant's kept accounts; with `dryRun`, only counts them. */
export async function moveTenantConnections(dryRun: boolean): Promise<Counts> {
  const rows = await db.query.storeSecret.findMany({
    where: like(schema.storeSecret.slot, `${PREFIX}%`),
    orderBy: (s, { desc }) => [desc(s.updatedAt)],
  });
  const counts: Counts = { accounts: 0, reused: 0, choices: 0 };
  if (!rows.length) {
    return counts;
  }
  /** The connection each holder, service and address became, newest secret first. */
  const made = new Map<string, string>();
  for (const row of rows) {
    const service = [...sameService(row.provider)].sort().join("|");
    const key = `${row.holder}\n${service}\n${row.label}`;
    let id = made.get(key);
    if (!id) {
      const existing = await db.query.personConnection.findFirst({
        where: and(
          eq(schema.personConnection.holder, row.holder),
          inArray(schema.personConnection.connectorId, sameService(row.provider)),
          eq(schema.personConnection.label, row.label),
        ),
        columns: { id: true },
      });
      if (existing) {
        id = existing.id;
        counts.reused++;
      } else {
        id = nanoid(14);
        counts.accounts++;
        if (!dryRun) {
          await db.insert(schema.personConnection).values({
            id,
            holder: row.holder,
            connectorId: row.provider,
            label: row.label,
            // Sealed as the store sealed it: the same key opens it.
            secret: row.data,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          });
        }
      }
      made.set(key, id);
    }
    counts.choices++;
    if (!dryRun) {
      await db
        .insert(schema.connectionChoice)
        .values({
          wizardId: row.wizardId,
          need: row.slot.slice(PREFIX.length),
          holder: row.holder,
          personConnectionId: id,
          chosenAt: row.updatedAt,
        })
        .onConflictDoNothing();
      await db.delete(schema.storeSecret).where(eq(schema.storeSecret.id, row.id));
    }
  }
  console.log(
    `${currentTenant()}: ${counts.choices} kept accounts → ${counts.accounts} new connections` +
      (counts.reused ? `, ${counts.reused} already there` : ""),
  );
  return counts;
}
