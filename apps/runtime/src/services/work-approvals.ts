import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { SessionUser } from "../auth/index.js";
import { db, schema } from "../db/client.js";
import { currentTenant } from "../tenants/tenant.js";
import { ServiceError } from "./errors.js";

/**
 * Calls of the space's AI held for a person's approval (docs/plans/work-chats.md, "Approvals: the
 * gate on the tool"). Holding stores the call; deciding is taken once, by the person the turn was
 * for or an owner or admin, never by the AI. The call itself runs in work-chats.ts.
 */

type ApprovalRow = typeof schema.chatApproval.$inferSelect;

export interface ApprovalView {
  id: string;
  chatId: string;
  toolName: string;
  input: unknown;
  askedBy: string;
  state: ApprovalRow["state"];
  output: unknown;
  decidedBy: string | null;
  createdAt: string;
}

const view = (a: ApprovalRow): ApprovalView => ({
  id: a.id,
  chatId: a.chatId,
  toolName: a.toolName,
  input: a.input ?? null,
  askedBy: a.askedBy,
  state: a.state,
  output: a.output ?? null,
  decidedBy: a.decidedBy,
  createdAt: a.createdAt.toISOString(),
});

/** Stores a call the gate held; its id goes to the AI and the chat's card. */
export async function holdCall(
  turn: { chatId: string; userId: string },
  toolName: string,
  input: unknown,
): Promise<string> {
  const id = nanoid(12);
  await db.insert(schema.chatApproval).values({
    id,
    tenantId: currentTenant(),
    chatId: turn.chatId,
    toolName,
    input: input ?? null,
    askedBy: turn.userId,
  });
  return id;
}

export async function approvalsOf(chatId: string): Promise<ApprovalView[]> {
  const rows = await db.query.chatApproval.findMany({
    where: eq(schema.chatApproval.chatId, chatId),
    orderBy: [asc(schema.chatApproval.createdAt)],
  });
  return rows.map(view);
}

/** Whether the person may decide: the turn was theirs, or they own or run the organization. */
export const mayDecide = (user: SessionUser, approval: { askedBy: string }) =>
  approval.askedBy === user.id || user.role === "owner" || user.role === "admin";

/**
 * Takes the decision, once: only a pending approval of this chat changes, so a second click or a
 * second person gets a conflict and nothing runs twice.
 */
export async function takeDecision(
  user: SessionUser,
  chatId: string,
  id: string,
  approve: boolean,
): Promise<ApprovalRow> {
  const found = await db.query.chatApproval.findFirst({
    where: and(eq(schema.chatApproval.id, id), eq(schema.chatApproval.chatId, chatId)),
  });
  if (!found) {
    throw new ServiceError("not_found", "approval not found");
  }
  if (!mayDecide(user, found)) {
    throw new ServiceError("forbidden", "only who asked, or an owner or admin, decides");
  }
  const [taken] = await db
    .update(schema.chatApproval)
    .set({ state: approve ? "approved" : "denied", decidedBy: user.id, decidedAt: new Date() })
    .where(and(eq(schema.chatApproval.id, id), eq(schema.chatApproval.state, "pending")))
    .returning();
  if (!taken) {
    throw new ServiceError("revision_conflict", "already decided");
  }
  return taken;
}

/** What the approved call gave, or why it failed. */
export async function noteOutcome(id: string, outcome: { output: unknown } | { error: string }) {
  await db
    .update(schema.chatApproval)
    .set(
      "error" in outcome
        ? { state: "failed", output: { error: outcome.error } }
        : { output: outcome.output ?? null },
    )
    .where(eq(schema.chatApproval.id, id));
}

/** The approvals waiting for the person, in the chats they see, newest first: the bell. */
export async function waitingFor(user: SessionUser, visibleChatIds: string[]) {
  if (!visibleChatIds.length) {
    return [];
  }
  const rows = await db.query.chatApproval.findMany({
    where: and(
      eq(schema.chatApproval.state, "pending"),
      inArray(schema.chatApproval.chatId, visibleChatIds),
      user.role === "member" ? eq(schema.chatApproval.askedBy, user.id) : undefined,
    ),
    orderBy: [desc(schema.chatApproval.createdAt)],
  });
  return rows.map(view);
}
