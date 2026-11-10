import type { MailboxError } from "@engenty/wizards-shared/connectors";
import { MAIL_SIGNAL } from "@engenty/wizards-shared/definition";
import { and, eq, inArray, isNotNull, isNull, lte, ne, or } from "drizzle-orm";
import {
  type BrokerResult,
  brokerPullStream,
  brokerReadMessage,
  signInRefused,
} from "../broker/index.js";
import { resolveConnector } from "../connectors/external.js";
import { control, controlDb, db, schema, withTenant } from "../db/client.js";
import type {
  ConnectorDefinition,
  InboundMessage,
  StreamPullResult,
} from "../engenty/connections-sdk/types.js";
import { feature, remoteFeatures } from "../features.js";
import { twoWayActive } from "../sync/state.js";
import { LOCAL_TENANT } from "../tenants/tenant.js";
import { runStore } from "./run-store.js";
import { SPACE_SCOPE, sendSignal, signalKey } from "./signals.js";

/**
 * A mailbox as a source of signals: read from a stored cursor once a minute, only while a run
 * waits on that space's mail, so a mailbox nobody waits on costs nothing. Only a connection that
 * signs in as the space and that an admin switched on (`autonomous_mode`). The cursor is saved
 * after the signals are sent: a crash in between reads the same mails again, and the mail's id as
 * the delivery key makes that the same signals.
 */

type Connection = typeof schema.spaceConnection.$inferSelect;
type Cursor = typeof schema.mailCursor.$inferSelect;

/**
 * How long one mail's text goes on: signals are kept whole, and they reach prompts and pages. Only a
 * mail a run waits on as it is read keeps its text. Of the rest the row has what tells who wrote
 * about what, and a run that comes to one later reads its text in the mailbox (`withMailText`).
 */
const MAIL_TEXT = 20_000;
const PAGE = 50;
/** The most pages a mailbox reads in one minute; the rest comes with the next minute. */
const PAGES_PER_TICK = 5;
/** Under a signal's 30 days: an older mail could no longer be told from one taken before. */
const FURTHEST_BACK_MS = 29 * 86_400_000;
const TICK_MS = 60_000;
/** Another runner leaves a mailbox alone this long after one started on it: under a tick. */
const LEASE_MS = 50_000;
const MAX_RETRY_MS = 3_600_000;
/** The connector's word for a cursor it no longer knows: `gmail_stream_cursor_expired`. */
const CURSOR_EXPIRED = /_stream_cursor_expired/;

/** The oldest mail any run can still care about: since it was switched on, and since the oldest open run began. */
async function furthestBack(spaceId: string, since: Date, now: Date): Promise<Date> {
  const oldest = await runStore.oldestOpen(spaceId);
  const times = [since.getTime(), oldest?.getTime() ?? now.getTime()];
  return new Date(Math.max(...times, now.getTime() - FURTHEST_BACK_MS));
}

/** A mail's sender as a key, if it is an address: `From: thread:abc` must not reach a thread. */
const senderKey = (from: string | null) =>
  from?.includes("@") && !from.toLowerCase().startsWith("thread:") ? from : null;

/** Of these keys, the ones a run in this space waits on now. */
async function waitedOn(spaceId: string, keys: string[]): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({ key: schema.runWait.key })
    .from(schema.runWait)
    .where(
      and(
        eq(schema.runWait.spaceId, spaceId),
        eq(schema.runWait.name, MAIL_SIGNAL),
        inArray(schema.runWait.key, keys.map(signalKey)),
      ),
    );
  return new Set(rows.map((r) => r.key));
}

/**
 * One mail, two signals: by sender and by thread. What the mailbox sent itself or a machine answered
 * wakes nobody, and a sender the provider found forged wakes no wait for that sender.
 */
