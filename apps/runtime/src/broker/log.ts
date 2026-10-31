import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema } from "../db/client.js";

/*
 * The broker's log (docs/plans/broker.md, "The log"): one row per call, allowed or not. Never a
 * token, a key, a password or a full body — the input goes in as its field names and sizes, one
 * clipped value that is no secret, and a hash of the whole.
 */

export type LogRow = typeof schema.brokerLog.$inferInsert;

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

/** Writes one row; a log that cannot be written never stops the call. */
export async function writeLog(row: Omit<LogRow, "id">): Promise<void> {
  try {
    await db.insert(schema.brokerLog).values({ id: nanoid(14), ...row });
  } catch (err) {
    console.error("[broker] the log could not be written:", err);
  }
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
