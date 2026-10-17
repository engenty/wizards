import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageVersion } from "../cli/home.js";
import { env } from "../env.js";
import { managed } from "../manage.js";
import type { PluginProblem, PluginSource } from "./discovery.js";

/**
 * Which Pro modules may load (docs/pro-modules.md). A Pro module is a closed
 * plugin the linked account's plan includes, installed by pro.ts into a folder of its own. It
 * loads while the entitlement the account's Manage-App signed lists it and has not ended, and
 * only in the release it was built for. Kept apart from pro.ts, so the loader needs no network.
 */

/** Where Pro modules are installed: apart from the person's own plugins, not watched. */
export const proModulesDir = () => join(env.dataDir, "pro-modules");

/** Written beside an installed module: what was installed, for which release. */
export const INSTALLED_FILE = ".engenty-module.json";

export interface InstalledModule {
  id: string;
  version: string;
  runtime: string;
  sha256: string;
  installedAt: string;
}

/** What the last check at the account said, as kept in the settings. */
export interface Entitlement {
  /** The tenant of the linked account; another account's entitlement counts for nothing. */
  tenantId: string;
  modules: string[];
  plan: { id: string; name: string } | null;
  /** Until when the modules stay on without asking again. */
  expiresAt: number;
  checkedAt: number;
}

export const ENTITLEMENT_SETTING = "pro.entitlement";

let entitlement: Entitlement | null = null;

export function currentEntitlement(): Entitlement | null {
  return entitlement;
}

export function setEntitlement(value: Entitlement | null) {
  entitlement = value;
}

/** `0.2.26` → `v0.2.26`: the release this runtime is. */
export const runtimeTag = () => `v${packageVersion()}`;

export function installedModule(root: string): InstalledModule | null {
  try {
    return JSON.parse(readFileSync(join(root, INSTALLED_FILE), "utf8")) as InstalledModule;
  } catch {
    return null;
  }
}

/**
 * Why an installed Pro module does not load now; null when it may. `release`: built for another
 * release (fetched anew at the next check); `unconfirmed`: the plan was not confirmed lately
 * (offline too long, or no account); `plan`: the plan does not include it.
 */
export type HeldBack = "managed" | "not_installed" | "release" | "unconfirmed" | "plan";

export function heldBack(source: PluginSource): HeldBack | null {
  if (managed) {
    return "managed";
  }
  const installed = installedModule(source.root);
  if (!installed || installed.id !== source.id) {
    return "not_installed";
  }
  if (installed.runtime !== runtimeTag()) {
    return "release";
  }
  if (!(entitlement && entitlement.expiresAt > Date.now())) {
    return "unconfirmed";
  }
  if (!entitlement.modules.includes(source.id)) {
    return "plan";
  }
  return null;
}

let held = new Map<string, HeldBack>();

/** The Pro modules that were found and did not load, with the reason, as of the last look. */
export function heldBackModules(): Map<string, HeldBack> {
  return held;
}

/**
 * The Pro modules of a look at the folders that may load, marked as such. A Pro module never
 * takes the id of a plugin found elsewhere.
 */
export function proSources(
  found: PluginSource[],
  taken: Set<string>,
): { load: PluginSource[]; problems: PluginProblem[] } {
  const load: PluginSource[] = [];
  const problems: PluginProblem[] = [];
  held = new Map();
  for (const source of found) {
    if (taken.has(source.id)) {
      problems.push({
        path: source.root,
        message: `Plugin "${source.id}" is already loaded from another folder.`,
      });
      continue;
    }
    const reason = heldBack(source);
    if (reason) {
      held.set(source.id, reason);
    } else {
      load.push({ ...source, pro: true });
    }
  }
  return { load, problems };
}
