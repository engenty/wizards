import { and, eq, gte } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema } from "../db/client.js";
import { wakeRun } from "../tenants/control.js";
import type { RunRow } from "./types.js";

/** "90m", "6h", "2d" in milliseconds. */
export function durationMs(text: string): number {
  const n = Number.parseInt(text, 10);
  const unit = text.at(-1);
  return n * (unit === "d" ? 86_400_000 : unit === "h" ? 3_600_000 : 60_000);
}

export async function registerWait(
  runId: string,
  stepId: string,
  spaceId: string,
  name: string,
  key: string,
) {
  const values = { runId, stepId, spaceId, name, key, since: new Date() };
  await db
    .insert(schema.runWait)
    .values(values)
    .onConflictDoUpdate({ target: schema.runWait.runId, set: values });
}

export async function dropWait(runId: string) {
  await db.delete(schema.runWait).where(eq(schema.runWait.runId, runId));
}

/**
 * Something arrived: written first, then every run that waits for it is put in line. Answers
 * before any step runs; the run itself takes the signal when a runner has it.
 */
export async function sendSignal(input: {
  spaceId: string;
  name: string;
  key: string;
  data?: Record<string, unknown>;
  source: string;
}): Promise<{ id: string; runs: number }> {
  const id = `sig_${nanoid(16)}`;
  await db.insert(schema.runSignal).values({ id, ...input, data: input.data ?? null, at: new Date() });
  const waiting = await db.query.runWait.findMany({
    where: and(
      eq(schema.runWait.spaceId, input.spaceId),
      eq(schema.runWait.name, input.name),
      eq(schema.runWait.key, input.key),
    ),
  });
  await Promise.all(waiting.map((w) => wakeRun(w.runId)));
  return { id, runs: waiting.length };
}

/** The oldest signal for this run's wait that it has not taken, since the run began. */
export async function takeSignal(run: RunRow, name: string) {
  const wait = await db.query.runWait.findFirst({ where: eq(schema.runWait.runId, run.id) });
  if (!wait) {
    return null;
  }
  const found = await db.query.runSignal.findMany({
    where: and(
      eq(schema.runSignal.spaceId, wait.spaceId),
      eq(schema.runSignal.name, name),
      eq(schema.runSignal.key, wait.key),
      gte(schema.runSignal.at, run.createdAt),
    ),
    orderBy: (s, { asc }) => asc(s.at),
  });
  return found.find((s) => !run.state.signals?.includes(s.id)) ?? null;
}
