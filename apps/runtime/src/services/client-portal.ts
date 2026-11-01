import { featureOn } from "@engenty/wizards-shared/features";
import { pageSlugOf } from "@engenty/wizards-shared/spaces";
import { and, desc, eq, inArray, isNotNull, or } from "drizzle-orm";
import type { SessionUser } from "../auth/index.js";
import { decide, readableIds, subjectsOfPerson } from "../broker/rwx.js";
import { db, schema } from "../db/client.js";
import { personCaller } from "../elements/caller.js";
import { elementCall } from "../elements/gate.js";
import { env } from "../env.js";
import { currentFeatures } from "../features.js";
import { tenantInfo } from "../manage.js";
import { runTicket } from "../secrets/signing.js";
import { brandView } from "./brand.js";
import { claimClientInvites } from "./client-spaces.js";
import { notFound, ServiceError } from "./errors.js";
import { startRun } from "./runs.js";
import { spaceFileContent, spaceFiles } from "./space-files.js";
import { listSpaces, ownedSpace } from "./spaces.js";
import { listWizards } from "./wizards.js";
import { createChat, readChat, sendMessage } from "./work-chats.js";

/*
 * The client contract (docs/plans/client-portal.md): what a client of the organization reaches
 * of their client spaces, for the client portal and any app built on the same contract. Every
 * call acts as the token's person with the role `client` (I1); a space is one of their client
 * spaces, else not found (I2, `ownedSpace`); the broker decides each item as that client, so the
 * parent's Knowledge and wizards come back only where the firm opened them. Behind the
 * `clientSpaces` switch, and only with the broker on: without it every rule says yes.
 */

/** Who calls: the token's person, as the work chats know a person. */
export type ClientWho = SessionUser & { client: string };

type SpaceRow = typeof schema.space.$inferSelect;
type RunRow = typeof schema.run.$inferSelect;

const clientSubjects = (who: { id: string }) => subjectsOfPerson(who.id, "client");

/** The contract is there for clients of an organization with client spaces and the broker on. */
async function requirePortal(who: ClientWho): Promise<void> {
  const features = await currentFeatures();
  if (features.clientSpaces !== true || !featureOn(features, "broker")) {
    throw notFound();
  }
  if (who.role !== "client") {
    throw new ServiceError("forbidden", "Only for clients of the organization.");
  }
}

/** One of the client's client spaces, with its parent. */
async function clientSpace(
  who: ClientWho,
  spaceId: string,
): Promise<{ space: SpaceRow; parent: SpaceRow }> {
  await requirePortal(who);
  const space = await ownedSpace(who.id, spaceId);
  if (space.kind !== "client" || !space.parentId) {
    throw notFound();
  }
  const parent = await db.query.space.findFirst({ where: eq(schema.space.id, space.parentId) });
  if (!parent) {
    throw notFound();
  }
  return { space, parent };
}

/** Whether the person is one of the client space's clients. */
async function isClientOf(userId: string, spaceId: string): Promise<boolean> {
  const row = await db.query.spaceMember.findFirst({
    columns: { id: true },
    where: and(
      eq(schema.spaceMember.spaceId, spaceId),
      eq(schema.spaceMember.userId, userId),
      eq(schema.spaceMember.role, "client"),
    ),
  });
  return Boolean(row);
}

/**
 * Whether a client opens a run: one of their client space's, started by them or shared with them
 * by the firm. The run's own routes ask it too (routes/runs.ts).
 */
export async function clientMayOpen(
  userId: string,
  run: Pick<RunRow, "clientSpaceId" | "userId" | "clientSharedAt">,
): Promise<boolean> {
  if (!run.clientSpaceId || !(run.userId === userId || run.clientSharedAt)) {
    return false;
  }
  return isClientOf(userId, run.clientSpaceId);
}

/** A logo's address on the runtime, for a page on another origin. */
const absolute = (path: string | null) => (path ? `${env.publicUrl}${path}` : null);

