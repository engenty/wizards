import { and, asc, desc, eq, exists, inArray, like, max, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { SessionUser } from "../auth/index.js";
import { db, schema } from "../db/client.js";
import type { ChatPartRecord } from "../db/schema.js";
import { managed, tenantMembers } from "../manage.js";
import { ServiceError } from "./errors.js";
import { userProfile } from "./profile.js";

/**
 * Work's chats (behind `workMode`): chats with members, in sections of the sidebar or in none,
 * sub-threads as chats with a parent. A private chat is seen by its members only, any other one by
 * everyone of the tenant, who joins it by writing in it. Messages keep the AI SDK's parts.
 */

/** A chat's title from its first message, cut to this length. */
const TITLE_CHARS = 60;

type ChatRow = typeof schema.chat.$inferSelect;
type MemberKind = "person" | "engenty";

export interface ChatListItem {
  id: string;
  title: string;
  sectionId: string | null;
  parentId: string | null;
  private: boolean;
  updatedAt: string;
}

/** A chat as the sidebar shows it: with what the person did with it and its last message. */
export interface SidebarChat extends ChatListItem {
  pinned: boolean;
  archived: boolean;
  unread: boolean;
  last: { author: string; text: string; at: string } | null;
}

/** A preview of a message's parts, cut short: its text, else what it did. */
const PREVIEW_CHARS = 160;

export interface ChatMemberView {
  kind: MemberKind;
  id: string;
  name: string;
  image: string | null;
}

export interface ChatMessageView {
  id: string;
  author: { kind: MemberKind; id: string };
  parts: ChatPartRecord[];
  createdAt: string;
}

const listItem = (c: ChatRow): ChatListItem => ({
  id: c.id,
  title: c.title,
  sectionId: c.sectionId,
  parentId: c.parentId,
  private: c.private,
  updatedAt: c.updatedAt.toISOString(),
});

const isMember = (user: SessionUser) =>
  exists(
    db
      .select({ one: sql`1` })
      .from(schema.chatMember)
      .where(
        and(
          eq(schema.chatMember.chatId, schema.chat.id),
          eq(schema.chatMember.kind, "person"),
          eq(schema.chatMember.memberId, user.id),
        ),
      ),
  );

/** The chats the person sees: the tenant's, but a private one only as a member. */
const visible = (user: SessionUser) =>
  and(eq(schema.chat.tenantId, user.tenantId), or(eq(schema.chat.private, false), isMember(user)));

async function visibleChat(user: SessionUser, id: string): Promise<ChatRow> {
  const found = await db.query.chat.findFirst({
    where: and(eq(schema.chat.id, id), visible(user)),
  });
  if (!found) {
    throw new ServiceError("not_found", "chat not found");
  }
  return found;
}

async function sectionOf(user: SessionUser, id: string | null | undefined) {
  if (!id) {
    return null;
  }
  const found = await db.query.chatSection.findFirst({
    where: and(eq(schema.chatSection.id, id), eq(schema.chatSection.tenantId, user.tenantId)),
  });
  if (!found) {
    throw new ServiceError("not_found", "section not found");
  }
  return found.id;
}

async function join(chatId: string, kind: MemberKind, memberId: string) {
  await db.insert(schema.chatMember).values({ chatId, kind, memberId }).onConflictDoNothing();
}

/**
 * The sidebar: the sections in their order and the chats the person sees, newest first, each with
 * the person's pin, archive and unread mark and its last message.
 */
export async function sidebar(user: SessionUser, query?: string) {
  const sections = await db.query.chatSection.findMany({
    where: eq(schema.chatSection.tenantId, user.tenantId),
    orderBy: [asc(schema.chatSection.position), asc(schema.chatSection.createdAt)],
  });
  const q = query?.trim();
  const matches = q
    ? or(
        like(schema.chat.title, `%${q}%`),
        exists(
          db
            .select({ one: sql`1` })
            .from(schema.chatMessage)
            .where(
              and(
                eq(schema.chatMessage.chatId, schema.chat.id),
                like(schema.chatMessage.parts, `%${q}%`),
              ),
            ),
        ),
      )
    : undefined;
  const chats = await db.query.chat.findMany({
    where: and(visible(user), matches),
    orderBy: [desc(schema.chat.updatedAt)],
  });
  const ids = chats.map((c) => c.id);
  const [states, lasts, names] = ids.length
    ? await Promise.all([
        db.query.chatState.findMany({
          where: and(inArray(schema.chatState.chatId, ids), eq(schema.chatState.userId, user.id)),
        }),
        db.query.chatMessage.findMany({
          where: and(
            inArray(schema.chatMessage.chatId, ids),
            sql`${schema.chatMessage.createdAt} = (SELECT MAX(l.created_at) FROM chat_message l WHERE l.chat_id = ${schema.chatMessage.chatId})`,
          ),
        }),
        people(user),
      ])
    : [[], [], new Map<string, { name: string }>()];
  const stateOf = new Map(states.map((st) => [st.chatId, st]));
  const lastOf = new Map(lasts.map((m) => [m.chatId, m]));
  return {
    sections: sections.map((sec) => ({ id: sec.id, name: sec.name })),
    chats: chats.map((c): SidebarChat => {
      const st = stateOf.get(c.id);
      const last = lastOf.get(c.id);
      return {
        ...listItem(c),
        pinned: Boolean(st?.pinnedAt),
        archived: Boolean(st?.archivedAt),
        unread: Boolean(
          last &&
            !(last.authorKind === "person" && last.authorId === user.id) &&
            (!st?.readAt || st.readAt < last.createdAt),
        ),
        last: last
          ? {
              author: names.get(last.authorId)?.name ?? last.authorId,
              text: previewOf(last.parts),
              at: last.createdAt.toISOString(),
            }
          : null,
      };
    }),
  };
}

function previewOf(parts: ChatPartRecord[]): string {
  const text = parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, PREVIEW_CHARS);
}

