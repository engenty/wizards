import type { CriticalKind } from "@engenty/wizards-shared/connectors";
import { and, eq } from "drizzle-orm";
import type { SessionUser } from "../auth/index.js";
import { criticalSince, type LoggedRow } from "../broker/index.js";
import { db, schema } from "../db/client.js";
import { currentTenant } from "../tenants/tenant.js";
import { isAdminRole } from "./access.js";
import { bellSeenAt, markBellSeen } from "./seen.js";

/**
 * What the broker's critical lines are under Work's bell (docs/plans/broker.md,
 * "Notifications"): the second kind of item beside the calls held for approval. An admin sees
 * every line of the spaces they administer – every space of the tenant – that came in during the
 * last days; the count on the bell is what came in since they last opened it. A member sees none.
 */

/** How far back the bell lists critical lines. */
export const BELL_DAYS = 7;
/** How many at most. */
const BELL_LINES = 50;

export interface CriticalItem {
  id: string;
  at: string;
  kind: CriticalKind;
  spaceId: string;
  who: { kind: string; id: string | null };
  connectionId: string;
  actionId: string;
  outcome: string;
  result: string | null;
  reason: string | null;
  /** Where clicking leads: the run, or the chat. */
  runId: string | null;
  wizardId: string | null;
  chatId: string | null;
}

export function criticalItem(row: LoggedRow): CriticalItem {
  return {
    id: row.id,
    at: row.at.toISOString(),
    kind: (row.criticalKind ?? "refused_write") as CriticalKind,
    spaceId: row.spaceId ?? "",
    who: { kind: row.whoKind, id: row.whoId },
    connectionId: row.connectionId,
    actionId: row.actionId,
    outcome: row.outcome,
    result: row.result,
    reason: row.reason,
    runId: row.runId,
    wizardId: row.wizardId,
    chatId: row.chatId,
  };
}

/** The spaces of the tenant whose bell is on. */
async function bellSpaces(): Promise<string[]> {
  const rows = await db.query.space.findMany({
    where: eq(schema.space.tenantId, currentTenant()),
    columns: { id: true, notify: true },
  });
  return rows.filter((s) => s.notify.bell).map((s) => s.id);
}

/** The critical lines for this person's bell, newest first, and how many are new since they opened it. */
export async function criticalsFor(
  user: SessionUser,
): Promise<{ critical: CriticalItem[]; unseen: number }> {
  if (!isAdminRole(user.role)) {
    return { critical: [], unseen: 0 };
  }
  const since = new Date(Date.now() - BELL_DAYS * 24 * 3600_000);
  const rows = await criticalSince(await bellSpaces(), since, BELL_LINES);
  const seen = (await bellSeenAt(user.id))?.getTime() ?? 0;
  return {
    critical: rows.map(criticalItem),
    unseen: rows.filter((r) => r.at.getTime() > seen).length,
  };
}

/** The person opened the bell. */
export async function bellOpened(user: SessionUser): Promise<void> {
  await markBellSeen(user.id);
}

/** For tests and the report: the critical rows of one space since a time. */
export async function criticalOfSpace(spaceId: string, since: Date): Promise<LoggedRow[]> {
  const rows = await criticalSince([spaceId], since);
  return rows.filter((r) => r.spaceId === spaceId);
}

/** Whether a space of the tenant exists (the routes' 404). */
export async function tenantSpace(spaceId: string) {
  return db.query.space.findFirst({
    where: and(eq(schema.space.id, spaceId), eq(schema.space.tenantId, currentTenant())),
  });
}
