import { createHash } from "node:crypto";
import type { RunNote } from "@engenty-wizards/shared/run";
import { and, count, eq, gte } from "drizzle-orm";
import { canSpend } from "./credits/credits.js";
import { db, schema } from "./db/client.js";
import { env } from "./env.js";

export function hashIp(ip: string | null | undefined): string | null {
  if (!ip) {
    return null;
  }
  return createHash("sha256").update(`${env.authSecret}:${ip}`).digest("hex").slice(0, 32);
}

function startOfDay(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export type WizardRow = typeof schema.wizard.$inferSelect;

/**
 * Why a shared wizard cannot start a run right now, or null when it can: a note, to answer in the
 * wizard's language (`noteText(reason, wizardLang(def))`).
 */
export async function wizardUnavailable(w: WizardRow): Promise<RunNote | null> {
  if (!w.shareEnabled || w.publishedVersion === null) {
    return { code: "wizardUnavailable" };
  }
  const [{ n }] = await db
    .select({ n: count() })
    .from(schema.run)
    .where(
      and(
        eq(schema.run.wizardId, w.id),
        eq(schema.run.mode, "live"),
        gte(schema.run.createdAt, startOfDay()),
      ),
    );
  if (n >= w.dailyRunLimit) {
    return { code: "wizardLimit" };
  }
  if (!(await canSpend())) {
    return { code: "wizardUnavailable" };
  }
  return null;
}

export async function verifyTurnstile(
  token: string | undefined,
  ip: string | null,
): Promise<boolean> {
  if (!env.turnstile.secret) {
    return true;
  }
  if (!token) {
    return false;
  }
  const body = new URLSearchParams({ secret: env.turnstile.secret, response: token });
  if (ip) {
    body.set("remoteip", ip);
  }
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body,
      signal: AbortSignal.timeout(8000),
    });
    const data = (await res.json()) as { success?: boolean };
    return Boolean(data.success);
  } catch {
    return false;
  }
}

/** Times per key, kept in this process; old ones drop out as the key is asked. */
const seen = new Map<string, number[]>();

/** Counts one more try for `key`; false once `max` tries fell within the last `windowMs`. */
export function allowed(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const recent = (seen.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    seen.set(key, recent);
    return false;
  }
  recent.push(now);
  seen.set(key, recent);
  if (seen.size > 50_000) {
    for (const [k, times] of seen) {
      if (!times.some((t) => now - t < windowMs)) {
        seen.delete(k);
      }
    }
  }
  return true;
}
