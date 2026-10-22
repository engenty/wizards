import type { LiveItem, LiveKind, LiveOp } from "@engenty/wizards-shared/live";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";

/**
 * The tenant's live feed (`live_change`, docs/plans/live-changes.md): numbered writes to the
 * items a studio shows. These read it in the current tenant's context.
 */

/** How long a change stays readable: a reconnect within it catches up, a later one resets. */
export const LIVE_KEEP_MS = 15 * 60_000;

export interface LiveRow extends LiveItem {
  seq: number;
}

/** The newest number in the feed, 0 when it never had a row. */
export async function newestSeq(): Promise<number> {
  const rows = await db.all<{ seq: number | null }>(
    sql`SELECT seq FROM sqlite_sequence WHERE name = 'live_change'`,
  );
  return rows[0]?.seq ?? 0;
}

/** The oldest number still kept, or null when the feed is empty. */
export async function oldestSeq(): Promise<number | null> {
  const rows = await db.all<{ seq: number | null }>(sql`SELECT MIN(seq) AS seq FROM live_change`);
  return rows[0]?.seq ?? null;
}

/** The changes after `since`, oldest first, at most `limit`. */
export async function changesAfter(since: number, limit: number): Promise<LiveRow[]> {
  const rows = await db.all<{
    seq: number;
    project_id: string | null;
    kind: string;
    op: string;
    item: string;
    parent: string | null;
  }>(
    sql`SELECT seq, project_id, kind, op, item, parent FROM live_change WHERE seq > ${since} ORDER BY seq LIMIT ${limit}`,
  );
  return rows.map((r) => ({
    seq: r.seq,
    projectId: r.project_id,
    kind: r.kind as LiveKind,
    op: r.op as LiveOp,
    item: r.item,
    parent: r.parent,
  }));
}

/** Deletes changes older than what a reconnect may catch up on. */
export async function pruneLive(now = Date.now()) {
  await db.run(sql`DELETE FROM live_change WHERE at < ${now - LIVE_KEEP_MS}`);
}
