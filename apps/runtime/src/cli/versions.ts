import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Layout } from "./home.js";

/**
 * The runtimes of an install made by install.sh, one folder per version, side by side:
 *
 *   runtime/<version>/     an npm prefix: node_modules/@engenty/wizards-runtime (up to 0.7.4
 *                          node_modules/wizards), package.json, package-lock.json
 *   runtime/current        → <version>, the one `bin/wizards` starts
 *   runtime/node_modules   → current/node_modules, for commands written before the versions
 *
 * On Windows the links are junctions, which need no administrator (install.ps1 makes them too).
 *
 * Up to 0.6.2 `runtime/` itself was the prefix; `switchTo` moves such an install into its
 * version folder first. A process keeps the files of the version it started with.
 */

const VERSION = /^\d+\.\d+\.\d+$/;

/** The npm package of the runtime. Up to 0.7.4 it was `wizards`, now the launcher `npx` runs. */
export const RUNTIME_PACKAGE = "@engenty/wizards-runtime";
/** The runtime's name up to 0.7.4, and where a command or an update of then looks for it. */
const LEGACY_PACKAGE = "wizards";

export const runtimeDir = (paths: Layout, version: string) => join(paths.runtime, version);
const currentLink = (paths: Layout) => join(paths.runtime, "current");
const modules = (paths: Layout) => join(paths.runtime, "node_modules");

function versionOf(dir: string): string | null {
  try {
    const { version } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

/**
 * The version of the runtime in an npm prefix; null when there is none. A `wizards` without the
 * runtime in it is the launcher, which an update of 0.7.4 or older fetches as the new version.
 */
export function versionIn(prefix: string): string | null {
  const legacy = join(prefix, "node_modules", LEGACY_PACKAGE);
  return (
    versionOf(join(prefix, "node_modules", RUNTIME_PACKAGE)) ??
    (existsSync(join(legacy, "apps", "runtime")) ? versionOf(legacy) : null)
  );
}

const isLink = (path: string) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

/** The version `bin/wizards` starts; null without a runtime. */
export function currentVersion(paths: Layout): string | null {
  if (isLink(currentLink(paths))) {
    // A junction names its target in full; a link here names the version folder alone.
    return versionIn(resolve(paths.runtime, readlinkSync(currentLink(paths))));
  }
  return versionIn(paths.runtime);
}

/** The version folders there are, each with a complete package in it. */
export function installedVersions(paths: Layout): string[] {
  try {
    return readdirSync(paths.runtime)
      .filter((name) => VERSION.test(name) && versionIn(join(paths.runtime, name)) === name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Points `link` at `target` in one step: a new link renamed over the old one. On Windows a
 * junction, with its target in full, which takes the old one's place.
 */
function link(target: string, path: string) {
  if (process.platform === "win32") {
    rmSync(path, { force: true });
    symlinkSync(resolve(dirname(path), target), path, "junction");
    return;
  }
  const tmp = `${path}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  symlinkSync(target, tmp);
  renameSync(tmp, path);
}

/** Moves a runtime from before the version folders into `runtime/<version>/`. */
function adoptLegacy(paths: Layout) {
  const version = versionIn(paths.runtime);
  if (isLink(modules(paths)) || !version) {
    return;
  }
  const into = runtimeDir(paths, version);
  rmSync(into, { recursive: true, force: true });
  mkdirSync(into, { recursive: true });
  for (const name of ["node_modules", "package.json", "package-lock.json"]) {
    if (existsSync(join(paths.runtime, name))) {
      renameSync(join(paths.runtime, name), join(into, name));
    }
  }
  link(version, currentLink(paths));
}

/** Makes `version` the one `bin/wizards` starts from now on. */
export function switchTo(paths: Layout, version: string) {
  if (versionIn(runtimeDir(paths, version)) !== version) {
    throw new Error(`${runtimeDir(paths, version)} holds no complete runtime ${version}.`);
  }
  adoptLegacy(paths);
  link(version, currentLink(paths));
  link(join("current", "node_modules"), modules(paths));
}

/** Deletes the version folders other than `keep` and the current one; returns what went. */
export function prune(paths: Layout, keep: string[]): string[] {
  const current = currentVersion(paths);
  const stale = installedVersions(paths).filter((v) => v !== current && !keep.includes(v));
  for (const version of stale) {
    rmSync(runtimeDir(paths, version), { recursive: true, force: true });
  }
  return stale;
}

/**
 * The packages the package-lock.json of an npm prefix names that are not there (the ones for
 * other machines aside). An npm stopped halfway, or two installs at once, leave some out without
 * saying so; install.sh checks the same.
 */
export function missingPackages(prefix: string): string[] {
  let packages: Record<
    string,
    { optional?: boolean; devOptional?: boolean; dev?: boolean; peer?: boolean }
  >;
  try {
    packages = JSON.parse(readFileSync(join(prefix, "package-lock.json"), "utf8")).packages ?? {};
  } catch {
    return ["package-lock.json"];
  }
  return Object.entries(packages)
    .filter(([where, p]) => where && !p.optional && !p.devOptional && !p.dev && !p.peer)
    .filter(([where]) => !existsSync(join(prefix, where, "package.json")))
    .map(([where]) => where);
}

/** Puts an npm prefix installed elsewhere into its version folder (never the current one). */
export function promote(paths: Layout, staged: string, version: string) {
  if (versionIn(staged) !== version) {
    throw new Error(`The download holds version ${versionIn(staged) ?? "none"}, not ${version}.`);
  }
  const missing = missingPackages(staged);
  if (missing.length) {
    throw new Error(
      `The download of ${version} misses ${missing.length} packages (${missing.slice(0, 3).join(", ")}).`,
    );
  }
  if (currentVersion(paths) === version) {
    rmSync(staged, { recursive: true, force: true });
    return;
  }
  // As install.sh leaves it: a command of 0.7.4 or older finds the runtime under its old name.
  const legacy = join(staged, "node_modules", LEGACY_PACKAGE);
  // Windows has no command of 0.7.4 or older.
  if (!existsSync(legacy) && process.platform !== "win32") {
    symlinkSync(RUNTIME_PACKAGE, legacy);
  }
  rmSync(runtimeDir(paths, version), { recursive: true, force: true });
  renameSync(staged, runtimeDir(paths, version));
}

// --- one install at a time -------------------------------------------------------------------

const lockDir = (paths: Layout) => join(paths.home, "install.lock");

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Takes the lock install.sh takes (a folder with its owner's pid in it), so that an update in
 * the background never writes runtime/ while an install does. Returns how to give it back, or
 * null while somebody else holds it; a lock whose owner is gone is taken over.
 */
export function tryInstallLock(paths: Layout): (() => void) | null {
  const dir = lockDir(paths);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(paths.home, { recursive: true });
      mkdirSync(dir);
    } catch (error) {
      // A home folder it cannot write to: no update either way.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        return null;
      }
      let owner = Number.NaN;
      try {
        owner = Number(readFileSync(join(dir, "pid"), "utf8").trim());
      } catch {
        // Made a moment ago, its pid not written yet: held.
      }
      if (Number.isInteger(owner) && owner > 0 && !alive(owner)) {
        rmSync(dir, { recursive: true, force: true });
        continue;
      }
      return null;
    }
    writeFileSync(join(dir, "pid"), `${process.pid}\n`);
    return () => rmSync(dir, { recursive: true, force: true });
  }
  return null;
}
