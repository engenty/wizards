import type { SyncKind, SyncRecord } from "@engenty/wizards-shared/sync";
import { sql } from "drizzle-orm";
import { db, inTransaction } from "../db/client.js";
import { nudge } from "../live/hub.js";
import { asSync } from "../services/access.js";
import { currentTenantOrNull } from "../tenants/tenant.js";
import { quietly } from "./log.js";
import { KIND_ORDER, KINDS, letDanglingGo } from "./records.js";

export interface ApplyItem {
  kind: SyncKind;
  item: string;
  spaceId: string;
  /** `null`: the item goes. */
  record: SyncRecord | null;
}

/**
 * Writes a batch of items in one transaction, in an order where what one points to comes
 * first; what still points nowhere at the end is let go. `quiet`: an install writing what it
 * pulled, which the triggers must not note as its own change. What follows a write (links,
 * events, the index) runs after the commit.
 */
export async function applyItems(items: ApplyItem[], options: { quiet: boolean }): Promise<void> {
  if (!items.length) {
    return;
  }
  const sorted = [...items].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  const afters = await asSync(() =>
    inTransaction(async () => {
      const write = async () => {
        // Points between the items of the batch are checked at the commit, not one by one.
        await db.run(sql`PRAGMA defer_foreign_keys = ON`);
        const done: (() => Promise<void> | void)[] = [];
        for (const x of sorted) {
          const def = KINDS[x.kind];
          const after = x.record
            ? await def.write(x.spaceId, x.item, x.record)
            : await def.remove(x.spaceId, x.item);
          if (after) {
            done.push(after);
          }
        }
        await letDanglingGo();
        return done;
      };
      return options.quiet ? quietly(write) : write();
    }),
  );
  for (const after of afters) {
    await Promise.resolve(after()).catch((err) => console.error("[sync] after a write:", err));
  }
  // A pull here, a push received in the cloud: open studios hear of it now.
  nudge(currentTenantOrNull());
}
