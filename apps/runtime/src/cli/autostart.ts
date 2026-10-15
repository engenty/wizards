import { execFile } from "node:child_process";
import { lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { installedByScript, installedScript, type Layout } from "./home.js";
import { findOnPath } from "./machine.js";

const run = promisify(execFile);

/**
 * engenty wizards starting by itself when the person logs in, so that links and AI clients
 * reach it without anybody starting it: `wizards start --no-open`, on a Mac from a
 * LaunchAgent, on Linux from a systemd user service, on Windows from a scheduled task (or, where
 * Windows refuses one without an administrator, a shortcut in the Startup folder). Only for an
 * install made by the installer, whose command stays where it is.
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

const TASK = "engenty wizards";
const TASK_HOW = `a scheduled task, ${TASK}`;
const STARTUP_HOW = "a shortcut in the Startup folder";

/** The shortcut Windows starts at login when no task may be made. */
function startupShortcut(env: NodeJS.ProcessEnv = process.env): string {
  return join(
    env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
    `${TASK}.lnk`,
  );
}

/**
 * What Windows starts: the install's Node and script through conhost without a window — Node is
 * a console program, and the task or shortcut would otherwise open a console at every login.
 */
export function windowsStart(paths: Layout): { file: string; args: string[] } {
  const { node, script } = installedScript(paths, "win32");
  return {
    file: join(process.env.SystemRoot ?? "C:\\Windows", "System32", "conhost.exe"),
    args: ["--headless", node, script, "start", "--no-open"],
  };
}

const quoted = (arg: string) => (/[\s"]/.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg);

async function windowsState(): Promise<Autostart> {
  try {
    await run("schtasks", ["/Query", "/TN", TASK], { timeout: 10_000 });
    return { on: true, how: TASK_HOW };
  } catch {
    return existsSync(startupShortcut())
      ? { on: true, how: STARTUP_HOW }
      : { on: false, how: TASK_HOW };
  }
}

async function setWindows(paths: Layout, on: boolean): Promise<Autostart> {
  await run("schtasks", ["/Delete", "/F", "/TN", TASK], { timeout: 10_000 }).catch(() => undefined);
  rmSync(startupShortcut(), { force: true });
  if (!on) {
    return windowsState();
  }
  // Takes effect at the next login, as on a Mac; nothing is started now.
  const { file, args } = windowsStart(paths);
  const command = [file, ...args].map(quoted).join(" ");
  try {
    await run(
      "schtasks",
      ["/Create", "/F", "/TN", TASK, "/SC", "ONLOGON", "/RL", "LIMITED", "/TR", command],
      {
        timeout: 15_000,
      },
    );
  } catch {
    // A task at logon may need an administrator; the Startup folder needs none.
    const ps = (text: string) => `'${text.replaceAll("'", "''")}'`;
    await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        [
          "$s = (New-Object -ComObject WScript.Shell).CreateShortcut(" +
            ps(startupShortcut()) +
            ")",
          `$s.TargetPath = ${ps(file)}`,
          `$s.Arguments = ${ps(args.map(quoted).join(" "))}`,
          `$s.WorkingDirectory = ${ps(paths.home)}`,
          "$s.Save()",
        ].join("; "),
      ],
      { timeout: 15_000 },
    );
  }
  return windowsState();
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
  if (!["darwin", "linux", "win32"].includes(process.platform)) {
    return { unavailable: `not on ${process.platform}` };
  }
  const file = process.platform === "darwin" ? LOGIN_ITEM : unitFile();
  const there = present(file);
  if (!there && !installedByScript(paths)) {
    return { unavailable: "only for installs made with the install script" };
  }
  if (process.platform === "win32") {
    return windowsState();
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
  if (process.platform === "win32") {
    return setWindows(paths, on);
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
