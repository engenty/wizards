import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readlinkSync, rmdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import * as p from "@clack/prompts";
import { LOGIN_LABEL, present, removeUnit, UNIT, unloadLoginItem } from "./autostart.js";
import { type App, apps as allApps } from "./connect.js";
import type { Layout } from "./home.js";
import { findWizardsProcesses, stopProcesses, type WizardsProcess } from "./processes.js";
import { settings } from "./start.js";
import { bad, cyan, dim, no, ok } from "./ui.js";

/**
 * `wizards uninstall`: shows what it removes (AI apps, login item, processes, the program, the
 * command's link), asks about the data on its own (kept unless the person says otherwise), does
 * it and looks again. Everything it needs is loaded before it deletes anything, so it runs from
 * the install it takes away as well as from npx.
 */

export interface UninstallOptions {
  dryRun: boolean;
  yes: boolean;
  deleteData: boolean;
}

/** What the uninstall works with; tests replace it, so they never touch this computer. */
export interface UninstallSystem {
  userHome: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  interactive: boolean;
  apps(paths: Layout): App[];
  processes(home: string): WizardsProcess[];
  stop(pids: number[]): Promise<number[]>;
  unloadLoginItem(): Promise<void>;
  removeUnit(file: string): Promise<void>;
}

export const realSystem = (): UninstallSystem => ({
  userHome: homedir(),
  platform: process.platform,
  env: process.env,
  interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  apps: allApps,
  processes: findWizardsProcesses,
  stop: (pids) => stopProcesses(pids),
  unloadLoginItem,
  removeUnit,
});

/** Parts of the install folder that are the person's: kept or deleted with the data. */
const WITH_DATA = [".env", ".env.local", "plugins"];

export interface Plan {
  home: string;
  apps: App[];
  loginItem: string | null;
  processes: WizardsProcess[];
  program: string[];
  links: string[];
  /** The data folder and the settings that go with it; empty when there is none. */
  data: string[];
}

function loginItemPath(system: UninstallSystem): string | null {
  if (system.platform === "darwin") {
    return join(system.userHome, "Library", "LaunchAgents", `${LOGIN_LABEL}.plist`);
  }
  if (system.platform === "linux") {
    const config = system.env.XDG_CONFIG_HOME || join(system.userHome, ".config");
    return join(config, "systemd", "user", UNIT);
  }
  return null;
}

/** The links install.sh put into ~/.local/bin that point into the install. */
function ourLinks(home: string, system: UninstallSystem): string[] {
  return ["wizards", "engenty-wizards"]
    .map((name) => join(system.userHome, ".local", "bin", name))
    .filter((link) => {
      try {
        return (
          lstatSync(link).isSymbolicLink() &&
          resolve(dirname(link), readlinkSync(link)).startsWith(home + sep)
        );
      } catch {
        return false;
      }
    });
}

/** Works out what an uninstall takes away, without changing anything. */
export async function makePlan(paths: Layout, system: UninstallSystem): Promise<Plan> {
  const apps: App[] = [];
  for (const app of system.apps(paths)) {
    if (await app.connected().catch(() => false)) {
      apps.push(app);
    }
  }
  const item = loginItemPath(system);
  let loginItem: string | null = null;
  try {
    loginItem = item && present(item) ? item : null;
  } catch {
    // Can't look: count it as there, so the uninstall tries and says so.
    loginItem = item;
  }
  const { dataDir } = settings(paths, system.env);
  const program: string[] = [];
  const data = existsSync(dataDir) ? [dataDir] : [];
  for (const name of existsSync(paths.home) ? readdirSync(paths.home) : []) {
    const path = join(paths.home, name);
    if (path === dataDir) {
      continue;
    }
    const empty = name === "plugins" && readdirSync(path).length === 0;
    (WITH_DATA.includes(name) && !empty ? data : program).push(path);
  }
  return {
    home: paths.home,
    apps,
    loginItem,
    processes: system.processes(paths.home),
    program,
    links: ourLinks(paths.home, system),
    data,
  };
}

/** Size of a folder as `du` counts it, e.g. " (805 MB)"; "" where it can't tell. */
function size(path: string): string {
  const kb = Number(spawnSync("du", ["-sk", path], { encoding: "utf8" }).stdout?.split(/\s/)[0]);
  return kb > 0 ? ` (${kb < 1024 ? `${kb} KB` : `${Math.round(kb / 1024)} MB`})` : "";
}

const processes = (n: number) => `${n} running process${n === 1 ? "" : "es"}`;

