import { allFields } from "@engenty-wizards/shared/definition";
import { startsSchema, type WizardStart } from "@engenty-wizards/shared/starts";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema } from "../db/client.js";
import { LIVE_START_KINDS, startFrom } from "../engine/starts.js";
import { currentFeatures } from "../features.js";
import { ServiceError } from "./errors.js";
import { ownedWizard, writableWizard } from "./wizards.js";

/** The starts of a wizard, as the share dialog shows them. */
export async function listStarts(userId: string, wizardId: string): Promise<WizardStart[]> {
  return (await ownedWizard(userId, wizardId)).starts;
}

/**
 * Replaces the starts of a wizard. Each is checked: its kind is one this runtime can begin,
 * its answers name fields of the wizard. A new start gets its id, owner and time here.
 */
export async function setStarts(userId: string, wizardId: string, input: unknown) {
  if (!(await currentFeatures()).startTriggers) {
    throw new ServiceError("refused", "Starts are not switched on here.");
  }
  const w = await writableWizard(userId, wizardId);
  const parsed = startsSchema.safeParse(input);
  if (!parsed.success) {
    throw new ServiceError("invalid", parsed.error.issues[0]?.message ?? "Invalid start");
  }
  const fields = new Set(allFields(w.draft).map((f) => f.id));
  const before = new Map(w.starts.map((s) => [s.id, s]));
  const now = new Date().toISOString();
  const starts = parsed.data.map((s) => {
    if (!LIVE_START_KINDS.includes(s.kind)) {
      throw new ServiceError("refused", `A start of the kind "${s.kind}" cannot run here yet.`);
    }
    for (const id of Object.keys(s.answers)) {
      if (!fields.has(id)) {
        throw new ServiceError("invalid", `The wizard has no field "${id}".`);
      }
    }
    const old = before.get(s.id);
    return {
      ...s,
      id: old ? s.id : nanoid(10),
      owner: old?.owner ?? userId,
      createdAt: old?.createdAt ?? now,
      lastRunAt: old?.lastRunAt,
      failures: old?.failures ?? 0,
      // Switched on again by hand: the failures that paused it are forgiven.
      ...(s.on && old && !old.on ? { failures: 0, pausedReason: undefined } : {}),
    };
  });
  await db
    .update(schema.wizard)
    .set({ starts, updatedAt: new Date() })
    .where(eq(schema.wizard.id, w.id));
  return starts;
}

/** Runs a start once, now: "Jetzt einmal ausprobieren". */
export async function runStartNow(userId: string, wizardId: string, startId: string) {
  const w = await ownedWizard(userId, wizardId);
  const start = w.starts.find((s) => s.id === startId);
  if (!start) {
    throw new ServiceError("not_found", "No such start.");
  }
  const runId = await startFrom(w, start, { kind: start.kind, at: new Date().toISOString() });
  return { runId };
}
