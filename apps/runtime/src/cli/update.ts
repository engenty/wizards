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
import { runningRuntime, settings } from "./start.js";
import { restart } from "./status.js";
import { cmd, cyan, no, ok } from "./ui.js";
import { currentVersion } from "./versions.js";

/** The installer this install was made with; it also updates one. */
const INSTALLER = "https://engenty.ai/install.sh";

async function installer(into: string): Promise<string> {
  const source = process.env.ENGENTY_WIZARDS_INSTALLER?.trim() || INSTALLER;
  if (!/^https?:\/\//.test(source)) {
    return source;
  }
  const response = await fetch(source);
  const text = response.ok ? await response.text() : "";
  // The address answers with the studio's page while a server has no installer yet.
  if (!text.startsWith("#!")) {
    throw new Error(`${source} didn’t return the installer.`);
  }
  const file = join(into, "install.sh");
  writeFileSync(file, text, { mode: 0o700 });
  return file;
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
  const tmp = mkdtempSync(join(paths.home, "update-"));
  try {
    const script = await installer(tmp);
    const code = await new Promise<number>((done) => {
      const child = spawn("bash", [script, "--no-setup"], { stdio: "inherit" });
      child.on("error", () => done(127));
      child.on("exit", (exit) => done(exit ?? 1));
    });
    if (code !== 0) {
      return code;
    }
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  const after = currentVersion(paths);
  if (before && after) {
    noteUpdated(paths, before, after);
  }

  if (await runningRuntime(settings(paths).dataDir)) {
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