/** `wizards uninstall [--dry-run] [--yes] [--delete-data]`. */
export async function uninstall(
  paths: Layout,
  options: UninstallOptions,
  system: UninstallSystem = realSystem(),
): Promise<number> {
  const t = (path: string) =>
    path.startsWith(system.userHome + sep) ? `~${path.slice(system.userHome.length)}` : path;
  if (!options.dryRun && !options.yes && !system.interactive) {
    console.error(
      "The uninstall asks before it deletes anything, and there is no terminal to ask in.\n" +
        "Run it with --yes (your data is kept), --yes --delete-data, or --dry-run to only look.",
    );
    return 2;
  }

  const plan = await makePlan(paths, system);
  const steps = [
    ...plan.apps.map((app) => `Disconnect ${app.name}`),
    ...(plan.loginItem ? [`Remove the login item ${t(plan.loginItem)}`] : []),
    ...(plan.processes.length ? [`Stop ${processes(plan.processes.length)}`] : []),
    ...(plan.program.length ? [`Delete the program in ${t(plan.home)}${size(plan.home)}`] : []),
    ...plan.links.map((link) => `Delete the command ${t(link)}`),
  ];
  if (!steps.length && !plan.data.length) {
    console.log(`${ok} engenty wizards isn’t installed here.`);
    return 0;
  }
  if (steps.length) {
    console.log("\nThis removes engenty wizards:");
  }
  for (const step of steps) {
    console.log(`  ${no} ${step}`);
  }
  if (plan.data.length) {
    console.log(`\nYour data: ${plan.data.map((path) => t(path) + size(path)).join(", ")}`);
    console.log(dim("  Kept unless you choose to delete it. A reinstall picks it up again."));
  }
  console.log("");
  if (options.dryRun) {
    console.log(dim("Nothing was changed (--dry-run)."));
    return 0;
  }

  let deleteData = options.yes && options.deleteData;
  if (!options.yes) {
    if (plan.data.length) {
      const answer = await p.confirm({
        message: "Delete your data too? Your wizards, runs and results are gone for good.",
        initialValue: false,
      });
      if (p.isCancel(answer)) {
        return 130;
      }
      deleteData = answer;
    }
    const go = await p.confirm({
      message: deleteData ? "Uninstall and delete your data now?" : "Uninstall now?",
    });
    if (p.isCancel(go) || !go) {
      p.cancel("Nothing was changed.");
      return 130;
    }
  }

  const failed = (what: string, error: unknown) =>
    console.log(`${bad} ${what}: ${(error as Error).message.split("\n")[0]}`);
  for (const app of plan.apps) {
    const result = await app
      .disconnect()
      .catch((error: Error) => ({ ok: false, message: error.message }));
    console.log(
      result.ok ? `${ok} Disconnected ${app.name}` : `${bad} ${app.name}: ${result.message}`,
    );
  }
  if (plan.loginItem) {
    try {
      if (system.platform === "darwin") {
        await system.unloadLoginItem();
        rmSync(plan.loginItem, { force: true });
      } else {
        await system.removeUnit(plan.loginItem);
      }
      console.log(`${ok} Removed the login item`);
    } catch (error) {
      failed("The login item", error);
    }
  }
  // Twice: an AI app's `wizards mcp` may start the studio again meanwhile.
  for (let round = 0; round < 2; round++) {
    const running = system.processes(paths.home);
    if (running.length && !(await system.stop(running.map((proc) => proc.pid))).length) {
      console.log(`${ok} Stopped ${processes(running.length)}`);
    }
  }
  for (const path of [...plan.program, ...plan.links, ...(deleteData ? plan.data : [])]) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch (error) {
      failed(`Couldn’t delete ${t(path)}`, error);
    }
  }
  for (const dir of [plan.home, join(system.userHome, ".engenty")]) {
    try {
      rmdirSync(dir);
    } catch {
      // not empty, or not there
    }
  }

  // A second look: what is still there.
  const after = await makePlan(paths, system);
  const left = [
    ...after.apps.map(
      (app) => `${app.name} still lists the wizards: ${cyan(`npx wizards disconnect ${app.id}`)}`,
    ),
    ...(after.loginItem ? [t(after.loginItem)] : []),
    ...after.processes.map((proc) => `process ${proc.pid}: ${cyan(`kill -9 ${proc.pid}`)}`),
    ...[...after.program, ...after.links, ...(deleteData ? after.data : [])].map(t),
  ];
  if (!deleteData && after.data.length) {
    console.log(`${ok} Kept your data: ${after.data.map(t).join(", ")}`);
  }
  if (left.length) {
    console.log(`\n${bad} Still there:`);
    for (const line of left) {
      console.log(`  ${line}`);
    }
    return 1;
  }
  console.log(`\n${ok} engenty wizards is uninstalled.\n`);
  return 0;
}

/** The options of `uninstall` from its command line; a message when something is off. */
export function parseUninstall(argv: string[]): UninstallOptions | string {
  const options: UninstallOptions = { dryRun: false, yes: false, deleteData: false };
  for (const arg of argv) {
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--yes" || arg === "-y") {
      options.yes = true;
    } else if (arg === "--delete-data") {
      options.deleteData = true;
    } else if (arg !== "uninstall") {
      return `Unknown option ${arg}. The uninstall takes --dry-run, --yes and --delete-data.`;
    }
  }
  return options;
}
