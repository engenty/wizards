import { CLIENTS, type ClientEntry } from "@engenty/model-setup";
// The search for a browser is shared with env.ts, so the runtime uses the one the setup found.
import { findChrome, findOnPath } from "../render/browser-path.js";
import { runtimePath, withPath } from "./environment.js";
import { runFile as run } from "./exec.js";
import type { Layout } from "./home.js";

export { findChrome, findOnPath };

/** What a command prints for `--version`: its last word that looks like one. */
async function versionOf(file: string, path: string): Promise<string | null> {
  try {
    const { stdout } = await run(file, ["--version"], {
      timeout: 10_000,
      env: { ...withPath(process.env, path), TERM: "dumb" },
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
  client: ClientEntry;
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
