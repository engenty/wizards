import { textLang, wizardLang } from "@engenty/wizards-shared/definition";
import { saidText } from "@engenty/wizards-shared/run";
import {
  dueOccurrence,
  fillOf,
  occurrenceKey,
  START_FAILURES_TO_PAUSE,
  type StartEvent,
  type StartKind,
  type WizardStart,
} from "@engenty/wizards-shared/starts";
import { and, eq, ne, sql } from "drizzle-orm";
import { control, controlDb, db, schema, withTenant } from "../db/client.js";
import { env } from "../env.js";
import { currentFeatures } from "../features.js";
import { wizardUnavailable } from "../limits.js";
import { noteOf } from "../model-errors.js";
import { publishedVersion, type WizardRow } from "../services/wizards.js";
import { addNotice } from "./notices.js";
import { runStore } from "./run-store.js";
import { createRun, OccurrenceTaken } from "./runner.js";
import type { RunRow } from "./types.js";

/**
 * Starts: what begins a run without a person. Schedules are looked at once a minute by every
 * runner; a row, a call or another wizard's end will call `startFrom` as it happens. A time of a
 * schedule starts one run: its key on the run is unique, so the database refuses a second one,
 * from another runner or after a crash. Plan: `docs/plans/starts.md`.
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

/**
 * Changes the starts of a wizard, or nothing when it is gone. The write only lands on the list
 * it read: the clock of two runners and a person in the share dialog don't undo each other.
 */
export async function changeStarts(
  wizardId: string,
  change: (starts: WizardStart[]) => WizardStart[],
  also: { updatedAt?: Date } = {},
): Promise<WizardStart[] | null> {
  for (let tries = 0; tries < 8; tries++) {
    const [row] = await db
      .select({ raw: sql<string>`${schema.wizard.starts}` })
      .from(schema.wizard)
      .where(eq(schema.wizard.id, wizardId));
    if (!row) {
      return null;
    }
    const starts = change(JSON.parse(row.raw) as WizardStart[]);
    const written = await db
      .update(schema.wizard)
      .set({ starts, ...also })
      .where(and(eq(schema.wizard.id, wizardId), sql`${schema.wizard.starts} = ${row.raw}`));
    if (written.rowsAffected > 0) {
      return starts;
    }
  }
  throw new Error(`The starts of wizard ${wizardId} keep changing.`);
}

/** Changes one start of a wizard in place; nothing when it is gone. */
async function patchStart(
  wizardId: string,
  startId: string,
  patch: (start: WizardStart) => WizardStart,
) {
  const starts = await changeStarts(wizardId, (all) =>
    all.map((s) => (s.id === startId ? patch(s) : s)),
  );
  return starts?.find((s) => s.id === startId) ?? null;
}

/** The later of two times, as the clock moves: never back. */
function later(a: string | undefined, b: string) {
  return a && a > b ? a : b;
}

export class StartRefused extends Error {}

/**
 * Begins a run from a start: the published wizard, the start's answers resolved against the
 * event, the owner's run. A start that cannot run (not published, the wizard's limits, no credits,
 * no model) counts as a failure like a run that failed. With an `occurrence`, the run is that time
 * of a schedule, and `OccurrenceTaken` says it began already.
 */
export async function startFrom(
  w: WizardRow,
  start: WizardStart,
  event: StartEvent,
  options: { ref?: string; occurrence?: string } = {},
): Promise<string> {
  const handled = (s: WizardStart) =>
    options.occurrence ? { ...s, handledUntil: later(s.handledUntil, event.at) } : s;
  try {
    const refused = await wizardUnavailable(w);
    if (refused) {
      throw new StartRefused(saidText(refused, textLang(wizardLang(w.draft))));
    }
    const version = await publishedVersion(w);
    if (!version) {
      throw new StartRefused(
        saidText({ code: "wizardUnavailable" }, textLang(wizardLang(w.draft))),
      );
    }
    const runId = await createRun({
      wizardId: w.id,
      definition: version.definition,
      files: version.files,
      version: w.publishedVersion,
      mode: "live",
      userId: start.owner ?? null,
      startedBy: {
        kind: start.kind,
        startId: start.id,
        ...(options.ref ? { ref: options.ref } : {}),
      },
      start: event,
      fill: fillOf(start, event),
      occurrence: options.occurrence,
    });
    // A crash before this write: the next look finds the run by its key and does this.
    await patchStart(w.id, start.id, (s) => {
      const { lastSkip: _, ...rest } = handled(s);
      return { ...rest, lastRunAt: event.at };
    });
    return runId;
  } catch (err) {
    if (err instanceof OccurrenceTaken) {
      throw err;
    }
    const said = noteOf(err);
    const lang = textLang(wizardLang(w.draft));
    const message = said ? saidText(said, lang) : err instanceof Error ? err.message : String(err);
    await countFailure(w.id, start.id, message, handled);
    throw err;
  }
}

