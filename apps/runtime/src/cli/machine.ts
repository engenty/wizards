import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
// The search for a browser is shared with env.ts, so the runtime uses the one the setup found.
import { findChrome, findOnPath } from "../render/browser-path.js";
import { runtimePath } from "./environment.js";
import type { Layout } from "./home.js";

export { findChrome, findOnPath };

const run = promisify(execFile);

/** How the setup installs an AI client: with npm into the install's own prefix, or by the vendor's script. */
export type ClientInstall = { kind: "npm"; pkg: string } | { kind: "script"; url: string };

export interface Client {
  id: "codex" | "claude" | "antigravity" | "cursor";
  name: string;
  bin: string;
  /** The subscription it answers on. */
  account: string;
  install: ClientInstall;
  /** The vendor's desktop app: on this machine, the person most likely has the subscription. */
  app?: string;
}

/** The AI clients the runtime can think with, in the order its own setup offers them. */
export const CLIENTS: readonly Client[] = [
  {
    id: "codex",
    name: "Codex",
    bin: "codex",
    account: "ChatGPT",
    install: { kind: "npm", pkg: "@openai/codex" },
    app: "ChatGPT",
  },
  {
    id: "claude",
    name: "Claude Code",
    bin: "claude",
    account: "Claude",
    install: { kind: "script", url: "https://claude.ai/install.sh" },
    app: "Claude",
  },
  {
    id: "antigravity",
    name: "Antigravity",
    bin: "agy",
    account: "Google AI",
    install: { kind: "script", url: "https://antigravity.google/cli/install.sh" },
    app: "Antigravity",
  },
  {
    id: "cursor",
    name: "Cursor Agent",
    bin: "cursor-agent",
    account: "Cursor",
    install: { kind: "script", url: "https://cursor.com/install" },
    app: "Cursor",
  },
];

const APP_ROOTS = ["/Applications", join(homedir(), "Applications")];

/** Whether `<name>.app` is in one of the Mac's Applications folders. */
export function macAppPresent(name: string, roots = APP_ROOTS): boolean {
  return roots.some((root) => existsSync(join(root, `${name}.app`)));
}

/** The client's desktop app, when it is on this Mac: its name, e.g. "Claude". */
export function vendorApp(client: Client, roots = APP_ROOTS) {
  if (process.platform !== "darwin" || !client.app) {
    return null;
  }
  return macAppPresent(client.app, roots) ? client.app : null;
}

/**
 * The client the setup suggests among those not installed: the one whose app is on this Mac —
 * its subscription is most likely already paid for — else the first.
 */
export function suggestedClient<T extends { client: Client }>(missing: T[]): T | null {
  return missing.find((state) => vendorApp(state.client)) ?? missing[0] ?? null;
}

/** The first file of that name on a PATH that may be run. */

/** What a command prints for `--version`: its last word that looks like one. */
async function versionOf(file: string, path: string): Promise<string | null> {
  try {
    const { stdout } = await run(file, ["--version"], {
      timeout: 10_000,
      env: { ...process.env, PATH: path, TERM: "dumb" },
    });
    const line = stdout.trim().split("\n").pop()?.trim() ?? "";
    return line.match(/\d+\.\d+[\w.+-]*/)?.[0] ?? (line || null);
  } catch {
    return null;
  }
}

export interface Found {
  /** Where it is; null: not on this machine. */
  path: string | null;
  version: string | null;
}

export interface ClientState extends Found {
  client: Client;
}

export async function detectClients(paths: Layout): Promise<ClientState[]> {
  const path = runtimePath(paths, process.env);
  return Promise.all(
    CLIENTS.map(async (client) => {
      const file = findOnPath(client.bin, path);
      // A file that does not answer `--version` is not a client we can run.
      const version = file ? await versionOf(file, path) : null;
      return { client, path: version ? file : null, version };
    }),
  );
}

export async function findFfmpeg(env: NodeJS.ProcessEnv = process.env): Promise<Found> {
  const path = env.PATH ?? "";
  const file = env.FFMPEG_PATH || findOnPath("ffmpeg", path);
  if (!file) {
    return { path: null, version: null };
  }
  try {
    const { stdout } = await run(file, ["-version"], { timeout: 10_000 });
    return { path: file, version: stdout.match(/ffmpeg version (\S+)/)?.[1] ?? null };
  } catch {
    return { path: null, version: null };
  }
}

/** Node 24.11 or newer: what the runtime is built for. */
export function nodeIsCurrent(version = process.versions.node): boolean {
  const [major, minor] = version.split(".").map(Number);
  return major > 24 || (major === 24 && minor >= 11);
}
