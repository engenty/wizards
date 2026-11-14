import { type Step, textLang, wizardLang } from "@engenty/wizards-shared/definition";
import { note } from "@engenty/wizards-shared/run";
import { and, desc, eq, inArray, isNotNull, isNull, lte, or, type SQL, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { accountRunMail } from "../auth/account.js";
import { control, controlDb, db, schema, withTenant } from "../db/client.js";
import { env } from "../env.js";
import { currentFeatures } from "../features.js";
import { ManageError, managed, runMail } from "../manage.js";
import { runViewTicketUntil, runWaitTicket } from "../secrets/signing.js";
import { shareUrl, studioUrl } from "../services/wizards.js";
import { currentTenant } from "../tenants/tenant.js";
import { answerersOf, teamToAsk, whoOf } from "./answerers.js";
import { emitEvent } from "./events.js";
import { pushToRunDevice } from "./push.js";
import type { RunRow } from "./types.js";

/**
 * A word to a person about a run: it waits for them, it ended. The row is written with the status
 * change, in one batch, and is the outbox: a crash between the two cannot lose it. A sender tick
 * on a runner claims each due row for a while, so two runners do not send twice, and delivers it:
 * the bell (the row itself), the device, the mail. A sender that dies lets go when the claim ends.
 *
 * Who is told:
 * - a member's run: its member, by bell, mail and the device the app gave the run
 * - a visitor's run: the visitor, by that device, and by mail at an `email` field with `notify`
 * - a channel's run: nobody here, its door says it (packages/wizards/src/plugin/thread.ts)
 * - a step with `who: "team"`: each person who may answer it, by bell and mail, on any of these runs
 *
 * Nobody is told what they did themselves (`by`), or while they look at the run.
 */

export type NoticeKind = (typeof schema.notice.$inferSelect)["kind"];
type NoticeRow = typeof schema.notice.$inferSelect;
export type NoticeValues = Omit<typeof schema.notice.$inferInsert, "id" | "tenantId" | "createdAt">;

/** Kept per tenant; older ones go as new ones come. */
const KEEP = 200;
/** A person's page says it is in view every 30 s: this long without a word, nobody looks. */
export const LOOKING_MS = 90_000;
/**
 * No mail to someone who saw the run this recently: they know, and may be back in a minute. A mail
 * costs more attention than a push, which goes as soon as they stopped looking.
 */
export const QUIET_MS = 10 * 60_000;
/** How long a sender holds a row. Longer than the two calls it makes (15 s each). */
const CLAIM_MS = 2 * 60_000;
const BATCH = 20;
/** Tries over about 3 hours (1, 2, 4 … 60 minutes); then the bell has to do. */
const MAX_ATTEMPTS = 6;
/** A link in a mail lasts at most this long, also on a run kept for longer. */
const LINK_MS = 30 * 24 * 60 * 60_000;

/** Who did what brought the run here; empty for the engine. */
export interface Actor {
  userId?: string | null;
  visitorId?: string | null;
}

type RunFacts = Pick<
  RunRow,
  "id" | "wizardId" | "userId" | "visitorId" | "runner" | "unattended" | "impersonatedBy" | "mode"
> & { startedBy: RunRow["startedBy"] };

/**
 * What a status change writes, one row per person told. `step`: the step the run now waits on. A
 * step for the team reaches its people from any door, and from them only the one who answered right
 * before is left out. A test run stays with who tries it, and a computer has one person: for those,
 * and every other step, it is the run's own person.
 */
export async function noticesFor(
  run: RunFacts,
  kind: NoticeKind,
  options: {
    detail?: string | null;
    waitKey?: string | null;
    by?: Actor;
    step?: Step | null;
    /** A reminder is due later; anything else now. */
    dueAt?: Date;
  } = {},
): Promise<NoticeValues[]> {
  if (
    speaksOfWait(kind) &&
    whoOf(options.step) === "team" &&
    managed &&
    run.mode === "live" &&
    !(run.unattended || run.impersonatedBy) &&
    (await durableOn())
  ) {
    const asked = await teamToAsk(await answerersOf(run));
    return asked
      .filter((id) => id !== options.by?.userId)
      .map((userId) => ({
        kind,
        wizardId: run.wizardId,
        runId: run.id,
        startId: run.startedBy?.startId ?? null,
        detail: options.detail?.slice(0, 300) ?? null,
        waitKey: options.waitKey ?? null,
        userId,
        visitor: false,
        shown: false,
        dueAt: options.dueAt ?? new Date(),
      }));
  }
  // On a computer its one person answers for the team: whoever came here through the link, and
  // through whichever door, they are told.
  const own =
    whoOf(options.step) === "team" && !managed
      ? await noticeFor({ ...run, runner: null }, kind, { ...options, by: undefined })
      : await noticeFor(run, kind, options);
  return own ? [own] : [];
}

/**
 * The one place that decides whether a status change tells the run's own person, and returns the
 * row to write with it. Every path that makes a run wait comes here: `drive`, `createRun`, `goBack`,
 * an ask.
 */
export async function noticeFor(
  run: Omit<RunFacts, "mode">,
  kind: NoticeKind,
  options: {
    detail?: string | null;
    waitKey?: string | null;
    by?: Actor;
    /** A reminder is due later; anything else now. */
    dueAt?: Date;
  } = {},
): Promise<NoticeValues | null> {
  const durable = await durableOn();
  const words = {
    kind,
    wizardId: run.wizardId,
    runId: run.id,
    startId: run.startedBy?.startId ?? null,
    detail: options.detail?.slice(0, 300) ?? null,
    waitKey: options.waitKey ?? null,
  };
  // Without the switch only a started run has a word, for the bell, and nothing to deliver.
  if (!durable) {
    return run.startedBy ? { ...words, userId: run.userId, shown: true, dueAt: null } : null;
  }
  // An autopilot, a channel's door, a platform admin acting as someone: nobody here is told.
  if (run.unattended || run.runner || run.impersonatedBy) {
    return null;
  }
  // The person's own act on their own page: they are there. Someone else's act tells them.
  const { by } = options;
  if (
    by &&
    ((by.userId && by.userId === run.userId) || (by.visitorId && by.visitorId === run.visitorId))
  ) {
    return null;
  }
  // On a computer with no accounts all runs are its one person's, also through the wizard's link.
  const member = Boolean(run.userId || run.startedBy) || !managed;
  if (!member && !run.visitorId) {
    return null;
  }
  return {
    ...words,
    userId: run.userId,
    visitor: !member,
    shown: false,
    dueAt: options.dueAt ?? new Date(),
  };
}

/** Whether runs tell people through the outbox here. */
export async function durableOn(): Promise<boolean> {
  return (await currentFeatures().catch(() => ({ durableRuns: false }))).durableRuns === true;
}

/**
 * The statements that write a notice, for a batch with the status change. `guard` says when the
 * change happens: both go in one transaction, and with the guard false neither does anything.
 */
export function noticeWrites(notice: NoticeValues | NoticeValues[], guard: SQL) {
  const notices = Array.isArray(notice) ? notice : [notice];
  const exists = sql`EXISTS (SELECT 1 FROM ${schema.run} WHERE ${guard})`;
  // The same word twice about one run says nothing new: a run that waits again replaces it. Once per
  // kind, or the second person told would take the first one's row with it.
  const replaces = [...new Set(notices.map((n) => n.kind))].map((kind) =>
    db
      .delete(schema.notice)
      .where(
        and(
          eq(schema.notice.runId, notices[0]?.runId as string),
          eq(schema.notice.kind, kind),
          isNull(schema.notice.readAt),
          exists,
        ),
      ),
  );
  const writes = notices.map((values) =>
    db.run(sql`
    INSERT INTO ${schema.notice}
      (id, tenant_id, kind, wizard_id, run_id, start_id, detail, user_id, visitor, wait_key, shown, due_at, created_at)
    SELECT ${nanoid(12)}, ${currentTenant()}, ${values.kind}, ${values.wizardId}, ${values.runId ?? null},
      ${values.startId ?? null}, ${values.detail ?? null}, ${values.userId ?? null}, ${values.visitor ? 1 : 0},
      ${values.waitKey ?? null}, ${values.shown ? 1 : 0}, ${values.dueAt?.getTime() ?? null}, ${Date.now()}
    WHERE ${exists}`),
  );
  return [...replaces, ...writes];
}

/** A word that belongs to no run: a start that paused. For the bell. */
export async function addNotice(input: {
  kind: NoticeKind;
  wizardId: string;
  startId?: string | null;
  detail?: string | null;
  userId?: string | null;
}) {
  await db.insert(schema.notice).values({
    id: nanoid(12),
    tenantId: currentTenant(),
    kind: input.kind,
    wizardId: input.wizardId,
    startId: input.startId ?? null,
    detail: input.detail?.slice(0, 300) ?? null,
    userId: input.userId ?? null,
  });
  await trim();
}

async function trim() {
  const tenantId = currentTenant();
  const old = await db.query.notice.findMany({
    where: and(eq(schema.notice.tenantId, tenantId), eq(schema.notice.visitor, false)),
    orderBy: [desc(schema.notice.createdAt)],
    // SQLite takes an offset only with a limit.
    limit: KEEP,
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

// --- the bell ------------------------------------------------------------------------------

/** What the person's bell shows: for them, or for anyone in the studio. */
const forPerson = (userId: string) =>
  and(
    eq(schema.notice.tenantId, currentTenant()),
    eq(schema.notice.shown, true),
    eq(schema.notice.visitor, false),
    or(isNull(schema.notice.userId), eq(schema.notice.userId, userId)),
  );

/** Whether a word says a run waits for someone: it means nothing once the wait is over. */
const speaksOfWait = (kind: NoticeKind) => kind === "needs_you" || kind === "reminder";

/** Whether the wait a `needs_you` or a `reminder` speaks of is still on. */
function stillWaits(
  key: string | null,
  run: Pick<RunRow, "status" | "cursor"> & { ask?: RunRow["ask"] },
): boolean {
  if (!key) {
    return run.status === "waiting_input";
  }
  if (key.startsWith("pause:")) {
    return run.status === "sleeping";
  }
  return key.startsWith("ask:")
    ? run.ask?.id === key.slice(4)
    : run.status === "waiting_input" && run.cursor === key.slice(5);
}

export async function listNotices(userId: string, limit = 50) {
  const rows = await db.query.notice.findMany({
    where: forPerson(userId),
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
  const waitingOn = rows.filter((r) => speaksOfWait(r.kind) && r.runId && !r.readAt);
  const runs = waitingOn.length
    ? await db.query.run.findMany({
        where: inArray(schema.run.id, waitingOn.map((r) => r.runId) as string[]),
        columns: { id: true, status: true, cursor: true, ask: true },
      })
    : [];
  return rows.map((r) => {
    const w = wizards.find((x) => x.id === r.wizardId);
    const run = runs.find((x) => x.id === r.runId);
    return {
      id: r.id,
      kind: r.kind,
      wizard: { id: r.wizardId, title: w?.title ?? "" },
      runId: r.runId,
      start: w?.starts.find((s) => s.id === r.startId) ?? null,
      detail: r.detail,
      // A wait someone answered asks for nothing any more.
      read: r.readAt !== null || (speaksOfWait(r.kind) && (!run || !stillWaits(r.waitKey, run))),
      at: r.createdAt.toISOString(),
    };
  });
}

/** Marks the named notices read, or every one the person's bell shows. */
export async function markNoticesRead(userId: string, ids: string[] | "all") {
  const where =
    ids === "all" ? forPerson(userId) : and(forPerson(userId), inArray(schema.notice.id, ids));
  await db.update(schema.notice).set({ readAt: new Date() }).where(where);
}

// --- the sender ----------------------------------------------------------------------------

/** Takes the due rows for a while: of two senders at once, each row goes to one. */
async function claimDue(now: Date): Promise<NoticeRow[]> {
  const due = db
    .select({ id: schema.notice.id })
    .from(schema.notice)
    .where(
      and(
        lte(schema.notice.dueAt, now),
        or(isNull(schema.notice.claimUntil), lte(schema.notice.claimUntil, now)),
      ),
    )
    .orderBy(schema.notice.dueAt)
    .limit(BATCH);
  return db
    .update(schema.notice)
    .set({ claimUntil: new Date(now.getTime() + CLAIM_MS) })
    .where(inArray(schema.notice.id, due))
    .returning();
}

const mark = (id: string, patch: Partial<typeof schema.notice.$inferInsert>) =>
  db.update(schema.notice).set(patch).where(eq(schema.notice.id, id));

/** Nothing more to deliver: a visitor's row has no bell to keep it for. */
async function finish(row: NoticeRow) {
  if (row.visitor) {
    await db.delete(schema.notice).where(eq(schema.notice.id, row.id));
    return;
  }
  await mark(row.id, { dueAt: null, claimUntil: null, shown: true });
}

/** Nobody needs telling any more: a row nobody saw goes, a row in the bell counts as read. */
async function settle(row: NoticeRow, now: Date) {
  if (row.visitor || !row.shown) {
    await db.delete(schema.notice).where(eq(schema.notice.id, row.id));
    return;
  }
  await mark(row.id, { dueAt: null, claimUntil: null, readAt: now });
}

const later = (row: NoticeRow, at: Date) => mark(row.id, { dueAt: at, claimUntil: null });

/** The address a visitor left for this: the first `email` field with `notify` that has an answer. */
export function visitorAddress(run: Pick<RunRow, "definition" | "state">): string | null {
  for (const step of run.definition.steps) {
    if (step.type !== "form") {
      continue;
    }
    for (const field of step.fields) {
      const value = run.state.values[field.id];
      if (
        field.kind === "email" &&
        field.notify &&
        typeof value === "string" &&
        /^[^\s@]+@[^\s@]+$/.test(value)
      ) {
        return value;
      }
    }
  }
  return null;
}

/**
 * The link a mail carries. A member signs in. A visitor's carries a ticket: while the run waits
 * one that only reads and answers it, about a run's end one that only reads. It lasts as long as
 * the run is kept, at most `LINK_MS`.
 */
function linkOf(row: NoticeRow, run: RunRow, wizard: { id: string; shareToken: string }) {
  if (askedOfAnother(row, run)) {
    return `${env.appUrl}/work/r/${run.id}`;
  }
  if (!row.visitor) {
    return `${studioUrl(wizard.id)}?run=${run.id}`;
  }
  const most = row.createdAt.getTime() + LINK_MS;
  const until = new Date(Math.min(run.expiresAt?.getTime() ?? most, most));
  const ticket = speaksOfWait(row.kind)
    ? runWaitTicket(run.id, until)
    : runViewTicketUntil(run.id, until);
  return `${shareUrl(wizard.shareToken)}/${run.id}?rt=${encodeURIComponent(ticket)}`;
}

/** The row asks someone other than the run's own person: one of those who answer for the team. */
const askedOfAnother = (row: NoticeRow, run: RunRow) =>
  Boolean(row.userId) && row.userId !== run.userId;

/** Whether the run is a client's: they started it in a space they are in as a client. */
async function clientOf(run: RunRow): Promise<boolean> {
  if (!(run.userId && run.clientSpaceId)) {
    return false;
  }
  const row = await db.query.spaceMember.findFirst({
    columns: { id: true },
    where: and(
      eq(schema.spaceMember.spaceId, run.clientSpaceId),
      eq(schema.spaceMember.userId, run.userId),
      eq(schema.spaceMember.role, "client"),
    ),
  });
  return Boolean(row);
}

type Delivery = "dealt" | "again";

/** A refusal is an answer (over the limit, no such person, a Manage-App without the route): the bell has to do. */
function afterFailure(err: unknown, channel: string, row: NoticeRow): Delivery {
  if (err instanceof ManageError && err.status < 500) {
    console.warn(`[notices] ${channel} for ${row.id} refused: ${err.status} ${err.code}`);
    return "dealt";
  }
  console.error(`[notices] ${channel} for ${row.id}:`, (err as Error).message);
  return "again";
}

async function mailOf(row: NoticeRow, run: RunRow): Promise<Delivery> {
  // A test run stays in the studio; a client's run in their portal, whose link a mail cannot know
  // yet. Whoever answers for the team is of the firm: their link goes to the run in Work.
  if (
    run.mode !== "live" ||
    (run.clientSpaceId && !askedOfAnother(row, run) && (await clientOf(run)))
  ) {
    return "dealt";
  }
  const address = row.visitor ? visitorAddress(run) : null;
  if (row.visitor && !address) {
    return "dealt";
  }
  const wizard = await db.query.wizard.findFirst({
    where: eq(schema.wizard.id, run.wizardId),
    columns: { id: true, shareToken: true, shareEnabled: true },
  });
  // Without its link the wizard's page answers nobody, so a visitor's mail would lead nowhere.
  if (!wizard || (row.visitor && !wizard.shareEnabled)) {
    return "dealt";
  }
  const mail = {
    kind: speaksOfWait(row.kind) ? ("waiting" as const) : (row.kind as "done" | "failed"),
    wizard: run.definition.title,
    url: linkOf(row, run, wizard),
    lang: textLang(run.lang ?? wizardLang(run.definition)),
    key: row.id,
  };
  try {
    if (!managed) {
      await accountRunMail(mail);
    } else if (address) {
      await runMail({ ...mail, tenantId: currentTenant(), to: { email: address } });
    } else if (row.userId) {
      await runMail({
        ...mail,
        tenantId: currentTenant(),
        to: { userId: row.userId },
        asked: askedOfAnother(row, run),
      });
    }
    return "dealt";
  } catch (err) {
    return afterFailure(err, "mail", row);
  }
}

async function pushOf(row: NoticeRow, run: RunRow): Promise<Delivery> {
  // The run's device is its own person's: it says nothing to someone else's question.
  if (!managed || run.mode !== "live" || askedOfAnother(row, run)) {
    return "dealt";
  }
  const kind = speaksOfWait(row.kind)
    ? row.waitKey?.startsWith("ask:")
      ? "asks"
      : "waiting"
    : row.kind;
  try {
    await pushToRunDevice(run, kind as "asks" | "waiting" | "done" | "failed");
    return "dealt";
  } catch (err) {
    return afterFailure(err, "push", row);
  }
}

async function deliver(row: NoticeRow, now: Date) {
  const run = row.runId
    ? await db.query.run.findFirst({ where: eq(schema.run.id, row.runId) })
    : null;
  if (!run) {
    await finish(row);
    return;
  }
  const index = await controlDb.query.runIndex.findFirst({
    where: eq(control.runIndex.runId, run.id),
    columns: { viewedAt: true },
  });
  // Who looks at the run is its own person: that says nothing about someone else who is asked.
  const viewed = askedOfAnother(row, run) ? 0 : (index?.viewedAt?.getTime() ?? 0);
  if (speaksOfWait(row.kind) ? !stillWaits(row.waitKey, run) : viewed >= row.createdAt.getTime()) {
    await settle(row, now);
    return;
  }
  if (now.getTime() - viewed < LOOKING_MS) {
    await later(row, new Date(now.getTime() + 30_000));
    return;
  }
  // A reminder says what a first word not yet delivered would say: one word, one mail.
  if (row.kind === "reminder") {
    await db
      .delete(schema.notice)
      .where(
        and(
          eq(schema.notice.runId, run.id),
          eq(schema.notice.kind, "needs_you"),
          eq(schema.notice.waitKey, row.waitKey ?? ""),
          isNotNull(schema.notice.dueAt),
        ),
      );
  }
  if (!row.visitor && !row.shown) {
    await mark(row.id, { shown: true });
  }
  let again = false;
  if (!row.pushedAt) {
    if ((await pushOf(row, run)) === "dealt") {
      await mark(row.id, { pushedAt: now });
    } else {
      again = true;
    }
  }
  if (!row.mailedAt) {
    if (now.getTime() - viewed < QUIET_MS) {
      await later(row, new Date(viewed + QUIET_MS));
      return;
    }
    if ((await mailOf(row, run)) === "dealt") {
      await mark(row.id, { mailedAt: now });
    } else {
      again = true;
    }
  }
  const attempts = row.attempts + 1;
  if (again && attempts < MAX_ATTEMPTS) {
    await mark(row.id, {
      attempts,
      claimUntil: null,
      dueAt: new Date(now.getTime() + 2 ** (attempts - 1) * 60_000),
    });
    return;
  }
  await finish(row);
  if (row.kind === "reminder") {
    await emitEvent(run.id, run.cursor, "info", note("reminderSent"));
  }
}

/** Delivers what is due in the tenant at hand. */
export async function deliverNotices(now = new Date()) {
  const rows = await claimDue(now);
  const key = (row: NoticeRow) => `${row.runId} ${row.waitKey}`;
  const reminded = new Set(rows.filter((row) => row.kind === "reminder").map(key));
  for (const row of rows) {
    // The first word and the reminder came due together: the reminder says it.
    const said = row.kind === "needs_you" && reminded.has(key(row));
    await (said
      ? db.delete(schema.notice).where(eq(schema.notice.id, row.id))
      : deliver(row, now)
    ).catch((err) => console.error(`[notices] ${row.id}:`, err));
  }
  if (rows.length) {
    await trim();
  }
}

/** Looks in every active tenant; a tenant with nothing due costs one indexed question. */
export async function deliverAllNotices(now = new Date()) {
  const tenants = await controlDb.query.tenant.findMany({
    where: eq(control.tenant.status, "active"),
    columns: { id: true },
  });
  for (const tenant of tenants) {
    await withTenant(tenant.id, () => deliverNotices(now)).catch((err) =>
      console.error(`[notices ${tenant.id}]`, err),
    );
  }
}

const TICK_MS = 30_000;
let timer: NodeJS.Timeout | null = null;
let sending = false;

/** The sender, on a process that runs runs. */
export function startNotices() {
  if (timer || !env.serves.runner) {
    return;
  }
  const tick = () => {
    if (sending) {
      return;
    }
    sending = true;
    void deliverAllNotices()
      .catch((err) => console.error("[notices]", err))
      .finally(() => {
        sending = false;
      });
  };
  timer = setInterval(tick, TICK_MS);
  timer.unref();
}
