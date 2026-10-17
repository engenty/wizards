import { AsyncResource } from "node:async_hooks";
import { EventEmitter } from "node:events";
import { noteText, type RunEvent, type RunNote } from "@engenty-wizards/shared/run";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";

const bus = new EventEmitter();
bus.setMaxListeners(0);

/** Something changed on a run: a new event row, or a status change (event = null). */
export type RunSignal = { runId: string; event: RunEvent | null };

export async function emitEvent(
  runId: string,
  stepId: string | null,
  type: RunEvent["type"],
  said: string | RunNote,
  asset?: string | null,
): Promise<void> {
  const note = typeof said === "string" ? null : said;
  const message = note ? noteText(note, "en") : (said as string);
  const [row] = await db
    .insert(schema.runEvent)
    .values({
      runId,
      stepId,
      type,
      message: message.slice(0, 2000),
      note,
      assetId: asset ?? null,
    })
    .returning();
  const event: RunEvent = {
    id: row.id,
    at: row.createdAt.toISOString(),
    stepId: row.stepId,
    type: row.type,
    message: row.message,
    note: row.note ?? null,
    asset: row.assetId,
  };
  bus.emit(runId, { runId, event } satisfies RunSignal);
}

export function signalChanged(runId: string) {
  bus.emit(runId, { runId, event: null } satisfies RunSignal);
}

/** The listener runs in the subscriber's own context (its tenant), whoever signals. */
export function subscribe(runId: string, listener: (signal: RunSignal) => void): () => void {
  const bound = AsyncResource.bind(listener);
  bus.on(runId, bound);
  return () => bus.off(runId, bound);
}

/** How often a watcher looks at the row for what another process changed. */
const WATCH_POLL_MS = 1000;

/**
 * Tells of every change on a run: at once when this process made it, within a second when the
 * runner (another process) wrote to the row, added an event or put a call to the run's device.
 * Each event row reaches the listener once, whichever process wrote it. Call it in the run's
 * tenant.
 */
export function watchRun(runId: string, listener: (signal: RunSignal) => void): () => void {
  /** The newest event the listener has had; null until the first look. */
  let told: number | null = null;
  const unsubscribe = subscribe(runId, (signal) => {
    if (signal.event) {
      if (told !== null && signal.event.id <= told) {
        return;
      }
      told = Math.max(told ?? 0, signal.event.id);
    }
    listener(signal);
  });
  let last: string | null = null;
  let busy = false;
  const look = async () => {
    if (busy) {
      return;
    }
    busy = true;
    try {
      const [row] = await db
        .select({
          updatedAt: schema.run.updatedAt,
          event: sql<
            number | null
          >`(select max(${schema.runEvent.id}) from ${schema.runEvent} where ${schema.runEvent.runId} = ${runId})`,
          call: sql<
            number | null
          >`(select max(${schema.deviceCall.id}) from ${schema.deviceCall} where ${schema.deviceCall.runId} = ${runId})`,
        })
        .from(schema.run)
        .where(eq(schema.run.id, runId));
      const newest = row?.event ?? 0;
      if (told === null) {
        told = newest;
      } else if (newest > told) {
        // Events another process wrote, in order; at most a page per look.
        for (const event of await recentEvents(runId, told, 100)) {
          if (event.id > (told ?? 0)) {
            told = event.id;
            listener({ runId, event });
          }
        }
      }
      const mark = row ? `${row.updatedAt.getTime()}:${row.call ?? 0}` : null;
      if (last !== null && mark !== last) {
        listener({ runId, event: null });
      }
      last = mark;
    } catch {
      // The next look tells.
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void look(), WATCH_POLL_MS);
  timer.unref();
  void look();
  return () => {
    clearInterval(timer);
    unsubscribe();
  };
}

export async function recentEvents(runId: string, afterId = 0, limit = 40): Promise<RunEvent[]> {
  const rows = await db
    .select()
    .from(schema.runEvent)
    .where(and(eq(schema.runEvent.runId, runId), gt(schema.runEvent.id, afterId)))
    .orderBy(desc(schema.runEvent.id))
    .limit(limit);
  return rows.reverse().map((r) => ({
    id: r.id,
    at: r.createdAt.toISOString(),
    stepId: r.stepId,
    type: r.type,
    message: r.message,
    note: r.note ?? null,
    asset: r.assetId,
  }));
}
