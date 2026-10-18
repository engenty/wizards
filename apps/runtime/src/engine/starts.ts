import {
  fillOf,
  START_FAILURES_TO_PAUSE,
  type StartEvent,
  type StartKind,
  scheduleDue,
  type WizardStart,
} from "@engenty/wizards-shared/starts";
import { eq, ne, sql } from "drizzle-orm";
import { canSpend } from "../credits/credits.js";
import { db, knownTenants, schema, withTenant } from "../db/client.js";
import { env } from "../env.js";
import { currentFeatures } from "../features.js";
import { ModelUnavailableError } from "../model-errors.js";
import { publishedVersion, type WizardRow } from "../services/wizards.js";
import { addNotice, noticeOwner } from "./notices.js";
import { createRun, NoCreditsError } from "./runner.js";
import type { RunRow } from "./types.js";

/**
 * Starts: what begins a run without a person. Schedules are looked at once a minute; a row, a
 * call or another wizard's end calls `startFrom` as it happens. Plan: `docs/plans/starts.md`.
 */

/** The start a run came from, as the wizard holds it now; null once it was removed. */
export async function startOf(run: Pick<RunRow, "wizardId" | "startedBy">) {
  if (!run.startedBy) {
    return null;
  }
  const w = await db.query.wizard.findFirst({
    where: eq(schema.wizard.id, run.wizardId),
    columns: { starts: true },
  });
  return w?.starts.find((s) => s.id === run.startedBy?.startId) ?? null;
}

/** Changes one start of a wizard in place; nothing when it is gone. */
async function patchStart(
  wizardId: string,
  startId: string,
  patch: (start: WizardStart) => WizardStart,
) {
  const w = await db.query.wizard.findFirst({
    where: eq(schema.wizard.id, wizardId),
    columns: { starts: true },
  });
  if (!w?.starts.some((s) => s.id === startId)) {
    return null;
  }
  const starts = w.starts.map((s) => (s.id === startId ? patch(s) : s));
  await db.update(schema.wizard).set({ starts }).where(eq(schema.wizard.id, wizardId));
  return starts.find((s) => s.id === startId) ?? null;
}

export class StartRefused extends Error {}

/**
 * Begins a run from a start: the published wizard, the start's answers resolved against the
 * event, the owner's run. A start that cannot run (not published, no credits, no model) counts
 * as a failure like a run that failed.
 */
export async function startFrom(
  w: WizardRow,
  start: WizardStart,
  event: StartEvent,
  ref?: string,
): Promise<string> {
  try {
    const version = await publishedVersion(w);
    if (!version || !w.shareEnabled) {
      throw new StartRefused("not published");
    }
    if (!(await canSpend())) {
      throw new NoCreditsError();
    }
    const runId = await createRun({
      wizardId: w.id,
      definition: version.definition,
      files: version.files,
      version: w.publishedVersion,
      mode: "live",
      userId: start.owner ?? null,
      startedBy: { kind: start.kind, startId: start.id, ...(ref ? { ref } : {}) },
      start: event,
      fill: fillOf(start, event),
    });
    await patchStart(w.id, start.id, (s) => ({ ...s, lastRunAt: event.at }));
    return runId;
  } catch (err) {
    const message =
      err instanceof StartRefused ||
      err instanceof NoCreditsError ||
      err instanceof ModelUnavailableError
        ? err.message
        : String(err);
    await countFailure(w.id, start.id, message);
    throw err;
  }
}

/** A failed run or a start that could not run: three in a row pause the start. */
async function countFailure(wizardId: string, startId: string, detail: string) {
  const start = await patchStart(wizardId, startId, (s) => {
    const failures = s.failures + 1;
    return failures >= START_FAILURES_TO_PAUSE
      ? { ...s, failures, on: false, pausedReason: detail.slice(0, 300) }
      : { ...s, failures };
  });
  if (start && !start.on && start.pausedReason) {
    await addNotice({ kind: "paused", wizardId, startId, detail: start.pausedReason });
  }
}

/** Called as any run ends: a start's run is counted, and the owner told. */
export async function startedRunEnded(runId: string, status: "done" | "failed" | "cancelled") {
  try {
    const run = await db.query.run.findFirst({ where: eq(schema.run.id, runId) });
    if (!run?.startedBy) {
      return;
    }
    if (status === "done") {
      await patchStart(run.wizardId, run.startedBy.startId, (s) => ({ ...s, failures: 0 }));
      await noticeOwner(run, "done");
    } else if (status === "failed") {
      await noticeOwner(run, "failed", run.error);
      await countFailure(run.wizardId, run.startedBy.startId, run.error ?? "failed");
    }
  } catch (err) {
    console.error(`[starts] run ${runId} ended:`, err);
  }
}

// --- the clock -----------------------------------------------------------------------------

/** Starts that run right now, by tenant and id: one run at a time each. */
const running = new Set<string>();

/** Begins every schedule that is due, in every tenant; done when they all began. */
export async function runDueSchedules(now = new Date()): Promise<void> {
  for (const tenant of await knownTenants()) {
    await withTenant(tenant, async () => {
      // The switch is per tenant: a team or an install that has starts on.
      if (!(await currentFeatures()).startTriggers) {
        return;
      }
      const wizards = await db.query.wizard.findMany({
        where: ne(schema.wizard.starts, sql`'[]'`),
      });
      for (const w of wizards) {
        for (const start of w.starts) {
          if (start.kind !== "schedule" || !start.on || !start.schedule) {
            continue;
          }
          const key = `${tenant}/${start.id}`;
          const since = new Date(start.createdAt ?? w.updatedAt);
          const last = start.lastRunAt ? new Date(start.lastRunAt) : null;
          if (running.has(key) || !scheduleDue(start.schedule, last, since, now)) {
            continue;
          }
          running.add(key);
          try {
            await startFrom(w, start, { kind: "schedule", at: now.toISOString() });
          } catch (err) {
            console.error(`[starts] ${w.id}/${start.id}:`, err);
          } finally {
            running.delete(key);
          }
        }
      }
    }).catch((err) => console.error(`[starts ${tenant}]`, err));
  }
}

const TICK_MS = 60_000;
let timer: NodeJS.Timeout | null = null;

/** Looks for due schedules soon after the start and then once a minute, while the runtime runs. */
export function startStarts() {
  if (timer || env.role === "web") {
    return;
  }
  const tick = () => void runDueSchedules().catch((err) => console.error("[starts]", err));
  setTimeout(tick, 5_000).unref();
  timer = setInterval(tick, TICK_MS);
  timer.unref();
}

/** The kinds a runtime can begin on its own today. */
export const LIVE_START_KINDS: StartKind[] = ["schedule"];
