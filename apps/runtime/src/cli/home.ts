import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where a local install lives: `~/.engenty/wizards`, inside the folder the engenty framework
 * keeps its own install in. `ENGENTY_HOME` moves both.
 */
export function wizardsHome(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.ENGENTY_HOME?.trim() || join(homedir(), ".engenty");
  return join(resolve(base), "wizards");
}

export interface Layout {
  home: string;
  /** Databases, files, the secret: the runtime's DATA_DIR. */
  data: string;
  logs: string;
  /** Settings of this install, read by the runtime at start. */
  envFile: string;
  /** What the setup remembers: when it ran. */
  installFile: string;
  /** The runtimes of an install made by install.sh, one npm prefix per version (versions.ts). */
  runtime: string;
  /** The Node that install.sh brought: `tools/node/bin/node`. */
  tools: string;
  /** npm prefix of AI clients the setup installed; their commands are in `clients/bin`. */
  clients: string;
  /** The `wizards` command of an install made by install.sh. */
  bin: string;
  /** Plugins the person put there: the runtime's PLUGINS_DIR (docs/content/dev/plugins). */
  plugins: string;
}

export function layout(home = wizardsHome()): Layout {
  return {
    home,
    data: join(home, "data"),
    logs: join(home, "logs"),
    envFile: join(home, ".env"),
    installFile: join(home, "install.json"),
    runtime: join(home, "runtime"),
    tools: join(home, "tools"),
    clients: join(home, "clients"),
    bin: join(home, "bin"),
    plugins: join(home, "plugins"),
  };
}

/** The folder this code was installed to: it holds `apps/`, `plugin/` and package.json. */
export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

let running: string | undefined;

/**
 * The version this process runs, read once: an update replaces package.json under a runtime that
 * still runs the old code, and the studio reloads only when another version answers.
 */
export function packageVersion(): string {
  if (running === undefined) {
    try {
      running =
        JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version ?? "0.0.0";
    } catch {
      running = "0.0.0";
    }
  }
  return running ?? "0.0.0";
}

/** How this copy got here: by install.sh into the home folder, or by npm/npx or a checkout. */
export function installedByScript(paths: Layout = layout()): boolean {
  try {
    // Node names this file by its real path; the home folder may be reached through a link.
    return packageRoot.startsWith(realpathSync(paths.runtime) + sep);
  } catch {
    return false;
  }
}

/** This copy is a checkout of the repository, run with `pnpm wizards`. */
export function isCheckout(): boolean {
  return existsSync(join(packageRoot, "pnpm-workspace.yaml"));
}

/** How this install is started, as the person types it. */
export const command = () =>
  installedByScript() ? "wizards" : isCheckout() ? "pnpm wizards" : "npx wizards";

export interface InstallNote {
  /** When the guided setup last ran to its end. */
  setupAt?: string;
  version?: string;
  /** Set up with `--local`: no account, nothing leaves this computer. A sign-in clears it. */
  local?: boolean;
  /** `wizards autoupdate on|off`; unset, it follows autoupdate.ts's defaults. */
  autoUpdate?: boolean;
  /** The setup ran without a terminal (CI, a script): no updates by themselves unless turned on. */
  unattended?: boolean;
}

export function readInstallNote(paths: Layout = layout()): InstallNote {
  try {
    return JSON.parse(readFileSync(paths.installFile, "utf8")) as InstallNote;
  } catch {
    return {};
  }
}

export function writeInstallNote(note: InstallNote, paths: Layout = layout()) {
  // A checkout or npx has no install folder until something writes into it.
  mkdirSync(dirname(paths.installFile), { recursive: true });
  writeFileSync(paths.installFile, `${JSON.stringify(note, null, 2)}\n`);
}

/** `KEY=value` lines of the install's `.env`, the way the runtime reads them. */
export function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) {
    return out;
  }
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match) {
      out[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  }
  return out;
}
