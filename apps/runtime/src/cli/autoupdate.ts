import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type InstallNote, type Layout, readEnvFile, readInstallNote } from "./home.js";
import {
  currentVersion,
  promote,
  prune,
  RUNTIME_PACKAGE,
  runtimeDir,
  switchTo,
  versionIn,
} from "./versions.js";

/**
 * Updates that come by themselves, for an install made by install.sh (never `npx wizards` or a
 * checkout). The runtime asks the npm registry for the newest runtime when it starts and once
 * a day; npm installs a newer one, checking its integrity, beside the one that runs
 * (versions.ts). Nothing switches then: runs cost credits and are never cut off. The next
 * `wizards start` (a restart, the next login) makes it `current` before any runtime runs.
 *
 * Off with `wizards autoupdate off` or WIZARDS_DISABLE_AUTOUPDATE=1 (terminal or the install's
 * .env); off by default in CI and for an install set up without a terminal.
 */

const LATEST_URL = `https://registry.npmjs.org/${RUNTIME_PACKAGE}/latest`;
const HOUR = 60 * 60_000;
/** How long the status and the studio keep saying what came with an update. */
const NOTICE_MS = 14 * 24 * HOUR;

export const notesUrl = (version: string) =>
  `https://github.com/engenty/wizards/releases/tag/v${version}`;

export interface UpdateState {
  /** When the npm registry was last asked. */
  checkedAt?: string;
  /** Downloaded and installed beside the version that runs; current at the next start. */
  pending?: { version: string; notes: string };
  /** The last switch to a new version. */
  updated?: { from: string; to: string; at: string; notes: string };
  /** What went wrong the last time. */
  error?: string;
}

const stateFile = (paths: Layout) => join(paths.home, "update.json");

export function readUpdateState(paths: Layout): UpdateState {
  try {
    return JSON.parse(readFileSync(stateFile(paths), "utf8")) as UpdateState;
  } catch {
    return {};
  }
}

