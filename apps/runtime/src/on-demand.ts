import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { packageEntry } from "./sandbox/install.js";

/**
 * Libraries only a few features need. The runtime's npm package names them as optional peers
 * instead of dependencies (scripts/npm-package.mjs, ON_DEMAND), so an install doesn't download
 * them: the first use installs one, at the version the package names, with the npm of the Node
 * that runs the runtime, into `extras/<name>@<version>` beside the runtime's node_modules. What
 * it needs and the runtime has (its peers above all) it finds there, one folder up. Where the
 * library is installed already (a checkout, the image), it loads like any other.
 */
export const ON_DEMAND = {
  "@llamaindex/liteparse": "reading scans",
  "@mastra/docker": "the Docker sandbox",
  "@turbodocx/html-to-docx": "writing Word files",
  exceljs: "Excel files",
  mammoth: "reading Word files",
  "word-extractor": "reading old Word files",
  "@executor-js/plugin-openapi": "connectors from an OpenAPI description",
} as const;

export type OnDemandName = keyof typeof ON_DEMAND;

/**
 * Peers a library is installed with, into its folder: they are loaded on demand with it, and the
 * code that uses the library imports them from there (`entry`), the same copy the library has.
 */
const ALONGSIDE: Partial<Record<OnDemandName, string[]>> = {
  "@executor-js/plugin-openapi": ["effect"],
};

/** Every package the runtime's npm package names as an optional peer: ON_DEMAND and ALONGSIDE. */
export const onDemandPackages = (): string[] => [
  ...Object.keys(ON_DEMAND),
  ...Object.values(ALONGSIDE).flat(),
];

/**
 * What an install of a library leaves out, as paths in its node_modules (`*` at the end matches
 * a name's start): what the runtime has already, which the library then finds one folder up, and
 * folders Node never loads.
 */
const LEAVE_OUT: Partial<Record<OnDemandName, string[]>> = {
  // Icons for its React screens; the runtime imports /core.
  "@executor-js/plugin-openapi": ["lucide-react"],
};

/** The runtime package's folder: three up from this file's folder in dist/ or src/. */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export interface OnDemandOptions {
  /** The runtime package's folder, with the package.json that names the version. */
  root?: string;
  /** Runs npm with these arguments; by default the npm of the Node that runs this. */
  npm?: (args: string[]) => Promise<{ code: number; tail: string }>;
  /** Told when a download starts; by default a line in the log. */
  onInstall?: (name: OnDemandName, version: string, dir: string) => void;
  /**
   * What to import, by default the library: one of its paths (`<name>/core`) or a peer it is
   * installed with (ALONGSIDE).
   */
  entry?: string;
}

const loading = new Map<string, Promise<unknown>>();

/** A library of ON_DEMAND as `import()` gives it, installed first where it is missing. */
export function onDemand<T>(name: OnDemandName, options: OnDemandOptions = {}): Promise<T> {
  const entry = options.entry ?? name;
  let found = loading.get(entry);
  if (!found) {
    found = load(name, entry, options);
    loading.set(entry, found);
    // A failed install is tried again on the next use.
    found.catch(() => loading.delete(entry));
  }
  return found as Promise<T>;
}

const isMissing = (err: unknown, name: string) =>
  (err as NodeJS.ErrnoException)?.code === "ERR_MODULE_NOT_FOUND" &&
  String((err as Error).message).includes(`'${name}'`);

/** `@scope/name/path` → `@scope/name` and `./path`. */
function specifier(entry: string): { pkg: string; path: string } {
  const parts = entry.split("/");
  const length = entry.startsWith("@") ? 2 : 1;
  const rest = parts.slice(length).join("/");
  return { pkg: parts.slice(0, length).join("/"), path: rest ? `./${rest}` : "." };
}

async function load(name: OnDemandName, entry: string, options: OnDemandOptions): Promise<unknown> {
  const { pkg, path } = specifier(entry);
  if (pkg !== name && !ALONGSIDE[name]?.includes(pkg)) {
    throw new Error(`${entry} isn’t installed with ${name}.`);
  }
  if (!options.root) {
    try {
      return await import(entry);
    } catch (err) {
      if (!isMissing(err, pkg)) {
        throw err;
      }
    }
  }
  return import(pathToFileURL(packageEntry(await installed(name, options), pkg, path)).href);
}

const installs = new Map<string, Promise<string>>();

/** The library's folder in extras/, installed first where it isn't there yet. */
function installed(name: OnDemandName, options: OnDemandOptions): Promise<string> {
  const root = options.root ?? PACKAGE_ROOT;
  const key = `${root}\0${name}`;
  let done = installs.get(key);
  if (!done) {
    done = (async () => {
      const dir = extrasDir(root, name);
      if (!existsSync(join(dir, "node_modules", name, "package.json"))) {
        await install(name, dir, root, options);
      }
      return dir;
    })();
    installs.set(key, done);
    done.catch(() => installs.delete(key));
  }
  return done;
}

