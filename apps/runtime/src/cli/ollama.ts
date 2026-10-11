import { spawn } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { statfs } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { decisionModelIn, ollamaRoot } from "../decision-model.js";
import { runLogged } from "./exec.js";
import type { Layout } from "./home.js";
import { findOnPath } from "./machine.js";

/** The first Ollama that answers decision questions at /v1/systemone. */
const DECISIONS_SINCE = [0, 35, 0];

/** What Clef-flash takes on disk, and about as much memory while it answers, in GB. */
export const DECISION_MODEL_GB = 11;

/** The Ollama app on a Mac: its server and its command are inside it. */
const MAC_APPS = ["/Applications/Ollama.app", join(homedir(), "Applications", "Ollama.app")];
const MAC_DOWNLOAD = "https://ollama.com/download/Ollama-darwin.zip";
/** Ollama's own installer on Linux: it puts the server in a systemd service, with sudo. */
const LINUX_SCRIPT = "https://ollama.com/install.sh";

export interface OllamaState {
  /** The `ollama` command; null where Ollama is not installed. */
  path: string | null;
  /** The version of the server that answers; null where none does. */
  version: string | null;
  /** The decision model it holds, as Ollama names it. */
  model: string | null;
}

/** Where Ollama answers: OLLAMA_URL as the runtime takes it (…/v1), without the /v1. */
export function ollamaAddress(env: NodeJS.ProcessEnv = process.env): string {
  return ollamaRoot(env.OLLAMA_URL || "http://127.0.0.1:11434/v1");
}

