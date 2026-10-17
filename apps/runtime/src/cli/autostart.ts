import { execFile } from "node:child_process";
import { lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { installedByScript, type Layout } from "./home.js";
import { findOnPath } from "./machine.js";

const run = promisify(execFile);

/**
 * engenty wizards starting by itself when the person logs in, so that links and AI clients
 * reach it without anybody starting it: `wizards start --no-open`, on a Mac from a
 * LaunchAgent, on Linux from a systemd user service. Only for an install made by install.sh,
 * whose command stays where it is.
 */

export const LOGIN_LABEL = "com.engenty.wizards.login";

/** The LaunchAgent. */
export const LOGIN_ITEM = join(homedir(), "Library", "LaunchAgents", `${LOGIN_LABEL}.plist`);

const xml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** The LaunchAgent: the command of this install, started again when it fails. */
export function loginItemText(command: string, log: string): string {
  const program = [command, "start", "--no-open"];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LOGIN_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${program.map((arg) => `    <string>${xml(arg)}</string>\n`).join("")}  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
  <key>ProcessType</key>
  <string>Interactive</string>
</dict>
</plist>
`;
}

export const UNIT = "engenty-wizards.service";

export function unitFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user", UNIT);
}

/** The systemd user service: the command of this install, started again when it fails. */
export function unitText(command: string): string {
  return [
    "[Unit]",
    "Description=engenty wizards",
    "Documentation=https://github.com/engenty/wizards",
    "",
    "[Service]",
    `ExecStart="${command.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}" start --no-open`,
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/** Whether it starts at login, or why it cannot here. */
export type Autostart = { on: boolean; how: string } | { unavailable: string };

const MAC_HOW = `a LaunchAgent, ${LOGIN_LABEL}`;
const LINUX_HOW = `a systemd user service, ${UNIT}`;

async function systemdHere(): Promise<boolean> {
  if (!findOnPath("systemctl", process.env.PATH ?? "")) {
    return false;
  }
  try {
    await run("systemctl", ["--user", "show-environment"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a file is there. Unlike existsSync, a folder it may not look into (a sandbox, its
 * permissions) is an error, not "no file": `autostart off` must not say it's off then.
 */
export function present(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw new Error(`Couldn’t check ${file}: ${(error as Error).message}`);
  }
}

/**
 * Whether it starts at login, read from the login item itself: a LaunchAgent or unit file that
 * is there counts, whichever copy of the command wrote it. Only an install made by install.sh can
 * write one.
 */
export async function autostartState(paths: Layout): Promise<Autostart> {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    return {
      unavailable: process.platform === "win32" ? "not on Windows" : `not on ${process.platform}`,
    };
  }
  const file = process.platform === "darwin" ? LOGIN_ITEM : unitFile();
  const there = present(file);
  if (!there && !installedByScript(paths)) {
    return { unavailable: "only for installs made with the install script" };
  }
  if (process.platform === "darwin") {
    return { on: there, how: MAC_HOW };
  }
  if (!(await systemdHere())) {
    return there
      ? { on: true, how: LINUX_HOW }
      : { unavailable: "this system has no systemd user session" };
  }
  try {
    await run("systemctl", ["--user", "is-enabled", "--quiet", UNIT], { timeout: 10_000 });
    return { on: true, how: LINUX_HOW };
  } catch {
    // A unit file that is there but not enabled still counts: `off` takes it away.
    return { on: there, how: LINUX_HOW };
  }
}

/** The LaunchAgent unloaded from this login session, if launchd has it; errors are ignored. */
export async function unloadLoginItem(): Promise<void> {
  const uid = process.getuid?.();
  if (process.platform !== "darwin" || uid === undefined) {
    return;
  }
  await run("launchctl", ["bootout", `gui/${uid}/${LOGIN_LABEL}`], { timeout: 15_000 }).catch(
    () => undefined,
  );
}

/** The systemd user service disabled, stopped and its file gone. */
export async function removeUnit(file = unitFile()): Promise<void> {
  if (findOnPath("systemctl", process.env.PATH ?? "")) {
    await run("systemctl", ["--user", "disable", "--now", UNIT]).catch(() => undefined);
  }
  rmSync(file, { force: true });
  if (findOnPath("systemctl", process.env.PATH ?? "")) {
    await run("systemctl", ["--user", "daemon-reload"]).catch(() => undefined);
  }
}

/** Switches it on or off; what it is afterwards, or an error the person can read. */
export async function setAutostart(paths: Layout, on: boolean): Promise<Autostart> {
  const state = await autostartState(paths);
  if ("unavailable" in state) {
    return state;
  }
  if (process.platform === "darwin") {
    // Takes effect at the next login; nothing is started or stopped now.
    if (on) {
      mkdirSync(dirname(LOGIN_ITEM), { recursive: true });
      writeFileSync(
        LOGIN_ITEM,
        loginItemText(
          join(paths.home, "bin", "wizards"),
          join(paths.home, "logs", "autostart.log"),
        ),
      );
    } else {
      rmSync(LOGIN_ITEM, { force: true });
    }
    return { on: present(LOGIN_ITEM), how: MAC_HOW };
  }
  const file = unitFile();
  if (on) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, unitText(join(paths.home, "bin", "wizards")));
    await run("systemctl", ["--user", "daemon-reload"]);
    await run("systemctl", ["--user", "enable", "--now", UNIT]);
  } else {
    await removeUnit(file);
  }
  return autostartState(paths);
}

/** The state for a status line: a login item that can't be checked reads as unavailable. */
export function autostartForStatus(paths: Layout): Promise<Autostart> {
  return autostartState(paths).catch((error: Error): Autostart => ({ unavailable: error.message }));
}
