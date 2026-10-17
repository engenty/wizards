import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  declaredByPlugin,
  defaultFeatures,
  FEATURES,
  type FeatureDeclaration,
  type Features,
  featureOn,
  parseFeatures,
  resolveFeatures,
} from "@engenty-wizards/shared/features";
import { accountOverview } from "./auth/account.js";
import { isCheckout, layout, packageRoot } from "./cli/home.js";
import { env } from "./env.js";
import { managed, tenantInfo } from "./manage.js";
import type { PluginSource } from "./plugins/discovery.js";
import { loadedPlugins } from "./plugins/registry.js";
import { currentTenantOrNull } from "./tenants/tenant.js";

/**
 * Which feature switches are on for this runtime (packages/shared/src/features.ts), laid over
 * each other, the last winning:
 *
 *   1. the defaults the code declares: the core's (packages/shared/src/feature-flags.ts) and the
 *      loaded plugins' (their manifests' `features`, under the plugin's id)
 *   2. the `FEATURES` environment variable (`teamPlans=on,site=off`): the cloud image, compose, dev
 *   3. what the Manage-App says — for the team of a cloud runtime, for the linked account of a
 *      local one; a plan's switches and what an admin set for the team or for everyone
 *   4. the `.features` file of this install (`~/.engenty/wizards/.features`; a checkout reads
 *      the repo root's, a cloud runtime its data folder's) — this machine's word is the last
 *
 * The file is read on every call, so a change counts at once. Nothing here is documented
 * outside the code.
 */

/** The `.features` file this runtime reads: the install's, the checkout's root, or the data folder's. */
export function featuresFile(): string {
  if (managed) {
    return join(env.dataDir, ".features");
  }
  return isCheckout() ? join(packageRoot, ".features") : join(layout().home, ".features");
}

let fileCache: { file: string; mtime: number; value: Features } | null = null;

/** What the `.features` file says, read again when it changed. */
export function fileFeatures(file = featuresFile()): Features {
  let mtime = -1;
  try {
    mtime = statSync(file).mtimeMs;
  } catch {
    fileCache = null;
    return {};
  }
  if (fileCache && fileCache.file === file && fileCache.mtime === mtime) {
    return fileCache.value;
  }
  const value = parseFeatures(readFileSync(file, "utf8"));
  fileCache = { file, mtime, value };
  return value;
}

const envFeatures = () => parseFeatures(process.env.FEATURES ?? "");

/** Every switch something declared: the core's, then each plugin's under its id. */
export function declaredFeatures(
  sources: PluginSource[] = loadedPlugins().map((p) => p.source),
): Record<string, FeatureDeclaration> {
  const out: Record<string, FeatureDeclaration> = { ...FEATURES };
  for (const source of sources) {
    Object.assign(out, declaredByPlugin(source.id, source.manifest.features));
  }
  return out;
}

/** The switches, with what the Manage-App said for the team or account laid in. */
export function features(remote?: Features | null): Features {
  return resolveFeatures(
    defaultFeatures(declaredFeatures()),
    envFeatures(),
    remote,
    fileFeatures(),
  );
}

export function feature(name: string, remote?: Features | null): boolean {
  return featureOn(features(remote), name);
}

let accountCache: { at: number; value: Features | null } | null = null;

/**
 * What the Manage-App says for the tenant at hand: the team's switches on a cloud runtime
 * (cached a minute by `tenantInfo`), the linked account's on a local one (cached a minute
 * here). Null when nothing is linked or the Manage-App does not answer.
 */
export async function remoteFeatures(): Promise<Features | null> {
  if (managed) {
    const id = currentTenantOrNull();
    if (!id) {
      return null;
    }
    return tenantInfo(id)
      .then((info) => info.features ?? null)
      .catch(() => null);
  }
  if (accountCache && Date.now() - accountCache.at < 60_000) {
    return accountCache.value;
  }
  const overview = await accountOverview().catch(() => null);
  accountCache = { at: Date.now(), value: overview?.tenant.features ?? null };
  return accountCache.value;
}

/** The switches for the tenant at hand, with what the Manage-App says fetched. */
export async function currentFeatures(): Promise<Features> {
  return features(await remoteFeatures());
}

/**
 * Writes one switch into the `.features` file as `name=on` or `name=off`, on the line that
 * names it when there is one (commented out or not), else at the end; `null` turns the line
 * back into the template's `# name=on|off`. Other lines and comments stay as they are. For the
 * `wizards features` command.
 */
export function writeFeature(name: string, on: boolean | null, file = featuresFile()): Features {
  let lines: string[] = [];
  try {
    lines = readFileSync(file, "utf8").replace(/\n+$/, "").split("\n");
  } catch {
    lines = [];
  }
  const names = (line: string) => {
    const m = /^\s*#?\s*([A-Za-z0-9.]+)\s*=\s*\S+\s*(?:#.*)?$/.exec(line);
    return m?.[1] === name;
  };
  const written = on === null ? `# ${name}=on|off` : `${name}=${on ? "on" : "off"}`;
  const at = lines.findIndex(names);
  if (at === -1) {
    lines.push(written);
  } else {
    lines[at] = written;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${lines.join("\n")}\n`);
  fileCache = null;
  return fileFeatures(file);
}
