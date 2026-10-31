import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { type Client, createClient } from "@libsql/client";
import { packageVersion } from "./cli/home.js";
import {
  failingTenants,
  knownTenants,
  openingTenants,
  probeControl,
  tenantDb,
} from "./db/client.js";
import { lineAskedSince } from "./engine/runner.js";
import { env } from "./env.js";
import { probeObjects } from "./files/objects.js";
import { redact } from "./log.js";
import { managed } from "./manage.js";
import { lineState, RUNNER_STALE_MS } from "./tenants/control.js";

/**
 * Whether this process can do its job (docs/plans/health-and-status.md): each check under its own
 * timeout, all of them at once, the answer kept for a while. `process` says whether the fault is
 * this process's own (a restart helps); the others are what it depends on.
 */
export type Level = "ok" | "degraded" | "down";

export interface CheckResult {
  status: Level;
  ms: number;
  error?: string;
  detail?: Record<string, unknown>;
}

export interface Health {
  status: Level;
  role: string;
  version: string;
  checkedAt: string;
  checks: Record<string, CheckResult>;
}

/** A check's longest wait; the whole answer goes out after ANSWER_MS at the latest. */
const CHECK_MS = 2000;
const ANSWER_MS = 3000;
/** How long an answer is kept: a public endpoint never loads the databases. */
const KEEP_MS = 10_000;
/** A request open this long is logged; this many of them, this old, mean this process is stuck. */
const SLOW_MS = 30_000;
const STUCK_MS = 120_000;
const STUCK_COUNT = 3;
/** One request open this long is enough. */
const STUCK_ALONE_MS = 600_000;
/** A tenant database still opening after this long is stuck (its busy retries take 31 s). */
const OPENING_MS = 60_000;
/** A run waiting this long for a runner: the runners are busy or stuck. */
const WAITING_MS = 600_000;

// --- requests in flight -------------------------------------------------------------

interface Open {
  method: string;
  path: string;
  start: number;
  logged: boolean;
}

const inFlight = new Map<number, Open>();
let nextRequest = 1;

/**
 * Marks a request open until its handler returned. A stream's handler returns as soon as the
 * stream starts, so streams never count.
 */
export function requestStarted(method: string, path: string): () => void {
  const id = nextRequest++;
  inFlight.set(id, { method, path, start: Date.now(), logged: false });
  return () => inFlight.delete(id);
}

/** The requests open longer than SLOW_MS; each one is logged once, with its path. */
function slowRequests(now: number) {
  const slow: { method: string; path: string; seconds: number }[] = [];
  for (const r of inFlight.values()) {
    const age = now - r.start;
    if (age < SLOW_MS) {
      continue;
    }
    if (!r.logged) {
      r.logged = true;
      console.warn(`[slow] ${r.method} ${r.path} open ${Math.round(age / 1000)} s`);
    }
    slow.push({ method: r.method, path: r.path, seconds: Math.round(age / 1000) });
  }
  return slow.sort((a, b) => b.seconds - a.seconds);
}

setInterval(() => slowRequests(Date.now()), 10_000).unref();

const loop = monitorEventLoopDelay({ resolution: 20 });
loop.enable();

// --- the checks -----------------------------------------------------------------------

export type Run = () => Promise<Omit<CheckResult, "ms"> | undefined>;

/** A check's call still open from an earlier answer: never started twice. */
const pending = new Map<string, number>();

export async function timed(name: string, run: Run): Promise<CheckResult> {
  const started = Date.now();
  const since = pending.get(name);
  if (since !== undefined) {
    return {
      status: "down",
      ms: 0,
      error: `still waiting since ${new Date(since).toISOString()}`,
    };
  }
  pending.set(name, started);
  const work = run()
    .then((r) => r ?? { status: "ok" as const })
    .catch((err: Error) => ({ status: "down" as const, error: redact(oneLine(err)) }))
    .finally(() => pending.delete(name));
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<Omit<CheckResult, "ms">>((resolve) => {
    timer = setTimeout(
      () => resolve({ status: "down", error: `no answer within ${CHECK_MS} ms` }),
      CHECK_MS,
    );
  });
  const result = await Promise.race([work, late]);
  clearTimeout(timer);
  return { ...result, ms: Date.now() - started };
}

const oneLine = (err: Error) =>
  String(err?.message ?? err)
    .split("\n")[0]
    .slice(0, 300);

