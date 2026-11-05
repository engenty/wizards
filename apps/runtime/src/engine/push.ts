import type { Lang } from "@engenty/wizards-shared/definition";
import { eq } from "drizzle-orm";
import { control, controlDb, db, schema } from "../db/client.js";
import { currentFeatures } from "../features.js";
import { managed, pushToDevice } from "../manage.js";
import { currentTenant } from "../tenants/tenant.js";

/**
 * Push for the mobile app: the app gives a run its device (`POST /api/runs/:id/notify`), and
 * when the run is done, failed or waits for the person, the runtime asks the Manage-App to tell
 * that device (it holds the APNs and FCM keys). A runtime that runs alone has no Manage-App and
 * no push; the app then only hears while it is open.
 */

export type PushDevice = { token: string; platform: "ios" | "android"; lang: Lang };
export type PushKind = "done" | "failed" | "waiting" | "asks";

const TEXT: Record<Lang, Record<PushKind, string>> = {
  en: {
    done: "Your result is ready.",
    failed: "The run stopped with an error.",
    waiting: "The wizard is waiting for you.",
    asks: "The wizard has a question for you.",
  },
  de: {
    done: "Dein Ergebnis ist bereit.",
    failed: "Der Lauf ist mit einem Fehler stehen geblieben.",
    waiting: "Der Wizard wartet auf dich.",
    asks: "Der Wizard hat eine Frage an dich.",
  },
};

export const pushAvailable = () => managed;

export async function setPushDevice(runId: string, device: PushDevice | null) {
  await controlDb
    .update(control.runIndex)
    .set({ push: device })
    .where(eq(control.runIndex.runId, runId));
}

/** The run's own person has its page in view. */
export async function setRunViewed(runId: string) {
  await controlDb
    .update(control.runIndex)
    .set({ viewedAt: new Date() })
    .where(eq(control.runIndex.runId, runId));
}

/** Tells the run's device, if the app gave one. A failure comes back to the caller. */
export async function pushToRunDevice(
  run: { id: string; definition: { title: string } },
  kind: PushKind,
) {
  const row = await controlDb.query.runIndex.findFirst({
    where: eq(control.runIndex.runId, run.id),
  });
  const device = row?.push;
  if (!device) {
    return;
  }
  await pushToDevice({
    tenantId: currentTenant(),
    device: { token: device.token, platform: device.platform },
    title: run.definition.title,
    body: TEXT[device.lang][kind],
    data: { runId: run.id, kind },
  });
  // An ended run has nothing more to say.
  if (kind === "done" || kind === "failed") {
    await setPushDevice(run.id, null);
  }
}

/**
 * Tells the run's device at once; never fails the run. With `durableRuns` the notice's row does
 * it (engine/notices.ts), so someone looking at the run is not told and a crash loses nothing.
 */
export async function pushRun(runId: string, kind: PushKind) {
  if (!managed) {
    return;
  }
  try {
    if ((await currentFeatures()).durableRuns) {
      return;
    }
    const run = await db.query.run.findFirst({ where: eq(schema.run.id, runId) });
    if (run) {
      await pushToRunDevice(run, kind);
    }
  } catch (err) {
    console.error("[push]", (err as Error).message);
  }
}
