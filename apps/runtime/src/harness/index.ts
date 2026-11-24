import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  type ClientAuth,
  type ClientStatus,
  detectClient,
  loginShellEnv,
  setClientFolders,
} from "@engenty/local-models/clients";
import { installCommand, POWERSHELL } from "../cli/clients.js";
import { inherited, runtimePath } from "../cli/environment.js";
import { layout } from "../cli/home.js";
import { CLIENTS, vendorApp } from "../cli/machine.js";
import { antigravity } from "./antigravity.js";
import { claude, codex, cursor } from "./clients.js";
import type { Harness, HarnessId } from "./types.js";

export { HARNESS_IDS, type Harness, type HarnessId } from "./types.js";

/**
 * Where the setup installs clients, whoever started this runtime: npm's prefix (on Windows the
 * prefix itself), and on Windows where Claude Code and Cursor Agent put themselves. A client's
 * environment finds them before the shell's PATH.
 */
setClientFolders(() => {
  if (process.platform !== "win32") {
    return [join(layout().clients, "bin")];
  }
  const { USERPROFILE: home, LOCALAPPDATA: local } = process.env;
  return [
    layout().clients,
    ...(home ? [join(home, ".local", "bin")] : []),
    ...(local ? [join(local, "cursor-agent"), join(local, "agy", "bin")] : []),
  ];
});

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
  auth: ClientAuth;
  /** The sign-in opens the client's own app, which the person ends. */
  interactiveLogin: boolean;
  /** It makes images on the sign-in as well (Codex); video and audio no client makes. */
  images: boolean;
}

/** The status last made of each client's detection, kept while the detection holds. */
const statuses = new Map<HarnessId, { of: ClientStatus; value: HarnessStatus }>();

/** One client, as it is now; asked again after a minute — it may get installed or signed in meanwhile. */
export async function detectHarness(id: HarnessId, force = false): Promise<HarnessStatus | null> {
  const h = harness(id);
  if (!h) {
    return null;
  }
  const status = await detectClient(h, force);
  const kept = statuses.get(id);
  if (kept?.of === status) {
    return kept.value;
  }
  const client = CLIENTS.find((c) => c.id === id);
  const value: HarnessStatus = {
    id,
    name: h.name,
    install: client ? installCommand(client, layout()) : "",
    app: client ? vendorApp(client) : null,
    version: status.version,
    auth: status.auth,
    interactiveLogin: h.login.interactive,
    images: Boolean(h.image),
  };
  statuses.set(id, { of: status, value });
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
  if (process.platform === "win32") {
    const [bin, ...args] = POWERSHELL;
    const command = installCommand(client, paths);
    return {
      bin,
      args: [...args, `Write-Host "$ ${command.replaceAll('"', '`"')}\`n"; ${command}`],
      env: { ...inherited(process.env), PATH: runtimePath(paths, process.env) },
    };
  }
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
