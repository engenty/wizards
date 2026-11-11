import type {
  AskAnswer,
  RunAsk,
  RunHostRef,
  RunState,
  RunStatus,
} from "@engenty/wizards-shared/run";
import { and, eq, inArray, isNull, lt, min, ne, notInArray, or, type SQL, sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";

export type RunRow = typeof schema.run.$inferSelect;
export type RunValues = typeof schema.run.$inferInsert;
export type RunPatch = Partial<RunValues>;
export type DeviceOfferRow = RunRow["deviceOffer"];

/**
 * What a write holds on besides the run's id. `claim`: the drive's claim, inside its drive. `rev`:
 * the revision a person's write read. `status`: the status a wait's write came from. `below`: a
 * revision the run's must be lower than, for a host's copy of a run that works elsewhere.
 */
export interface RunGuard {
  claim?: number;
  rev?: number;
  status?: RunStatus;
  below?: number;
}

/** Statements that go into one batch with a write, built on the write's condition. */
type Alongside = (where: SQL) => unknown[];

/** The statuses a run stays in once it is over; any other is still going, a wait included. */
const ENDED = ["done", "failed", "cancelled"] as const;

/**
 * The one way to the run's row (`schema.run`) for a run under way: every read and write of it goes
 * through here, each with the guard it holds on.
 */
export const runStore = {
  /** The condition a write on the run holds on. */
  where(runId: string, guard: RunGuard = {}): SQL {
    return and(
      eq(schema.run.id, runId),
      guard.claim === undefined ? undefined : eq(schema.run.claim, guard.claim),
      guard.rev === undefined ? undefined : eq(schema.run.rev, guard.rev),
      guard.status === undefined ? undefined : eq(schema.run.status, guard.status),
      guard.below === undefined ? undefined : lt(schema.run.rev, guard.below),
    ) as SQL;
  },

  /** True while a row matches `where`: what a notice written with a write holds on. */
  exists(where: SQL): SQL {
    return sql`EXISTS (SELECT 1 FROM ${schema.run} WHERE ${where})`;
  },

  async get(runId: string): Promise<RunRow | undefined> {
    return db.query.run.findFirst({ where: eq(schema.run.id, runId) });
  },

  /** Some columns of the run. */
  async pick<K extends keyof RunRow>(
    runId: string,
    ...keys: K[]
  ): Promise<Pick<RunRow, K> | undefined> {
    const columns = Object.fromEntries(keys.map((k) => [k, true])) as { [k in K]: true };
    return (await db.query.run.findFirst({ where: eq(schema.run.id, runId), columns })) as
      | Pick<RunRow, K>
      | undefined;
  },

  /**
   * Where the run lives: null for this runtime, else the host's kind and address. Undefined when
   * there is no such run.
   */
  async hostOf(runId: string): Promise<RunHostRef | null | undefined> {
    return (await runStore.pick(runId, "host"))?.host;
  },

  /** Places the run on a host; null brings it back to this runtime. */
  async setHost(runId: string, host: RunHostRef | null) {
    await db.update(schema.run).set({ host }).where(eq(schema.run.id, runId));
  },

  /** Where the runs a person's notices wait on stand. */
  async waitsOf(runIds: string[]) {
    return db.query.run.findMany({
      where: inArray(schema.run.id, runIds),
      columns: { id: true, status: true, cursor: true, ask: true },
    });
  },

  /** When the run last changed, and its newest event and device call. */
  async lastChange(runId: string) {
    const [row] = await db
      .select({
        updatedAt: schema.run.updatedAt,
        event: sql<
          number | null
        >`(select max(${schema.runEvent.id}) from ${schema.runEvent} where ${schema.runEvent.runId} = ${runId})`,
        call: sql<
          number | null
        >`(select max(${schema.deviceCall.id}) from ${schema.deviceCall} where ${schema.deviceCall.runId} = ${runId})`,
        // A share job the broker works on changes its own row, not the run's.
        job: sql<
          number | null
        >`(select max(${schema.shareJob.updatedAt}) from ${schema.shareJob} where ${schema.shareJob.runId} = ${runId})`,
      })
      .from(schema.run)
      .where(eq(schema.run.id, runId));
    return row;
  },

  /** When the oldest run of the space that is still going began. */
  async oldestOpen(spaceId: string): Promise<Date | null> {
    const [oldest] = await db
      .select({ at: min(schema.run.createdAt) })
      .from(schema.run)
      .innerJoin(schema.wizard, eq(schema.run.wizardId, schema.wizard.id))
      .where(and(eq(schema.wizard.spaceId, spaceId), notInArray(schema.run.status, [...ENDED])));
    return oldest?.at ?? null;
  },

  /** A run of the start, another time's or one begun by hand, is still going. */
  async startStillGoing(wizardId: string, startId: string, occurrence: string): Promise<boolean> {
    const row = await db.query.run.findFirst({
      columns: { id: true },
      where: and(
        eq(schema.run.wizardId, wizardId),
        sql`json_extract(${schema.run.startedBy}, '$.startId') = ${startId}`,
        notInArray(schema.run.status, [...ENDED]),
        // This time's own run is not an overlap: the same look by another runner, or before a crash.
        or(isNull(schema.run.occurrence), ne(schema.run.occurrence, occurrence)),
      ),
    });
    return Boolean(row);
  },

  /**
   * Writes a new run; nothing when its wizard has a run of that occurrence already. `alongside`
   * goes in after it, in one batch. The rows the insert wrote.
   */
  async create(values: RunValues, alongside?: Alongside): Promise<number> {
    const insert = db
      .insert(schema.run)
      .values(values)
      .onConflictDoNothing({ target: [schema.run.wizardId, schema.run.occurrence] });
    const statements = alongside?.(eq(schema.run.id, values.id)) ?? [];
    const inserted = statements.length
      ? ((await db.batch([insert, ...statements] as never)) as { rowsAffected: number }[])[0]
      : await insert;
    return inserted?.rowsAffected ?? 0;
  },

  /** Puts a claim on the run's own row; an older claim that arrives late changes nothing. */
  async claim(runId: string, generation: number) {
    await db
      .update(schema.run)
      .set({ claim: generation })
      .where(and(eq(schema.run.id, runId), lt(schema.run.claim, generation)));
  },

  /**
   * Moves the run: the patch, a new `rev` and `updatedAt`, held on `guard`. The new `rev` is the
   * next one, or the patch's: a host's copy carries the host's revision. `alongside` goes in
   * before it, in one batch, on the same condition. The rows the write changed.
   */
  async move(
    runId: string,
    patch: RunPatch,
    guard: RunGuard = {},
    alongside?: Alongside,
  ): Promise<number> {
    const where = runStore.where(runId, guard);
    const write = db
      .update(schema.run)
      .set({
        ...patch,
        // A run that rests has no drive to break off, whatever becomes of this process now.
        ...(patch.status && patch.status !== "running" ? { driving: false } : {}),
        rev: patch.rev ?? sql`${schema.run.rev} + 1`,
        updatedAt: new Date(),
      })
      .where(where);
    const statements = alongside?.(where) ?? [];
    const result = statements.length
      ? ((await db.batch([...statements, write] as never)) as { rowsAffected: number }[]).at(-1)
      : await write;
    return result?.rowsAffected ?? 0;
  },

  /** Marks the run as being driven; inside its drive, held on the drive's claim. */
  async markDriving(runId: string, claim?: number) {
    await db.update(schema.run).set({ driving: true }).where(runStore.where(runId, { claim }));
  },

  /** Keeps a person's request's change to the state, if the run is still at `rev`. */
  async writeState(runId: string, rev: number, state: RunState): Promise<boolean> {
    const result = await db
      .update(schema.run)
      .set({ state, rev: sql`${schema.run.rev} + 1` })
      .where(and(eq(schema.run.id, runId), eq(schema.run.rev, rev)));
    return result.rowsAffected > 0;
  },

  /** One page's entry of what is typed and not sent yet, written in place. */
  async keepUnsent(runId: string, stepId: string, values: Record<string, unknown>) {
    await db
      .update(schema.run)
      .set({
        unsent: sql`json_set(coalesce(${schema.run.unsent}, '{}'), ${`$.${stepId}`}, json(${JSON.stringify(values)}))`,
      })
      .where(eq(schema.run.id, runId));
  },

  /** The question the run waits on, its answer cleared. `alongside` goes in before it. */
  async setAsk(runId: string, ask: RunAsk | null, alongside?: Alongside) {
    const where = eq(schema.run.id, runId);
    const write = db
      .update(schema.run)
      .set({ ask, answer: null, updatedAt: new Date() })
      .where(where);
    const statements = alongside?.(where) ?? [];
    if (statements.length) {
      await db.batch([...statements, write] as never);
    } else {
      await write;
    }
  },

  /** Leaves the answer for the waiting step; false when that question is no longer open. */
  async answerAsk(runId: string, askId: string, answer: AskAnswer): Promise<boolean> {
    const result = await db
      .update(schema.run)
      .set({ answer: { askId, answer } })
      .where(
        sql`${schema.run.id} = ${runId} AND json_extract(${schema.run.ask}, '$.id') = ${askId}`,
      );
    return result.rowsAffected > 0;
  },

  /** Clears a question and its answer. */
  async clearAsk(runId: string) {
    await db.update(schema.run).set({ ask: null, answer: null }).where(eq(schema.run.id, runId));
  },

  /** What the device the run is watched from offers. */
  async offerDevice(runId: string, deviceOffer: DeviceOfferRow) {
    await db.update(schema.run).set({ deviceOffer }).where(eq(schema.run.id, runId));
  },

  /** The run's cost, as the ledger booked it. */
  async setCost(runId: string, micros: number) {
    await db.update(schema.run).set({ costMicros: micros }).where(sql`${schema.run.id} = ${runId}`);
  },

  /** Adds to the run's cost. */
  async addCost(runId: string, micros: number) {
    await db
      .update(schema.run)
      .set({ costMicros: sql`${schema.run.costMicros} + ${micros}` })
      .where(sql`${schema.run.id} = ${runId}`);
  },
};

export type RunStore = typeof runStore;
