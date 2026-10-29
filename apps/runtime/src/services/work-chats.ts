import { note } from "@engenty/wizards-shared/run";
import { toAISdkStream } from "@mastra/ai-sdk";
import { toAISdkMessages } from "@mastra/ai-sdk/ui";
import { RequestContext } from "@mastra/core/request-context";
import { and, asc, desc, eq, exists, inArray, like, max, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { toolSizes } from "../agents/studio-assistant.js";
import type { SessionUser } from "../auth/index.js";
import { canSpend } from "../credits/credits.js";
import { db, schema } from "../db/client.js";
import { managed, tenantMembers } from "../manage.js";
import { contextWindowOf, costOf, usageOf } from "../models.js";
import { assistantToolLabels } from "../tools/plugin.js";
import { type ClientStep, ClientSteps, stepChunk, stepParts } from "./client-steps.js";
import { ServiceError } from "./errors.js";
import { userProfile } from "./profile.js";
import { addProjectFile, fileView, projectFileContent } from "./project-files.js";
import {
  type LazyTurn,
  lazyTurn,
  MAX_STEPS,
  TURN_KEY,
  TURN_MS,
  type TurnChoice,
  toolToRun,
  type WorkTurn,
} from "./work-ai.js";
import { approvalsOf, noteOutcome, takeDecision, waitingFor } from "./work-approvals.js";
import { type ChatFile, chatFiles, fileKind, messageContents, viewParts } from "./work-files.js";
import { LAST_MESSAGES, workMastra } from "./work-mastra.js";

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
  /** Since when the space's AI answers here; null while it doesn't. */
  answeringSince: string | null;
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
  /** A view's Form this message answers: the call that showed it, and the answers by field. */
  form?: FormAnswer;
}

/** A Form's answers, sent as a person's message (`show_view`, work-ai.ts). */
export interface FormAnswer {
  call: string;
  values: Record<string, unknown>;
}

const listItem = (c: ChatRow): ChatListItem => ({
  id: c.id,
  spaceId: c.projectId,
  title: c.title,
  sectionId: c.sectionId,
  parentId: c.parentId,
  private: c.private,
  updatedAt: c.updatedAt.toISOString(),
  // A turn older than its limit isn't running any more (its process may have died).
  answeringSince:
    c.answeringSince && Date.now() - c.answeringSince.getTime() < TURN_MS
      ? c.answeringSince.toISOString()
      : null,
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

/**
 * The live feed's changes as the person may hear of them: a chat they see as it is; one they
 * don't see (private, or they were taken out of it) as gone, with its id alone, so it leaves a
 * sidebar that had it. A section's always (sections are the space's).
 */
export async function chatChangesFor<
  T extends {
    kind: string;
    op: string;
    item: string;
    projectId: string | null;
    parent: string | null;
  },
>(user: SessionUser, items: T[]): Promise<T[]> {
  const ids = items.filter((i) => i.kind === "chat" && i.parent !== "section").map((i) => i.item);
  if (!ids.length) {
    return items;
  }
  const seen = await db.query.chat.findMany({
    where: and(inArray(schema.chat.id, ids), visible(user)),
    columns: { id: true },
  });
  const ok = new Set(seen.map((c) => c.id));
  return items.map((i) =>
    i.kind !== "chat" || i.parent === "section" || ok.has(i.item)
      ? i
      : { ...i, op: "del", projectId: null, parent: null },
  );
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
      signal?: {
        attributes?: { name?: string; id?: string };
        metadata?: { authorId?: string; files?: ChatFile[]; form?: FormAnswer };
      };
    };
  };
};

/** A stored Mastra message as the chat shows it; its files as links into the space's files. */
function messageView(spaceId: string, m: StoredMessage): ChatMessageView {
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
    parts: viewParts(
      spaceId,
      (converted?.parts ?? []).filter((p) => p.type !== "step-start"),
      signal?.metadata?.files,
    ),
    createdAt: new Date(m.createdAt).toISOString(),
    ...(signal?.metadata?.form ? { form: signal.metadata.form } : {}),
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
    messages: (recalled.messages as unknown as StoredMessage[]).map((m) =>
      messageView(chat.projectId, m),
    ),
    threads: threads.map(listItem),
    approvals: await approvalsOf(chat.id),
    tools: await assistantToolLabels(user.tenantId),
  };
}

