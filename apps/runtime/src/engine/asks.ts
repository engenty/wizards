import type { AskAnswer, AskInput, RunAsk } from "@engenty-wizards/shared/run";
import { eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema } from "../db/client.js";
import { signalChanged } from "./events.js";
import { pushRun } from "./push.js";

/** How long a step waits for the person before it goes on without them. */
const ASK_TIMEOUT_MS = 15 * 60_000;
/** How often the waiting step looks for the answer in the row. */
const ASK_POLL_MS = 1000;

export type AskResult = AskAnswer | { type: "timeout" };

async function setAsk(runId: string, ask: RunAsk | null) {
  await db
    .update(schema.run)
    .set({ ask, answer: null, updatedAt: new Date() })
    .where(eq(schema.run.id, runId));
  signalChanged(runId);
}

/**
 * Puts a question to the person and waits. The run stays "running": the step is in the middle
 * of its work and goes on with the answer. One question per run at a time. The question and the
 * answer go through the run's row: the web that takes the answer need not be the process that
 * asked.
 */
export async function askPerson(
  runId: string,
  ask: AskInput & { stepId: string },
  signal: AbortSignal,
): Promise<AskResult> {
  const open = await db.query.run.findFirst({
    where: eq(schema.run.id, runId),
    columns: { ask: true },
  });
  if (open?.ask) {
    throw new Error("The wizard is already waiting for the person.");
  }
  const full = { ...ask, id: nanoid(10), at: new Date().toISOString() } as RunAsk;
  await setAsk(runId, full);
  void pushRun(runId, "asks");
  const until = Date.now() + ASK_TIMEOUT_MS;
  try {
    while (!signal.aborted) {
      if (Date.now() >= until) {
        return { type: "timeout" };
      }
      const row = await db.query.run.findFirst({
        where: eq(schema.run.id, runId),
        columns: { answer: true },
      });
      if (row?.answer?.askId === full.id) {
        return row.answer.answer;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, ASK_POLL_MS);
        function done() {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        }
        signal.addEventListener("abort", done, { once: true });
      });
    }
    return { type: "skip" };
  } finally {
    await setAsk(runId, null).catch(() => undefined);
  }
}

/** The question a run is waiting on, if any. */
export async function pendingAsk(runId: string): Promise<RunAsk | null> {
  const row = await db.query.run.findFirst({
    where: eq(schema.run.id, runId),
    columns: { ask: true },
  });
  return row?.ask ?? null;
}

/** Leaves the answer for the waiting step; false when that question is no longer open. */
export async function answerAsk(runId: string, askId: string, answer: AskAnswer): Promise<boolean> {
  const result = await db
    .update(schema.run)
    .set({ answer: { askId, answer } })
    .where(sql`${schema.run.id} = ${runId} AND json_extract(${schema.run.ask}, '$.id') = ${askId}`);
  return result.rowsAffected > 0;
}

/** A run a runner takes starts its step afresh: a question left in the row has no one waiting. */
export async function clearStaleAsk(runId: string) {
  await db.update(schema.run).set({ ask: null, answer: null }).where(eq(schema.run.id, runId));
}