function executable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The `ollama` command: on the PATH, or inside the app on a Mac that never linked it. */
export function findOllama(env: NodeJS.ProcessEnv = process.env): string | null {
  const onPath = findOnPath("ollama", env.PATH ?? "");
  if (onPath || process.platform !== "darwin") {
    return onPath;
  }
  return (
    MAC_APPS.map((app) => join(app, "Contents", "Resources", "ollama")).find(executable) ?? null
  );
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

export async function ollamaState(env: NodeJS.ProcessEnv = process.env): Promise<OllamaState> {
  const root = ollamaAddress(env);
  const version = (await getJson<{ version?: string }>(`${root}/api/version`))?.version ?? null;
  const tags = version ? await getJson<{ models?: { name: string }[] }>(`${root}/api/tags`) : null;
  return {
    path: findOllama(env),
    version,
    model: decisionModelIn((tags?.models ?? []).map((m) => m.name)),
  };
}

/** Whether this Ollama is new enough to answer decision questions. */
export function servesDecisions(version: string): boolean {
  const parts = version.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  for (const [i, wanted] of DECISIONS_SINCE.entries()) {
    const have = parts[i] ?? 0;
    if (have !== wanted) {
      return have > wanted;
    }
  }
  return true;
}

/** Free space where Ollama keeps its models (the home folder), in GB. */
export async function freeGb(dir = homedir()): Promise<number | null> {
  try {
    const stats = await statfs(dir);
    return Math.floor((stats.bavail * stats.bsize) / 2 ** 30);
  } catch {
    return null;
  }
}

/** The app an `ollama` command belongs to on a Mac; null for one from Homebrew or elsewhere. */
function macApp(path: string | null): string | null {
  if (process.platform !== "darwin") {
    return null;
  }
  if (!path) {
    return MAC_APPS.find((app) => existsSync(app)) ?? null;
  }
  try {
    const real = realpathSync(path);
    const at = real.indexOf(".app/");
    return at > 0 ? real.slice(0, at + 4) : null;
  } catch {
    return null;
  }
}

export interface Outcome {
  ok: boolean;
  message: string;
}

/**
 * Installs Ollama. On a Mac its app goes into Applications (~/Applications where that is not
 * writable) and asks for no password; on Linux Ollama's own script runs in this terminal and
 * asks for one, as it installs a system service.
 */
export async function installOllama(
  paths: Layout,
  onLine: (line: string) => void,
): Promise<Outcome> {
  const logFile = join(paths.logs, "install.log");
  if (process.platform === "darwin") {
    let target = "/Applications";
    try {
      accessSync(target, constants.W_OK);
    } catch {
      target = join(homedir(), "Applications");
      mkdirSync(target, { recursive: true });
    }
    const tmp = mkdtempSync(join(tmpdir(), "ollama-"));
    try {
      const zip = join(tmp, "Ollama.zip");
      const download = await runLogged("curl", ["-fsSL", MAC_DOWNLOAD, "-o", zip], {
        logFile,
        onLine,
      });
      if (download.code !== 0) {
        return { ok: false, message: `The download failed. ${lastLine(download.tail)}` };
      }
      const unpack = await runLogged("ditto", ["-x", "-k", zip, target], { logFile, onLine });
      if (unpack.code !== 0) {
        return { ok: false, message: `It could not be unpacked. ${lastLine(unpack.tail)}` };
      }
      return { ok: true, message: join(target, "Ollama.app") };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  if (process.platform === "linux") {
    const code = await new Promise<number>((resolve) => {
      const child = spawn("sh", ["-c", `curl -fsSL ${LINUX_SCRIPT} | sh`], { stdio: "inherit" });
      child.on("error", () => resolve(127));
      child.on("close", (status) => resolve(status ?? 1));
    });
    return code === 0
      ? { ok: true, message: "ollama" }
      : { ok: false, message: `Ollama's installer stopped (exit ${code}).` };
  }
  return { ok: false, message: "Ollama is installed by this setup on macOS and Linux only." };
}

const lastLine = (text: string) => text.split("\n").pop() ?? "";

/**
 * Starts Ollama's server where it does not run: the app on a Mac (it then starts at login by
 * itself), Homebrew's service, else `ollama serve` in the background. Its version once it
 * answers; null where it does not within half a minute.
 */
export async function startOllama(path: string | null, paths: Layout): Promise<string | null> {
  const logFile = join(paths.logs, "install.log");
  const app = macApp(path);
  const brew = findOnPath("brew", process.env.PATH ?? "");
  let real = path ?? "";
  try {
    real = path ? realpathSync(path) : "";
  } catch {
    // a dangling link: started as it is
  }
  if (app) {
    await runLogged("open", ["-g", app], { logFile });
  } else if (brew && real.includes("/Cellar/ollama/")) {
    await runLogged(brew, ["services", "start", "ollama"], { logFile });
  } else if (path) {
    mkdirSync(paths.logs, { recursive: true });
    const out = openSync(join(paths.logs, "ollama.log"), "a");
    spawn(path, ["serve"], { detached: true, stdio: ["ignore", out, out] }).unref();
  } else {
    return null;
  }
  for (let i = 0; i < 60; i++) {
    const { version } = await ollamaState();
    if (version) {
      return version;
    }
    await sleep(500);
  }
  return null;
}

/**
 * Pulls a model into the running Ollama; `onProgress` hears the bytes so far and in all as they
 * come. Rejects with Ollama's own reason.
 */
export async function pullModel(
  model: string,
  onProgress: (done: number, total: number) => void,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const res = await fetch(`${ollamaAddress(env)}/api/pull`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream: true }),
  });
  if (!(res.ok && res.body)) {
    throw new Error(`Ollama answered ${res.status}. ${await res.text().catch(() => "")}`.trim());
  }
  // Each part of the model reports on its own; the sum is the download.
  const parts = new Map<string, { total: number; completed: number }>();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let finished = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      const event = JSON.parse(line) as {
        status?: string;
        digest?: string;
        total?: number;
        completed?: number;
        error?: string;
      };
      if (event.error) {
        throw new Error(event.error);
      }
      if (event.digest && event.total) {
        parts.set(event.digest, { total: event.total, completed: event.completed ?? 0 });
        let sum = 0;
        let all = 0;
        for (const part of parts.values()) {
          sum += part.completed;
          all += part.total;
        }
        onProgress(sum, all);
      }
      finished ||= event.status === "success";
    }
  }
  if (!finished) {
    throw new Error("The download broke off.");
  }
}