/** The chat row's last message, for the sidebar; the first message of a person names the chat. */
async function noteLast(chat: ChatRow, author: { id: string; name: string }, text: string) {
  const flat = text.replace(/\s+/g, " ").trim();
  await db
    .update(schema.chat)
    .set({
      updatedAt: new Date(),
      lastAuthorId: author.id,
      lastAuthorName: author.name,
      lastText: flat.slice(0, PREVIEW_CHARS),
      ...(chat.title || author.id === AI_AUTHOR
        ? {}
        : { title: (text.trim().split("\n")[0] ?? "").slice(0, TITLE_CHARS) }),
    })
    .where(eq(schema.chat.id, chat.id));
}

/**
 * A file a person adds to a message in a chat: it lands in the chat's space's files (pictures and
 * media as assets, the rest as documents, read and indexed), and the message names it by its id.
 */
export async function attachFile(
  user: SessionUser,
  id: string,
  file: { name: string; mime: string; data: Uint8Array },
) {
  const chat = await visibleChat(user, id);
  const row = await addProjectFile(chat.projectId, { ...file, kind: fileKind(file.mime) });
  return fileView(row);
}

/** Throws unless the person sees the chat: for routes of a chat that read nothing of it. */
export async function seeChat(user: SessionUser, id: string): Promise<void> {
  await visibleChat(user, id);
}

/** A file of the chat's space, for the chat's views and their Fields (`/chats/:id/assets/:file`). */
export async function chatFileContent(user: SessionUser, id: string, fileId: string) {
  const chat = await visibleChat(user, id);
  return projectFileContent(chat.projectId, fileId);
}

/** What became of a message: kept, queued, or a turn (new, or the running one it went into). */
export type Sent = { kind: "kept" } | { kind: "queued" } | { kind: "turn"; stream: ReadableStream };

/**
 * A person writes in a chat. They join it, the message goes into the chat's thread with them as
 * author, and their first message names the chat. Not asked, the AI doesn't run. Asked, the
 * message wakes it for a turn or goes into the turn it is running; the asker follows that turn
 * (its stream, in the AI SDK's UI parts). `later` waits until the running turn ends. `files`: the
 * ids of the space's files that go with it, which the model sees (work-files.ts).
 */
export async function sendMessage(
  user: SessionUser,
  id: string,
  text: string,
  /** `choice`: what the person chose in the composer for the turn it starts (work-ai.ts). */
  options: {
    ask?: boolean;
    later?: boolean;
    files?: string[];
    choice?: TurnChoice;
    form?: FormAnswer;
  } = {},
): Promise<Sent> {
  const chat = await visibleChat(user, id);
  const named = await chatFiles(chat.projectId, options.files ?? []);
  if (!text && !named.length) {
    throw new ServiceError("invalid", "empty message");
  }
  await join(chat.id, "person", user.id);
  const name = (await userProfile(user)).name;
  const { agent } = await workMastra();
  const { contents, files } = await messageContents(chat.projectId, text, named);
  const message = {
    contents,
    attributes: { name },
    metadata: {
      authorId: user.id,
      ...(files.length ? { files } : {}),
      ...(options.form ? { form: options.form } : {}),
    },
  };
  const target = { resourceId: chat.projectId, threadId: chat.id };
  if (options.ask && !(await canSpend())) {
    throw new ServiceError("no_credits", note("creditsUsedUp"));
  }
  // Every message is stored the moment it is sent, before any turn, and never delivered as
  // itself: a remark to a colleague doesn't steer the AI's running turn, and a stopped or failed
  // turn can't take a person's words with it (Mastra stores a turn's input when it ends, and
  // throws a stopped turn away).
  await agent.sendMessage(message, {
    ...target,
    ifActive: { behavior: "persist" },
    ifIdle: { behavior: "persist" },
  }).accepted;
  await noteLast(chat, { id: user.id, name }, text || files.map((f) => f.name).join(", "));
  if (!options.ask) {
    return { kind: "kept" };
  }
  // Asking the AI is a signal that isn't stored: the stored message is what it answers.
  const { turn, streamOptions } = await turnFor(chat, user.id, options.choice);
  const asked = {
    type: "reactive" as const,
    tagName: "asked",
    contents: `${name} asked you in the message above; answer it.`,
    transient: true,
  };
  // Running as the chat's watcher sees it: a run Mastra still winds down after its status is over.
  const running = await runningIn(chat.id);
  // For after the answer: queued while a turn runs; with none running it is a turn of its own.
  if (options.later && running) {
    await expectTurn(chat, turn);
    await agent.queueSignal(asked, { ...target, ifIdle: { behavior: "wake", streamOptions } })
      .accepted;
    return { kind: "queued" };
  }
  // Into a running turn the message goes as it is (the turn doesn't read the thread again), with
  // the reminder that the request before it still stands (engenty-pro, 8e7b970d1).
  const signal = running
    ? {
        type: "user" as const,
        attributes: { name },
        contents: (
          await messageContents(
            chat.projectId,
            `${text}\n\n(The request before this one still stands.)`.trim(),
            named,
          )
        ).contents,
        transient: true,
      }
    : asked;
  return deliverOrWake(chat, turn, streamOptions, (ifIdle) =>
    agent.sendSignal(signal, { ...target, ifActive: { behavior: "deliver" }, ifIdle }),
  );
}

