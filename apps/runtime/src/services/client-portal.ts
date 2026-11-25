import { featureOn } from "@engenty/wizards-shared/features";
import { and, desc, eq, inArray, isNotNull, ne, or } from "drizzle-orm";
import type { SessionUser } from "../auth/index.js";
import { decide, readableIds, subjectsOfPerson } from "../broker/rwx.js";
import { db, schema } from "../db/client.js";
import { personCaller } from "../elements/caller.js";
import { elementCall } from "../elements/gate.js";
import { answeringNarrowed, stepOfRun, whoOf } from "../engine/answerers.js";
import { env } from "../env.js";
import { currentFeatures } from "../features.js";
import { tenantInfo } from "../manage.js";
import { runTicket, runViewTicket } from "../secrets/signing.js";
import { currentTenant } from "../tenants/tenant.js";
import { brandView } from "./brand.js";
import { claimClientInvites } from "./client-spaces.js";
import { notFound, ServiceError } from "./errors.js";
import { startRun } from "./runs.js";
import { spaceFileContent, spaceFiles } from "./space-files.js";
import { brandSpaceId } from "./space-parent.js";
import { listSpaces } from "./spaces.js";
import { listWizards } from "./wizards.js";

/*
 * The client contract (docs/plans/client-portal.md): what a client of the organization reaches
 * of their client spaces, for the client portal and any app built on the same contract. Every
 * call acts as the token's person with the role `client` (I1); a space is one they are in, else
 * not found (I2, `ownedSpace`); the broker decides each item as that client, so the space's and
 * the organization's Knowledge and wizards come back only where the firm opened them. Behind the
 * `clientSpaces` and `orgSpaces` switches, and only with the broker on: without it every rule
 * says yes.
 */

/** Who calls: the token's person, as the work chats know a person. */
export type ClientWho = SessionUser & { client: string };

type SpaceRow = typeof schema.space.$inferSelect;
type RunRow = typeof schema.run.$inferSelect;

const clientSubjects = (who: { id: string }) => subjectsOfPerson(who.id, "client");

/** The contract is there for clients of an organization with clients and the broker on. */
async function requirePortal(who: ClientWho): Promise<void> {
  const features = await currentFeatures();
  if (
    features.clientSpaces !== true ||
    features.orgSpaces !== true ||
    !featureOn(features, "broker")
  ) {
    throw notFound();
  }
  if (who.role !== "client") {
    throw new ServiceError("forbidden", "Only for clients of the organization.");
  }
}

/**
 * Where the person is one of the clients: a join with `space_member` (role `client`), so the
 * same one query answers whether an item is missing or is someone else's (docs/plans/
 * client-portal.md, "Addresses"): both are not found, alike in answer and in time.
 */
const asClient = (who: { id: string }) =>
  and(
    eq(schema.spaceMember.userId, who.id),
    eq(schema.spaceMember.role, "client"),
    eq(schema.space.tenantId, currentTenant()),
  );

/**
 * One of the client spaces the client is in, with the spaces whose wizards it runs: its own and
 * the organization's root.
 */
async function clientSpace(
  who: ClientWho,
  spaceId: string,
): Promise<{ space: SpaceRow; sources: string[] }> {
  await requirePortal(who);
  const [row] = await db
    .select({ space: schema.space })
    .from(schema.space)
    .innerJoin(schema.spaceMember, eq(schema.spaceMember.spaceId, schema.space.id))
    .where(and(eq(schema.space.id, spaceId), eq(schema.space.kind, "client"), asClient(who)))
    .limit(1);
  if (!row?.space.parentId) {
    throw notFound();
  }
  return { space: row.space, sources: [row.space.id, row.space.parentId] };
}

/** Whether the person is one of the space's clients. */
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
 * Whether a client opens a run: one of their client space's, started by them or shared with them by the
 * firm. The run's own routes ask it too (routes/runs.ts).
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

