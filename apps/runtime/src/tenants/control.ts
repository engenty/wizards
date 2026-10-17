import { and, count, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { control, controlDb } from "../db/client.js";
import { env } from "../env.js";
import { currentTenant } from "./tenant.js";

// What the runtime looks up before it knows the tenant: public tokens and run ids.

type LinkKind = "wizard" | "result" | "logo" | "code";

/** Remembers which tenant a public token belongs to. */
export async function putLink(token: string, kind: LinkKind, ref: string) {
  await controlDb
    .insert(control.link)
    .values({ token, tenantId: currentTenant(), kind, ref })
    .onConflictDoUpdate({
      target: control.link.token,
      set: { tenantId: currentTenant(), kind, ref },
    });
}

/** A token's link goes, and with a wizard's share token its ID. */
export async function dropLinks(tokens: string[]) {
  if (tokens.length) {
    await controlDb.delete(control.link).where(inArray(control.link.token, tokens));
    await controlDb
      .delete(control.link)
      .where(and(eq(control.link.kind, "code"), inArray(control.link.ref, tokens)));
  }
}

// --- wizard IDs ----------------------------------------------------------------------
// The share token is 14 characters of both cases, `_` and `-`: nobody types that on a phone.
// The ID is 8 capitals and digits without look-alikes (no 0 O 1 I), made the first time someone
// asks for it and gone when the share token rotates.

const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_LENGTH = 8;

function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

/** What a person typed, as stored: capitals, no spaces or dashes. */
export const normalizeCode = (input: string) => input.toUpperCase().replace(/[\s-]/g, "");

/** The ID of a wizard's share token; made on the first ask. */
export async function codeOf(shareToken: string): Promise<string> {
  const row = await controlDb.query.link.findFirst({
    where: and(eq(control.link.kind, "code"), eq(control.link.ref, shareToken)),
  });
  if (row) {
    return row.token;
  }
  for (;;) {
    const code = newCode();
    const made = await controlDb
      .insert(control.link)
      .values({ token: code, tenantId: currentTenant(), kind: "code", ref: shareToken })
      .onConflictDoNothing()
      .returning({ token: control.link.token });
    if (made.length) {
      return code;
    }
  }
}

/** The share token behind an ID, and its tenant. */
export async function tokenOfCode(
  input: string,
): Promise<{ token: string; tenantId: string } | null> {
  const code = normalizeCode(input);
  if (code.length !== CODE_LENGTH) {
    return null;
  }
  const row = await controlDb.query.link.findFirst({
    where: and(eq(control.link.kind, "code"), eq(control.link.token, code)),
  });
  return row ? { token: row.ref, tenantId: row.tenantId } : null;
}

export async function tenantOfLink(token: string, kind: LinkKind): Promise<string | null> {
  const row = await controlDb.query.link.findFirst({
    where: and(eq(control.link.token, token), eq(control.link.kind, kind)),
  });
  return row?.tenantId ?? null;
}

// --- runs ----------------------------------------------------------------------

const runTenants = new Map<string, string>();

export async function indexRun(input: {
  runId: string;
  visitorId?: string | null;
  ipHash?: string | null;
}) {
  const tenantId = currentTenant();
  runTenants.set(input.runId, tenantId);
  await controlDb.insert(control.runIndex).values({
    runId: input.runId,
    tenantId,
    visitorId: input.visitorId ?? null,
    ipHash: input.ipHash ?? null,
  });
}

export async function tenantOfRun(runId: string): Promise<string | null> {
  const known = runTenants.get(runId);
  if (known) {
    return known;
  }
  const row = await controlDb.query.runIndex.findFirst({
    where: eq(control.runIndex.runId, runId),
  });
  if (row) {
    runTenants.set(runId, row.tenantId);
    if (runTenants.size > 5000) {
      runTenants.delete(runTenants.keys().next().value as string);
    }
  }
  return row?.tenantId ?? null;
}

export async function dropRuns(runIds: string[]) {
  for (const id of runIds) {
    runTenants.delete(id);
  }
  for (let i = 0; i < runIds.length; i += 200) {
    await controlDb
      .delete(control.runIndex)
      .where(inArray(control.runIndex.runId, runIds.slice(i, i + 200)));
  }
}

// --- the queue: which runner works on which run ---------------------------------
// `active` = the run wants a runner. `owner` = the one driving it, `seen` = its last heartbeat.

/** An owner silent this long has lost the run: another runner takes it. */
export const RUNNER_STALE_MS = 30_000;

/** Puts a run in line for a runner (again): active, owned by nobody. */
export async function wakeRun(runId: string) {
  await controlDb
    .update(control.runIndex)
    .set({ active: true, owner: null, seen: null })
    .where(eq(control.runIndex.runId, runId));
}

/** The run is done with runners for now: a page, a review or the end. */
export async function restRun(runId: string) {
  await controlDb
    .update(control.runIndex)
    .set({ active: false, owner: null, seen: null })
    .where(eq(control.runIndex.runId, runId));
}

/**
 * Takes a run for this runner, in one statement: only while nobody (alive) holds it and the
 * tenant's owned runs stay under its limit. False: someone else has it, or the tenant is at its
 * limit — the run stays in line.
 */
export async function claimRun(runId: string, tenantId: string, limit: number): Promise<boolean> {
  const now = Date.now();
  const stale = now - RUNNER_STALE_MS;
  const result = await controlDb.run(sql`
    UPDATE run_index SET owner = ${env.runner.id}, seen = ${now}
    WHERE run_id = ${runId} AND active = 1
      AND (owner IS NULL OR seen IS NULL OR seen < ${stale})
      AND (SELECT count(*) FROM run_index
           WHERE tenant_id = ${tenantId} AND owner IS NOT NULL AND seen >= ${stale}
             AND run_id != ${runId}) < ${limit}`);
  return result.rowsAffected > 0;
}

/** This runner still works on these runs. */
export async function heartbeatRuns(runIds: string[]) {
  if (runIds.length) {
    await controlDb
      .update(control.runIndex)
      .set({ seen: new Date() })
      .where(
        and(eq(control.runIndex.owner, env.runner.id), inArray(control.runIndex.runId, runIds)),
      );
  }
}

/** A runner that stops hands its runs back to the line; another takes them at once. */
export async function disownRuns() {
  await controlDb
    .update(control.runIndex)
    .set({ owner: null, seen: null })
    .where(eq(control.runIndex.owner, env.runner.id));
}

/** The runs in line: unowned, or whose owner fell silent. */
export async function waitingRuns(): Promise<{ runId: string; tenantId: string }[]> {
  const stale = new Date(Date.now() - RUNNER_STALE_MS);
  return controlDb
    .select({ runId: control.runIndex.runId, tenantId: control.runIndex.tenantId })
    .from(control.runIndex)
    .where(
      and(
        eq(control.runIndex.active, true),
        or(
          isNull(control.runIndex.owner),
          isNull(control.runIndex.seen),
          lt(control.runIndex.seen, stale),
        ),
      ),
    )
    .orderBy(control.runIndex.createdAt);
}

/** Where the runner holding a run is reached; null when none holds it or it named no address. */
export async function ownerUrl(runId: string): Promise<string | null> {
  const row = await controlDb.query.runIndex.findFirst({
    where: eq(control.runIndex.runId, runId),
  });
  if (!row?.owner || !row.seen || row.seen.getTime() < Date.now() - RUNNER_STALE_MS) {
    return null;
  }
  const who = await controlDb.query.runner.findFirst({ where: eq(control.runner.id, row.owner) });
  return who?.url || null;
}

/** This process reports as a runner: its address, and that it is alive. */
export async function registerRunner() {
  const now = new Date();
  await controlDb
    .insert(control.runner)
    .values({ id: env.runner.id, url: env.runner.url || null, seen: now })
    .onConflictDoUpdate({
      target: control.runner.id,
      set: { url: env.runner.url || null, seen: now },
    });
  // Runners gone for a day are forgotten.
  await controlDb
    .delete(control.runner)
    .where(lt(control.runner.seen, new Date(now.getTime() - 86_400_000)));
}

export async function forgetRunner() {
  await controlDb.delete(control.runner).where(eq(control.runner.id, env.runner.id));
}

/** A visitor's runs are counted across every wizard of every tenant. */
export async function visitorOverLimit(visitorId: string, ipHash: string | null): Promise<boolean> {
  const since = new Date(Date.now() - 3600_000);
  const who = ipHash
    ? or(eq(control.runIndex.visitorId, visitorId), eq(control.runIndex.ipHash, ipHash))
    : eq(control.runIndex.visitorId, visitorId);
  const [{ n }] = await controlDb
    .select({ n: count() })
    .from(control.runIndex)
    .where(and(who, gte(control.runIndex.createdAt, since)));
  return n >= env.limits.visitorRunsPerHour;
}

// --- tenants ---------------------------------------------------------------------

export async function tenantStatus(id: string): Promise<"active" | "suspended" | null> {
  const row = await controlDb.query.tenant.findFirst({ where: eq(control.tenant.id, id) });
  return row?.status ?? null;
}

export async function setTenantStatus(id: string, status: "active" | "suspended") {
  await controlDb.update(control.tenant).set({ status }).where(eq(control.tenant.id, id));
}

/** Everything the control database knows about a tenant goes with it. */
export async function forgetTenantRows(id: string) {
  await controlDb.delete(control.link).where(eq(control.link.tenantId, id));
  await controlDb.delete(control.runIndex).where(eq(control.runIndex.tenantId, id));
  await controlDb.delete(control.session).where(eq(control.session.tenantId, id));
  await controlDb.delete(control.tenant).where(eq(control.tenant.id, id));
  for (const [runId, tenantId] of runTenants) {
    if (tenantId === id) {
      runTenants.delete(runId);
    }
  }
}

/** The line's view of one run: which tenant it belongs to, whether it is awake. */
export async function runIndexOf(runId: string) {
  const row = await controlDb.query.runIndex.findFirst({
    where: eq(control.runIndex.runId, runId),
  });
  return row ? { tenantId: row.tenantId, active: row.active } : null;
}
