import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { EnginePackage } from "./install.js";

/**
 * What `wizards sandbox add agentos` installs (install.ts): agentOS's core, about 480 MB on a Mac and 820 MB on Linux, which
 * only the computers and servers that run the sandbox with it need. The cloud's sandbox container
 * installs the same (deploy/Dockerfile.sandbox).
 */
export const AGENTOS_VERSION = "0.4.7";

export const AGENTOS_CORE = "@rivet-dev/agentos-core";
/** The helper agentOS ships for each platform, beside the core: `<package>/agentos-native-sidecar`. */
const SIDECAR_PACKAGE = "@rivet-dev/agentos-runtime-sidecar-";
/** Where the core keeps its programs, compiled to WebAssembly. */
const COMMANDS = join("node_modules", "@rivet-dev", "agentos-runtime-core", "commands");

/**
 * Programs agentOS ships but leaves off the PATH; the install packs them so every VM has them.
 * The ones from the `@agentos-software` registry are in a format 0.4 no longer reads.
 */
export const AGENTOS_EXTRA_COMMANDS = ["curl", "git", "jq", "sqlite3", "unzip", "zip"] as const;

/** agentOS ships its helper for macOS and glibc Linux, on arm64 and x64. */
export function agentOsSupported(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): boolean {
  return ["darwin", "linux"].includes(platform) && ["arm64", "x64"].includes(arch);
}

/** The package of extra programs every VM gets (AGENTOS_EXTRA_COMMANDS). */
export const agentOsExtras = (dir: string) => join(dir, "extras");

/** The helper with its routine lines filtered out, or null where there is no bash. */
export const agentOsSidecar = (dir: string) => join(dir, "sidecar.sh");

/** An agentOS package is a folder with a manifest and its programs in `bin/`. */
function packExtras(dir: string) {
  const bin = join(agentOsExtras(dir), "bin");
  mkdirSync(bin, { recursive: true });
  for (const command of AGENTOS_EXTRA_COMMANDS) {
    const target = join(bin, command);
    copyFileSync(join(dir, COMMANDS, command), target);
    // Without the mode, the VM finds the program and refuses to run it.
    chmodSync(target, 0o755);
  }
  writeFileSync(
    join(agentOsExtras(dir), "agentos-package.json"),
    `${JSON.stringify({ name: "engenty-wizards-extras", version: AGENTOS_VERSION })}\n`,
  );
}

/**
 * The helper prints a line on stderr for every engine it keeps warm, a few per command, and
 * agentOS passes its stderr on to the server's. The wrapper leaves those lines out.
 */
function writeSidecarWrapper(dir: string) {
  const bash = ["/bin/bash", "/usr/bin/bash"].find((path) => existsSync(path));
  const modules = join(dir, "node_modules", "@rivet-dev");
  const platform = readdirSync(modules).find((name) =>
    `@rivet-dev/${name}`.startsWith(SIDECAR_PACKAGE),
  );
  const helper = platform && join(modules, platform, "agentos-native-sidecar");
  if (!bash || !helper || !existsSync(helper)) {
    return;
  }
  const quoted = `'${helper.replaceAll("'", `'\\''`)}'`;
  writeFileSync(
    agentOsSidecar(dir),
    `#!${bash}\n` +
      "# agentOS's helper without the lines it prints for every engine it keeps warm.\n" +
      `exec ${quoted} "$@" 2> >(grep --line-buffered -v -e '^agentos-v8-runtime: ' -e 'vfs::posix::tar_fs' >&2)\n`,
  );
  chmodSync(agentOsSidecar(dir), 0o755);
}

export const AGENTOS_PACKAGE: EnginePackage = {
  label: "agentOS",
  version: AGENTOS_VERSION,
  packages: [`${AGENTOS_CORE}@${AGENTOS_VERSION}`],
  size: process.platform === "linux" ? "about 820 MB" : "about 480 MB",
  unsupported: () =>
    agentOsSupported()
      ? null
      : `agentOS runs on macOS and Linux (arm64, x64), not on ${process.platform} ${process.arch}.`,
  prepare(dir) {
    packExtras(dir);
    writeSidecarWrapper(dir);
  },
};
