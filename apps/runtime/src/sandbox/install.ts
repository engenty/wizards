import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { wizardsHome } from "../cli/home.js";
import { AGENTOS_PACKAGE } from "./agentos-package.js";

/**
 * Engines whose code is not part of engenty wizards: they weigh hundreds of MB, or only the
 * computers that use them need them. `wizards sandbox add <name>` (or this file run with node)
 * installs one into a folder of its own, `engines/<name>`, and the engine loads it from there with
 * `import()`. The runtime's package.json never lists them.
 *
 * This file and the engines' packages import nothing of the runtime but home.js: the image's
 * `engines` stage runs it with only them copied (apps/runtime/Dockerfile).
 */
export interface EnginePackage {
  /** Its name in messages: "agentOS". */
  label: string;
  /** The version `wizards status` compares with what is installed. */
  version: string;
  /** What npm installs into the folder, each at an exact version. */
  packages: string[];
  /** For the messages: "about 340 MB". */
  size: string;
  /** Why it can't run on this computer, or null. */
  unsupported?(): string | null;
  /** After npm: takes out what it never uses, writes what it needs beside. */
  prepare?(dir: string): void;
}

export const ENGINE_PACKAGES: Record<string, EnginePackage> = {
  agentos: AGENTOS_PACKAGE,
};

/** Written last: a folder without it is an install that did not finish. */
const MARKER = "engine.json";

/** Where the engines go: `SANDBOX_ENGINES_DIR`, else `~/.engenty/wizards/engines`. */
export function enginesDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.SANDBOX_ENGINES_DIR?.trim() || join(wizardsHome(env), "engines"));
}

export const engineDir = (name: string, env: NodeJS.ProcessEnv = process.env) =>
  join(enginesDir(env), name);

/** The version installed in `dir`, or null when nothing usable is there. */
export function installedVersion(dir: string): string | null {
  try {
    const { version } = JSON.parse(readFileSync(join(dir, MARKER), "utf8"));
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

/** The file an export map's entry names for `import`: conditions may nest (`import.default`). */
function importTarget(target: unknown): string | undefined {
  if (typeof target === "string") {
    return target;
  }
  if (Array.isArray(target)) {
    return target.map(importTarget).find(Boolean);
  }
  if (target && typeof target === "object") {
    for (const condition of ["import", "node", "default"]) {
      const found = importTarget((target as Record<string, unknown>)[condition]);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

/** A package of an engine's folder, for `import()`: its export map's `.`, else its main. */
export function packageEntry(dir: string, name: string): string {
  const root = join(dir, "node_modules", name);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const { exports } = pkg;
  const dot = exports && typeof exports === "object" && "." in exports ? exports["."] : exports;
  return join(root, importTarget(dot) ?? pkg.main ?? "index.js");
}

/** Loads a package an engine installed; says how to install it when it isn't there. */
export async function importFromEngine(
  engine: string,
  dir: string,
  name: string,
): Promise<unknown> {
  if (!installedVersion(dir)) {
    throw new Error(`${engine} isn’t installed in ${dir}: wizards sandbox add ${engine}`);
  }
  return import(pathToFileURL(packageEntry(dir, name)).href);
}

export type RunNpm = (args: string[]) => Promise<{ code: number; tail: string }>;

/**
 * Installs an engine into `dir` with the given npm, replacing what was there. Install scripts do
 * not run; an engine that needs one does its work in `prepare`.
 */
export async function installEngine(name: string, dir: string, npm: RunNpm): Promise<string> {
  const engine = ENGINE_PACKAGES[name];
  if (!engine) {
    throw new Error(`There is no engine “${name}” to install. ${engineList()}`);
  }
  const unsupported = engine.unsupported?.();
  if (unsupported) {
    throw new Error(unsupported);
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), '{ "private": true }\n');
  const result = await npm([
    "install",
    "--prefix",
    dir,
    "--no-audit",
    "--no-fund",
    "--ignore-scripts",
    "--loglevel=error",
    ...engine.packages,
  ]);
  if (result.code !== 0) {
    throw new Error(`npm couldn’t install ${name}: ${result.tail.trim().split("\n").at(-1)}`);
  }
  engine.prepare?.(dir);
  writeFileSync(
    join(dir, MARKER),
    `${JSON.stringify({ name, version: engine.version }, null, 2)}\n`,
  );
  return engine.version;
}

export function removeEngine(dir: string) {
  rmSync(dir, { recursive: true, force: true });
}

export const engineList = () =>
  `The engines to install: ${Object.keys(ENGINE_PACKAGES).join(", ")}.`;

/** `node apps/runtime/dist/sandbox/install.js agentos …`: an image or a checkout installs so. */
if (import.meta.main) {
  const { spawn } = await import("node:child_process");
  const npm: RunNpm = (args) =>
    new Promise((resolve) => {
      const child = spawn("npm", args, { stdio: ["ignore", "inherit", "inherit"] });
      child.on("error", (err) => resolve({ code: 127, tail: err.message }));
      child.on("close", (code) => resolve({ code: code ?? 1, tail: "" }));
    });
  const names = process.argv
    .slice(2)
    .flatMap((arg) => arg.split(","))
    .filter(Boolean);
  if (!names.length) {
    console.error(`Name the engines to install. ${engineList()}`);
    process.exitCode = 2;
  }
  for (const name of names) {
    try {
      const version = await installEngine(name, engineDir(name), npm);
      console.log(`${name} ${version} is installed in ${engineDir(name)}.`);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  }
}
