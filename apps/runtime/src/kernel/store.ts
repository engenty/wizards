import type { AskRow, Row, Run, Score, Store } from "@engenty/wizards-kernel";
import type { RunStatus } from "@engenty/wizards-shared/run";
import { and, asc, eq, gte } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import type { RunRow } from "../engine/types.js";
import { setWake } from "../tenants/control.js";

/**
 * A run of version 2 in the tenant's database (docs/plans/kernel.md): the cursor, the wake time
 * and the fence are the run's own columns, what else the kernel keeps is `state.kernel`, and the
 * rows and scores have their tables.
 */
export type WriteRun = (
  runId: string,
  patch: Partial<typeof schema.run.$inferInsert>,
  seen?: { rev: number },
) => Promise<unknown>;

const isAsk = (row: Row): row is AskRow => !("left" in row);
const kindOf = (row: Row) =>
  "left" in row ? "left" : row.approves != null ? "approval" : row.parent != null ? "note" : "ask";

/** The status the run's row shows for what the kernel says of it. */
export function statusOf(run: Run): RunStatus {
  if (run.status === "done" || run.status === "failed" || run.status === "running") {
    return run.status;
  }
  if (run.status === "stopped") {
    return "cancelled";
  }
  const waiting = run.rows.filter(isAsk).filter((row) => row.state === "waiting");
  // A wait is for a signal or a time; everything else waits for somebody.
  if (waiting.length && waiting.every((row) => row.type === "wait")) {
    return waiting.some((row) => row.signal) ? "waiting_signal" : "sleeping";
  }
  return "waiting_input";
}

/** What was read of a run, to write only what changed. */
const seen = new WeakMap<
  Run,
  { rows: string[]; scores: number; status: RunStatus; inDrive: boolean; wakeAt?: number }
>();

export async function loadKernelRun(row: RunRow, inDrive = false): Promise<Run | undefined> {
  const kept = row.state.kernel;
  if (!kept) {
    return undefined;
  }
  const rows = await db
    .select()
    .from(schema.runRow)
    .where(eq(schema.runRow.runId, row.id))
    .orderBy(asc(schema.runRow.n));
  const scores = await db.select().from(schema.runScore).where(eq(schema.runScore.runId, row.id));
  const run: Run = {
    id: row.id,
    wizard: row.id,
    input: kept.input ?? {},
    startedAt: kept.startedAt,
    status: kept.status,
    cursor: kept.status === "done" ? null : row.cursor,
    open: kept.open,
    rows: rows.map((r) => r.data as unknown as Row),
    wakeAt: row.wakeAt?.getTime(),
    output: kept.output,
    error: row.error ?? undefined,
    scores: scores.map((s) => s.data as unknown as Score),
    grant: kept.grant as Run["grant"],
    rev: row.rev,
  };
  seen.set(run, {
    rows: run.rows.map((r) => JSON.stringify(r)),
    scores: scores.length,
    status: row.status,
    inDrive,
  });
  return run;
}

/**
 * `write` is the engine's own write of a run's row: it counts `rev` up, holds a drive to its
 * claim, and tells whoever must hear of a new status. A person's write is refused when the run
 * moved on meanwhile.
 */
export function kernelStore(
  load: (runId: string) => Promise<RunRow | undefined>,
  write: WriteRun,
  inDrive = false,
): Store {
  return {
    async load(runId) {
      const row = await load(runId);
      return row ? loadKernelRun(row, inDrive) : undefined;
    },
    async save(run) {
      const before = seen.get(run) ?? {
        rows: [],
        scores: 0,
        status: "running" as RunStatus,
        inDrive,
      };
      const now = new Date();
      const rows = run.rows.map((r) => JSON.stringify(r));
      const changed = rows.flatMap((data, n) => (before.rows[n] === data ? [] : [n]));
      if (before.rows.length > rows.length) {
        await db
          .delete(schema.runRow)
          .where(and(eq(schema.runRow.runId, run.id), gte(schema.runRow.n, rows.length)));
        await db.delete(schema.runScore).where(eq(schema.runScore.runId, run.id));
        before.scores = 0;
      }
      for (const n of changed) {
        const row = run.rows[n];
        const values = {
          runId: run.id,
          n,
          step: row.step,
          kind: kindOf(row) as "ask" | "left" | "approval" | "note",
          state: isAsk(row) ? row.state : null,
          data: row as unknown as Record<string, unknown>,
          at: now,
        };
        await db
          .insert(schema.runRow)
          .values(values)
          .onConflictDoUpdate({
            target: [schema.runRow.runId, schema.runRow.n],
            set: { step: values.step, kind: values.kind, state: values.state, data: values.data },
          });
      }
      for (const score of (run.scores ?? []).slice(before.scores)) {
        await db
          .insert(schema.runScore)
          .values({
            runId: run.id,
            eval: score.eval,
            row: score.row,
            score: score.score ?? null,
            data: score as unknown as Record<string, unknown>,
            at: now,
          })
          .onConflictDoNothing();
      }
      const status = statusOf(run);
      const row = await load(run.id);
      if (!row) {
        throw new Error(`There is no run "${run.id}".`);
      }
      await write(
        run.id,
        {
          cursor: run.cursor ?? row.cursor,
          wakeAt: run.wakeAt ? new Date(run.wakeAt) : null,
          error: run.error ?? null,
          state: {
            ...row.state,
            kernel: {
              input: run.input,
              startedAt: run.startedAt,
              open: run.open,
              status: run.status,
              grant: run.grant,
              output: run.output,
            },
          },
          // Only a status that is new: each one is told to those who wait for it.
          ...(status === before.status ? {} : { status }),
        },
        before.inDrive ? undefined : { rev: run.rev },
      );
      // The clock reads its own copy of the time a run goes on.
      if (status !== before.status || run.wakeAt !== before.wakeAt) {
        await setWake(run.id, run.wakeAt ? new Date(run.wakeAt) : null);
      }
      run.rev += 1;
      seen.set(run, {
        rows,
        scores: run.scores?.length ?? 0,
        status,
        inDrive: before.inDrive,
        wakeAt: run.wakeAt,
      });
    },
  };
}
