import { createHash } from "node:crypto";
import type { CriticalKind } from "@engenty/wizards-shared/connectors";
import { and, desc, eq, gt, inArray, lt, not, or, type SQL, sql } from "drizzle-orm";
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
 * or a wizard's guests have sent their mails for the run or the day; `sign_in_failed` – a sign-in
 * ran out or the service refused it; `first_use` of a connection of the space; `rule_changed` –
 * RWX, or a connection's rules or audience.
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
}

/**
 * Which critical kind a row is, if any: the one place that decides. Every refusal of a write, a
 * delete or a send is critical; a refused read only where a guest reached outside a connection's
 * audience. A connection's first use and a changed rule are critical though nothing was refused.
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
    if (row.result === "run_limit" || row.result === "day_limit") {
      return "limit_reached";
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
    console.warn(
      `[broker] ${criticalKind}: ${row.whoKind}${row.whoId ? ` ${row.whoId}` : ""} → ${row.connectionId} ${row.actionId} (${row.kind}): ${row.outcome}, ${row.result ?? ""}${row.reason ? ` – ${row.reason}` : ""}`,
    );
    const full = written as LoggedRow;
    for (const listener of listeners) {
      try {
        listener(full);
      } catch (err) {
        console.error("[broker] a listener failed:", err);
      }
    }
  }
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

/** A space's log, newest first, filtered. */
export async function logOfSpace(spaceId: string, query: LogQuery = {}): Promise<LoggedRow[]> {
  const log = schema.brokerLog;
  const where: SQL[] = [eq(log.spaceId, spaceId)];
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
  return db.query.brokerLog.findMany({
    where: and(...where),
    orderBy: [desc(log.at), desc(log.id)],
    limit: Math.min(Math.max(query.limit ?? LOG_PAGE, 1), LOG_PAGE),
  });
}

/** One line of a space's log. */
export async function logLine(spaceId: string, id: string): Promise<LoggedRow | null> {
  const row = await db.query.brokerLog.findFirst({
    where: and(eq(schema.brokerLog.spaceId, spaceId), eq(schema.brokerLog.id, id)),
  });
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
