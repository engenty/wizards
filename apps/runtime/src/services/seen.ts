import { eq, gt, inArray } from "drizzle-orm";
import { db, schema } from "../db/client.js";

/**
 * When a person of the tenant was last in the app, and when they last opened Work's bell
 * (`person_seen`). Every studio request marks the person, once a minute at most; the hourly mail
 * of the broker's critical lines (broker/notify.ts) is skipped while an admin was here, and the
 * bell counts what came in since it was opened (services/broker-bell.ts).
 */

/** Marked again within this long, a request writes nothing. */
const AGAIN_MS = 60_000;
const marked = new Map<string, number>();

/** Here, now. */
export async function markSeen(userId: string, at = new Date()): Promise<void> {
  const key = `${userId}`;
  const before = marked.get(key) ?? 0;
  if (at.getTime() - before < AGAIN_MS) {
    return;
  }
  marked.set(key, at.getTime());
  await db
    .insert(schema.personSeen)
    .values({ userId, seenAt: at })
    .onConflictDoUpdate({ target: schema.personSeen.userId, set: { seenAt: at } });
}

/** The person opened the bell: what is there counts as seen. */
export async function markBellSeen(userId: string, at = new Date()): Promise<void> {
  await db
    .insert(schema.personSeen)
    .values({ userId, seenAt: at, bellSeenAt: at })
    .onConflictDoUpdate({
      target: schema.personSeen.userId,
      set: { seenAt: at, bellSeenAt: at },
    });
}

/** When the person last opened the bell; null: never. */
export async function bellSeenAt(userId: string): Promise<Date | null> {
  const row = await db.query.personSeen.findFirst({
    where: eq(schema.personSeen.userId, userId),
  });
  return row?.bellSeenAt ?? null;
}

/** Whether any of these people was in the app after this time. */
export async function anySeenSince(userIds: string[], since: Date): Promise<boolean> {
  if (!userIds.length) {
    return false;
  }
  const row = await db.query.personSeen.findFirst({
    where: (t, { and }) => and(inArray(t.userId, userIds), gt(t.seenAt, since)),
  });
  return Boolean(row);
}

/** For tests: the throttle forgets. */
export function forgetSeen(): void {
  marked.clear();
}
