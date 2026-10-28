import { toAISdkMessages } from "@mastra/ai-sdk/ui";
import { and, asc, desc, eq, exists, like, max, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { SessionUser } from "../auth/index.js";
import { db, schema } from "../db/client.js";
import { managed, tenantMembers } from "../manage.js";
import { ServiceError } from "./errors.js";
import { userProfile } from "./profile.js";
import { workMastra } from "./work-mastra.js";

/**
 * Work's chats (behind `workMode`): chats of a space with members, in sections of the space's
 * sidebar or in none, sub-threads as chats with a parent. A private chat is seen by its members
 * only, any other one by everyone of the tenant, who joins it by writing in it. The messages are
 * a Mastra memory thread per chat (work-mastra.ts); the chat row keeps what the sidebar shows.
 */

/** A chat's title from its first message, cut to this length. */
const TITLE_CHARS = 60;
/** The last message's start the sidebar keeps. */
const PREVIEW_CHARS = 160;
/** Who wrote a message of the space's AI. */
export const AI_AUTHOR = "ai";

type ChatRow = typeof schema.chat.$inferSelect;
type MemberKind = "person" | "engenty";

export interface ChatListItem {
  id: string;
  spaceId: string;
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

export interface ChatMemberView {
  kind: MemberKind;
  id: string;
  name: string;
  image: string | null;
}

/** One message as the chat shows it: the AI SDK's parts, and who wrote it. */
export interface ChatMessageView {
  id: string;
  author: { kind: "person" | "ai"; id: string; name: string };
  parts: { type: string; [key: string]: unknown }[];
  createdAt: string;
}

const listItem = (c: ChatRow): ChatListItem => ({
  id: c.id,
  spaceId: c.projectId,
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

/** A space of the person's tenant. */
async function spaceOf(user: SessionUser, id: string) {
  const found = await db.query.project.findFirst({
    where: and(eq(schema.project.id, id), eq(schema.project.tenantId, user.tenantId)),
  });
  if (!found) {
    throw new ServiceError("not_found", "space not found");
  }
  return found.id;
}

async function sectionOf(user: SessionUser, spaceId: string, id: string | null | undefined) {
  if (!id) {
    return null;
  }
  const found = await db.query.chatSection.findFirst({
    where: and(
      eq(schema.chatSection.id, id),
      eq(schema.chatSection.tenantId, user.tenantId),
      eq(schema.chatSection.projectId, spaceId),
    ),
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
 * The sidebar of a space: its sections in their order and the chats the person sees, newest
 * first, each with the person's pin, archive and unread mark and its last message. The search
 * looks at titles and last messages.
 */
export async function sidebar(user: SessionUser, spaceId: string, query?: string) {
  const space = await spaceOf(user, spaceId);
  const sections = await db.query.chatSection.findMany({
    where: eq(schema.chatSection.projectId, space),
    orderBy: [asc(schema.chatSection.position), asc(schema.chatSection.createdAt)],
  });
  const q = query?.trim();
  const chats = await db.query.chat.findMany({
    where: and(
      visible(user),
      eq(schema.chat.projectId, space),
      q ? or(like(schema.chat.title, `%${q}%`), like(schema.chat.lastText, `%${q}%`)) : undefined,
    ),
    orderBy: [desc(schema.chat.updatedAt)],
  });
  const states = await db.query.chatState.findMany({
    where: eq(schema.chatState.userId, user.id),
  });
  const stateOf = new Map(states.map((st) => [st.chatId, st]));
  return {
    sections: sections.map((sec) => ({ id: sec.id, name: sec.name })),
    chats: chats.map((c): SidebarChat => {
      const st = stateOf.get(c.id);
      const hasMessage = c.lastAuthorId !== null;
      return {
        ...listItem(c),
        pinned: Boolean(st?.pinnedAt),
        archived: Boolean(st?.archivedAt),
        unread:
          hasMessage && c.lastAuthorId !== user.id && (!st?.readAt || st.readAt < c.updatedAt),
        last: hasMessage
          ? {
              author: c.lastAuthorName ?? "",
              text: c.lastText ?? "",
              at: c.updatedAt.toISOString(),
            }
          : null,
      };
    }),
  };
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
  input: {
    spaceId?: string;
    title?: string;
    sectionId?: string | null;
    parentId?: string | null;
    private?: boolean;
  },
): Promise<ChatListItem> {
  const parent = input.parentId ? await visibleChat(user, input.parentId) : null;
  // A sub-thread is in its parent's space and section, and as private.
  const space = parent ? parent.projectId : await spaceOf(user, input.spaceId ?? "");
  const [row] = await db
    .insert(schema.chat)
    .values({
      id: nanoid(12),
      tenantId: user.tenantId,
      projectId: space,
      title: input.title?.trim() ?? "",
      sectionId: parent ? parent.sectionId : await sectionOf(user, space, input.sectionId),
      parentId: parent?.id ?? null,
      private: parent ? parent.private : (input.private ?? false),
      createdBy: user.id,
    })
    .returning();
  await join(row.id, "person", user.id);
  const { memory } = await workMastra();
  await memory.createThread({ threadId: row.id, resourceId: space, title: row.title });
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
        ? { sectionId: await sectionOf(user, chat.projectId, patch.sectionId) }
        : {}),
      ...(patch.private !== undefined ? { private: patch.private } : {}),
    })
    .where(eq(schema.chat.id, chat.id))
    .returning();
  return listItem(row);
}

/** Who made the chat, or an owner or admin, deletes it with its sub-threads and their messages. */
export async function deleteChat(user: SessionUser, id: string) {
  const chat = await visibleChat(user, id);
  if (chat.createdBy !== user.id && user.role === "member") {
    throw new ServiceError("forbidden", "only who made the chat deletes it");
  }
  const threads = [chat.id];
  for (let at = 0; at < threads.length; at++) {
    const children = await db.query.chat.findMany({
      where: eq(schema.chat.parentId, threads[at]),
      columns: { id: true },
    });
    threads.push(...children.map((c) => c.id));
  }
  const { memory } = await workMastra();
  for (const threadId of threads) {
    await memory.deleteThread(threadId);
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

type StoredMessage = {
  id: string;
  role: string;
  createdAt: Date | string;
  content: {
    parts?: unknown[];
    metadata?: {
      signal?: { attributes?: { name?: string; id?: string }; metadata?: { authorId?: string } };
    };
  };
};

/** A stored Mastra message as the chat shows it. */
function messageView(m: StoredMessage): ChatMessageView {
  const signal = m.content.metadata?.signal;
  const person = m.role === "user" || m.role === "signal";
  const [converted] = toAISdkMessages([m] as never, { version: "v7" } as never) as {
    parts: ChatMessageView["parts"];
  }[];
  return {
    id: m.id,
    author: person
      ? {
          kind: "person",
          id: signal?.metadata?.authorId ?? signal?.attributes?.id ?? "",
          name: signal?.attributes?.name ?? "",
        }
      : { kind: "ai", id: AI_AUTHOR, name: "" },
    parts: (converted?.parts ?? []).filter((p) => p.type !== "step-start"),
    createdAt: new Date(m.createdAt).toISOString(),
  };
}

/** One chat as its page shows it: members, messages and sub-threads. */
export async function readChat(user: SessionUser, id: string) {
  const chat = await visibleChat(user, id);
  await setChatState(user, chat.id, { read: true });
  const { memory } = await workMastra();
  const [members, recalled, threads, names] = await Promise.all([
    db.query.chatMember.findMany({
      where: eq(schema.chatMember.chatId, chat.id),
      orderBy: [asc(schema.chatMember.joinedAt)],
    }),
    memory.recall({ threadId: chat.id, resourceId: chat.projectId, perPage: false }),
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
    messages: (recalled.messages as unknown as StoredMessage[]).map(messageView),
    threads: threads.map(listItem),
  };
}

/**
 * A person writes in a chat: they join it, the message goes into the chat's thread with them as
 * author, and the first message names the chat. The AI is not asked here: the message is kept
 * without a run (step 3, PR 3 asks it).
 */
export async function postMessage(user: SessionUser, id: string, text: string) {
  const chat = await visibleChat(user, id);
  await join(chat.id, "person", user.id);
  const name = (await userProfile(user)).name;
  const { agent } = await workMastra();
  const sent = agent.sendMessage(
    { contents: text, attributes: { name }, metadata: { authorId: user.id } },
    { resourceId: chat.projectId, threadId: chat.id, ifIdle: { behavior: "persist" } },
  );
  await sent.accepted;
  const flat = text.replace(/\s+/g, " ").trim();
  await db
    .update(schema.chat)
    .set({
      updatedAt: new Date(),
      lastAuthorId: user.id,
      lastAuthorName: name,
      lastText: flat.slice(0, PREVIEW_CHARS),
      ...(chat.title ? {} : { title: (text.trim().split("\n")[0] ?? "").slice(0, TITLE_CHARS) }),
    })
    .where(eq(schema.chat.id, chat.id));
  return { ok: true };
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

export async function createSection(user: SessionUser, spaceId: string, name: string) {
  const space = await spaceOf(user, spaceId);
  const [last] = await db
    .select({ position: max(schema.chatSection.position) })
    .from(schema.chatSection)
    .where(eq(schema.chatSection.projectId, space));
  const [row] = await db
    .insert(schema.chatSection)
    .values({
      id: nanoid(12),
      tenantId: user.tenantId,
      projectId: space,
      name: name.trim(),
      position: (last?.position ?? -1) + 1,
      createdBy: user.id,
    })
    .returning();
  return { id: row.id, name: row.name };
}

async function ownSection(user: SessionUser, id: string) {
  const found = await db.query.chatSection.findFirst({
    where: and(eq(schema.chatSection.id, id), eq(schema.chatSection.tenantId, user.tenantId)),
  });
  if (!found) {
    throw new ServiceError("not_found", "section not found");
  }
  return found;
}

export async function renameSection(user: SessionUser, id: string, name: string) {
  const section = await ownSection(user, id);
  await db
    .update(schema.chatSection)
    .set({ name: name.trim() })
    .where(eq(schema.chatSection.id, section.id));
  return { id, name: name.trim() };
}

/** Moves a section one place up or down among its space's sections. */
export async function moveSection(user: SessionUser, id: string, direction: "up" | "down") {
  const section = await ownSection(user, id);
  const all = await db.query.chatSection.findMany({
    where: eq(schema.chatSection.projectId, section.projectId),
    orderBy: [asc(schema.chatSection.position), asc(schema.chatSection.createdAt)],
  });
  const at = all.findIndex((sec) => sec.id === section.id);
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
  const section = await ownSection(user, id);
  await db.delete(schema.chatSection).where(eq(schema.chatSection.id, section.id));
}
