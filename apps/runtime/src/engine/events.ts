import { AsyncResource } from "node:async_hooks";
import { EventEmitter } from "node:events";
import { note as noted, noteText, type RunEvent, type RunNote } from "@engenty/wizards-shared/run";
import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { runStore } from "./run-store.js";

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

/**
 * What a run says when `run_effect` finds an outside action `started`: it may have happened, and
 * nothing repeats it by itself. `to`: who a mail went to, when the action sends one. The check in
 * `brokerCall` (broker/effect.ts) calls this.
 */
export async function effectUnsure(
  runId: string,
  stepId: string,
  action: { tool: string; to?: string },
): Promise<void> {
  await emitEvent(
    runId,
    stepId,
    "effect_unsure",
    action.to
      ? noted("effectMailMayBeSent", { to: action.to })
      : noted("effectMayHaveHappened", { what: action.tool }),
  );
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
 * While the run changed a moment ago, more often: an answer just handed it to a runner (another
 * process), whose next write the person is waiting for.
 */
const WATCH_HOT_MS = 100;
/** How long after a change the watcher keeps looking often. */
const WATCH_HOT_FOR_MS = 15_000;

/**
 * Tells of every change on a run: at once when this process made it, within a second when the
 * runner (another process) wrote to the row, added an event or put a call to the run's device, or
 * the broker worked on one of its share jobs.
 * Each event row reaches the listener once, whichever process wrote it. Call it in the run's
 * tenant.
 */
export function watchRun(runId: string, listener: (signal: RunSignal) => void): () => void {
  /** The newest event the listener has had; null until the first look. */
  let told: number | null = null;
  // When the row last changed, as the last look saw it or this process did it: a run at work is
  // looked at often.
  let changedAt = 0;
  let lookedAt = 0;
  const unsubscribe = subscribe(runId, (signal) => {
    // This process changed the run (an answer that handed it to a runner): look often from now.
    changedAt = Date.now();
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
    const now = Date.now();
    const hot = now - changedAt < WATCH_HOT_FOR_MS;
    if (busy || now - lookedAt < (hot ? WATCH_HOT_MS : WATCH_POLL_MS) - 20) {
      return;
    }
    lookedAt = now;
    busy = true;
    try {
      const row = await runStore.lastChange(runId);
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
      changedAt = Math.max(changedAt, row?.updatedAt.getTime() ?? 0);
      const mark = row ? `${row.updatedAt.getTime()}:${row.call ?? 0}:${row.job ?? 0}` : null;
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
  const timer = setInterval(() => void look(), WATCH_HOT_MS);
  timer.unref();
  void look();
  return () => {
    clearInterval(timer);
    unsubscribe();
  };
}

/** Where a watcher of a run on another host reads: the host's state and its stream of changes. */
export interface ChangeSource {
  state(signal?: AbortSignal): Promise<{ run: { rev: number }; event: number }>;
  changes(
    since: number,
    after: number | undefined,
    signal: AbortSignal,
  ): AsyncIterable<{ rev: number; events: RunEvent[] }>;
}

/** How long a watcher waits before it opens a broken stream of changes again. */
const WATCH_RETRY_MS = 1000;

/**
 * `watchRun` for a run another host holds: its stream of changes says, not the row. Each line of
 * the log reaches the listener once, then a change of revision as a signal without an event. A
 * stream that breaks off is opened again from what was told. `since`: the revision the caller
 * read, so a change between that read and the watch is not missed. Call it in the run's tenant.
 */
export function watchChanges(
  runId: string,
  source: ChangeSource,
  listener: (signal: RunSignal) => void,
  since?: number,
): () => void {
  const bound = AsyncResource.bind(listener);
  const abort = new AbortController();
  const { signal } = abort;
  void (async () => {
    let rev: number | null = null;
    let told = 0;
    while (!signal.aborted) {
      try {
        if (rev === null) {
          const now = await source.state(signal);
          // A revision the caller already read: a change since then is told at once.
          rev = since ?? now.run.rev;
          told = now.event;
        }
        for await (const change of source.changes(rev, told, signal)) {
          for (const event of change.events) {
            if (event.id > told) {
              told = event.id;
              bound({ runId, event });
            }
          }
          if (change.rev !== rev) {
            rev = change.rev;
            bound({ runId, event: null });
          }
        }
      } catch (err) {
        if (!signal.aborted) {
          console.warn(`[run ${runId}] its host's changes broke off:`, err);
        }
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, WATCH_RETRY_MS);
        function done() {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        }
        signal.addEventListener("abort", done, { once: true });
      });
    }
  })();
  return () => abort.abort();
}

/**
 * The newest line of this type since `stepId` last started, if the visit has one: what a step
 * already said when a takeover or a second wake comes back to it.
 */
export async function saidInVisit(
  runId: string,
  stepId: string,
  type: RunEvent["type"],
): Promise<typeof schema.runEvent.$inferSelect | null> {
  const [last] = await db
    .select()
    .from(schema.runEvent)
    .where(
      and(
        eq(schema.runEvent.runId, runId),
        eq(schema.runEvent.stepId, stepId),
        inArray(schema.runEvent.type, [type, "step_started"]),
      ),
    )
    .orderBy(desc(schema.runEvent.id))
    .limit(1);
  return last?.type === type ? last : null;
}

/** The step's last visit started and has not ended: nothing finished or failed since. */
export async function visitLeftOpen(runId: string, stepId: string): Promise<boolean> {
  const [last] = await db
    .select({ type: schema.runEvent.type })
    .from(schema.runEvent)
    .where(
      and(
        eq(schema.runEvent.runId, runId),
        eq(schema.runEvent.stepId, stepId),
        inArray(schema.runEvent.type, ["step_started", "step_done", "error"]),
      ),
    )
    .orderBy(desc(schema.runEvent.id))
    .limit(1);
  return last?.type === "step_started";
}

/** The run's lines after `afterId`, oldest first, at most `limit`: a reader that must miss none pages on. */
export async function eventsAfter(
  runId: string,
  afterId: number,
  limit = 200,
): Promise<RunEvent[]> {
  const rows = await db
    .select()
    .from(schema.runEvent)
    .where(and(eq(schema.runEvent.runId, runId), gt(schema.runEvent.id, afterId)))
    .orderBy(asc(schema.runEvent.id))
    .limit(limit);
  return rows.map(eventOf);
}

const eventOf = (r: typeof schema.runEvent.$inferSelect): RunEvent => ({
  id: r.id,
  at: r.createdAt.toISOString(),
  stepId: r.stepId,
  type: r.type,
  message: r.message,
  note: r.note ?? null,
  asset: r.assetId,
});

export async function recentEvents(runId: string, afterId = 0, limit = 40): Promise<RunEvent[]> {
  const rows = await db
    .select()
    .from(schema.runEvent)
    .where(and(eq(schema.runEvent.runId, runId), gt(schema.runEvent.id, afterId)))
    .orderBy(desc(schema.runEvent.id))
    .limit(limit);
  return rows.reverse().map(eventOf);
}