async function signalMail(spaceId: string, connectionId: string, mail: InboundMessage, from: Date) {
  if (mail.outgoing || mail.auto_reply) {
    return;
  }
  const received = Date.parse(mail.received_at ?? "");
  const at = new Date(Number.isNaN(received) ? Date.now() : received);
  if (at < from) {
    return;
  }
  const data = {
    from: mail.from_email,
    name: mail.from_name,
    subject: mail.subject,
    thread: mail.provider_thread_id,
    message: mail.provider_message_id,
    at: at.toISOString(),
  };
  const keys = [
    mail.sender_failed_checks ? null : senderKey(mail.from_email),
    mail.provider_thread_id ? `thread:${mail.provider_thread_id}` : null,
  ].filter((k): k is string => k !== null);
  const waited = await waitedOn(spaceId, keys);
  const text = mail.body_text?.slice(0, MAIL_TEXT) ?? null;
  for (const key of keys) {
    await sendSignal({
      spaceId,
      scope: SPACE_SCOPE,
      name: MAIL_SIGNAL,
      key,
      data: waited.has(signalKey(key)) ? { ...data, text } : data,
      source: `mail:${connectionId}`,
      delivery: mail.provider_message_id,
      at,
    });
  }
}

/**
 * What a wait hands on from a signal. A mail that came before anyone waited has no text in its row:
 * it is read from the mailbox now. A mail that can't be read any more wakes the run all the same.
 */
export async function withMailText(signal: {
  data: Record<string, unknown> | null;
  source?: string;
}): Promise<Record<string, unknown> | null> {
  const { data, source } = signal;
  if (!(data && source?.startsWith("mail:") && typeof data.message === "string")) {
    return data;
  }
  if ("text" in data) {
    return data;
  }
  try {
    const row = await db.query.spaceConnection.findFirst({
      where: eq(schema.spaceConnection.id, source.slice("mail:".length)),
    });
    const connector = row && (await resolveConnector(row.spaceId, row.connectorId))?.connector;
    if (!(row && connector?.stream?.read)) {
      return { ...data, text: null };
    }
    const got = await brokerReadMessage({
      connection: { kind: "space_connection", row, connector },
      message: data.message,
    });
    return {
      ...data,
      text: (got.ok ? got.result?.body_text?.slice(0, MAIL_TEXT) : null) ?? null,
    };
  } catch (err) {
    console.warn(`[mail-watch] reading ${data.message}: ${(err as Error)?.message ?? err}`);
    return { ...data, text: null };
  }
}

/** A refusal or an error, in the words the share dialog has for it. */
class NotRead extends Error {
  constructor(
    readonly why: MailboxError,
    message: string,
  ) {
    super(message);
  }
}

const saved = (connectionId: string, set: Partial<Cursor>) =>
  db.update(schema.mailCursor).set(set).where(eq(schema.mailCursor.connectionId, connectionId));

/** Reads what came since the cursor, a few pages at most, and saves the cursor after each page. */
async function readMailbox(
  row: Connection,
  connector: ConnectorDefinition,
  held: Cursor,
  now: Date,
) {
  const from = await furthestBack(row.spaceId, held.since, now);
  let cursor = held.cursor;
  for (let pages = 0; pages < PAGES_PER_TICK; pages++) {
    let got: BrokerResult<StreamPullResult>;
    try {
      got = await brokerPullStream({
        connection: { kind: "space_connection", row, connector },
        cursor,
        since: from,
        limit: PAGE,
      });
    } catch (err) {
      // Too old for the provider: start over from a date. The delivery keys absorb the overlap.
      if (cursor !== null && CURSOR_EXPIRED.test((err as Error).message)) {
        cursor = null;
        continue;
      }
      throw err;
    }
    if (!got.ok) {
      throw new NotRead(got.refused === "not_connected" ? "sign_in" : "rules", got.reason);
    }
    for (const mail of got.result.items) {
      await signalMail(row.spaceId, row.id, mail, from);
    }
    cursor = got.result.nextCursor;
    await saved(row.id, { cursor, readAt: new Date(), error: null, failures: 0 });
    if (!got.result.hasMore) {
      return;
    }
  }
}