/**
 * A turn for the person, made when it really starts (Mastra resolves the agent's model then):
 * input taken into a running turn builds nothing, and a queued one's 20 minutes start with it.
 */
async function turnFor(chat: ChatRow, userId: string, choice: TurnChoice = {}) {
  const space = await db.query.project.findFirst({ where: eq(schema.project.id, chat.projectId) });
  const turn = lazyTurn(
    {
      space: { id: chat.projectId, name: space?.name ?? "" },
      chatId: chat.id,
      userId,
    },
    choice,
  );
  const requestContext = new RequestContext();
  requestContext.set(TURN_KEY, turn);
  return { turn, streamOptions: { requestContext, maxSteps: MAX_STEPS, abortSignal: turn.signal } };
}

type StreamOptions = Awaited<ReturnType<typeof turnFor>>["streamOptions"];
type IfIdle = { behavior: "wake"; streamOptions: StreamOptions };

/**
 * Sends input to the chat's thread: into the running turn, or waking one. Either way the asker
 * follows the run it went into (the chat's watcher), from its start.
 */
async function deliverOrWake(
  chat: ChatRow,
  turn: LazyTurn,
  streamOptions: StreamOptions,
  send: (ifIdle: IfIdle) => { accepted: Promise<{ action?: string } | undefined> },
): Promise<Sent> {
  const watcher = await watch(chat);
  await settled(chat);
  watcher.next.push(turn);
  const accepted = await send({ behavior: "wake", streamOptions }).accepted;
  if (accepted?.action !== "wake") {
    watcher.next.splice(watcher.next.indexOf(turn), 1);
  }
  return { kind: "turn", stream: followRun(chat.id, true) };
}

/** A queued turn's setup waits in the watcher's line for the run Mastra starts after this one. */
async function expectTurn(chat: ChatRow, turn: LazyTurn) {
  (await watch(chat)).next.push(turn);
}

// --- the chat's watcher -------------------------------------------------------------------
// Every run of a chat's thread goes through one path, however it started (a message waking the
// AI, an approval's outcome, a message queued for after the answer): the watcher subscribes to
// the thread and, for each run, says the AI answers (`answering_since`), lets the chat follow it
// (`followRun`), keeps a client's tool steps, and at its end writes the chat's last message.
// It lives in this process: a second process per tenant would need it shared, like signals.

/** One run of the AI as others follow it: what streamed so far, and who listens. */
interface Run {
  chunks: unknown[];
  listeners: Set<(c: unknown) => void>;
  done: boolean;
}

interface Watcher {
  /** The setups of the turns that will start, in order (a client's steps live in them). */
  next: LazyTurn[];
  run: Run | null;
  /** Who waits for the next run to start (the asker who just woke one). */
  waiting: Set<(run: Run) => void>;
  idle: ReturnType<typeof setTimeout> | null;
  stop: () => void;
}

const watchers = new Map<string, Promise<Watcher>>();
/** A watcher with nothing running and nothing queued lets go of the thread after this long. */
const IDLE_MS = 60_000;
const END = Symbol("end");

function watch(chat: ChatRow): Promise<Watcher> {
  let found = watchers.get(chat.id);
  if (!found) {
    found = startWatching(chat);
    watchers.set(chat.id, found);
    found.catch(() => watchers.delete(chat.id));
  }
  return found.then((w) => {
    if (w.idle) {
      clearTimeout(w.idle);
      w.idle = null;
    }
    return w;
  });
}