/**
 * Installs every library of ON_DEMAND that isn't there yet, one after the other, without
 * loading it: a full installation. Where one is installed like any other, nothing happens.
 */
export async function installAll(
  onEach?: (name: OnDemandName, error?: Error) => void,
  options: OnDemandOptions = {},
): Promise<void> {
  for (const name of Object.keys(ON_DEMAND) as OnDemandName[]) {
    try {
      if (options.root || !resolvable(name)) {
        await installed(name, options);
      }
      onEach?.(name);
    } catch (err) {
      onEach?.(name, err as Error);
    }
  }
}

const resolvable = (name: string) => {
  try {
    import.meta.resolve(name);
    return true;
  } catch {
    return false;
  }
};

/** `<prefix>/extras/<name>@<version>`, the prefix being the folder whose node_modules holds the runtime. */
export function extrasDir(root: string, name: OnDemandName): string {
  const version = versionFor(root, name);
  let prefix = dirname(root);
  while (basename(prefix) !== "node_modules") {
    const up = dirname(prefix);
    if (up === prefix) {
      throw new Error(`${name} isn’t installed (for ${ON_DEMAND[name]}).`);
    }
    prefix = up;
  }
  return join(dirname(prefix), "extras", `${name.replace("/", "+")}@${version}`);
}

/** The version the runtime package names for a library of ON_DEMAND, or for a peer it comes with. */
function versionFor(root: string, name: OnDemandName, pkg: string = name): string {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const version = manifest.peerDependencies?.[pkg];
  if (typeof version !== "string") {
    throw new Error(`${pkg} isn’t installed (for ${ON_DEMAND[name]}).`);
  }
  return version;
}

/** Installs into a folder of its own and moves it in place whole: a stopped install leaves none. */
async function install(name: OnDemandName, dir: string, root: string, options: OnDemandOptions) {
  const npm = options.npm ?? npmOfThisNode;
  const version = basename(dir).slice(basename(dir).lastIndexOf("@") + 1);
  const alongside = (ALONGSIDE[name] ?? []).map((pkg) => `${pkg}@${versionFor(root, name, pkg)}`);
  const stage = `${dir}.${process.pid}.tmp`;
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  writeFileSync(join(stage, "package.json"), '{ "private": true }\n');
  (
    options.onInstall ??
    (() => console.log(`[on-demand] ${ON_DEMAND[name]}: installing ${name} ${version} into ${dir}`))
  )(name, version, dir);
  const result = await npm([
    "install",
    "--prefix",
    stage,
    "--omit=dev",
    "--ignore-scripts",
    // The runtime's own copies serve as the peers: one @mastra/core, not two.
    "--legacy-peer-deps",
    "--no-audit",
    "--no-fund",
    "--loglevel=error",
    ...alongside,
    `${name}@${version}`,
  ]);
  if (result.code !== 0 || !existsSync(join(stage, "node_modules", name, "package.json"))) {
    rmSync(stage, { recursive: true, force: true });
    const reason = result.tail.trim().split("\n").at(-1) || `npm ended with ${result.code}`;
    throw new Error(
      `${name} (for ${ON_DEMAND[name]}) is downloaded the first time it’s needed, and that didn’t work: ${reason}`,
    );
  }
  leaveOut(join(stage, "node_modules"), LEAVE_OUT[name] ?? []);
  try {
    renameSync(stage, dir);
  } catch (err) {
    // Another process put it there first.
    rmSync(stage, { recursive: true, force: true });
    if (!existsSync(join(dir, "node_modules", name, "package.json"))) {
      throw err;
    }
  }
}

function leaveOut(modules: string, paths: string[]) {
  for (const path of paths) {
    const at = join(modules, path);
    if (!path.endsWith("*")) {
      rmSync(at, { recursive: true, force: true });
      continue;
    }
    const start = basename(at).slice(0, -1);
    const parent = dirname(at);
    for (const entry of existsSync(parent) ? readdirSync(parent) : []) {
      if (entry.startsWith(start)) {
        rmSync(join(parent, entry), { recursive: true, force: true });
      }
    }
  }
}

/** npm of the Node that runs this: its npm-cli.js, which starts the same on every system. */
function npmOfThisNode(args: string[]): Promise<{ code: number; tail: string }> {
  const bin = dirname(process.execPath);
  const cli =
    process.platform === "win32"
      ? join(bin, "node_modules", "npm", "bin", "npm-cli.js")
      : join(bin, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  return new Promise((resolve) => {
    let tail = "";
    const child = spawn(process.execPath, [cli, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const take = (chunk: Buffer) => {
      tail = (tail + chunk.toString("utf8")).slice(-4000);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (err) => resolve({ code: 127, tail: err.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, tail }));
  });
}