/** Whether `url` answers below 500. */
async function answers(url: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(CHECK_MS) });
  await res.body?.cancel();
  if (res.status >= 500) {
    throw new Error(`answered ${res.status}`);
  }
}

let controlStuck = false;

async function controlCheck(): Promise<Omit<CheckResult, "ms">> {
  try {
    await probeControl();
    controlStuck = false;
    return { status: "ok" };
  } catch (err) {
    // The database or this process's client? A new client tells.
    const fresh = await probeControl(true).then(
      () => true,
      () => false,
    );
    controlStuck = fresh;
    return {
      status: "down",
      error: redact(oneLine(err as Error)),
      detail: { stuckClient: fresh },
    };
  }
}

let lockDb: Client | undefined;

async function tenantsCheck() {
  const folder = join(env.dataDir, "tenants");
  await mkdir(folder, { recursive: true });
  const file = join(folder, `.health-${randomBytes(4).toString("hex")}`);
  await writeFile(file, "ok");
  await rm(file, { force: true });
  // The roles share the volume: taking SQLite's write lock there shows that its locking works.
  if (!lockDb) {
    lockDb = createClient({ url: `file:${join(env.dataDir, "health.db")}` });
    await lockDb.execute("PRAGMA busy_timeout = 1000");
    await lockDb.execute("PRAGMA journal_mode = WAL");
  }
  const tx = await lockDb.transaction("write");
  await tx.rollback();
  return undefined;
}

/** How often every tenant database is opened in the background, for `databases`. */
const SWEEP_MS = 60_000;
let swept = 0;
let sweeping = false;

/**
 * Opens every known tenant database, one after the other, at most once a minute and never twice
 * at once. An open one answers at once; one that fails (a migration, say) is tried again.
 */
function sweepTenants(now: number) {
  if (sweeping || now - swept < SWEEP_MS) {
    return;
  }
  sweeping = true;
  swept = now;
  void (async () => {
    try {
      for (const id of await knownTenants()) {
        await tenantDb(id).catch(() => undefined);
      }
    } catch {
      // the control database is `control`'s to report
    } finally {
      sweeping = false;
    }
  })();
}

/**
 * Whether the tenant databases open: every request of a tenant needs its own. The sweep runs
 * behind the check, so the answer is what the last sweep and the requests since found. Some
 * failing is `degraded`, all failing `down`.
 */
export async function databasesCheck(): Promise<Omit<CheckResult, "ms"> | undefined> {
  sweepTenants(Date.now());
  const failing = failingTenants();
  if (!failing.length) {
    return undefined;
  }
  const known = (await knownTenants()).length;
  return {
    status: failing.length >= known ? "down" : "degraded",
    error: `${failing.length} of ${known} tenant databases don't open: ${failing[0].error}`,
    detail: { failing: failing.map((f) => ({ id: f.id, at: new Date(f.at).toISOString() })) },
  };
}

async function lineCheck(): Promise<Omit<CheckResult, "ms">> {
  const { runners, oldestWaiting } = await lineState();
  const now = Date.now();
  const alive = runners.filter(
    (r) =>
      r.seen.getTime() > now - RUNNER_STALE_MS &&
      // A runner from before `line_at` existed reports none.
      (r.lineAt === null || r.lineAt.getTime() > now - RUNNER_STALE_MS),
  );
  const waitingSeconds = oldestWaiting ? Math.round((now - oldestWaiting.getTime()) / 1000) : 0;
  const detail = {
    runners: runners.map((r) => ({
      id: r.id,
      seen: r.seen.toISOString(),
      lineAt: r.lineAt?.toISOString() ?? null,
    })),
    oldestWaitingSeconds: waitingSeconds,
  };
  if (!alive.length) {
    return { status: "down", error: "no runner takes runs", detail };
  }
  if (waitingSeconds * 1000 > WAITING_MS) {
    return {
      status: "degraded",
      error: `a run has waited ${waitingSeconds} s for a runner`,
      detail,
    };
  }
  return { status: "ok", detail };
}

function lineStuck(now: number) {
  const since = env.serves.runner ? lineAskedSince() : null;
  return since !== null && now - since > OPENING_MS;
}

