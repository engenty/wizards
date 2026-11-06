import { createHash } from "node:crypto";
import { BROKER_REFUSALS, type CriticalKind } from "@engenty/wizards-shared/connectors";
import {
  and,
  count,
  desc,
  eq,
  exists,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  ne,
  not,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema } from "../db/client.js";

/*
 * The broker's log (docs/plans/broker.md, "The log"): one row per call, allowed or not. Never a
 * token, a key, a password or a full body — the input goes in as its field names and sizes, one
 * clipped value that is no secret, and a hash of the whole. A row of one of the critical kinds
 * below is heard ("Notifications"): under the admins' bell, in the hourly mail, in the report
 * to the Manage-App.
 */

export type LogRow = typeof schema.brokerLog.$inferInsert;
export type LoggedRow = typeof schema.brokerLog.$inferSelect;

/**
 * What the broker's admins hear of (docs/plans/broker.md, "Notifications"), one of
 * `CRITICAL_KINDS` (shared/connectors): `refused_write` – a *Nie*, the grant or the AI-step rule
 * stopped a write, a delete or a send; `outside_audience` – a guest's run reached a connection
 * that is for the space's members or admins; `host_not_in_grant`; `limit_reached` – a guest's run
 * or a wizard's guests have sent their mails for the run or the day, or a connection of the space
 * has taken its calls for a run or the day; `sign_in_failed` – a sign-in ran out or the service
 * refused it; `first_use` of a connection of the space; `rule_changed` – RWX, a connection's
 * rules, audience or limits, or a connection paused or resumed.
 */
export { CRITICAL_KINDS, type CriticalKind } from "@engenty/wizards-shared/connectors";

/** The action under which a changed rule is logged; the connection is the one changed, or `rwx`. */
export const RULE_CHANGE_ACTION = "change_rules";
/** The result under which a sign-in that ran out or was refused is logged. */
export const SIGN_IN_FAILED = "sign_in_failed";

/** What is known of a call when its line is written, beyond the row itself. */
export interface LineContext {
  /** A connection of the space used for the first time. */
  firstUse?: boolean;
  /** A connection's limit refused a call before, in this run or today: the admins heard of it. */
  limitHeard?: boolean;
}

/** The refusals of a connection's own limits (`takePlace`): its calls per run, its calls per day. */
export const CALLS_PER_RUN = "calls_per_run";
export const CALLS_PER_DAY = "calls_per_day";

/**
 * Which critical kind a row is, if any: the one place that decides. Every refusal of a write, a
 * delete or a send is critical; a refused read only where a guest reached outside a connection's
 * audience. A connection's first use and a changed rule are critical though nothing was refused.
 * What a paused connection refuses is not: the admins paused it themselves and heard of that
 * (`rule_changed`), and the mail that tells them of critical lines may go through that connection.
 * A connection's limit is heard of once per run or day, at the first call it refuses: the ones
 * after are refused and logged, and that mail may be one of them.
 */
export function criticalOf(
  row: Pick<LogRow, "whoKind" | "kind" | "outcome" | "result" | "connectionId" | "actionId"> & {
    rule?: string | null;
  },
  context: LineContext = {},
): CriticalKind | null {
  if (row.actionId === RULE_CHANGE_ACTION) {
    return "rule_changed";
  }
  if (row.result === SIGN_IN_FAILED) {
    return "sign_in_failed";
  }
  if (row.outcome === "deny") {
    if (row.result === "paused") {
      return null;
    }
    if (row.result === "run_limit" || row.result === "day_limit") {
      return "limit_reached";
    }
    if (row.result === CALLS_PER_RUN || row.result === CALLS_PER_DAY) {
      return context.limitHeard ? null : "limit_reached";
    }
    if (row.connectionId.startsWith("host:") && row.result === "not_in_grant") {
      return "host_not_in_grant";
    }
    if (row.rule === "audience" && row.whoKind === "guest") {
      return "outside_audience";
    }
    return row.kind === "read" ? null : "refused_write";
  }
  return row.result === "ok" && context.firstUse ? "first_use" : null;
}

