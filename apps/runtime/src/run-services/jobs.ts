import { noteText, type Said, type StepOutput } from "@engenty/wizards-shared/run";
import { type Pending, ServiceError, type ServiceStep } from "@engenty/wizards-shared/run-services";
import type { FlowFailure } from "@engenty/wizards-shared/transition";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema, withTenant } from "../db/client.js";
import { classifyFailure } from "../engine/failures.js";
import { flowFailure, withDeadline } from "../engine/host.js";
import { runStore } from "../engine/run-store.js";
import { failSaid, failureContext, kick } from "../engine/runner.js";
import { env } from "../env.js";
import { noteFreeTierRefusal } from "../models.js";
import { RUNNER_STALE_MS } from "../tenants/control.js";
import { currentTenant } from "../tenants/tenant.js";
import type { InProcessContext } from "./in-process.js";

/*
 * The whole steps a service works on for long while the run sleeps (docs/plans/runs-on-their-own.md,
 * "A long call answers pending"): a film, a video. Only with `runServices` on.
 *
 * A job is a row in `run_job` and the work in the process that holds it. The run keeps the job's
 * id in its state (`RunState.job`) and sleeps; asked again for the step, the service answers the
 * job's output, `pending` while it works, or throws its failure. Done or failed, the job wakes the
 * run.
 *
 * The process that works on a job keeps its `seen` fresh, as a runner keeps its claims. One silent
 * past `RUNNER_STALE_MS` is gone: a crash, a deploy. The run looks at its job by itself every
 * `JOB_LOOK_MS`, and the runner that drives it then starts the job again, from the start (a film
 * picks up its folder and its client's session, motion-graphics/step.ts).
 */

export type JobKind = "film" | "video";

/** How often a run that sleeps on a job looks at it by itself: what finds a job whose process is gone. */
export const JOB_LOOK_MS = 2 * 60_000;
/** How often the process that works on a job says so. */
const HEARTBEAT_MS = 10_000;

/** The kind of job a whole step is; null: it answers in one go. */
export function jobKindOf(step: ServiceStep): JobKind | null {
  if (step.type === "motion-graphics") {
    return "film";
  }
  return step.type === "generate" && step.asset === "video" ? "video" : null;
}

/** A job's failure as the service answers it: its class, and what the run's log says. */
export class JobFailed extends ServiceError {
  declare readonly said: Said;

  constructor(failure: FlowFailure, said: Said) {
    super(failure, typeof said === "string" ? said : noteText(said, "en"), said);
    this.name = "JobFailed";
  }
}

/** The jobs this process works on, by id. */
const working = new Map<string, { tenant: string; runId: string; abort: AbortController }>();
let beat: ReturnType<typeof setInterval> | null = null;

/**
 * The step as a job: the output of the job the run sleeps on, `pending` while it works (started
 * again here when its process is gone), its failure; or a new job. `work` does the step.
 */
export async function answerJob(
  step: ServiceStep,
  ctx: InProcessContext,
  kind: JobKind,
  work: (ctx: InProcessContext) => Promise<StepOutput>,
): Promise<StepOutput | Pending> {
  const held = ctx.state.job?.stepId === step.id ? ctx.state.job.id : null;
  const row = held
    ? await db.query.runJob.findFirst({
        where: and(eq(schema.runJob.id, held), eq(schema.runJob.runId, ctx.runId)),
      })
    : undefined;
  if (row?.status === "done" && row.output) {
    return row.output;
  }
  if (row?.status === "failed" && row.error) {
    throw new JobFailed(row.error.failure, row.error.said);
  }
  if (row) {
    if (!working.has(row.id) && (await takeOver(row.id))) {
      start(row.id, step, ctx, work);
    }
    return pending(row.id);
  }
  const id = `job_${nanoid(16)}`;
  const now = new Date();
  await db.insert(schema.runJob).values({
    id,
    runId: ctx.runId,
    stepId: step.id,
    kind,
    status: "running",
    owner: env.runner.id,
    seen: now,
    createdAt: now,
    updatedAt: now,
  });
  start(id, step, ctx, work);
  return pending(id);
}

const pending = (id: string): Pending => ({
  pending: true,
  id,
  wakeAt: Date.now() + JOB_LOOK_MS,
});