/** The firm's brand, as its space shows it: the client portal wears it. */
async function firmBrand(parentId: string) {
  const brand = await brandView(parentId);
  return { ...brand, logoUrl: absolute(brand.logoUrl) };
}

// --- who and where ---------------------------------------------------------------------------

/** The person and their organization: the portal checks the host against its address. */
export async function clientMe(who: ClientWho) {
  await requirePortal(who);
  // A client who signs in only at the portal takes up their invitations here.
  await claimClientInvites(who.id, who.email);
  const org = await tenantInfo(who.tenantId).catch(() => null);
  return {
    person: { id: who.id, name: who.name, email: who.email },
    organization: {
      id: who.tenantId,
      name: org?.name ?? "",
      slug: org?.slug ?? null,
      pagesHost: org?.pagesHost ?? null,
    },
  };
}

/** The client's client spaces, each with the firm's space and brand. */
export async function clientSpaces(who: ClientWho) {
  await requirePortal(who);
  await claimClientInvites(who.id, who.email);
  const spaces = (await listSpaces(who.id)).filter((s) => s.kind === "client" && s.parentId);
  const parents = spaces.length
    ? await db.query.space.findMany({
        columns: { id: true, name: true },
        where: inArray(
          schema.space.id,
          spaces.map((s) => s.parentId as string),
        ),
      })
    : [];
  return Promise.all(
    spaces.map(async (s) => ({
      id: s.id,
      name: s.name,
      slug: s.slug ?? s.id,
      firm: {
        name: parents.find((p) => p.id === s.parentId)?.name ?? "",
        brand: await firmBrand(s.parentId as string),
      },
    })),
  );
}

// --- wizards ---------------------------------------------------------------------------------

/** A wizard's address in the portal: from its title, unique among the ones listed. */
function withSlugs<T extends { id: string; title: string }>(wizards: T[]) {
  const taken = new Set<string>();
  return wizards.map((w) => {
    const base = pageSlugOf(w.title) || w.id.toLowerCase();
    let slug = base;
    for (let n = 2; taken.has(slug); n++) {
      slug = `${base}-${n}`;
    }
    taken.add(slug);
    return { ...w, slug };
  });
}

/** The parent's published wizards the firm opened to its clients: read and run. */
async function openWizards(who: ClientWho, parent: SpaceRow) {
  const published = (await listWizards(who.id, parent.id)).filter((w) => w.published);
  const ids = published.map((w) => w.id);
  const readable = new Set(await readableIds(parent.id, clientSubjects(who), "wizard", ids));
  const open: typeof published = [];
  for (const w of published) {
    if (
      readable.has(w.id) &&
      (await decide(parent.id, clientSubjects(who), { kind: "wizard", id: w.id }, "x")).ok
    ) {
      open.push(w);
    }
  }
  return withSlugs(
    open.map((w) => ({ id: w.id, title: w.title, description: w.description ?? "" })),
  );
}

export async function clientWizards(who: ClientWho, spaceId: string) {
  const { parent } = await clientSpace(who, spaceId);
  return openWizards(who, parent);
}

/**
 * Starts one of the opened wizards in the client space: the wizard is the parent's, the run the
 * client space's. A line of the audit like every element call.
 */
export async function clientStartWizard(who: ClientWho, spaceId: string, wizardId: string) {
  const { space, parent } = await clientSpace(who, spaceId);
  const caller = personCaller({
    space: { id: space.id, name: space.name },
    userId: who.id,
    role: "client",
    signal: new AbortController().signal,
    client: who.client,
  });
  return elementCall(
    caller,
    {
      action: "wizard_start",
      resource: { kind: "wizard", id: wizardId },
      rulesIn: parent.id,
      perm: "x",
      input: { wizardId },
    },
    async () => {
      if (!(await openWizards(who, parent)).some((w) => w.id === wizardId)) {
        throw notFound();
      }
      const { runId } = await startRun(who.id, wizardId, {}, { clientSpaceId: space.id });
      return { runId, ticket: runTicket(runId) };
    },
  );
}