/** A failed run or a start that could not run: three in a row pause the start. */
async function countFailure(
  wizardId: string,
  startId: string,
  detail: string,
  also: (s: WizardStart) => WizardStart = (s) => s,
) {
  const start = await patchStart(wizardId, startId, (s) => {
    const failures = s.failures + 1;
    return also(
      failures >= START_FAILURES_TO_PAUSE
        ? { ...s, failures, on: false, pausedReason: detail.slice(0, 300) }
        : { ...s, failures },
    );
  });
  if (start && !start.on && start.pausedReason) {
    await addNotice({
      kind: "paused",
      wizardId,
      startId,
      detail: start.pausedReason,
      userId: start.owner,
    });
  }
}

/** Called as any run ends: a start's run is counted; its notice went in with the status. */
export async function startedRunEnded(runId: string, status: "done" | "failed" | "cancelled") {
  try {
    const run = await runStore.get(runId);
    if (!run?.startedBy) {
      return;
    }
    if (status === "done") {
      await patchStart(run.wizardId, run.startedBy.startId, (s) => ({ ...s, failures: 0 }));
    } else if (status === "failed") {
      await countFailure(run.wizardId, run.startedBy.startId, run.error ?? "failed");
    }
  } catch (err) {
    console.error(`[starts] run ${runId} ended:`, err);
  }
}

// --- the clock -----------------------------------------------------------------------------

/** A run of the start, another time's or one begun by hand, is still going. */
async function stillGoing(wizardId: string, startId: string, occurrence: string) {
  return runStore.startStillGoing(wizardId, startId, occurrence);
}

/** Deals with the time of a schedule that is due, if one is: starts a run or leaves it out. */
async function lookAtSchedule(w: WizardRow, start: WizardStart, now: Date) {
  const schedule = start.schedule;
  const due =
    schedule && dueOccurrence(schedule, new Date(start.handledUntil ?? now.toISOString()), now);
  if (!schedule || !due) {
    return;
  }
  const at = due.at.toISOString();
  const skip = (why: "overlap" | "late") =>
    patchStart(w.id, start.id, (s) => ({
      ...s,
      handledUntil: later(s.handledUntil, at),
      lastSkip: { at, why },
    }));
  if (due.late) {
    await skip("late");
    return;
  }
  const occurrence = occurrenceKey(start.id, due.at);
  if (schedule.overlap === "skip" && (await stillGoing(w.id, start.id, occurrence))) {
    await skip("overlap");
    return;
  }
  try {
    await startFrom(w, start, { kind: "schedule", at }, { occurrence });
  } catch (err) {
    if (!(err instanceof OccurrenceTaken)) {
      throw err;
    }
    // Another runner was first, or this one crashed after the run began: only the write is left.
    await patchStart(w.id, start.id, (s) => {
      const { lastSkip: _, ...rest } = s;
      return {
        ...rest,
        handledUntil: later(s.handledUntil, at),
        lastRunAt: later(s.lastRunAt, at),
      };
    });
  }
}

/** Deals with every schedule that is due, in every active tenant; done when they all were. */
export async function runDueSchedules(now = new Date()): Promise<void> {
  const tenants = await controlDb.query.tenant.findMany({
    where: eq(control.tenant.status, "active"),
    columns: { id: true },
  });
  for (const tenant of tenants) {
    await withTenant(tenant.id, async () => {
      const wizards = await db.query.wizard.findMany({
        where: ne(schema.wizard.starts, sql`'[]'`),
      });
      // The switch is per tenant, and asking for it can ask the Manage-App: only with starts to run.
      if (!wizards.length || !(await currentFeatures()).startTriggers) {
        return;
      }
      for (const w of wizards) {
        for (const start of w.starts) {
          if (start.kind === "schedule" && start.on) {
            await lookAtSchedule(w, start, now).catch((err) =>
              console.error(`[starts] ${w.id}/${start.id}:`, err),
            );
          }
        }
      }
    }).catch((err) => console.error(`[starts ${tenant.id}]`, err));
  }
}

const TICK_MS = 60_000;
let timer: NodeJS.Timeout | null = null;
let looking = false;

/** Looks for due schedules soon after the start and then once a minute, on a process that runs runs. */
export function startStarts() {
  if (timer || !env.serves.runner) {
    return;
  }
  const tick = () => {
    if (looking) {
      return;
    }
    looking = true;
    void runDueSchedules()
      .catch((err) => console.error("[starts]", err))
      .finally(() => {
        looking = false;
      });
  };
  setTimeout(tick, 5_000).unref();
  timer = setInterval(tick, TICK_MS);
  timer.unref();
}

/** The kinds a runtime can begin on its own today. */
export const LIVE_START_KINDS: StartKind[] = ["schedule"];
