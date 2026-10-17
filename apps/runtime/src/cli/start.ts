import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { mintLocalTicket } from "../auth/local-ticket.js";
import { type Running, readRunning } from "../running.js";
import { RESTART_EXIT } from "../update.js";
import { applyPendingUpdate, autoUpdatePolicy, notesUrl } from "./autoupdate.js";
import { runtimeEnv } from "./environment.js";
import { installedByScript, type Layout, packageRoot, readEnvFile } from "./home.js";
import { findOnPath } from "./machine.js";
import { cmd, cyan, dim, live, tilde } from "./ui.js";

const DEFAULT_PORT = 24368;
const START_TIMEOUT_MS = 60_000;

/** The settings this install starts with: its `.env`, overridden by the terminal's variables. */
export function settings(paths: Layout, env: NodeJS.ProcessEnv = process.env) {
  const fileEnv = readEnvFile(paths.envFile);
  const value = (key: string) => env[key]?.trim() || fileEnv[key]?.trim() || "";
  return {
    fileEnv,
    dataDir: value("DATA_DIR") ? resolve(paths.home, value("DATA_DIR")) : paths.data,
    port: Number(value("API_PORT")) || null,
    appUrl: value("APP_URL").replace(/\/$/, ""),
  };
}

/**
 * The secret the runtime this command starts signs with, read the way it reads it (env.ts): its
 * APP_SECRET, else the one it keeps in the data folder; null before it made one. The runtime
 * never sees the terminal's APP_SECRET (cli/environment.ts), only its folder's `.env.local` and
 * `.env`, so the terminal's is left out here too: a ticket signed with it would be refused.
 */
