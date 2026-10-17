import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema } from "../db/client.js";
import { currentTenant } from "../tenants/tenant.js";
import type { RunRow } from "./types.js";

/**
 * A word to the owner about a run nobody watches: it waits for them, it is done, it failed,
 * its start was paused. The studio's bell lists them; `readAt` marks what was seen.
 */

export type NoticeKind = (typeof schema.notice.$inferSelect)["kind"];

/** Kept per tenant; older ones go as new ones come. */
const KEEP = 200;

export async function noticeOwner(
  run: Pick<RunRow, "id" | "wizardId" | "startedBy">,
  kind: NoticeKind,
  detail: string | null = null,
) {
  if (!run.startedBy) {
    return;
  }
  await addNotice({
    kind,
    wizardId: run.wizardId,
    runId: run.id,
    startId: run.startedBy.startId,
    detail,
  });
}

export async function addNotice(input: {
  kind: NoticeKind;
  wizardId: string;
  runId?: string | null;
  startId?: string | null;
  detail?: string | null;
}) {
  const tenantId = currentTenant();
  // The same word twice about one run says nothing new: a run that waits again replaces it.
  if (input.runId) {
    await db
      .delete(schema.notice)
      .where(
        and(
          eq(schema.notice.runId, input.runId),
          eq(schema.notice.kind, input.kind),
          isNull(schema.notice.readAt),
        ),
      );
  }
  await db.insert(schema.notice).values({
    id: nanoid(12),
    tenantId,
    kind: input.kind,
    wizardId: input.wizardId,
    runId: input.runId ?? null,
    startId: input.startId ?? null,
    detail: input.detail?.slice(0, 300) ?? null,
  });
  const old = await db.query.notice.findMany({
    where: eq(schema.notice.tenantId, tenantId),
    orderBy: [desc(schema.notice.createdAt)],
    offset: KEEP,
    columns: { id: true },
  });
  if (old.length) {
    await db.delete(schema.notice).where(
      inArray(
        schema.notice.id,
        old.map((n) => n.id),
      ),
    );
  }
}

export async function listNotices(limit = 50) {
  const rows = await db.query.notice.findMany({
    where: eq(schema.notice.tenantId, currentTenant()),
    orderBy: [desc(schema.notice.createdAt)],
    limit,
  });
  const wizardIds = [...new Set(rows.map((r) => r.wizardId))];
  const wizards = wizardIds.length
    ? await db.query.wizard.findMany({
        where: inArray(schema.wizard.id, wizardIds),
        columns: { id: true, title: true, starts: true },
      })
    : [];
  return rows.map((r) => {
    const w = wizards.find((x) => x.id === r.wizardId);
    return {
      id: r.id,
      kind: r.kind,
      wizard: { id: r.wizardId, title: w?.title ?? "" },
      runId: r.runId,
      start: w?.starts.find((s) => s.id === r.startId) ?? null,
      detail: r.detail,
      read: r.readAt !== null,
      at: r.createdAt.toISOString(),
    };
  });
}

/** Marks the named notices read, or every one of the tenant. */
export async function markNoticesRead(ids: string[] | "all") {
  const where =
    ids === "all"
      ? eq(schema.notice.tenantId, currentTenant())
      : and(eq(schema.notice.tenantId, currentTenant()), inArray(schema.notice.id, ids));
  await db.update(schema.notice).set({ readAt: new Date() }).where(where);
}