/** This process itself: requests that hang, a loop that stalls, databases that never open. */
function processCheck(now: number): CheckResult {
  const slow = slowRequests(now);
  const stuck = slow.filter((r) => r.seconds * 1000 >= STUCK_MS);
  const opening = openingTenants().filter((t) => now - t.since > OPENING_MS);
  const loopMs = Math.round(loop.percentile(99) / 1e6);
  loop.reset();
  const memory = process.memoryUsage();
  const reasons = [
    stuck.length >= STUCK_COUNT || stuck.some((r) => r.seconds * 1000 >= STUCK_ALONE_MS)
      ? `${stuck.length} requests open for more than ${STUCK_MS / 1000} s`
      : null,
    opening.length ? `tenant databases opening for minutes: ${opening.map((t) => t.id)}` : null,
    controlStuck ? "the control database answers a new client, not this process's" : null,
    lineStuck(now) ? "the runner's look at the line hangs" : null,
  ].filter((r): r is string => r !== null);
  return {
    status: reasons.length ? "down" : "ok",
    ms: 0,
    ...(reasons.length ? { error: reasons.join("; ") } : {}),
    detail: {
      openRequests: inFlight.size,
      slowRequests: slow.slice(0, 20),
      loopDelayP99Ms: loopMs,
      memoryMb: Math.round(memory.rss / 1_048_576),
      uptimeSeconds: Math.round(process.uptime()),
    },
  };
}

/** The checks this role runs, and whether one that is down takes the whole answer down. */
function checksOf(): { name: string; required: boolean; run: Run }[] {
  const { serves } = env;
  const all: { name: string; required: boolean; run: Run; when: boolean }[] = [
    { name: "control", required: true, run: controlCheck, when: true },
    { name: "tenants", required: true, run: tenantsCheck, when: true },
    // Not required: a database that doesn't open leaves the others serving; the status page
    // reads this check by name.
    { name: "databases", required: false, run: databasesCheck, when: serves.studio },
    {
      name: "objects",
      required: true,
      run: async () => {
        await probeObjects();
        return undefined;
      },
      when: true,
    },
    {
      name: "line",
      // Without a runner, the pages still answer; the runner itself is down.
      required: serves.runner,
      run: lineCheck,
      when: true,
    },
    {
      name: "gateway",
      required: false,
      run: async () => {
        await answers(`${env.manage.gatewayUrl}/health`);
        return undefined;
      },
      when: managed && Boolean(env.manage.gatewayUrl) && (serves.studio || serves.runner),
    },
    {
      name: "manage",
      required: false,
      run: async () => {
        await answers(`${env.manage.url}/api/health`);
        return undefined;
      },
      when: managed && serves.studio,
    },
    {
      name: "browser",
      required: false,
      run: async () => {
        await answers(`${env.browserCdpUrl}/json/version`);
        return undefined;
      },
      when: serves.runner && Boolean(env.browserCdpUrl),
    },
  ];
  return all.filter((c) => c.when);
}

async function evaluate(): Promise<Health> {
  const checks = checksOf();
  const results = await Promise.race([
    Promise.all(checks.map(async (c) => [c.name, await timed(c.name, c.run)] as const)),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ANSWER_MS).unref()),
  ]);
  const byName: Record<string, CheckResult> = Object.fromEntries(
    results ??
      checks.map((c) => [c.name, { status: "down", ms: ANSWER_MS, error: "no answer in time" }]),
  );
  // After the others: a stuck control client shows in `process`.
  byName.process = processCheck(Date.now());
  const required = new Set(["process", ...checks.filter((c) => c.required).map((c) => c.name)]);
  const down = Object.entries(byName).filter(([, r]) => r.status !== "ok");
  const status: Level = down.some(([name, r]) => required.has(name) && r.status === "down")
    ? "down"
    : down.length
      ? "degraded"
      : "ok";
  return {
    status,
    role: env.role,
    version: packageVersion(),
    checkedAt: new Date().toISOString(),
    checks: { process: byName.process, ...byName },
  };
}

let kept: { at: number; answer: Promise<Health> } | undefined;

/** The checks' answer, at most KEEP_MS old; callers meanwhile share one evaluation. */
export function health(): Promise<Health> {
  const now = Date.now();
  if (!kept || now - kept.at > KEEP_MS) {
    kept = { at: now, answer: evaluate() };
  }
  return kept.answer;
}

/** What anyone may see: each check's name and status, nothing about hosts, tenants or errors. */
export function publicHealth(h: Health) {
  return {
    status: h.status,
    role: h.role,
    version: h.version,
    checkedAt: h.checkedAt,
    checks: Object.fromEntries(Object.entries(h.checks).map(([name, r]) => [name, r.status])),
  };
}

/** 200 while this process can serve (also when degraded), 503 when it can't. */
export const httpStatus = (h: Health) => (h.status === "down" ? 503 : 200);
