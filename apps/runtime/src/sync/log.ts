import type { SyncKind } from "@engenty/wizards-shared/sync";
import { and, eq, gt, inArray, max, sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";

/**
 * The change log of a tenant's database (`sync_change`, filled by the triggers of migration
 * 0022): in the cloud, the numbers a pull asks from; on an install, what was changed here and
 * has not been pushed yet.
 */

export interface LoggedItem {
  kind: SyncKind;
  item: string;
  projectId: string;
  /** The item's last change. */
  seq: number;
}

/** The last number of each of these items; 0 for one the log has not seen. */
export async function lastSeqs(
  items: { kind: string; item: string }[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < items.length; i += 200) {
    const part = items.slice(i, i + 200);
    const rows = await db
      .select({
        kind: schema.syncChange.kind,
        item: schema.syncChange.item,
        seq: max(schema.syncChange.seq),
      })
      .from(schema.syncChange)
      .where(
        inArray(
          schema.syncChange.item,
          part.map((x) => x.item),
        ),
      )
      .groupBy(schema.syncChange.kind, schema.syncChange.item);
    for (const r of rows) {
      out.set(`${r.kind}|${r.item}`, r.seq ?? 0);
    }
  }
  return out;
}

export const seqKey = (kind: string, item: string) => `${kind}|${item}`;

/** The last number of the space's log; 0 when nothing of it changed yet. */
export async function spaceSeq(projectId: string): Promise<number> {
  const [row] = await db
    .select({ seq: max(schema.syncChange.seq) })
    .from(schema.syncChange)
    .where(eq(schema.syncChange.projectId, projectId));
  return row?.seq ?? 0;
}

/** The items of a space that changed after `since`, by their last change, oldest first. */
export async function changedSince(
  projectId: string,
  since: number,
  limit: number,
): Promise<LoggedItem[]> {
  const seq = max(schema.syncChange.seq);
  const rows = await db
    .select({ kind: schema.syncChange.kind, item: schema.syncChange.item, seq })
    .from(schema.syncChange)
    .where(and(eq(schema.syncChange.projectId, projectId), gt(schema.syncChange.seq, since)))
    .groupBy(schema.syncChange.kind, schema.syncChange.item)
    .orderBy(seq)
    .limit(limit);
  return rows.map((r) => ({
    kind: r.kind as SyncKind,
    item: r.item,
    projectId,
    seq: r.seq ?? 0,
  }));
}

/** Keeps only each item's last change: what a pull or a push needs. */
export async function compactLog(projectId?: string) {
  await db.run(
    projectId
      ? sql`DELETE FROM sync_change WHERE project_id = ${projectId} AND seq NOT IN (SELECT MAX(seq) FROM sync_change WHERE project_id = ${projectId} GROUP BY kind, item)`
      : sql`DELETE FROM sync_change WHERE seq NOT IN (SELECT MAX(seq) FROM sync_change GROUP BY kind, item)`,
  );
}

/** Drops what was pushed: changes of the space up to `seq`. */
export async function dropPushed(projectId: string, seq: number) {
  await db
    .delete(schema.syncChange)
    .where(
      and(eq(schema.syncChange.projectId, projectId), sql`${schema.syncChange.seq} <= ${seq}`),
    );
}

/** Notes an item as changed here, though no write did: a version kept by the person's choice. */
export async function notePending(projectId: string, kind: SyncKind, item: string) {
  await db.insert(schema.syncChange).values({ projectId, kind, item });
}

/** Runs `fn` with the triggers quiet: what it writes is not noted as a change of this side. */
export async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  await db.update(schema.syncGuard).set({ applying: 1 }).where(eq(schema.syncGuard.id, 1));
  try {
    return await fn();
  } finally {
    await db.update(schema.syncGuard).set({ applying: 0 }).where(eq(schema.syncGuard.id, 1));
  }
}