// --- runs and results ------------------------------------------------------------------------

/** The runs of the client space the client sees: their own, and those shared with them. */
const seenRuns = (who: ClientWho, spaceId: string) =>
  and(
    eq(schema.run.clientSpaceId, spaceId),
    or(eq(schema.run.userId, who.id), isNotNull(schema.run.clientSharedAt)),
  );

async function titlesOf(wizardIds: string[]) {
  const rows = wizardIds.length
    ? await db.query.wizard.findMany({
        columns: { id: true, title: true },
        where: inArray(schema.wizard.id, [...new Set(wizardIds)]),
      })
    : [];
  return new Map(rows.map((w) => [w.id, w.title]));
}

const resultOf = (who: ClientWho, titles: Map<string, string>) => (r: RunRow) => ({
  runId: r.id,
  wizardId: r.wizardId,
  title: titles.get(r.wizardId) ?? r.definition.title,
  status: r.status,
  mine: r.userId === who.id,
  sharedAt: r.clientSharedAt?.toISOString() ?? null,
  updatedAt: r.updatedAt.toISOString(),
});

/** The results of the client space the client sees, newest first. */
export async function clientResults(who: ClientWho, spaceId: string) {
  const { space } = await clientSpace(who, spaceId);
  const rows = await db.query.run.findMany({
    where: and(seenRuns(who, space.id), eq(schema.run.status, "done")),
    orderBy: [desc(schema.run.updatedAt)],
    limit: 100,
  });
  const titles = await titlesOf(rows.map((r) => r.wizardId));
  return rows.map(resultOf(who, titles));
}

/** A ticket for one run the client sees: the run's own routes open with it (`?rt=`). */
export async function clientOpenRun(who: ClientWho, spaceId: string, runId: string) {
  const { space } = await clientSpace(who, spaceId);
  const run = await db.query.run.findFirst({
    where: and(eq(schema.run.id, runId), seenRuns(who, space.id)),
  });
  if (!run) {
    throw notFound();
  }
  return { runId: run.id, ticket: runTicket(run.id) };
}

/**
 * What waits for the client: their runs waiting on a page or an answer, the latest results the
 * firm shared, the wizards they can start.
 */
export async function clientForYou(who: ClientWho, spaceId: string) {
  const { space, parent } = await clientSpace(who, spaceId);
  const [waiting, shared, wizards] = await Promise.all([
    db.query.run.findMany({
      where: and(
        eq(schema.run.clientSpaceId, space.id),
        eq(schema.run.userId, who.id),
        or(
          eq(schema.run.status, "waiting_input"),
          and(eq(schema.run.status, "running"), isNotNull(schema.run.ask)),
        ),
      ),
      orderBy: [desc(schema.run.updatedAt)],
      limit: 20,
    }),
    db.query.run.findMany({
      where: and(
        eq(schema.run.clientSpaceId, space.id),
        isNotNull(schema.run.clientSharedAt),
        eq(schema.run.status, "done"),
      ),
      orderBy: [desc(schema.run.clientSharedAt)],
      limit: 10,
    }),
    openWizards(who, parent),
  ]);
  const titles = await titlesOf([...waiting, ...shared].map((r) => r.wizardId));
  return {
    waiting: waiting.map(resultOf(who, titles)),
    shared: shared.map(resultOf(who, titles)),
    wizards,
  };
}

// --- chats -----------------------------------------------------------------------------------

/** The client space's chats the client is a member of: the firm's other chats stay internal. */
async function memberChats(who: ClientWho, spaceId: string) {
  const mine = await db
    .select({ chatId: schema.chatMember.chatId })
    .from(schema.chatMember)
    .where(and(eq(schema.chatMember.kind, "person"), eq(schema.chatMember.memberId, who.id)));
  if (!mine.length) {
    return [];
  }
  return db.query.chat.findMany({
    where: and(
      eq(schema.chat.spaceId, spaceId),
      inArray(
        schema.chat.id,
        mine.map((m) => m.chatId),
      ),
    ),
    orderBy: [desc(schema.chat.updatedAt)],
  });
}

