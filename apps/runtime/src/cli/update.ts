import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { autoUpdatePolicy, noteUpdated } from "./autoupdate.js";
import {
  installedByScript,
  isCheckout,
  type Layout,
  readInstallNote,
  writeInstallNote,
} from "./home.js";
import { runningRuntime, settings, startInBackground } from "./start.js";
import { restart, stop } from "./status.js";
import { cmd, cyan, no, ok } from "./ui.js";
import { currentVersion } from "./versions.js";

const windows = process.platform === "win32";

/** The installer this install was made with; it also updates one. */
const INSTALLER = windows ? "https://engenty.ai/install.ps1" : "https://engenty.ai/install.sh";

async function installer(into: string): Promise<string> {
  const source = process.env.ENGENTY_WIZARDS_INSTALLER?.trim() || INSTALLER;
  if (!/^https?:\/\//.test(source)) {
    return source;
  }
  const response = await fetch(source);
  const text = response.ok ? await response.text() : "";
  // The address answers with the studio's page while a server has no installer yet.
  if (!text.startsWith(windows ? "# engenty wizards" : "#!")) {
    throw new Error(`${source} didn’t return the installer.`);
  }
  const file = join(into, windows ? "install.ps1" : "install.sh");
  writeFileSync(file, text, { mode: 0o700 });
  return file;
}

/** The installer, without its questions. */
function runInstaller(script: string): Promise<number> {
  const [command, args] = windows
    ? ["powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-NoSetup"]]
    : ["bash", [script, "--no-setup"]];
  return new Promise<number>((done) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", () => done(127));
    child.on("exit", (exit) => done(exit ?? 1));
  });
}

/**
 * Brings an install made by install.sh to the newest version by running the installer again
 * without its questions: Node, the runtime and the command. With `restart`, a runtime that runs
 * restarts into the new version; otherwise it says how.
 */
export async function update(paths: Layout, options: { restart?: boolean } = {}): Promise<number> {
  if (!installedByScript(paths)) {
    console.log(
      isCheckout()
        ? `This is a source checkout. To update: ${cyan("git pull && pnpm install && pnpm build")}`
        : `This copy runs from npm. To update: ${cyan("npx wizards@latest")}`,
    );
    return 0;
  }
  const before = currentVersion(paths);
  // Windows keeps the files of a running program locked, its native modules among them: the
  // runtime stops for the update and starts again after it, as the new version.
  const stopped = windows && (await runningRuntime(settings(paths).dataDir)) !== null;
  if (stopped && (await stop(paths)) !== 0) {
    return 1;
  }
  const tmp = mkdtempSync(join(paths.home, "update-"));
  try {
    const code = await runInstaller(await installer(tmp));
    if (code !== 0) {
      return code;
    }
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    if (stopped) {
      await startInBackground(paths);
    }
  }

  const after = currentVersion(paths);
  if (before && after) {
    noteUpdated(paths, before, after);
  }

  if (!stopped && (await runningRuntime(settings(paths).dataDir))) {
    if (options.restart) {
      return restart(paths);
    }
    console.log(`  Installed. Restart engenty wizards to use the new version: ${cmd("restart")}`);
  }
  return 0;
}

/** `wizards autoupdate [on|off]`: whether updates come by themselves (autoupdate.ts). */
export function autoUpdateCommand(paths: Layout, value: string): number {
  if (value && value !== "on" && value !== "off") {
    console.error(`Use ${cmd("autoupdate on")} or ${cmd("autoupdate off")}.`);
    return 2;
  }
  const installed = installedByScript(paths);
  if (value && installed) {
    writeInstallNote({ ...readInstallNote(paths), autoUpdate: value === "on" }, paths);
  }
  const policy = autoUpdatePolicy(paths, { installed });
  console.log(
    policy.on
      ? `${ok} Updates come by themselves: downloaded in the background, used from the next start.`
      : `${no} Updates don’t come by themselves: ${policy.reason}. To update now: ${cmd("update")}`,
  );
  return value && !installed ? 1 : 0;
}