async function startWatching(chat: ChatRow): Promise<Watcher> {
  const { agent } = await workMastra();
  // With the runs' status: a run ends when Mastra says so, not at its `finish` chunk (a message
  // delivered just then goes on in the same run).
  const subscription = await agent.subscribeToThread({
    resourceId: chat.projectId,
    threadId: chat.id,
    withRunStatus: true,
  });
  const watcher: Watcher = {
    next: [],
    run: null,
    waiting: new Set(),
    idle: null,
    stop: () => {
      subscription.unsubscribe();
      watchers.delete(chat.id);
    },
  };
  void (async () => {
    let feed: ReadableStreamDefaultController<unknown> | null = null;
    let dev: ((chunk: { type: string; payload?: any }) => void) | null = null;
    let runId: string | null = null;
    let reply = "";
    /** A run's `finish` (or abort, error), held until the run's status says it ended. */
    let last: unknown = null;
    const end = () => {
      if (feed) {
        if (last) {
          feed.enqueue(last);
        }
        feed.close();
      }
      feed = null;
      runId = null;
      last = null;
    };
    for await (const chunk of subscription.stream) {
      const c = chunk as { type: string; runId?: string; payload?: { text?: string } };
      if (c.type === "thread-run-status") {
        if (c.runId === runId) {
          end();
        }
        continue;
      }
      if (!c.runId) {
        continue;
      }
      if (c.runId !== runId) {
        end();
        runId = c.runId;
        reply = "";
        ({ feed, dev } = beginRun(chat, watcher, () => reply));
      } else if (c.type === "start") {
        // The run went on after a message came in: still one message for the chat.
        continue;
      }
      if (c.type === "finish" || c.type === "abort" || c.type === "error") {
        last = chunk;
        continue;
      }
      // More came after a `finish`: it wasn't the run's last.
      last = null;
      dev?.(c);
      if (c.type === "text-delta") {
        reply += c.payload?.text ?? "";
      }
      feed?.enqueue(chunk);
    }
    end();
  })().catch((err) => console.error("[work-chats] watching a chat:", err));
  return watcher;
}

/**
 * A run starts: the chat says so, its chunks go to whoever follows, and its end is kept. `dev`
 * reads the run's own chunks for the developer mode.
 */
function beginRun(
  chat: ChatRow,
  watcher: Watcher,
  reply: () => string,
): {
  feed: ReadableStreamDefaultController<unknown>;
  dev: (chunk: { type: string; payload?: any }) => void;
} {
  const setup = watcher.next.shift();
  const steps = setup?.steps ?? new ClientSteps();
  const run: Run = { chunks: [], listeners: new Set(), done: false };
  watcher.run = run;
  for (const wake of watcher.waiting) {
    wake(run);
  }
  watcher.waiting.clear();
  void db
    .update(schema.chat)
    .set({ answeringSince: new Date() })
    .where(eq(schema.chat.id, chat.id))
    .catch((err) => console.error("[work-chats] answering:", err));
  let feed!: ReadableStreamDefaultController<unknown>;
  const chunks = new ReadableStream({
    start(controller) {
      feed = controller;
    },
  });
  const ui = toAISdkStream(
    { fullStream: chunks } as never,
    // The chat shows the AI's reasoning and its sources as they come, not only once stored.
    { from: "agent", version: "v7", sendReasoning: true, sendSources: true } as never,
  ) as unknown as AsyncIterable<{ type: string }>;
  const send = (chunk: unknown) => {
    run.chunks.push(chunk);
    for (const listener of run.listeners) {
      listener(chunk);
    }
  };
  void (async () => {
    const off = steps.on((step) => send(stepChunk(step)));
    try {
      for await (const chunk of ui) {
        // A client's steps go before the run's last chunk, inside its message.
        if (chunk.type === "finish") {
          off();
        }
        send(chunk);
      }
    } finally {
      off();
      run.done = true;
      for (const listener of [...run.listeners]) {
        listener(END);
      }
      if (watcher.run === run) {
        watcher.run = null;
      }
      await afterTurn(chat, reply(), steps.list).catch((err) =>
        console.error("[work-chats] after the turn:", err),
      );
      if (!watcher.next.length && !watcher.run) {
        watcher.idle = setTimeout(watcher.stop, IDLE_MS);
      }
    }
  })();
  return { feed, dev: devChunks(chat, setup, send) };
}

/** The chunks only the developer mode reads: the routes leave them out for everyone else. */
export const DEV_CHUNK = "data-dev-";