function writeUpdateState(paths: Layout, state: UpdateState) {
  mkdirSync(paths.home, { recursive: true });
  const tmp = `${stateFile(paths)}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, stateFile(paths));
}

/** Whether `a` is a newer version than `b`; a `v` and a pre-release suffix are ignored. */
export function isNewer(a: string, b: string): boolean {
  const parts = (v: string) => v.replace(/^v/, "").split("-")[0].split(".").map(Number);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) {
      return (x[i] || 0) > (y[i] || 0);
    }
  }
  return false;
}

// --- whether it is on ----------------------------------------------------------------------

const truthy = (value: string | undefined) =>
  value !== undefined && !["", "0", "false", "no", "off"].includes(value.trim().toLowerCase());

/** A build machine. The runtime gets ENGENTY_WIZARDS_CI from the command, which sees CI. */
export const isCI = (env: NodeJS.ProcessEnv) => truthy(env.CI) || truthy(env.ENGENTY_WIZARDS_CI);

export interface Policy {
  on: boolean;
  /** Why, in a few words, for the status and the studio. */
  reason: string;
}

/**
 * Whether this install updates itself. The variable switches it off whatever else says;
 * `wizards autoupdate on|off` decides next; without either it is on, except in CI and for an
 * install set up without a terminal.
 */
export function autoUpdatePolicy(
  paths: Layout,
  options: { installed: boolean; env?: NodeJS.ProcessEnv; note?: InstallNote },
): Policy {
  const env = options.env ?? process.env;
  if (!options.installed) {
    return { on: false, reason: "only an install made by install.sh updates itself" };
  }
  if (
    truthy(env.WIZARDS_DISABLE_AUTOUPDATE ?? readEnvFile(paths.envFile).WIZARDS_DISABLE_AUTOUPDATE)
  ) {
    return { on: false, reason: "WIZARDS_DISABLE_AUTOUPDATE is set" };
  }
  const { autoUpdate, unattended } = options.note ?? readInstallNote(paths);
  if (autoUpdate !== undefined) {
    return { on: autoUpdate, reason: autoUpdate ? "turned on" : "turned off" };
  }
  if (isCI(env)) {
    return { on: false, reason: "off in CI" };
  }
  if (unattended) {
    return { on: false, reason: "off: set up without a terminal" };
  }
  return { on: true, reason: "on" };
}

// --- checking and downloading ----------------------------------------------------------------

/** What the update does to the world; tests replace it. */
export interface UpdateDeps {
  fetch: typeof fetch;
  /** Installs a package (`@engenty/wizards-runtime@1.2.3`) into an npm prefix with the install's own Node. */
  npmInstall(paths: Layout, prefix: string, spec: string): Promise<void>;
  now(): Date;
}

export const systemDeps: UpdateDeps = {
  fetch: (...args) => fetch(...args),
  npmInstall,
  now: () => new Date(),
};

/** The version npm's `latest` tag names; null when it names none. */
async function latestVersion(deps: UpdateDeps, env: NodeJS.ProcessEnv): Promise<string | null> {
  const response = await deps.fetch(env.ENGENTY_WIZARDS_REGISTRY_URL?.trim() || LATEST_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`The npm registry answered ${response.status} for the newest version.`);
  }
  const { version } = (await response.json()) as { version?: unknown };
  return typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version) ? version : null;
}

/** npm of the install's own Node, as install.sh runs it; its output goes to logs/update.log. */
async function npmInstall(paths: Layout, prefix: string, spec: string): Promise<void> {
  const bin = join(paths.tools, "node", "bin");
  mkdirSync(paths.logs, { recursive: true });
  const log = openSync(join(paths.logs, "update.log"), "a");
  const args =
    "install --omit=dev --ignore-scripts --legacy-peer-deps --no-audit --no-fund --loglevel=error";
  const code = await new Promise<number>((done) => {
    const child = spawn(join(bin, "npm"), [...args.split(" "), "--prefix", prefix, spec], {
      stdio: ["ignore", log, log],
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    child.on("error", () => done(127));
    child.on("exit", (exit) => done(exit ?? 1));
  });
  if (code !== 0) {
    throw new Error(`npm install of the new version failed (exit ${code}); see logs/update.log.`);
  }
}

export type CheckResult =
  | { kind: "off" | "skipped" | "failed"; reason: string }
  | { kind: "current" | "downloaded"; version: string };

/**
 * Asks npm for the newest version and, when it is newer than the current one, installs it into
 * its version folder (npm checks the package against the registry's integrity hash). It switches nothing. `force` asks even
 * within the hour since the last time.
 */
export async function checkForUpdate(
  paths: Layout,
  options: { policy: Policy; force?: boolean; env?: NodeJS.ProcessEnv },
  deps: UpdateDeps = systemDeps,
): Promise<CheckResult> {
  if (!options.policy.on) {
    return { kind: "off", reason: options.policy.reason };
  }
  const state = readUpdateState(paths);
  const now = deps.now();
  const current = currentVersion(paths);
  if (!current) {
    return { kind: "skipped", reason: "no runtime installed" };
  }
  if (!options.force && now.getTime() - Date.parse(state.checkedAt ?? "0") < HOUR) {
    return { kind: "skipped", reason: "asked within the hour" };
  }
  state.checkedAt = now.toISOString();
  delete state.error;
  const tmp = mkdtempSync(join(paths.home, "update-"));
  try {
    const version = await latestVersion(deps, options.env ?? process.env);
    if (!version || !isNewer(version, current)) {
      return { kind: "current", version: current };
    }
    if (state.pending?.version !== version || !versionIn(runtimeDir(paths, version))) {
      await deps.npmInstall(paths, tmp, `${RUNTIME_PACKAGE}@${version}`);
      promote(paths, tmp, version);
      state.pending = { version, notes: notesUrl(version) };
      prune(paths, keepOf(state));
    }
    return { kind: "downloaded", version };
  } catch (error) {
    state.error = (error as Error).message;
    return { kind: "failed", reason: state.error };
  } finally {
    writeUpdateState(paths, state);
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** The versions kept besides the current one: the one waiting and the one before. */
const keepOf = (state: UpdateState) =>
  [state.pending?.version, state.updated?.from].filter((v): v is string => Boolean(v));

// --- switching -------------------------------------------------------------------------------

/**
 * Makes a downloaded version `current`. Only called where no runtime runs (`wizards start`
 * before it starts one), so no run is cut off; a version that is no longer newer is dropped.
 */
export function applyPendingUpdate(
  paths: Layout,
  now = new Date(),
): { from: string; to: string } | null {
  const state = readUpdateState(paths);
  const { pending } = state;
  const from = currentVersion(paths);
  if (!pending || !from) {
    return null;
  }
  delete state.pending;
  try {
    if (!isNewer(pending.version, from)) {
      return null;
    }
    switchTo(paths, pending.version);
    state.updated = { from, to: pending.version, at: now.toISOString(), notes: pending.notes };
    prune(paths, [from]);
    return { from, to: pending.version };
  } catch (error) {
    state.error = (error as Error).message;
    return null;
  } finally {
    writeUpdateState(paths, state);
  }
}

/** Notes a switch somebody made by hand (`wizards update`), so the notice says it too. */
export function noteUpdated(paths: Layout, from: string, to: string, now = new Date()) {
  if (from !== to) {
    const state = readUpdateState(paths);
    delete state.pending;
    state.updated = { from, to, at: now.toISOString(), notes: notesUrl(to) };
    writeUpdateState(paths, state);
  }
}

/** What the status and the studio say: a fresh update, or one waiting for the next start. */
export function updateNotice(paths: Layout, running: string, now = new Date()) {
  const { updated, pending } = readUpdateState(paths);
  return {
    updated:
      updated?.to === running && now.getTime() - Date.parse(updated.at) < NOTICE_MS
        ? updated
        : null,
    pending: pending && isNewer(pending.version, running) ? pending : null,
  };
}

/** The runtime's part: a check soon after it starts, then once a day. */
export function scheduleUpdateChecks(paths: Layout, policy: () => Policy, deps = systemDeps) {
  if (!policy().on) {
    return;
  }
  const check = async (force: boolean) => {
    const result = await checkForUpdate(paths, { policy: policy(), force }, deps);
    if (result.kind === "downloaded") {
      console.log(`[update] ${result.version} is ready; it runs from the next start.`);
    } else if (result.kind === "failed") {
      console.error(`[update] ${result.reason}`);
    }
  };
  setTimeout(() => void check(false), 30_000).unref();
  setInterval(() => void check(true), 24 * HOUR).unref();
}