/** The space's brand, its own or the organization's it takes: the client portal wears it. */
async function firmBrand(spaceId: string) {
  const brand = await brandView(await brandSpaceId(spaceId));
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

/** The spaces the client is in, each with the organization's name and the brand it wears. */
export async function clientSpaces(who: ClientWho) {
  await requirePortal(who);
  await claimClientInvites(who.id, who.email);
  const spaces = (await listSpaces(who.id)).filter((s) => s.kind === "client" && s.parentId);
  const org = spaces.length ? await tenantInfo(who.tenantId).catch(() => null) : null;
  return Promise.all(
    spaces.map(async (s) => ({
      id: s.id,
      name: s.name,
      firm: { name: org?.name ?? "", brand: await firmBrand(s.id) },
    })),
  );
}

// --- wizards ---------------------------------------------------------------------------------

type PublishedWizard = Awaited<ReturnType<typeof listWizards>>[number];

/**
 * The published wizards the firm opened to its clients, of the space and of the organization's
 * root, each with the space whose rules decide it: read and run.
 */
async function openedWizards(
  who: ClientWho,
  sources: string[],
): Promise<{ spaceId: string; wizard: PublishedWizard }[]> {
  const open: { spaceId: string; wizard: PublishedWizard }[] = [];
  for (const spaceId of sources) {
    const published = (await listWizards(who.id, spaceId)).filter((w) => w.published);
    const ids = published.map((w) => w.id);
    const readable = new Set(await readableIds(spaceId, clientSubjects(who), "wizard", ids));
    for (const wizard of published) {
      if (
        readable.has(wizard.id) &&
        (await decide(spaceId, clientSubjects(who), { kind: "wizard", id: wizard.id }, "x")).ok
      ) {
        open.push({ spaceId, wizard });
      }
    }
  }
  return open;
}

/** The opened wizards as the contract lists them. */
async function openWizards(who: ClientWho, sources: string[]) {
  return (await openedWizards(who, sources)).map(({ wizard: w }) => ({
    id: w.id,
    title: w.title,
    description: w.description ?? "",
    avatar: w.avatar,
    steps: w.stepCount,
  }));
}

export async function clientWizards(who: ClientWho, spaceId: string) {
  const { sources } = await clientSpace(who, spaceId);
  return openWizards(who, sources);
}

/**
 * Starts one of the opened wizards in the space: the run is the space's, whichever space the
 * wizard is in. A line of the audit like every element call.
 */
export async function clientStartWizard(who: ClientWho, spaceId: string, wizardId: string) {
  const { space, sources } = await clientSpace(who, spaceId);
  const opened = (await openedWizards(who, sources)).find((o) => o.wizard.id === wizardId);
  // A wizard not opened is refused by the rules of the space it is in, as one opened is decided.
  const home = opened
    ? opened.spaceId
    : ((
        await db.query.wizard.findFirst({
          columns: { spaceId: true },
          where: and(eq(schema.wizard.id, wizardId), eq(schema.wizard.tenantId, currentTenant())),
        })
      )?.spaceId ?? space.id);
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
      rulesIn: sources.includes(home) ? home : space.id,
      perm: "x",
      input: { wizardId },
    },
    async () => {
      if (!opened) {
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
  avatar: r.definition.avatar,
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

/**
 * A ticket for one run the client sees, by the run alone (a deep link, `/portal/r/<run>`): the
 * run's own routes open with it (`?rt=`); its client space comes along. A run the firm shared
 * gets a ticket that only reads it.
 */
export async function clientOpenRun(who: ClientWho, runId: string) {
  await requirePortal(who);
  const [row] = await db
    .select({ id: schema.run.id, spaceId: schema.space.id, userId: schema.run.userId })
    .from(schema.run)
    .innerJoin(schema.space, eq(schema.space.id, schema.run.clientSpaceId))
    .innerJoin(schema.spaceMember, eq(schema.spaceMember.spaceId, schema.space.id))
    .where(
      and(
        eq(schema.run.id, runId),
        asClient(who),
        or(eq(schema.run.userId, who.id), isNotNull(schema.run.clientSharedAt)),
      ),
    )
    .limit(1);
  if (!row) {
    throw notFound();
  }
  // The client's own run they go on with; one the firm shared they only read.
  const mine = row.userId === who.id;
  return {
    runId: row.id,
    spaceId: row.spaceId,
    readOnly: !mine,
    ticket: mine ? runTicket(row.id) : runViewTicket(row.id),
  };
}

/**
 * What waits for the client: their runs waiting on a page or an answer, the latest results the
 * firm shared, the wizards they can start.
 */
export async function clientForYou(who: ClientWho, spaceId: string) {
  const { space, sources } = await clientSpace(who, spaceId);
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
    openWizards(who, sources),
  ]);
  const titles = await titlesOf([...waiting, ...shared].map((r) => r.wizardId));
  // What the firm's team is asked waits for them, not for the client.
  const narrowed = await answeringNarrowed();
  const theirs = waiting.filter((r) => !(narrowed && whoOf(stepOfRun(r)) === "team"));
  return {
    waiting: theirs.map(resultOf(who, titles)),
    shared: shared.map(resultOf(who, titles)),
    wizards,
  };
}

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

/** One file of the client's client spaces, by the file alone (a deep link, `/portal/f/<file>`). */
async function clientFileRow(who: ClientWho, fileId: string) {
  await requirePortal(who);
  const [row] = await db
    .select({ file: schema.spaceFile })
    .from(schema.spaceFile)
    .innerJoin(schema.space, eq(schema.space.id, schema.spaceFile.spaceId))
    .innerJoin(schema.spaceMember, eq(schema.spaceMember.spaceId, schema.space.id))
    .where(
      and(
        eq(schema.spaceFile.id, fileId),
        inArray(schema.spaceFile.kind, ["document", "asset"]),
        ne(schema.spaceFile.status, "failed"),
        asClient(who),
      ),
    )
    .limit(1);
  const file = row?.file;
  const readable =
    file &&
    (file.kind !== "document" ||
      (await readableIds(file.spaceId, clientSubjects(who), "document", [file.id])).length > 0);
  if (!(file && readable)) {
    throw notFound();
  }
  return file;
}

/** What a file is, and its client space. */
export async function clientFileInfo(who: ClientWho, fileId: string) {
  const f = await clientFileRow(who, fileId);
  return {
    spaceId: f.spaceId,
    file: {
      id: f.id,
      name: f.name,
      mime: f.mime,
      size: f.size,
      createdAt: f.createdAt.toISOString(),
    },
  };
}

/** One file's bytes, as the client may read it. */
export async function clientFile(who: ClientWho, fileId: string) {
  const f = await clientFileRow(who, fileId);
  const { row, data } = await spaceFileContent(f.spaceId, f.id, clientSubjects(who));
  return { name: row.name, mime: row.mime, data };
}