/** A field whose value is never written down, whatever the action calls it. */
const SECRET = /token|secret|password|passwd|key|auth|credential|cookie|session|bearer|_base64$/i;

/** The widest a logged value gets. */
const SAMPLE = 80;

/** What the log keeps of a call's input. */
export function summarizeInput(input: unknown): string {
  const whole = JSON.stringify(input ?? null) ?? "null";
  const fields: Record<string, number> = {};
  let sample: string | null = null;
  if (input && typeof input === "object" && !Array.isArray(input)) {
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      fields[key] = typeof value === "string" ? value.length : (JSON.stringify(value) ?? "").length;
      if (sample === null && typeof value === "string" && value && !SECRET.test(key)) {
        sample = `${key}: ${value.replace(/\s+/g, " ").slice(0, SAMPLE)}`;
      }
    }
  }
  return JSON.stringify({
    fields,
    sample,
    size: whole.length,
    sha256: createHash("sha256").update(whole).digest("hex"),
  });
}

type Heard = (row: LoggedRow) => void;
const listeners = new Set<Heard>();

/** Hears every critical row as it is written: the report to the Manage-App (services/manage-reports.ts). */
export function onCritical(listener: Heard): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A critical row is a line of the runtime's own log too, and goes to whoever listens. */
function hear(row: LoggedRow): void {
  console.warn(
    `[broker] ${row.criticalKind}: ${row.whoKind}${row.whoId ? ` ${row.whoId}` : ""} → ${row.connectionId} ${row.actionId} (${row.kind}): ${row.outcome}, ${row.result ?? ""}${row.reason ? ` – ${row.reason}` : ""}`,
  );
  for (const listener of listeners) {
    try {
      listener(row);
    } catch (err) {
      console.error("[broker] a listener failed:", err);
    }
  }
}

/**
 * Writes one row, deciding whether it is critical; a log that cannot be written never stops the
 * call. A critical row is also a line of the runtime's own log, so the log ring and „wizards
 * report“ carry it (docs/plans/remote-debug.md), and goes to whoever listens.
 */
export async function writeLog(
  row: Omit<LogRow, "id" | "critical" | "criticalKind">,
  context: LineContext = {},
): Promise<void> {
  const criticalKind = criticalOf(row, context);
  const written: LogRow = { id: nanoid(14), ...row, critical: criticalKind !== null, criticalKind };
  try {
    await db.insert(schema.brokerLog).values(written);
  } catch (err) {
    console.error("[broker] the log could not be written:", err);
    return;
  }
  if (criticalKind) {
    hear(written as LoggedRow);
  }
}

// --- a connection's limits (docs/plans/capabilities-next.md, 2b) -----------------------------

