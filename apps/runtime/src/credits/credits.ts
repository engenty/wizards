import { sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { ManageError, managed, release, reserve, runUsage, tenantInfo } from "../manage.js";
import { currentTenant } from "../tenants/tenant.js";
import { ownAccountReady } from "../upstreams.js";

/**
 * Credits live in the Manage-App: its gateway books every model call. The runtime only asks
 * whether a tenant may start, reserves before a run and reads what a run cost. A runtime that
 * runs alone has no credits; it keeps the provider cost of a run for display (1 credit = 1 cent).
 */
export const MICROS_PER_CREDIT = 1_000_000;

export function usdToMicros(usd: number): number {
  return Math.ceil(usd * 100 * MICROS_PER_CREDIT);
}

/** At least one credit left — enough to start something. */
export async function canSpend(): Promise<boolean> {
  if (!managed) {
    return true;
  }
  try {
    const tenant = currentTenant();
    const t = await tenantInfo(tenant);
    if (t.status !== "active") {
      return false;
    }
    // An organization with an own account ready runs on it without credits; a call that needs
    // credits still gets its 402 from the gateway (ownKeysGateway).
    return t.balanceCredits >= 1 || (await ownAccountReady(tenant));
  } catch (err) {
    console.error("[credits]", err);
    return false;
  }
}

export async function balanceCredits(): Promise<number | null> {
  if (!managed) {
    return null;
  }
  return (await tenantInfo(currentTenant(), true).catch(() => null))?.balanceCredits ?? null;
}

/**
 * Holds credits for a run before it starts. False = the free balance does not cover it;
 * "guest_budget" = a visitor's run past what visitors may spend on this tenant's wizards.
 */
export async function reserveForRun(
  runId: string,
  /** How many; a function when working that out costs something: called only where a hold is made. */
  amount: number | (() => Promise<number>),
  guest = false,
): Promise<boolean | "guest_budget"> {
  if (!managed) {
    return true;
  }
  const credits = typeof amount === "number" ? amount : await amount();
  if (credits <= 0) {
    return true;
  }
  try {
    await reserve(currentTenant(), runId, Math.ceil(credits), guest);
    return true;
  } catch (err) {
    if (err instanceof ManageError && err.status === 402) {
      return false;
    }
    if (err instanceof ManageError && err.code === "guest_budget") {
      return "guest_budget";
    }
    throw err;
  }
}

export async function releaseRun(runId: string) {
  if (managed) {
    await release(runId).catch((err) => console.error("[credits] release", err));
  }
}

async function setStepCost(runId: string, stepId: string, micros: number) {
  await db
    .insert(schema.runCost)
    .values({ runId, stepId, micros })
    .onConflictDoUpdate({
      target: [schema.runCost.runId, schema.runCost.stepId],
      set: { micros },
    });
}

/** What the ledger booked for the run so far, written to the run and its steps. */
export async function syncRunCost(runId: string) {
  if (!managed) {
    return;
  }
  try {
    const usage = await runUsage(currentTenant(), runId);
    await db
      .update(schema.run)
      .set({ costMicros: Math.round(usage.credits * MICROS_PER_CREDIT) })
      .where(sql`${schema.run.id} = ${runId}`);
    for (const [stepId, credits] of Object.entries(usage.steps)) {
      await setStepCost(runId, stepId, Math.round(credits * MICROS_PER_CREDIT));
    }
  } catch (err) {
    console.error("[credits] usage", err);
  }
}

/** A runtime that runs alone adds up the provider cost itself. */
export async function addLocalCost(runId: string, stepId: string, usd: number) {
  const micros = usdToMicros(usd);
  if (managed || micros <= 0) {
    return;
  }
  await db
    .update(schema.run)
    .set({ costMicros: sql`${schema.run.costMicros} + ${micros}` })
    .where(sql`${schema.run.id} = ${runId}`);
  await db
    .insert(schema.runCost)
    .values({ runId, stepId, micros })
    .onConflictDoUpdate({
      target: [schema.runCost.runId, schema.runCost.stepId],
      set: { micros: sql`${schema.runCost.micros} + ${micros}` },
    });
}