export async function clientChats(who: ClientWho, spaceId: string) {
  const { space } = await clientSpace(who, spaceId);
  return (await memberChats(who, space.id)).map((c) => ({
    id: c.id,
    title: c.title,
    updatedAt: c.updatedAt.toISOString(),
    last: c.lastText ? { name: c.lastAuthorName ?? "", text: c.lastText } : null,
    answering: Boolean(c.answeringSince),
  }));
}

async function memberChat(who: ClientWho, spaceId: string, chatId: string) {
  const { space } = await clientSpace(who, spaceId);
  const chat = (await memberChats(who, space.id)).find((c) => c.id === chatId);
  if (!chat) {
    throw notFound();
  }
  return chat;
}

/** A chat's messages as the client reads them: who wrote and the text, no tool calls. */
export async function clientChatMessages(who: ClientWho, spaceId: string, chatId: string) {
  const chat = await memberChat(who, spaceId, chatId);
  const read = await readChat(who, chat.id);
  return {
    chat: { id: chat.id, title: chat.title, answering: Boolean(read.chat.answeringSince) },
    messages: read.messages
      .map((m) => ({
        id: m.id,
        author: { kind: m.author.kind, name: m.author.name, me: m.author.id === who.id },
        text: m.parts
          .filter((p) => p.type === "text" && typeof p.text === "string")
          .map((p) => p.text as string)
          .join("\n\n")
          .trim(),
        createdAt: m.createdAt,
      }))
      .filter((m) => m.text),
  };
}

/**
 * Writes in one of the client's chats, or starts a new one with the firm. `ask` lets the space's
 * AI answer as the client: its turn runs on, the next read shows the answer.
 */
export async function clientChatPost(
  who: ClientWho,
  spaceId: string,
  input: { chatId?: string; text: string; ask?: boolean },
) {
  const { space } = await clientSpace(who, spaceId);
  const chatId = input.chatId
    ? (await memberChat(who, space.id, input.chatId)).id
    : (await createChat(who, { spaceId: space.id })).id;
  const sent = await sendMessage(who, chatId, input.text, { ask: input.ask === true });
  if (sent.kind === "turn") {
    // Nobody follows the stream here: it is read to its end so the turn runs through.
    void sent.stream.pipeTo(new WritableStream()).catch(() => undefined);
  }
  return { chatId, sent: sent.kind };
}

// --- files -----------------------------------------------------------------------------------

/** The client space's documents and files, to download: one still being read is there already. */
export async function clientFiles(who: ClientWho, spaceId: string) {
  const { space } = await clientSpace(who, spaceId);
  const rows = (await spaceFiles(space.id)).filter(
    (f) => (f.kind === "document" || f.kind === "asset") && f.status !== "failed",
  );
  const shown = new Set(
    await readableIds(
      space.id,
      clientSubjects(who),
      "document",
      rows.filter((f) => f.kind === "document").map((f) => f.id),
    ),
  );
  return rows
    .filter((f) => f.kind !== "document" || shown.has(f.id))
    .map((f) => ({
      id: f.id,
      name: f.name,
      mime: f.mime,
      size: f.size,
      createdAt: f.createdAt.toISOString(),
    }));
}

/** One file's bytes, as the client may read it. */
export async function clientFile(who: ClientWho, spaceId: string, fileId: string) {
  const { space } = await clientSpace(who, spaceId);
  const { row, data } = await spaceFileContent(space.id, fileId, clientSubjects(who));
  if (row.kind !== "document" && row.kind !== "asset") {
    throw notFound();
  }
  return { name: row.name, mime: row.mime, data };
}
