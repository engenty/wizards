import { and, eq, ne } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema } from "../db/client.js";
import { currentTenant } from "../tenants/tenant.js";

/**
 * A run's review with `approve`, for the team: the row stands while the run waits on it, and is gone
 * once the run has moved, so a held row says what is held now. What the review decided is kept by
 * `decidedHeld`.
 */
export async function holdReview(
  run: { id: string; userId: string | null },
  review: { stepId: string; title: string } | null,
) {
  await db
    .delete(schema.approval)
    .where(
      and(
        eq(schema.approval.runId, run.id),
        eq(schema.approval.state, "pending"),
        review ? ne(schema.approval.stepId, review.stepId) : undefined,
      ),
    );
  if (!review) {
    return;
  }
  const held = await db.query.approval.findFirst({
    where: and(
      eq(schema.approval.runId, run.id),
      eq(schema.approval.stepId, review.stepId),
      eq(schema.approval.state, "pending"),
    ),
    columns: { id: true },
  });
  if (!held) {
    await db.insert(schema.approval).values({
      id: nanoid(12),
      tenantId: currentTenant(),
      runId: run.id,
      stepId: review.stepId,
      toolName: review.title,
      askedBy: run.userId ?? "",
      heldFor: "team",
    });
  }
}

/** What a run's review decided, and who decided it. The run's write said who was first. */
export async function decidedHeld(
  run: { id: string; userId: string | null },
  review: { stepId: string; title: string },
  approved: boolean,
  decidedBy: string | null,
) {
  await db.insert(schema.approval).values({
    id: nanoid(12),
    tenantId: currentTenant(),
    runId: run.id,
    stepId: review.stepId,
    toolName: review.title,
    askedBy: run.userId ?? "",
    heldFor: "team",
    state: approved ? "approved" : "denied",
    decidedBy,
    decidedAt: new Date(),
  });
}
