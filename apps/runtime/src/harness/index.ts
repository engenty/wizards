import { join } from "node:path";
import type { ClientSetupStatus } from "@engenty/model-setup";
import { ClientSetup } from "@engenty/model-setup/server";
import { setClientFolders } from "@engenty/model-sources/clients";
import { inherited, runtimePath } from "../cli/environment.js";
import { layout } from "../cli/home.js";
import { antigravity, claude, codex, cursor } from "./clients.js";
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
export type HarnessStatus = ClientSetupStatus<HarnessId>;

/** The clients as the setup finds, installs and signs them in. */
export const clientSetup = new ClientSetup({
  clients: HARNESSES,
  folder: () => layout().clients,
  env: (shellPath) => ({
    ...inherited(process.env),
    PATH: runtimePath(layout(), shellPath ? { ...process.env, PATH: shellPath } : process.env),
  }),
});

/** One client, as it is now; asked again after a minute — it may get installed or signed in meanwhile. */
export function detectHarness(id: HarnessId, force = false): Promise<HarnessStatus | null> {
  return clientSetup.detect(id, force);
}

/** Every client this runtime knows, installed or not. */
export function detectHarnesses(force = false): Promise<HarnessStatus[]> {
  return clientSetup.detectAll(force);
}