/** Today's first moment (UTC), as every per-day count sees it. */
export function startOfToday(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** A connection's limits as a call meets them; null: none. */
export interface CallLimits {
  perRun: number | null;
  perDay: number | null;
}

/**
 * The lines that count under a connection's limits: the calls the broker let through to the
 * service, whatever came of them. One that failed counts, and one still under way (`result` is
 * null). A refused call, one held for an approval and a changed rule count for nothing.
 */
function counted(): SQL {
  const log = schema.brokerLog;
  return and(
    ne(log.outcome, "deny"),
    ne(log.actionId, RULE_CHANGE_ACTION),
    or(isNull(log.result), notInArray(log.result, [...BROKER_REFUSALS])),
  ) as SQL;
}

const inRun = (connectionId: string, runId: string) =>
  and(
    eq(schema.brokerLog.connectionId, connectionId),
    eq(schema.brokerLog.runId, runId),
    counted(),
  ) as SQL;
const today = (connectionId: string) =>
  and(
    eq(schema.brokerLog.connectionId, connectionId),
    gte(schema.brokerLog.at, startOfToday()),
    counted(),
  ) as SQL;

/** The line of a call that took its place and is under way; `closeLine` writes its end. */
export interface OpenLine {
  id: string;
  row: Omit<LogRow, "id" | "critical" | "criticalKind">;
}

/**
 * Takes a call's place under its connection's limits by writing its line: the count and the line
 * are one statement, so of two calls at once only one gets the last free place, in whichever
 * process they run. A call with no run counts for the day only. Answers the open line, or which
 * limit is reached; then nothing was written.
 */
export async function takePlace(
  row: Omit<LogRow, "id" | "critical" | "criticalKind" | "result" | "resultSize" | "durationMs">,
  limits: CallLimits,
): Promise<OpenLine | { full: "run" | "day" }> {
  const log = schema.brokerLog;
  const places: SQL[] = [];
  if (limits.perRun !== null && row.runId) {
    places.push(
      sql`(select count(*) from ${log} where ${inRun(row.connectionId, row.runId)}) < ${limits.perRun}`,
    );
  }
  if (limits.perDay !== null) {
    places.push(
      sql`(select count(*) from ${log} where ${today(row.connectionId)}) < ${limits.perDay}`,
    );
  }
  const id = nanoid(14);
  // The columns as the table has them: a time is its milliseconds, a flag 0 or 1.
  const values: [column: string, value: unknown][] = [
    ["id", id],
    ["at", row.at.getTime()],
    ["duration_ms", 0],
    ["who_kind", row.whoKind],
    ["who_id", row.whoId ?? null],
    ["run_id", row.runId ?? null],
    ["step_id", row.stepId ?? null],
    ["client", row.client ?? null],
    ["chat_id", row.chatId ?? null],
    ["wizard_id", row.wizardId ?? null],
    ["space_id", row.spaceId ?? null],
    ["connection_id", row.connectionId],
    ["action_id", row.actionId],
    ["kind", row.kind],
    ["input_summary", row.inputSummary],
    ["outcome", row.outcome],
    ["rule", row.rule ?? null],
    ["reason", row.reason ?? null],
    ["critical", 0],
  ];
  const taken = await db.run(
    sql`insert into broker_log (${sql.raw(values.map(([column]) => column).join(", "))}) select ${sql.join(
      values.map(([, value]) => sql`${value}`),
      sql`, `,
    )} where ${and(...places) ?? sql`1`}`,
  );
  if (taken.rowsAffected > 0) {
    return { id, row: { ...row, durationMs: 0 } };
  }
  // Which one: the run's where the run has made its calls, else the day's.
  const full =
    limits.perRun !== null &&
    row.runId &&
    (await db.$count(log, inRun(row.connectionId, row.runId))) >= limits.perRun
      ? "run"
      : "day";
  return { full };
}

/**
 * Writes the end of a call that took a place: what came of it, how long it took, how much came
 * back, and whether the line is critical now (a connection's first use). A line whose end cannot
 * be written keeps its place and never stops the call.
 */
export async function closeLine(
  open: OpenLine,
  end: { durationMs: number; result: string; resultSize?: number | null },
  context: LineContext = {},
): Promise<void> {
  const row = { ...open.row, ...end, resultSize: end.resultSize ?? null };
  const criticalKind = criticalOf(row, context);
  try {
    await db
      .update(schema.brokerLog)
      .set({
        durationMs: row.durationMs,
        result: row.result,
        resultSize: row.resultSize,
        critical: criticalKind !== null,
        criticalKind,
      })
      .where(eq(schema.brokerLog.id, open.id));
  } catch (err) {
    console.error("[broker] the log could not be written:", err);
    return;
  }
  if (criticalKind) {
    hear({ ...row, id: open.id, critical: true, criticalKind } as LoggedRow);
  }
}

/** Whether this connection's limit refused a call before, in this run or today: it was heard of then. */
export async function limitHeard(
  connectionId: string,
  full: "run" | "day",
  runId: string | null,
): Promise<boolean> {
  const log = schema.brokerLog;
  const refused = and(eq(log.connectionId, connectionId), eq(log.critical, true));
  const before =
    full === "run" && runId
      ? and(refused, eq(log.result, CALLS_PER_RUN), eq(log.runId, runId))
      : and(refused, eq(log.result, CALLS_PER_DAY), gte(log.at, startOfToday()));
  return (await db.$count(log, before)) > 0;
}

/** The calls each of these connections took today, as the limit per day counts them. */
export async function callsToday(connectionIds: string[]): Promise<Map<string, number>> {
  if (!connectionIds.length) {
    return new Map();
  }
  const log = schema.brokerLog;
  const rows = await db
    .select({ id: log.connectionId, calls: count() })
    .from(log)
    .where(and(inArray(log.connectionId, connectionIds), gte(log.at, startOfToday()), counted()))
    .groupBy(log.connectionId);
  return new Map(rows.map((row) => [row.id, row.calls]));
}

/** A rule changed by an admin: RWX (`connectionId` "rwx") or a connection's rules or audience. */
export function logRuleChange(change: {
  userId: string;
  spaceId: string;
  connectionId: string;
  /** What changed, as the log keeps an input: the fields and one sample. */
  summary: Record<string, unknown>;
  reason: string;
}): Promise<void> {
  return writeLog({
    at: new Date(),
    durationMs: 0,
    whoKind: "admin",
    whoId: change.userId,
    runId: null,
    stepId: null,
    chatId: null,
    wizardId: null,
    spaceId: change.spaceId,
    connectionId: change.connectionId,
    actionId: RULE_CHANGE_ACTION,
    kind: "write",
    inputSummary: summarizeInput(change.summary),
    outcome: "allow",
    rule: null,
    reason: change.reason,
    result: "ok",
    resultSize: null,
  });
}

/** The filters of the log as the Protokoll page and its API ask for it. */
export interface LogQuery {
  connection?: string;
  who?: string;
  outcome?: string;
  /** What came of the call: `ok`, a refusal (`needs_approval` holds a call for the admins), an error's class. */
  result?: string;
  /** Refused: by a rule, or by the person asked. */
  refused?: boolean;
  critical?: boolean;
  since?: Date;
  /** Up to, not including, this time: the end of a time range. */
  until?: Date;
  /**
   * A text, found in the action, the connection, the reason, the result, the rule, the caller's
   * id and the input's sample — and in the ids `matches` names for it (people, connections and
   * wizards found by their names).
   */
  q?: string;
  matches?: { who?: string[]; connections?: string[]; wizards?: string[] };
  /** Rows older than this one: the next page. */
  before?: LogCursor;
  limit?: number;
  /** Only this person's own lines (`ownLines`): what a member reads of the log. */
  own?: string;
}

/** Where a page of the log ended: the last row's time and id (rows of one millisecond go by id). */
export interface LogCursor {
  at: Date;
  id: string;
}

/** The cursor as the API hands it out: `<ms>.<id>`. */
export function cursorOf(row: Pick<LoggedRow, "at" | "id">): string {
  return `${row.at.getTime()}.${row.id}`;
}

/** A cursor the API took; null where it is none. */
export function readCursor(text: string): LogCursor | null {
  const match = /^(\d{1,15})\.([A-Za-z0-9_-]{1,40})$/.exec(text);
  return match ? { at: new Date(Number(match[1])), id: match[2] as string } : null;
}

/** The widest the log answers at once. */
export const LOG_PAGE = 200;

/** The results of a call the person asked turned down, beside an `outcome` of `deny`. */
const REFUSED_BY_PERSON = ["declined"];

/** `%` and `_` stand for themselves in a search. */
function likeOf(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * A person's own lines: the calls they made themselves (an AI step of their run calls as them)
 * and the ones Goose made for them, and the fixed steps of a run held for them, which call as
 * the step. Part of the query, so a page, a cursor and a search count nobody else's lines.
 */
function ownLines(userId: string): SQL {
  const log = schema.brokerLog;
  return or(
    and(inArray(log.whoKind, ["person", "goose"]), eq(log.whoId, userId)),
    and(
      eq(log.whoKind, "step"),
      exists(
        db
          .select({ one: sql`1` })
          .from(schema.run)
          .where(and(eq(schema.run.id, log.runId), eq(schema.run.userId, userId))),
      ),
    ),
  ) as SQL;
}

/** A space's log, newest first, filtered. */
export async function logOfSpace(spaceId: string, query: LogQuery = {}): Promise<LoggedRow[]> {
  const log = schema.brokerLog;
  const where: SQL[] = [eq(log.spaceId, spaceId)];
  if (query.own) {
    where.push(ownLines(query.own));
  }
  if (query.connection) {
    where.push(eq(log.connectionId, query.connection));
  }
  if (query.who) {
    where.push(eq(log.whoKind, query.who));
  }
  if (query.outcome) {
    where.push(eq(log.outcome, query.outcome));
  }
  if (query.result) {
    where.push(eq(log.result, query.result));
  }
  if (query.refused !== undefined) {
    const refused = or(
      eq(log.outcome, "deny"),
      and(eq(log.outcome, "ask"), inArray(log.result, REFUSED_BY_PERSON)),
    ) as SQL;
    where.push(query.refused ? refused : not(refused));
  }
  if (query.critical !== undefined) {
    where.push(eq(log.critical, query.critical));
  }
  if (query.since) {
    where.push(gt(log.at, query.since));
  }
  if (query.until) {
    where.push(lt(log.at, query.until));
  }
  const text = query.q?.trim();
  if (text) {
    const like = likeOf(text);
    const found: SQL[] = [
      log.actionId,
      log.connectionId,
      log.reason,
      log.result,
      log.rule,
      log.whoId,
      log.inputSummary,
    ].map((column) => sql`${column} like ${like} escape '\\'`);
    const { who = [], connections = [], wizards = [] } = query.matches ?? {};
    if (who.length) {
      found.push(inArray(log.whoId, who));
    }
    if (connections.length) {
      found.push(inArray(log.connectionId, connections));
    }
    if (wizards.length) {
      found.push(inArray(log.wizardId, wizards));
    }
    where.push(or(...found) as SQL);
  }
  if (query.before) {
    where.push(
      or(
        lt(log.at, query.before.at),
        and(eq(log.at, query.before.at), lt(log.id, query.before.id)),
      ) as SQL,
    );
  }
  return db
    .select()
    .from(log)
    .where(and(...where))
    .orderBy(desc(log.at), desc(log.id))
    .limit(Math.min(Math.max(query.limit ?? LOG_PAGE, 1), LOG_PAGE));
}

/** One line of a space's log; with `own`, only where it is that person's own. */
export async function logLine(
  spaceId: string,
  id: string,
  own?: string,
): Promise<LoggedRow | null> {
  const log = schema.brokerLog;
  const [row] = await db
    .select()
    .from(log)
    .where(and(eq(log.spaceId, spaceId), eq(log.id, id), ...(own ? [ownLines(own)] : [])))
    .limit(1);
  return row ?? null;
}

/** The critical rows of these spaces since a time, newest first. */
export async function criticalSince(
  spaceIds: string[],
  since: Date,
  limit = LOG_PAGE,
): Promise<LoggedRow[]> {
  if (!spaceIds.length) {
    return [];
  }
  return db.query.brokerLog.findMany({
    where: and(
      inArray(schema.brokerLog.spaceId, spaceIds),
      eq(schema.brokerLog.critical, true),
      gt(schema.brokerLog.at, since),
    ),
    orderBy: [desc(schema.brokerLog.at)],
    limit,
  });
}

/** When a connection was last used, by whom and for what: „Letzte Nutzung“. */
export async function lastUseOf(
  connectionId: string,
  /** A wizard's connection ids repeat across wizards: name the wizard to tell them apart. */
  within: { wizardId?: string } = {},
): Promise<{
  at: Date;
  who: { kind: string; id: string | null };
  actionId: string;
  kind: string;
  outcome: string;
} | null> {
  const row = await db.query.brokerLog.findFirst({
    where: and(
      eq(schema.brokerLog.connectionId, connectionId),
      ...(within.wizardId ? [eq(schema.brokerLog.wizardId, within.wizardId)] : []),
    ),
    orderBy: [desc(schema.brokerLog.at)],
  });
  return row
    ? {
        at: row.at,
        who: { kind: row.whoKind, id: row.whoId },
        actionId: row.actionId,
        kind: row.kind,
        outcome: row.outcome,
      }
    : null;
}