/** Takes the mailbox for this minute; null when another runner has it or its last try keeps it waiting. */
async function claim(connectionId: string, now: Date): Promise<Cursor | null> {
  await db.insert(schema.mailCursor).values({ connectionId, since: now }).onConflictDoNothing();
  const [held] = await db
    .update(schema.mailCursor)
    .set({ nextAt: new Date(now.getTime() + LEASE_MS) })
    .where(
      and(
        eq(schema.mailCursor.connectionId, connectionId),
        or(isNull(schema.mailCursor.nextAt), lte(schema.mailCursor.nextAt, now)),
      ),
    )
    .returning();
  return held ?? null;
}

/** A try that failed waits longer each time, up to an hour: a dead sign-in is not asked every minute. */
async function failed(held: Cursor, err: unknown, now: Date) {
  const failures = held.failures + 1;
  const why: MailboxError =
    err instanceof NotRead ? err.why : signInRefused(err) ? "sign_in" : "read";
  console.warn(`[mail-watch] ${held.connectionId}: ${(err as Error)?.message ?? err}`);
  await saved(held.connectionId, {
    error: why,
    failures,
    nextAt: new Date(now.getTime() + Math.min(TICK_MS * 2 ** failures, MAX_RETRY_MS)),
  });
}

/** Mailboxes one process is reading right now: a slow one is not started a second time. */
const reading = new Set<string>();

/** This tenant's mailboxes that someone waits on and that are switched on, read once each. */
async function watchTenant(now: Date) {
  const waiting = await db
    .selectDistinct({ spaceId: schema.runWait.spaceId })
    .from(schema.runWait)
    .where(eq(schema.runWait.name, MAIL_SIGNAL));
  if (!(waiting.length && feature("durableRuns", await remoteFeatures().catch(() => null)))) {
    return;
  }
  const rows = await db.query.spaceConnection.findMany({
    where: and(
      inArray(
        schema.spaceConnection.spaceId,
        waiting.map((w) => w.spaceId),
      ),
      eq(schema.spaceConnection.signIn, "space"),
      ne(schema.spaceConnection.autonomousMode, "off"),
      isNotNull(schema.spaceConnection.secret),
    ),
  });
  await Promise.all(
    rows.map(async (row) => {
      if (reading.has(row.id)) {
        return;
      }
      const connector = (await resolveConnector(row.spaceId, row.connectorId))?.connector;
      if (!connector?.stream) {
        return;
      }
      reading.add(row.id);
      try {
        const held = await claim(row.id, now);
        if (held) {
          await readMailbox(row, connector, held, now).catch((err) => failed(held, err, now));
        }
      } finally {
        reading.delete(row.id);
      }
    }),
  );
}

/** One minute's look at every tenant. The same tenants as the plugins' jobs. */
export async function watchMail(now = new Date()): Promise<void> {
  const tenants = await controlDb.query.tenant.findMany({
    where: eq(control.tenant.status, "active"),
    columns: { id: true },
  });
  await Promise.all(
    tenants
      // An install whose spaces sync both ways leaves this to the cloud, like the plugins' jobs.
      .filter((tenant) => !(twoWayActive() && tenant.id === LOCAL_TENANT))
      .map((tenant) =>
        withTenant(tenant.id, () => watchTenant(now)).catch((err) =>
          console.error(`[mail-watch ${tenant.id}]`, err),
        ),
      ),
  );
}

let timer: NodeJS.Timeout | null = null;

/** A runner reads the mailboxes: soon after the start, then once a minute. */
export function startMailWatch() {
  if (timer) {
    return;
  }
  const tick = () => void watchMail().catch((err) => console.error("[mail-watch]", err));
  setTimeout(tick, 5_000).unref();
  timer = setInterval(tick, TICK_MS);
  timer.unref();
}
