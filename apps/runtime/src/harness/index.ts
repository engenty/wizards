import { mkdirSync } from "node:fs";
import { installCommand } from "../cli/clients.js";
import { inherited, runtimePath } from "../cli/environment.js";
import { layout } from "../cli/home.js";
import { CLIENTS, vendorApp } from "../cli/machine.js";
import { antigravity } from "./antigravity.js";
import { claude } from "./claude.js";
import { codex } from "./codex.js";
import { cursor } from "./cursor.js";
import { forgetEnv, loginShellEnv, resolveEnv } from "./env.js";
import type { Harness, HarnessAuth, HarnessId } from "./types.js";

export { HarnessModel, notInstalled, signedOut } from "./model.js";
export { HARNESS_IDS, type Harness, type HarnessAuth, type HarnessId } from "./types.js";

/**
 * The AI clients this runtime can run as a model, in the order the setup offers them. The first
 * one installed is the one the setup recommends.
 */
export const HARNESSES: readonly Harness[] = [codex, claude, antigravity, cursor];

export function harness(id: string): Harness | null {
  return HARNESSES.find((h) => h.id === id) ?? null;
}

/** Whether a binding's vendor names a client: `claude/sonnet`, `codex/default`. */
export function isHarnessVendor(vendor: string): vendor is HarnessId {
  return HARNESSES.some((h) => h.id === vendor);
}

/** A client on this machine: what the setup and the settings show of it. */
export interface HarnessStatus {
  id: HarnessId;
  name: string;
  /** How to install it in a terminal; the setup runs the same command. */
  install: string;
  /** The vendor's desktop app on this machine ("Claude"): the subscription is most likely there. */
  app: string | null;
  /** Null: not installed. */
  version: string | null;
  auth: HarnessAuth;
  /** The sign-in opens the client's own app, which the person ends. */
  interactiveLogin: boolean;
  /** It makes images on the sign-in as well (Codex); video and audio no client makes. */
  images: boolean;
}

const detected = new Map<HarnessId, { at: number; value: HarnessStatus }>();

/** One client, as it is now; asked again after a minute — it may get installed or signed in meanwhile. */
export async function detectHarness(id: HarnessId, force = false): Promise<HarnessStatus | null> {
  const h = harness(id);
  if (!h) {
    return null;
  }
  const hit = detected.get(id);
  if (!force && hit && Date.now() - hit.at < 60_000) {
    return hit.value;
  }
  if (force) {
    // The person may just have signed in or set a key in their shell.
    forgetEnv(id);
  }
  const client = CLIENTS.find((c) => c.id === id);
  let value: HarnessStatus = {
    id,
    name: h.name,
    install: client ? installCommand(client, layout()) : "",
    app: client ? vendorApp(client) : null,
    version: null,
    auth: "none",
    interactiveLogin: h.login.interactive,
    images: Boolean(h.image),
  };
  try {
    const { env, auth } = await resolveEnv(h);
    const version = await h.version(env);
    if (version) {
      value = { ...value, version, auth };
    }
  } catch {
    // not installed
  }
  detected.set(id, { at: Date.now(), value });
  return value;
}

/** Every client this runtime knows, installed or not. */
export function detectHarnesses(force = false): Promise<HarnessStatus[]> {
  return Promise.all(HARNESSES.map((h) => detectHarness(h.id, force) as Promise<HarnessStatus>));
}

/**
 * What the inline terminal runs to install a client: the command the terminal setup runs, shown
 * first. A client from npm goes into the install's own prefix with the npm of its own Node.
 */
export async function installSpec(
  id: string,
): Promise<{ bin: string; args: string[]; env: NodeJS.ProcessEnv } | null> {
  const client = CLIENTS.find((c) => c.id === id);
  if (!client) {
    return null;
  }
  const paths = layout();
  mkdirSync(paths.clients, { recursive: true });
  const shell = await loginShellEnv();
  return {
    bin: "bash",
    args: [
      "-c",
      'printf "\\033[2m$ %s\\033[0m\\n\\n" "$1"; set -o pipefail; eval "$1"',
      "install",
      installCommand(client, paths),
    ],
    env: {
      ...inherited(process.env),
      PATH: runtimePath(paths, { ...process.env, PATH: shell.PATH || process.env.PATH }),
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    },
  };
}
