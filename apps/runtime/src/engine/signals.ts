import { RUN_DONE_SIGNAL, signalMissing, type WaitStep } from "@engenty/wizards-shared/definition";
import { and, asc, eq, gte, inArray, lt, notInArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema } from "../db/client.js";
import { signalWaiting } from "./run-host-client.js";
import type { RunRow } from "./types.js";

/**
 * Signals (the durable runs plan): something arrived, a row is written, then the runs that wait
 * for it are put in line. Nothing here runs a step, so a sender has its answer at once, and one
 * that comes before the wait is still there when the run gets to it.
 */

const KEPT_MS = 30 * 86_400_000;

/** The most of a signal's data that is kept: what a run hands on goes into prompts and pages. */
export const SIGNAL_DATA_BYTES = 64 * 1024;

/** Who a signal may wake: its token's wizard, or that one run; `space` when sent from inside. */
export const wizardScope = (wizardId: string) => `wizard:${wizardId}`;
export const runScope = (runId: string) => `run:${runId}`;
export const SPACE_SCOPE = "space";

/** How keys compare: a person typed one of them, a service wrote the other. */
export const signalKey = (key: string) => key.trim().toLowerCase();

export interface SentSignal {
  id: string;
  /** How many runs it woke. A delivery sent again says what it said first. */
  runs: number;
}

/** Puts the runs that wait for this signal in line, or tells their host; keeps how many that were. */
async function wakeWaiting(signal: typeof schema.runSignal.$inferSelect): Promise<SentSignal> {
  const waiting = await db.query.runWait.findMany({
    where: and(
      eq(schema.runWait.spaceId, signal.spaceId),
      eq(schema.runWait.name, signal.name),
      eq(schema.runWait.key, signal.key),
      signal.scope === SPACE_SCOPE
        ? undefined
        : signal.scope.startsWith("run:")
          ? eq(schema.runWait.runId, signal.scope.slice("run:".length))
          : eq(schema.runWait.wizardId, signal.scope.slice("wizard:".length)),
    ),
  });
  const fitting = waiting.filter((w) => !signalMissing(signal.data, w.fields).length);
  await Promise.all(fitting.map((w) => signalWaiting(w.runId, signal)));
  await db
    .update(schema.runSignal)
    .set({ runs: fitting.length })
    .where(eq(schema.runSignal.id, signal.id));
  return { id: signal.id, runs: fitting.length };
}

/**
 * The one way a signal comes in: written first, then matched. The same delivery again is the same
 * signal: it wakes nothing and answers what it answered first. One whose first try stopped before
 * it answered goes on from there, which a run's taking each signal once makes harmless.
 */
export async function sendSignal(input: {
  spaceId: string;
  scope: string;
  name: string;
  key: string;
  data?: Record<string, unknown> | null;
  source: string;
  /** The sender's id for this delivery; without one every call is a signal of its own. */
  delivery?: string | null;
  /** When it happened, where that is not now: a run only hears what came since it began. */
  at?: Date;
}): Promise<SentSignal> {
  const row = {
    id: `sig_${nanoid(16)}`,
    spaceId: input.spaceId,
    scope: input.scope,
    name: input.name,
    key: signalKey(input.key),
    delivery: input.delivery || nanoid(16),
    data: input.data ?? null,
    source: input.source,
    runs: null,
    at: input.at ?? new Date(),
  };
  const made = await db.insert(schema.runSignal).values(row).onConflictDoNothing().returning();
  if (made[0]) {
    return wakeWaiting(made[0]);
  }
  const first = await db.query.runSignal.findFirst({
    where: and(
      eq(schema.runSignal.spaceId, row.spaceId),
      eq(schema.runSignal.scope, row.scope),
      eq(schema.runSignal.name, row.name),
      eq(schema.runSignal.key, row.key),
      eq(schema.runSignal.delivery, row.delivery),
    ),
  });
  if (!first) {
    throw new Error("A signal's delivery is taken, and no row holds it.");
  }
  return first.runs === null ? wakeWaiting(first) : { id: first.id, runs: first.runs };
}

/** Written before the run looks: a signal that comes now sees the wait and wakes the run. */
export async function registerWait(run: RunRow, spaceId: string, step: WaitStep, key: string) {
  const values = {
    runId: run.id,
    wizardId: run.wizardId,
    spaceId,
    name: step.signal?.name ?? "",
    key: signalKey(key),
    fields: step.signal?.fields ?? null,
    since: new Date(),
  };
  await db
    .insert(schema.runWait)
    .values(values)
    .onConflictDoUpdate({ target: schema.runWait.runId, set: values });
}

export async function dropWait(runId: string) {
  await db.delete(schema.runWait).where(eq(schema.runWait.runId, runId));
}

/**
 * The oldest signal for this wait that the run has not taken, since the run began: from inside
 * the space, for its wizard or for it alone. Signals whose data does not fit its fields stay out.
 */
export async function findSignal(run: RunRow, spaceId: string, step: WaitStep, key: string) {
  const wait = step.signal;
  if (!wait) {
    return null;
  }
  const taken = run.state.signals ?? [];
  const found = await db.query.runSignal.findMany({
    where: and(
      eq(schema.runSignal.spaceId, spaceId),
      eq(schema.runSignal.name, wait.name),
      eq(schema.runSignal.key, signalKey(key)),
      // A key from before the run is someone else's business; a run's end is a fact about that run.
      wait.name === RUN_DONE_SIGNAL ? undefined : gte(schema.runSignal.at, run.createdAt),
      inArray(schema.runSignal.scope, [SPACE_SCOPE, wizardScope(run.wizardId), runScope(run.id)]),
      taken.length ? notInArray(schema.runSignal.id, taken) : undefined,
    ),
    orderBy: asc(schema.runSignal.at),
    limit: 50,
  });
  // A mail's text may still be in the mailbox: the run reads it there when it takes the signal.
  return (
    found.find(
      (s) =>
        !signalMissing(
          s.data,
          s.source.startsWith("mail:") ? wait.fields?.filter((f) => f !== "text") : wait.fields,
        ).length,
    ) ?? null
  );
}

/** Signals past their 30 days. Runs hourly, with the expired runs. */
export async function purgeOldSignals(now = Date.now()) {
  await db.delete(schema.runSignal).where(lt(schema.runSignal.at, new Date(now - KEPT_MS)));
}
