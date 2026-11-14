import { and, eq, inArray, like } from "drizzle-orm";
import { nanoid } from "nanoid";
import { sameService } from "../connectors/same-service.js";
import type { Db } from "./client.js";
import * as schema from "./schema.js";

/*
 * The accounts wizards kept in their store (`store_secret`, slot `connection:<need>`) become
 * connections of their holder (docs/plans/run-connections.md, step 1): one per holder, service
 * and address, and the wizard remembers it as its choice for that need. The store's rows go. The
 * sealed secret moves as it is: nothing is unsealed.
 *
 * Runs while a tenant's database opens, right after its migrations (`db/client.ts`), so a tenant
 * converts when its schema moves. One write transaction: a second process opening the same
 * tenant waits for it and then finds nothing left. A tenant with nothing kept costs one query.
 */

const PREFIX = "connection:";

export interface MovedAccounts {
  /** Connections made. */
  accounts: number;
  /** Kept accounts that found their connection already there. */
  reused: number;
  /** Kept accounts moved: one choice each. */
  choices: number;
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export async function moveKeptAccounts(db: Db): Promise<MovedAccounts> {
  const any = await db
    .select({ id: schema.storeSecret.id })
    .from(schema.storeSecret)
    .where(like(schema.storeSecret.slot, `${PREFIX}%`))
    .limit(1);
  if (!any.length) {
    return { accounts: 0, reused: 0, choices: 0 };
  }
  return db.transaction(move);
}

async function move(tx: Tx): Promise<MovedAccounts> {
  const counts: MovedAccounts = { accounts: 0, reused: 0, choices: 0 };
  // Read again inside the transaction: another process may have moved them meanwhile.
  const rows = await tx.query.storeSecret.findMany({
    where: like(schema.storeSecret.slot, `${PREFIX}%`),
    orderBy: (s, { desc }) => [desc(s.updatedAt)],
  });
  /** The connection each holder, service and address became; the newest secret makes it. */
  const made = new Map<string, string>();
  for (const row of rows) {
    const key = `${row.holder}\n${[...sameService(row.provider)].sort().join("|")}\n${row.label}`;
    let id = made.get(key);
    if (!id) {
      id = await existing(tx, row.holder, row.provider, row.label);
      if (id) {
        counts.reused++;
      } else {
        const [inserted] = await tx
          .insert(schema.personConnection)
          .values({
            id: nanoid(14),
            holder: row.holder,
            connectorId: row.provider,
            label: row.label,
            // Sealed as the store sealed it: the same key opens it.
            secret: row.data,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          })
          .onConflictDoNothing()
          .returning({ id: schema.personConnection.id });
        id = inserted?.id ?? (await existing(tx, row.holder, row.provider, row.label));
        if (!id) {
          throw new Error(`No connection for ${row.holder}'s ${row.provider} account.`);
        }
        counts.accounts++;
      }
      made.set(key, id);
    }
    await tx
      .insert(schema.connectionChoice)
      .values({
        wizardId: row.wizardId,
        need: row.slot.slice(PREFIX.length),
        holder: row.holder,
        personConnectionId: id,
        chosenAt: row.updatedAt,
      })
      .onConflictDoNothing();
    await tx.delete(schema.storeSecret).where(eq(schema.storeSecret.id, row.id));
    counts.choices++;
  }
  return counts;
}

async function existing(
  tx: Tx,
  holder: string,
  connectorId: string,
  label: string,
): Promise<string | undefined> {
  const found = await tx.query.personConnection.findFirst({
    where: and(
      eq(schema.personConnection.holder, holder),
      inArray(schema.personConnection.connectorId, sameService(connectorId)),
      eq(schema.personConnection.label, label),
    ),
    columns: { id: true },
  });
  return found?.id;
}