/** What the person does with a chat for themselves: pin, archive, mark read or unread. */
export async function setChatState(
  user: SessionUser,
  id: string,
  patch: { pinned?: boolean; archived?: boolean; read?: boolean },
) {
  const chat = await visibleChat(user, id);
  const now = new Date();
  const values = {
    ...(patch.pinned !== undefined ? { pinnedAt: patch.pinned ? now : null } : {}),
    ...(patch.archived !== undefined ? { archivedAt: patch.archived ? now : null } : {}),
    ...(patch.read !== undefined ? { readAt: patch.read ? now : null } : {}),
  };
  await db
    .insert(schema.chatState)
    .values({ chatId: chat.id, userId: user.id, ...values })
    .onConflictDoUpdate({
      target: [schema.chatState.chatId, schema.chatState.userId],
      set: values,
    });
}

export async function createChat(
  user: SessionUser,
  input: { title?: string; sectionId?: string | null; parentId?: string | null; private?: boolean },
): Promise<ChatListItem> {
  const parent = input.parentId ? await visibleChat(user, input.parentId) : null;
  const [row] = await db
    .insert(schema.chat)
    .values({
      id: nanoid(12),
      tenantId: user.tenantId,
      title: input.title?.trim() ?? "",
      // A sub-thread sits where its parent sits, and is as private.
      sectionId: parent ? parent.sectionId : await sectionOf(user, input.sectionId),
      parentId: parent?.id ?? null,
      private: parent ? parent.private : (input.private ?? false),
      createdBy: user.id,
    })
    .returning();
  await join(row.id, "person", user.id);
  return listItem(row);
}

export async function updateChat(
  user: SessionUser,
  id: string,
  patch: { title?: string; sectionId?: string | null; private?: boolean },
): Promise<ChatListItem> {
  const chat = await visibleChat(user, id);
  const [row] = await db
    .update(schema.chat)
    .set({
      ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
      ...(patch.sectionId !== undefined
        ? { sectionId: await sectionOf(user, patch.sectionId) }
        : {}),
      ...(patch.private !== undefined ? { private: patch.private } : {}),
    })
    .where(eq(schema.chat.id, chat.id))
    .returning();
  return listItem(row);
}

/** Who made the chat, or an owner or admin, deletes it with its sub-threads. */
export async function deleteChat(user: SessionUser, id: string) {
  const chat = await visibleChat(user, id);
  if (chat.createdBy !== user.id && user.role === "member") {
    throw new ServiceError("forbidden", "only who made the chat deletes it");
  }
  await db.delete(schema.chat).where(eq(schema.chat.id, chat.id));
}

/** The tenant's people by id, for the names in a chat; alone, the one person. */
async function people(
  user: SessionUser,
): Promise<Map<string, { name: string; image: string | null }>> {
  if (!managed) {
    const profile = await userProfile(user);
    return new Map([[user.id, { name: profile.name, image: user.image ?? null }]]);
  }
  const { members } = await tenantMembers(user.tenantId);
  return new Map(members.map((m) => [m.userId, { name: m.name, image: m.image }]));
}