/**
 * What the developer mode shows of a run (the web's dev.tsx): the prompt once the turn is made,
 * and each step at its end with its model, tokens, time and cost, as Goose's developer mode does.
 */
function devChunks(
  chat: ChatRow,
  setup: LazyTurn | undefined,
  send: (chunk: unknown) => void,
): (chunk: { type: string; payload?: any }) => void {
  let made: WorkTurn | null = null;
  let step = 0;
  // A step lasts from the end of the one before, its tools' work included, to its own end.
  let started = Date.now();
  void setup
    ?.get()
    .then(async (turn) => {
      made = turn;
      send({ type: `${DEV_CHUNK}prompt`, data: await devPrompt(chat, turn), transient: true });
    })
    .catch(() => null);
  return (chunk) => {
    if (chunk.type !== "step-finish" || !made) {
      return;
    }
    const output = chunk.payload?.output;
    const usage = usageOf(output?.usage);
    step += 1;
    send({
      type: `${DEV_CHUNK}step`,
      data: {
        step,
        model: made.resolved.ref,
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        cachedInputTokens: usage.cachedInputTokens ?? 0,
        ms: Date.now() - started,
        costUsd: costOf(made.resolved, output?.usage),
        tools: (output?.toolCalls ?? []).map((c: any) => c.payload?.toolName ?? c.toolName ?? ""),
        window: contextWindowOf(made.resolved.ref),
      },
      transient: true,
    });
    started = Date.now();
  };
}

/** The prompt of a turn taken apart: its instructions, the chat's messages it reads, its tools. */
async function devPrompt(chat: ChatRow, turn: WorkTurn) {
  const { memory } = await workMastra();
  const { messages } = await memory.recall({
    threadId: chat.id,
    resourceId: chat.projectId,
    perPage: LAST_MESSAGES,
  });
  const chars = (m: { content?: { parts?: unknown[] } }) =>
    (m.content?.parts ?? []).reduce<number>(
      (n, p) =>
        n +
        ((p as { type?: string }).type === "text"
          ? String((p as { text?: string }).text ?? "").length
          : JSON.stringify(p).length),
      0,
    );
  return {
    model: turn.resolved.ref,
    system: turn.instructions,
    context: "",
    history: (messages as unknown as { role: string; content?: { parts?: unknown[] } }[]).map(
      (m) => ({ role: m.role === "assistant" ? "assistant" : "user", chars: chars(m) }),
    ),
    tools: toolSizes(turn.tools),
  };
}

/** A run as a stream to follow from its start: the running one, or (`next`) the one about to start. */
function followRun(chatId: string, next: boolean): ReadableStream {
  const found = watchers.get(chatId);
  let listener: ((c: unknown) => void) | null = null;
  let current: Run | null = null;
  return new ReadableStream({
    async start(controller) {
      const watcher = await found;
      const attach = (run: Run) => {
        current = run;
        for (const chunk of run.chunks) {
          controller.enqueue(chunk);
        }
        if (run.done) {
          controller.close();
          return;
        }
        listener = (chunk) => {
          if (chunk === END) {
            run.listeners.delete(listener as (c: unknown) => void);
            controller.close();
          } else {
            controller.enqueue(chunk);
          }
        };
        run.listeners.add(listener);
      };
      if (watcher?.run && !watcher.run.done) {
        attach(watcher.run);
      } else if (watcher && next) {
        watcher.waiting.add(attach);
      } else {
        controller.close();
      }
    },
    cancel() {
      if (listener && current) {
        current.listeners.delete(listener);
      }
    },
  });
}

/**
 * Waits until a run the watcher saw end has let go of the thread in Mastra too (a few ms): input
 * sent before would continue the finished run instead of starting the next.
 */
