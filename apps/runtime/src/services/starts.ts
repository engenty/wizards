import { allFields } from "@engenty/wizards-shared/definition";
import { startsSchema, type WizardStart } from "@engenty/wizards-shared/starts";
import { nanoid } from "nanoid";
import { changeStarts, LIVE_START_KINDS, startFrom } from "../engine/starts.js";
import { currentFeatures } from "../features.js";
import { ServiceError } from "./errors.js";
import { ownedWizard, writableWizard } from "./wizards.js";

async function requireStartsOn() {
  if (!(await currentFeatures()).startTriggers) {
    throw new ServiceError("refused", "Starts are not switched on here.");
  }
}

/** The starts of a wizard, as the share dialog shows them. */
export async function listStarts(userId: string, wizardId: string): Promise<WizardStart[]> {
  return (await ownedWizard(userId, wizardId)).starts;
}

/** A start from a tool has no id when it is new; the schema wants one, and `setStarts` replaces it. */
export function withStartIds<S extends { id?: string }>(starts: S[]) {
  return starts.map((s) => ({ ...s, id: s.id ?? `new-${nanoid(8)}` }));
}

/** Whether two schedules fire at the same times; what happens around them may differ. */
function sameTimes(a: WizardStart, b: WizardStart) {
  const times = (s: WizardStart) =>
    JSON.stringify([
      s.schedule?.every,
      s.schedule?.weekday,
      s.schedule?.day,
      s.schedule?.time,
      s.schedule?.tz,
    ]);
  return times(a) === times(b);
}

/**
 * Replaces the starts of a wizard. Each is checked: its kind is one this runtime can begin,
 * its answers name fields of the wizard. A new start gets its id and owner here; what the clock
 * keeps stays as the clock wrote it, whatever the caller sent.
 */
export async function setStarts(userId: string, wizardId: string, input: unknown) {
  await requireStartsOn();
  const w = await writableWizard(userId, wizardId);
  const parsed = startsSchema.safeParse(input);
  if (!parsed.success) {
    throw new ServiceError("invalid", parsed.error.issues[0]?.message ?? "Invalid start");
  }
  const fields = new Set(allFields(w.draft).map((f) => f.id));
  for (const s of parsed.data) {
    if (!LIVE_START_KINDS.includes(s.kind)) {
      throw new ServiceError("refused", `A start of the kind "${s.kind}" cannot run here yet.`);
    }
    for (const id of Object.keys(s.answers)) {
      if (!fields.has(id)) {
        throw new ServiceError("invalid", `The wizard has no field "${id}".`);
      }
    }
  }
  const now = new Date();
  const starts = await changeStarts(
    w.id,
    (current) => {
      const before = new Map(current.map((s) => [s.id, s]));
      return parsed.data.map((s) => {
        const old = before.get(s.id);
        const onAgain = s.on && old !== undefined && !old.on;
        return {
          ...s,
          id: old ? s.id : nanoid(10),
          owner: old?.owner ?? userId,
          // A time from before this change, or from while it was off, does not fire.
          handledUntil:
            !old || onAgain || !sameTimes(old, s) ? now.toISOString() : old.handledUntil,
          lastRunAt: old?.lastRunAt,
          lastSkip: old?.lastSkip,
          // Switched on again by hand: the failures that paused it are forgiven.
          failures: onAgain ? 0 : (old?.failures ?? 0),
          pausedReason: s.on ? undefined : old?.pausedReason,
        };
      });
    },
    { updatedAt: now },
  );
  if (!starts) {
    throw new ServiceError("not_found", "No such wizard.");
  }
  return starts;
}

/** Runs a start once, now: "Jetzt einmal ausprobieren". */
export async function runStartNow(userId: string, wizardId: string, startId: string) {
  await requireStartsOn();
  const w = await ownedWizard(userId, wizardId);
  const start = w.starts.find((s) => s.id === startId);
  if (!start) {
    throw new ServiceError("not_found", "No such start.");
  }
  const runId = await startFrom(w, start, { kind: start.kind, at: new Date().toISOString() });
  return { runId };
}
