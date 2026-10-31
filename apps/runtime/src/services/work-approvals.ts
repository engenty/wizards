import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { SessionUser } from "../auth/index.js";
import { db, schema } from "../db/client.js";
import { currentTenant } from "../tenants/tenant.js";
import { isAdminRole } from "./access.js";
import { ServiceError } from "./errors.js";

/**
 * Calls of the space's AI held for a person's approval (docs/plans/work-chats.md, "Approvals: the
 * gate on the tool"). Holding stores the call; deciding is taken once, by the person the turn was
 * for or an owner or admin, never by the AI. A call held for the space's admins („Mit Freigabe“
 * on a connection that signs in as the space, docs/plans/capabilities.md A7) is decided by an
 * owner or admin alone. The call itself runs in work-chats.ts.
 */

type ApprovalRow = typeof schema.chatApproval.$inferSelect;

/** Whose decision a held call waits for. */
export type HeldFor = ApprovalRow["heldFor"];

export interface ApprovalView {
  id: string;
  chatId: string;
  toolName: string;
  input: unknown;
  askedBy: string;
  heldFor: HeldFor;
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
  heldFor: a.heldFor,
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
  heldFor: HeldFor = "asker",
): Promise<string> {
  const id = nanoid(12);
  await db.insert(schema.chatApproval).values({
    id,
    tenantId: currentTenant(),
    chatId: turn.chatId,
    toolName,
    input: input ?? null,
    askedBy: turn.userId,
    heldFor,
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

/**
 * Whether the person may decide: the turn was theirs, or they own or run the organization. A call
 * held for the admins is theirs alone, whoever asked.
 */
export const mayDecide = (user: SessionUser, approval: { askedBy: string; heldFor: HeldFor }) =>
  isAdminRole(user.role) || (approval.heldFor === "asker" && approval.askedBy === user.id);

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
    throw new ServiceError(
      "forbidden",
      found.heldFor === "admins"
        ? "only an owner or admin decides"
        : "only who asked, or an owner or admin, decides",
    );
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

/**
 * The approvals waiting for the person, newest first: the bell. A member sees their own, in the
 * chats they see; an owner or admin every pending call of the organization, those held for the
 * admins among them, in private chats they are not in too (docs/plans/capabilities.md, A7a).
 */
export async function waitingFor(user: SessionUser, visibleChatIds: string[]) {
  const admin = isAdminRole(user.role);
  if (!(admin || visibleChatIds.length)) {
    return [];
  }
  const rows = await db.query.chatApproval.findMany({
    where: and(
      eq(schema.chatApproval.tenantId, user.tenantId),
      eq(schema.chatApproval.state, "pending"),
      admin
        ? undefined
        : and(
            inArray(schema.chatApproval.chatId, visibleChatIds),
            eq(schema.chatApproval.askedBy, user.id),
            eq(schema.chatApproval.heldFor, "asker"),
          ),
    ),
    orderBy: [desc(schema.chatApproval.createdAt)],
  });
  return rows.map(view);
}

/** Whether a tool's result says the call is held: the gate's answer, and a hold for the admins. */
export function heldBy(output: unknown): string | null {
  const o = output as { approval?: unknown; status?: unknown } | null | undefined;
  return o && typeof o === "object" && typeof o.approval === "string" && o.status === "waiting"
    ? o.approval
    : null;
}