async function settled(chat: ChatRow) {
  if (await runningIn(chat.id)) {
    return;
  }
  const { agent } = await workMastra();
  const target = { resourceId: chat.projectId, threadId: chat.id };
  for (let waited = 0; agent.getActiveThreadRunId(target) && waited < 2000; waited += 20) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Whether a run of the AI is under way in the chat, as its watcher sees it. */
async function runningIn(chatId: string): Promise<boolean> {
  const watcher = await watchers.get(chatId);
  return Boolean(watcher?.run && !watcher.run.done);
}

/** The running turn of a chat as a stream to follow, from its start; null when none runs here. */
export async function followTurn(user: SessionUser, id: string): Promise<ReadableStream | null> {
  const chat = await visibleChat(user, id);
  const watcher = await watchers.get(chat.id);
  return watcher?.run && !watcher.run.done ? followRun(chat.id, false) : null;
}

/** What a finished turn leaves: its text as the chat's last message, a client's steps stored. */
async function afterTurn(chat: ChatRow, reply: string, steps: ClientStep[]) {
  await db.update(schema.chat).set({ answeringSince: null }).where(eq(schema.chat.id, chat.id));
  if (steps.length) {
    const { memory } = await workMastra();
    const { messages } = await memory.recall({
      threadId: chat.id,
      resourceId: chat.projectId,
      perPage: false,
    });
    const answer = [...messages].reverse().find((m) => m.role === "assistant");
    // Just before the answer they led to.
    const at = answer ? new Date(new Date(answer.createdAt).getTime() - 1) : new Date();
    await memory.saveMessages({
      messages: [
        {
          id: nanoid(14),
          role: "assistant",
          threadId: chat.id,
          resourceId: chat.projectId,
          createdAt: at,
          content: { format: 2, parts: stepParts(steps) },
        } as never,
      ],
    });
  }
  if (reply.trim()) {
    await noteLast(chat, { id: AI_AUTHOR, name: "" }, reply);
  }
}

/**
 * A person decides on a held call. Approved, the stored call runs once, with the stored arguments
 * and the access of the person the turn was for; the AI hears the outcome in the chat (a signal)
 * and goes on, waking for a turn of its own when none runs. Denied, it hears that.
 */
export async function decideApproval(
  user: SessionUser,
  chatId: string,
  approvalId: string,
  approve: boolean,
): Promise<Sent> {
  const chat = await visibleChat(user, chatId);
  const taken = await takeDecision(user, chat.id, approvalId, approve);
  const name = (await userProfile(user)).name;
  const { turn, streamOptions } = await turnFor(chat, taken.askedBy);
  let told: string;
  if (approve) {
    const space = await db.query.project.findFirst({
      where: eq(schema.project.id, chat.projectId),
    });
    const tool = await toolToRun(
      { id: chat.projectId, name: space?.name ?? "" },
      taken.askedBy,
      taken.toolName,
      turn.signal,
    );
    try {
      if (!tool?.execute) {
        throw new Error(`The tool ${taken.toolName} is not there any more.`);
      }
      // Checked again: a client's call reaches the gate without Mastra's check, and the tool
      // may have changed since the call was held.
      const checked = tool.inputSchema?.safeParse?.(taken.input);
      if (checked && !checked.success) {
        throw new Error(
          `The held arguments don't fit ${taken.toolName}: ${checked.error?.message ?? ""}`,
        );
      }
      const output = await tool.execute(checked?.success ? checked.data : taken.input);
      // Mastra answers a failed check of its own with a value, not an error.
      if (output && typeof output === "object" && (output as { error?: unknown }).error === true) {
        throw new Error(
          String((output as { message?: unknown }).message ?? "The tool refused the call."),
        );
      }
      await noteOutcome(taken.id, { output });
      told = `${name} approved ${taken.toolName} (approval ${taken.id}); it ran once. Result: ${JSON.stringify(output ?? null).slice(0, 4000)}`;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await noteOutcome(taken.id, { error });
      told = `${name} approved ${taken.toolName} (approval ${taken.id}), but it failed: ${error}`;
    }
  } else {
    told = `${name} denied ${taken.toolName} (approval ${taken.id}); it did not run.`;
  }
  const { agent } = await workMastra();
  const target = { resourceId: chat.projectId, threadId: chat.id };
  return deliverOrWake(chat, turn, streamOptions, (ifIdle) =>
    agent.sendSignal(
      { type: "reactive", tagName: "approval", contents: told },
      { ...target, ifActive: { behavior: "deliver" }, ifIdle },
    ),
  );
}

/** The approvals waiting for the person, in the chats they see: the bell's count. */
export async function waitingApprovals(user: SessionUser) {
  const chats = await db.query.chat.findMany({ where: visible(user), columns: { id: true } });
  return waitingFor(
    user,
    chats.map((c) => c.id),
  );
}

/** Stop: the AI's turn in the chat ends, and what was queued behind it is dropped. */
export async function stopTurn(user: SessionUser, id: string) {
  const chat = await visibleChat(user, id);
  const { agent } = await workMastra();
  return agent.abortThreadStream({
    resourceId: chat.projectId,
    threadId: chat.id,
    clearPendingSignals: true,
  });
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
