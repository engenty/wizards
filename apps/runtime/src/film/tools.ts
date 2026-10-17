import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { env } from "../env.js";

/**
 * The HyperFrames CLI (github.com/heygen-com/hyperframes, Apache 2.0): renders a composition of
 * HTML, CSS and JS to MP4 frame by frame in headless Chrome. Installed once into the data folder
 * on the first film, pinned to a version; Chrome comes with it on its first render.
 */
export const HYPERFRAMES_VERSION = "0.8.137";

const home = join(env.dataDir, "tools", `hyperframes-${HYPERFRAMES_VERSION}`);
const entry = join(home, "node_modules", "hyperframes", "bin", "hyperframes.mjs");

let installing: Promise<string> | null = null;

/** Terminal colour codes. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** The CLI's entry script; installs it on first use. */
export function hyperframesEntry(): Promise<string> {
  if (existsSync(entry)) {
    return Promise.resolve(entry);
  }
  installing ??= install().finally(() => {
    installing = null;
  });
  return installing;
}

async function install(): Promise<string> {
  await mkdir(home, { recursive: true });
  // npm sits next to the node that runs us; else the one on PATH.
  const local = join(dirname(process.execPath), "npm");
  const npm = existsSync(local) ? local : "npm";
  const { code, out } = await spawnText(
    npm,
    [
      "install",
      "--prefix",
      home,
      "--no-audit",
      "--no-fund",
      "--loglevel",
      "error",
      `hyperframes@${HYPERFRAMES_VERSION}`,
    ],
    { cwd: home, timeoutMs: 10 * 60_000 },
  );
  if (code !== 0 || !existsSync(entry)) {
    throw new Error(`HyperFrames could not be installed: ${out.slice(-400)}`);
  }
  return entry;
}

/** What the CLI and the renderer see: no keys of ours, no telemetry. */
function cliEnv(): NodeJS.ProcessEnv {
  const pass = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR", "SHELL"];
  const out: NodeJS.ProcessEnv = {};
  for (const k of pass) {
    if (process.env[k]) {
      out[k] = process.env[k];
    }
  }
  // ffmpeg as the runtime finds it, first on the PATH.
  if (env.ffmpegPath.includes("/")) {
    out.PATH = `${dirname(env.ffmpegPath)}:${out.PATH ?? ""}`;
  }
  out.HYPERFRAMES_NO_TELEMETRY = "1";
  out.HYPERFRAMES_SKIP_SKILLS = "1";
  return out;
}

export interface CliResult {
  code: number;
  out: string;
}

/** Runs `hyperframes <args>` in a project folder and returns what it printed (the tail). */
export async function runHyperframes(
  args: string[],
  opts: { cwd: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<CliResult> {
  const cli = await hyperframesEntry();
  return spawnText(process.execPath, [cli, ...args], {
    cwd: opts.cwd,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs ?? 20 * 60_000,
    env: cliEnv(),
  });
}

function spawnText(
  bin: string,
  args: string[],
  opts: { cwd: string; signal?: AbortSignal; timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<CliResult> {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: opts.env ?? cliEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      signal: opts.signal,
    });
    const keep = (d: Buffer) => {
      out = (out + String(d)).slice(-30_000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 1, out: `${out}\n${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // Colours and progress bars mean nothing to a model reading this.
      resolve({ code: code ?? 1, out: out.replace(ANSI, "") });
    });
  });
}
