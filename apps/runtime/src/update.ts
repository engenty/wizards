import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import {
  autoUpdatePolicy,
  isNewer,
  scheduleUpdateChecks,
  type UpdateState,
  updateNotice,
} from "./cli/autoupdate.js";
import { installedByScript, isCheckout, layout, packageRoot, packageVersion } from "./cli/home.js";

export { isNewer };

const RELEASES_URL =
  process.env.ENGENTY_WIZARDS_RELEASES_URL?.trim() ||
  "https://api.github.com/repos/engenty/wizards/releases/latest";
/** How long an answer from GitHub holds, found or not, before the runtime asks again. */
const CHECK_EVERY_MS = 60 * 60_000;

/**
 * The exit code with which the runtime asks the command that started it for a restart: after an
 * update, that command starts the new version (cli/start.ts).
 */
export const RESTART_EXIT = 75;

/** Set by the command that starts the runtime when it starts it again on RESTART_EXIT. */
const RESTARTS = "ENGENTY_WIZARDS_RESTARTS";

/** How this copy got here: only an install made by install.sh can update itself. */
export type InstallKind = "script" | "checkout" | "npm";

export interface UpdateStatus {
  current: string;
  /** The newest release, or null when it is not known (no network, or the check is off). */
  latest: string | null;
  newer: boolean;
  kind: InstallKind;
  /** Where the release is described. */
  url: string | null;
  /** The studio can run the update itself. */
  canApply: boolean;
  /** After an update the runtime starts the new version by itself; else the person restarts it. */
  restarts: boolean;
  applying: "idle" | "running" | "done" | "failed";
  /** When GitHub was last asked, found or not; null before the first time. */
  checkedAt: number | null;
  /** False where ENGENTY_WIZARDS_NO_UPDATE_CHECK keeps the runtime from asking. */
  enabled: boolean;
  /** Downloaded and waiting for the next start. */
  pending: UpdateState["pending"] | null;
  /** The update this version came with, for a while after it: "Updated to …, what changed". */
  updated: UpdateState["updated"] | null;
}

let cached: { at: number; latest: string | null; url: string | null } | null = null;
let applying: UpdateStatus["applying"] = "idle";
let restart: ((code: number) => void) | null = null;

/** How the runtime stops cleanly; the update calls it with RESTART_EXIT once it is installed. */
export function onRestart(shutdown: (code: number) => void) {
  restart = shutdown;
}

function restarts(): boolean {
  return process.env[RESTARTS] === "1" && restart !== null;
}

const enabled = () => !process.env.ENGENTY_WIZARDS_NO_UPDATE_CHECK;

/** The newest release GitHub knows; `fresh` asks again although the last answer still holds. */
async function newestRelease(
  fresh = false,
): Promise<{ latest: string | null; url: string | null }> {
  if (!enabled()) {
    return { latest: null, url: null };
  }
  const age = cached ? Date.now() - cached.at : Number.POSITIVE_INFINITY;
  if (cached && age < CHECK_EVERY_MS && !fresh) {
    return cached;
  }
  let found: { latest: string | null; url: string | null } = { latest: null, url: null };
  try {
    const response = await fetch(RELEASES_URL, {
      headers: { accept: "application/vnd.github+json", "user-agent": "engenty-wizards" },
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) {
      const release = (await response.json()) as { tag_name?: string; html_url?: string };
      if (typeof release.tag_name === "string" && /^v?\d+\.\d+/.test(release.tag_name)) {
        found = { latest: release.tag_name.replace(/^v/, ""), url: release.html_url ?? null };
      }
    }
  } catch {
    // offline: the studio says nothing
  }
  cached = { at: Date.now(), ...found };
  return found;
}

function installKind(): InstallKind {
  return installedByScript() ? "script" : isCheckout() ? "checkout" : "npm";
}

export async function updateStatus(fresh = false): Promise<UpdateStatus> {
  const current = packageVersion();
  const { latest, url } = await newestRelease(fresh);
  const kind = installKind();
  const paths = layout();
  const notice =
    kind === "script" ? updateNotice(paths, current) : { updated: null, pending: null };
  return {
    current,
    latest,
    newer: latest !== null && isNewer(latest, current),
    kind,
    url,
    canApply: kind === "script",
    restarts: restarts(),
    applying,
    checkedAt: cached?.at ?? null,
    enabled: enabled(),
    ...notice,
  };
}

const autoPolicy = () => autoUpdatePolicy(layout(), { installed: installKind() === "script" });

/** The runtime looks for an update when it starts and once a day; it switches nothing itself. */
export function startUpdateChecks() {
  scheduleUpdateChecks(layout(), autoPolicy);
}

/**
 * Runs `wizards update` in the background, the same steps as in a terminal. Afterwards a
 * runtime started by the command restarts into the new version; any other keeps running the old
 * one until somebody restarts it. The output goes to logs/update.log.
 */
export function applyUpdate(): UpdateStatus["applying"] {
  if (applying === "running" || installKind() !== "script") {
    return applying;
  }
  const paths = layout();
  mkdirSync(paths.logs, { recursive: true });
  const log = openSync(join(paths.logs, "update.log"), "a");
  applying = "running";
  const child = spawn(process.execPath, [join(packageRoot, "bin/wizards.mjs"), "update"], {
    cwd: paths.home,
    stdio: ["ignore", log, log],
  });
  child.on("error", () => {
    applying = "failed";
  });
  child.on("exit", (code) => {
    applying = code === 0 ? "done" : "failed";
    if (applying === "done" && restarts()) {
      // A moment for the page to hear that it is done.
      setTimeout(() => restart?.(RESTART_EXIT), 1500);
    }
  });
  return applying;
}