/** The job's process is gone (silent past `RUNNER_STALE_MS`): this one takes it, once. */
async function takeOver(id: string): Promise<boolean> {
  const now = new Date();
  const result = await db
    .update(schema.runJob)
    .set({ owner: env.runner.id, seen: now, updatedAt: now })
    .where(
      and(
        eq(schema.runJob.id, id),
        eq(schema.runJob.status, "running"),
        or(
          isNull(schema.runJob.seen),
          lt(schema.runJob.seen, new Date(now.getTime() - RUNNER_STALE_MS)),
        ),
      ),
    );
  return result.rowsAffected > 0;
}

/** Works on the job in this process, under the step's deadline; done or failed, the run wakes. */
function start(
  id: string,
  step: ServiceStep,
  ctx: InProcessContext,
  work: (ctx: InProcessContext) => Promise<StepOutput>,
) {
  const tenant = currentTenant();
  const abort = new AbortController();
  working.set(id, { tenant, runId: ctx.runId, abort });
  beat ??= setInterval(() => void heartbeat(), HEARTBEAT_MS);
  beat.unref();
  void withTenant(tenant, async () => {
    try {
      const output = await withDeadline(step.type, abort.signal, (signal) =>
        work({ ...ctx, signal }),
      );
      await settle(id, { status: "done", output });
    } catch (err) {
      if (abort.signal.aborted) {
        // This process stops, or the job is another's or the run's over: nothing is settled here.
        if (abort.signal.reason === "stop") {
          await db.update(schema.runJob).set({ seen: null }).where(mine(id));
        }
        return;
      }
      console.error(`[run ${ctx.runId} step ${step.id}] job ${id}:`, err);
      await noteFreeTierRefusal(err);
      const failure = flowFailure(err, classifyFailure(err, failureContext()), false);
      await settle(id, { status: "failed", error: { failure, said: await failSaid(err) } });
    } finally {
      working.delete(id);
    }
    await wakeOnJob(ctx.runId, id);
  }).catch((err) => console.error(`[run ${ctx.runId}] job ${id}:`, err));
}

const mine = (id: string) => and(eq(schema.runJob.id, id), eq(schema.runJob.owner, env.runner.id));

async function settle(
  id: string,
  end:
    | { status: "done"; output: StepOutput }
    | { status: "failed"; error: { failure: FlowFailure; said: Said } },
) {
  await db
    .update(schema.runJob)
    .set({ ...end, updatedAt: new Date() })
    .where(mine(id));
}

/**
 * The job is done or failed: the run that sleeps on it goes in line now. A run on its way to sleep
 * finds the job ended right after its write (`jobEnded`), so between the two no wake is lost.
 */
async function wakeOnJob(runId: string, id: string) {
  const run = await runStore.pick(runId, "status", "state");
  if (run?.status === "sleeping" && run.state.job?.id === id) {
    kick(runId);
  }
}

/** The run sleeps on `id` now: a job that ended meanwhile wakes it at once. */
export async function jobEnded(runId: string, id: string) {
  const row = await db.query.runJob.findFirst({
    columns: { status: true },
    where: and(eq(schema.runJob.id, id), eq(schema.runJob.runId, runId)),
  });
  if (row && row.status !== "running") {
    kick(runId);
  }
}

/** This process still works on its jobs. One another process took, or whose run is over, stops. */
async function heartbeat() {
  if (!working.size) {
    if (beat) {
      clearInterval(beat);
      beat = null;
    }
    return;
  }
  for (const [id, job] of working) {
    await withTenant(job.tenant, async () => {
      const now = new Date();
      const result = await db.update(schema.runJob).set({ seen: now }).where(mine(id));
      const run = await runStore.pick(job.runId, "status");
      if (result.rowsAffected === 0) {
        job.abort.abort("taken");
      } else if (
        !run ||
        run.status === "done" ||
        run.status === "failed" ||
        run.status === "cancelled"
      ) {
        job.abort.abort("over");
      }
    }).catch((err) => console.warn(`[job ${id}] heartbeat:`, (err as Error).message));
  }
}

/** The process stops: its jobs stay for whichever runner the run asks next. */
export function stopJobs() {
  for (const job of working.values()) {
    job.abort.abort("stop");
  }
}
