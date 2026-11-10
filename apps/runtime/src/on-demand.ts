import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
  "@turbodocx/html-to-docx": "Word files",
  exceljs: "Excel files",
} as const;

export type OnDemandName = keyof typeof ON_DEMAND;

/** The runtime package's folder: three up from this file's folder in dist/ or src/. */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export interface OnDemandOptions {
  /** The runtime package's folder, with the package.json that names the version. */
  root?: string;
  /** Runs npm with these arguments; by default the npm of the Node that runs this. */
  npm?: (args: string[]) => Promise<{ code: number; tail: string }>;
  /** Told when a download starts; by default a line in the log. */
  onInstall?: (name: OnDemandName, version: string, dir: string) => void;
}

const loading = new Map<string, Promise<unknown>>();

/** A library of ON_DEMAND as `import()` gives it, installed first where it is missing. */
export function onDemand<T>(name: OnDemandName, options: OnDemandOptions = {}): Promise<T> {
  let found = loading.get(name);
  if (!found) {
    found = load(name, options);
    loading.set(name, found);
    // A failed install is tried again on the next use.
    found.catch(() => loading.delete(name));
  }
  return found as Promise<T>;
}

const isMissing = (err: unknown, name: string) =>
  (err as NodeJS.ErrnoException)?.code === "ERR_MODULE_NOT_FOUND" &&
  String((err as Error).message).includes(`'${name}'`);

async function load(name: OnDemandName, options: OnDemandOptions): Promise<unknown> {
  if (!options.root) {
    try {
      return await import(name);
    } catch (err) {
      if (!isMissing(err, name)) {
        throw err;
      }
    }
  }
  return import(pathToFileURL(packageEntry(await installed(name, options), name)).href);
}

/** The library's folder in extras/, installed first where it isn't there yet. */
async function installed(name: OnDemandName, options: OnDemandOptions): Promise<string> {
  const dir = extrasDir(options.root ?? PACKAGE_ROOT, name);
  if (!existsSync(join(dir, "node_modules", name, "package.json"))) {
    await install(name, dir, options);
  }
  return dir;
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

function versionFor(root: string, name: OnDemandName): string {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const version = manifest.peerDependencies?.[name];
  if (typeof version !== "string") {
    throw new Error(`${name} isn’t installed (for ${ON_DEMAND[name]}).`);
  }
  return version;
}

/** Installs into a folder of its own and moves it in place whole: a stopped install leaves none. */
async function install(name: OnDemandName, dir: string, options: OnDemandOptions) {
  const npm = options.npm ?? npmOfThisNode;
  const version = basename(dir).slice(basename(dir).lastIndexOf("@") + 1);
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
    `${name}@${version}`,
  ]);
  if (result.code !== 0 || !existsSync(join(stage, "node_modules", name, "package.json"))) {
    rmSync(stage, { recursive: true, force: true });
    const reason = result.tail.trim().split("\n").at(-1) || `npm ended with ${result.code}`;
    throw new Error(
      `${name} (for ${ON_DEMAND[name]}) is downloaded the first time it’s needed, and that didn’t work: ${reason}`,
    );
  }
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