export function readSecret(paths: Layout, env: NodeJS.ProcessEnv = process.env): string | null {
  const { fileEnv, dataDir } = settings(paths, env);
  const given =
    readEnvFile(join(paths.home, ".env.local")).APP_SECRET?.trim() || fileEnv.APP_SECRET?.trim();
  if (given) {
    return given;
  }
  try {
    return readFileSync(join(dataDir, "secret"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

export async function healthy(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const probe = createServer();
    probe.once("error", () => done(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => done(true)));
  });
}

/** The usual port, or the next free one after it. */
async function freePort(): Promise<number> {
  for (let port = DEFAULT_PORT; port < DEFAULT_PORT + 20; port++) {
    if (await portIsFree(port)) {
      return port;
    }
  }
  throw new Error(`No free port between ${DEFAULT_PORT} and ${DEFAULT_PORT + 19}.`);
}

/** The runtime that already runs on this install's data folder and answers. */
export async function runningRuntime(dataDir: string): Promise<Running | null> {
  const running = readRunning(dataDir);
  return running && (await healthy(running.port)) ? running : null;
}

/** A link that lets this browser into a running runtime: a ticket signed with the runtime's secret. */
export function entryUrl(
  running: Pick<Running, "url">,
  paths: Layout,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const secret = readSecret(paths, env);
  // No secret to be read here: the browser gets in if it was let in before.
  return secret ? `${running.url}/api/local/enter?t=${mintLocalTicket(secret)}` : `${running.url}/`;
}

/** Opens an address in the person's browser; false when this machine has none to open it with. */
export function openBrowser(url: string): boolean {
  const opener =
    process.platform === "darwin"
      ? "open"
      : process.env.DISPLAY || process.env.WAYLAND_DISPLAY
        ? "xdg-open"
        : null;
  if (!opener || !findOnPath(opener, process.env.PATH ?? "")) {
    return false;
  }
  try {
    spawn(opener, [url], { stdio: "ignore", detached: true }).unref();
    return true;
  } catch {
    return false;
  }
}

function show(url: string, entry: string, open: boolean) {
  const opened = open && openBrowser(entry);
  console.log("");
  console.log(`  ${live} engenty wizards is running: ${cyan(url)}`);
  if (opened) {
    console.log(dim("    The studio opens in your browser."));
  } else {
    console.log(`    Open the studio: ${cyan(entry)}`);
    console.log(dim("    The link signs in one browser and works only once."));
  }
}

/** The command of this install, as it is on disk now: `wizards <args>`. */
function spawnCommand(paths: Layout, args: string[], options: SpawnOptions): ChildProcess {
  const wrapper = join(paths.bin, "wizards");
  return existsSync(wrapper)
    ? spawn(wrapper, args, options)
    : spawn(process.execPath, [join(packageRoot, "bin/wizards.mjs"), ...args], options);
}

/**
 * `wizards start --no-open` detached from this terminal, its output in logs/runtime.log; the
 * runtime once it answers, or null when it ended or did not answer within a minute.
 */
export async function startInBackground(paths: Layout): Promise<Running | null> {
  const { dataDir } = settings(paths);
  mkdirSync(paths.logs, { recursive: true });
  const log = openSync(join(paths.logs, "runtime.log"), "a");
  const child = spawnCommand(paths, ["start", "--no-open"], {
    cwd: paths.home,
    detached: true,
    stdio: ["ignore", log, log],
  });
  let exited = false;
  child.on("error", () => {
    exited = true;
  });
  child.on("exit", () => {
    exited = true;
  });
  child.unref();
  const began = Date.now();
  while (!exited && Date.now() - began < START_TIMEOUT_MS) {
    await new Promise((wait) => setTimeout(wait, 300));
    const started = await runningRuntime(dataDir);
    if (started) {
      return started;
    }
  }
  return null;
}

/**
 * Starts the runtime of this install and opens the studio: in the foreground, or with
 * `background` detached from this terminal. If one already runs on the same data folder
 * (another terminal, the desktop app), that one is opened instead.
 */
export async function start(
  paths: Layout,
  options: { open: boolean; background?: boolean },
): Promise<number> {
  const { fileEnv, dataDir, port: wanted, appUrl } = settings(paths);
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(paths.logs, { recursive: true });

  const running = await runningRuntime(dataDir);
  if (running) {
    show(running.url, entryUrl(running, paths), options.open);
    console.log(dim(`    It was already running. To stop it: ${cmd("stop")}`));
    return 0;
  }

  // Nothing runs, so no run is cut off: a version downloaded meanwhile becomes current and
  // takes this process's place (the login item keeps waiting on the same pid). In the
  // background, the `start` spawned below does it.
  if (!options.background && installedByScript(paths) && process.execve) {
    const switched = autoUpdatePolicy(paths, { installed: true }).on && applyPendingUpdate(paths);
    if (switched) {
      console.log(`  ${live} Updated to ${switched.to}. What changed: ${notesUrl(switched.to)}`);
      const wrapper = join(paths.bin, "wizards");
      try {
        process.execve(wrapper, [wrapper, "start", ...(options.open ? [] : ["--no-open"])]);
      } catch {
        // This version starts once more; the next start is the new one.
      }
    }
  }

  if (options.background) {
    const started = await startInBackground(paths);
    if (!started) {
      console.error(
        `engenty wizards didn’t start. Its log is in ${tilde(join(paths.logs, "runtime.log"))}.`,
      );
      return 1;
    }
    show(started.url, entryUrl(started, paths), options.open);
    console.log(dim(`    It’s running in the background. To stop it: ${cmd("stop")}`));
    console.log(dim(`    Its log is in ${tilde(join(paths.logs, "runtime.log"))}.`));
    return 0;
  }

  const port = wanted ?? (await freePort());
  if (!wanted && port !== DEFAULT_PORT) {
    console.log(dim(`  Port ${DEFAULT_PORT} is taken, so it uses ${port}.`));
  }
  const accessKey = randomBytes(24).toString("hex");
  const url = appUrl || `http://localhost:${port}`;
  const child = spawn(process.execPath, [join(packageRoot, "apps/runtime/dist/index.js")], {
    cwd: paths.home,
    env: {
      ...runtimeEnv(paths, { port, url, dataDir, accessKey }, process.env, fileEnv),
      // This command starts it again when it exits with RESTART_EXIT.
      ENGENTY_WIZARDS_RESTARTS: "1",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  let current: ChildProcess = child;

  let exited: number | null = null;
  const ended = new Promise<number>((done) => {
    child.on("error", (error) => {
      console.error(`engenty wizards didn’t start: ${error.message}`);
      exited = 1;
      done(1);
    });
    child.on("exit", (code, signal) => {
      exited = code ?? (signal ? 0 : 1);
      done(exited);
    });
  });
  // Ctrl-C reaches the runtime as well (same terminal); it closes its browser and its databases.
  process.on("SIGINT", () => undefined);
  process.on("SIGTERM", () => current.kill("SIGTERM"));

  const began = Date.now();
  while (exited === null && !(await healthy(port))) {
    if (Date.now() - began > START_TIMEOUT_MS) {
      child.kill("SIGTERM");
      console.error("engenty wizards didn’t respond within 60 seconds.");
      return 1;
    }
    await new Promise((wait) => setTimeout(wait, 150));
  }
  if (exited !== null) {
    return exited || 1;
  }
  show(url, `${url}/api/local/enter?k=${accessKey}`, options.open);
  console.log(dim("    To stop it, press Ctrl-C."));
  console.log("");
  const code = await ended;
  if (code !== RESTART_EXIT) {
    return code;
  }
  // Updated or `wizards restart`: the command as it is on disk now starts it again, in this
  // terminal or under the login item, which keeps waiting on this process.
  console.log(dim("  Restarting…"));
  current = spawnCommand(paths, ["start", "--no-open"], { stdio: "inherit" });
  return new Promise<number>((done) => {
    current.on("error", () => done(1));
    current.on("exit", (exit) => done(exit ?? 0));
  });
}

/** `wizards studio`: opens the studio in the browser; when nothing runs, it starts as a service first. */
export async function studio(paths: Layout): Promise<number> {
  const { dataDir } = settings(paths);
  const running = await runningRuntime(dataDir);
  if (running) {
    show(running.url, entryUrl(running, paths), true);
    return 0;
  }
  return start(paths, { open: true, background: true });
}

/** `wizards open`: lets the browser into the runtime that runs. */
export async function open(paths: Layout, print: boolean): Promise<number> {
  const { dataDir } = settings(paths);
  const running = await runningRuntime(dataDir);
  if (!running) {
    console.error(`engenty wizards isn’t running. To start it: ${cmd("start")}`);
    return 1;
  }
  const entry = entryUrl(running, paths);
  if (print || !openBrowser(entry)) {
    console.log(entry);
  }
  return 0;
}