/** One chat as its page shows it: members, messages and sub-threads. */
export async function readChat(user: SessionUser, id: string) {
  const chat = await visibleChat(user, id);
  await setChatState(user, chat.id, { read: true });
  const [members, messages, threads, names] = await Promise.all([
    db.query.chatMember.findMany({
      where: eq(schema.chatMember.chatId, chat.id),
      orderBy: [asc(schema.chatMember.joinedAt)],
    }),
    db.query.chatMessage.findMany({
      where: eq(schema.chatMessage.chatId, chat.id),
      // Messages of one millisecond keep the order they were written in.
      orderBy: [asc(schema.chatMessage.createdAt), asc(sql`rowid`)],
    }),
    db.query.chat.findMany({
      where: and(eq(schema.chat.parentId, chat.id), visible(user)),
      orderBy: [desc(schema.chat.updatedAt)],
    }),
    people(user),
  ]);
  return {
    chat: listItem(chat),
    members: members.map(
      (m): ChatMemberView => ({
        kind: m.kind,
        id: m.memberId,
        name: names.get(m.memberId)?.name ?? m.memberId,
        image: names.get(m.memberId)?.image ?? null,
      }),
    ),
    messages: messages.map(
      (m): ChatMessageView => ({
        id: m.id,
        author: { kind: m.authorKind, id: m.authorId },
        parts: m.parts,
        createdAt: m.createdAt.toISOString(),
      }),
    ),
    threads: threads.map(listItem),
  };
}

/** A person writes in a chat: they join it, and its first message names it. */
export async function postMessage(
  user: SessionUser,
  id: string,
  text: string,
): Promise<ChatMessageView> {
  const chat = await visibleChat(user, id);
  await join(chat.id, "person", user.id);
  const parts: ChatPartRecord[] = [{ type: "text", text }];
  const [row] = await db
    .insert(schema.chatMessage)
    .values({ id: nanoid(14), chatId: chat.id, authorKind: "person", authorId: user.id, parts })
    .returning();
  const firstLine = text.trim().split("\n")[0] ?? "";
  await db
    .update(schema.chat)
    .set({
      updatedAt: row.createdAt,
      ...(chat.title ? {} : { title: firstLine.slice(0, TITLE_CHARS) }),
    })
    .where(eq(schema.chat.id, chat.id));
  return {
    id: row.id,
    author: { kind: "person", id: user.id },
    parts,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Adds a person of the tenant or an engenty to a chat the person sees. */
export async function addMember(user: SessionUser, id: string, kind: MemberKind, memberId: string) {
  const chat = await visibleChat(user, id);
  if (kind === "person" && managed) {
    const { members } = await tenantMembers(user.tenantId);
    if (!members.some((m) => m.userId === memberId)) {
      throw new ServiceError("not_found", "no such person in the organization");
    }
  }
  await join(chat.id, kind, memberId);
}

export async function removeMember(
  user: SessionUser,
  id: string,
  kind: MemberKind,
  memberId: string,
) {
  const chat = await visibleChat(user, id);
  await db
    .delete(schema.chatMember)
    .where(
      and(
        eq(schema.chatMember.chatId, chat.id),
        eq(schema.chatMember.kind, kind),
        eq(schema.chatMember.memberId, memberId),
      ),
    );
}

// --- sections -------------------------------------------------------------------

export async function createSection(user: SessionUser, name: string) {
  const [last] = await db
    .select({ position: max(schema.chatSection.position) })
    .from(schema.chatSection)
    .where(eq(schema.chatSection.tenantId, user.tenantId));
  const [row] = await db
    .insert(schema.chatSection)
    .values({
      id: nanoid(12),
      tenantId: user.tenantId,
      name: name.trim(),
      position: (last?.position ?? -1) + 1,
      createdBy: user.id,
    })
    .returning();
  return { id: row.id, name: row.name };
}

export async function renameSection(user: SessionUser, id: string, name: string) {
  const sectionId = await sectionOf(user, id);
  await db
    .update(schema.chatSection)
    .set({ name: name.trim() })
    .where(eq(schema.chatSection.id, sectionId as string));
  return { id, name: name.trim() };
}

/** Moves a section one place up or down among the tenant's sections. */
export async function moveSection(user: SessionUser, id: string, direction: "up" | "down") {
  const sectionId = (await sectionOf(user, id)) as string;
  const all = await db.query.chatSection.findMany({
    where: eq(schema.chatSection.tenantId, user.tenantId),
    orderBy: [asc(schema.chatSection.position), asc(schema.chatSection.createdAt)],
  });
  const at = all.findIndex((sec) => sec.id === sectionId);
  const to = direction === "up" ? at - 1 : at + 1;
  if (to < 0 || to >= all.length) {
    return;
  }
  [all[at], all[to]] = [all[to], all[at]];
  await db.transaction(async (tx) => {
    for (const [position, sec] of all.entries()) {
      await tx
        .update(schema.chatSection)
        .set({ position })
        .where(eq(schema.chatSection.id, sec.id));
    }
  });
}

/** Deletes a section; its chats stay, outside any section. */
export async function deleteSection(user: SessionUser, id: string) {
  const sectionId = await sectionOf(user, id);
  await db.delete(schema.chatSection).where(eq(schema.chatSection.id, sectionId as string));
}
