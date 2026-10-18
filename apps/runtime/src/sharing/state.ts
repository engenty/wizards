import type { ShareIcon, ShareJobView, ShareRequest } from "@engenty/wizards-shared/sharing";
import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema } from "../db/client.js";
import { pendingAsk } from "../engine/asks.js";
import { signalChanged } from "../engine/events.js";
import { currentTenant } from "../tenants/tenant.js";
import { serverText } from "../texts.js";

/**
 * Share jobs as rows: one result on its way to one target. A change signals the run, so the
 * person's open result page shows it — the job rides along in the run's view.
 */

type JobRow = typeof schema.shareJob.$inferSelect;

/** Jobs this process is working on, by run. One at a time per run: they share its browser. */
const working = new Map<string, { jobId: string; abort: AbortController }>();

export function workingJob(runId: string) {
  return working.get(runId) ?? null;
}

export function setWorking(runId: string, job: { jobId: string; abort: AbortController } | null) {
  if (job) {
    working.set(runId, job);
  } else {
    working.delete(runId);
  }
}

async function view(row: JobRow): Promise<ShareJobView> {
  return {
    id: row.id,
    target: row.target,
    name: row.name,
    icon: row.icon,
    status: row.status,
    events: row.events,
    ask: row.status === "running" ? await pendingAsk(row.runId) : null,
    result: row.result ?? null,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
  };
}

/** A job left "running" by a server that stopped: nobody works on it any more. */
async function settled(row: JobRow): Promise<JobRow> {
  if (row.status !== "running" || working.get(row.runId)?.jobId === row.id) {
    return row;
  }
  const error = serverText(row.request.lang ?? "en", "shareInterrupted");
  await db
    .update(schema.shareJob)
    .set({ status: "failed", error, updatedAt: new Date() })
    .where(eq(schema.shareJob.id, row.id));
  return { ...row, status: "failed", error };
}

export async function createJob(input: {
  runId: string;
  target: string;
  name: string;
  icon: ShareIcon;
  request: ShareRequest;
}): Promise<ShareJobView> {
  const [row] = await db
    .insert(schema.shareJob)
    // The column's default counts whole seconds; jobs of one second must still keep their order.
    .values({
      id: nanoid(14),
      tenantId: currentTenant(),
      status: "running",
      createdAt: new Date(),
      ...input,
    })
    .returning();
  signalChanged(input.runId);
  return view(row);
}

export async function addJobEvent(runId: string, jobId: string, message: string) {
  const row = await db.query.shareJob.findFirst({ where: eq(schema.shareJob.id, jobId) });
  if (!row) {
    return;
  }
  const events = [
    ...row.events,
    { at: new Date().toISOString(), message: message.slice(0, 300) },
  ].slice(-40);
  await db
    .update(schema.shareJob)
    .set({ events, updatedAt: new Date() })
    .where(eq(schema.shareJob.id, jobId));
  signalChanged(runId);
}

export async function finishJob(
  runId: string,
  jobId: string,
  end:
    | { status: "done"; result: NonNullable<ShareJobView["result"]> }
    | { status: "failed"; error: string }
    | { status: "cancelled" },
) {
  await db
    .update(schema.shareJob)
    .set({
      status: end.status,
      result: end.status === "done" ? end.result : null,
      error: end.status === "failed" ? end.error : null,
      updatedAt: new Date(),
    })
    .where(and(eq(schema.shareJob.id, jobId), eq(schema.shareJob.status, "running")));
  signalChanged(runId);
}

export async function shareJobs(runId: string, limit = 12): Promise<ShareJobView[]> {
  const rows = await db.query.shareJob.findMany({
    where: eq(schema.shareJob.runId, runId),
    orderBy: [desc(schema.shareJob.createdAt), desc(schema.shareJob.id)],
    limit,
  });
  return Promise.all(rows.map(async (row) => view(await settled(row))));
}

/** The run's newest job: the one on its way, or the last one that arrived or failed. */
export async function latestShareJob(runId: string): Promise<ShareJobView | null> {
  return (await shareJobs(runId, 1))[0] ?? null;
}

/** How many jobs a run has started, whatever became of them. */
export async function jobCount(runId: string): Promise<number> {
  const rows = await db.query.shareJob.findMany({
    where: eq(schema.shareJob.runId, runId),
    columns: { id: true },
  });
  return rows.length;
}

/** How often a target has sent for a run. */
export async function sentCount(runId: string, target: string): Promise<number> {
  const rows = await db.query.shareJob.findMany({
    where: and(
      eq(schema.shareJob.runId, runId),
      eq(schema.shareJob.target, target),
      eq(schema.shareJob.status, "done"),
    ),
    columns: { id: true },
  });
  return rows.length;
}
