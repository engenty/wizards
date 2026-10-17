import { spawnSync } from "node:child_process";
import { join } from "node:path";
import * as p from "@clack/prompts";
import type { Running } from "../running.js";
import { type UpdateStatus, updateStatus } from "../update.js";
import { type AccountState, accountMenu, accountState, describeAccount } from "./account.js";
import { type Autostart, autostartForStatus, setAutostart } from "./autostart.js";
import { connectCommand } from "./connect.js";
import { command, type Layout, packageRoot, packageVersion, readInstallNote } from "./home.js";
import { type SetupOptions, setup } from "./setup.js";
import { open, runningRuntime, settings, start } from "./start.js";
import { restart, status, stop } from "./status.js";
import { badge, busy, cmd, cyan, dim, no, ok } from "./ui.js";
import { update } from "./update.js";

type Action =
  | "start"
  | "foreground"
  | "open"
  | "restart"
  | "stop"
  | "update"
  | "service"
  | "connect"
  | "account"
  | "status"
  | "setup"
  | "uninstall"
  | "help"
  | "quit";

interface State {
  running: Running | null;
  atLogin: Autostart;
  release: UpdateStatus | null;
  account: AccountState;
}

async function look(paths: Layout): Promise<State> {
  const { dataDir } = settings(paths);
  const [running, atLogin, release, account] = await Promise.all([
    runningRuntime(dataDir),
    autostartForStatus(paths),
    updateStatus().catch(() => null),
    accountState(),
  ]);
  return { running, atLogin, release, account };
}

function report({ running, atLogin, release, account }: State): string {
  const lines = [
    running
      ? `${ok} running  ${cyan(running.url)} ${dim(`pid ${running.pid}, since ${new Date(running.startedAt).toLocaleString()}`)}`
      : `${no} not running`,
  ];
  if (!("unavailable" in atLogin)) {
    lines.push(atLogin.on ? `${ok} starts at login` : `${no} doesn’t start at login`);
  }
  lines.push(
    account.kind === "linked"
      ? `${ok} signed in as ${describeAccount(account)}`
      : `${no} ${describeAccount(account)}`,
  );
  if (release?.newer) {
    lines.push(`${cyan("↑")} ${release.latest} is out ${dim(`(you have ${release.current})`)}`);
  }
  return lines.join("\n");
}

function choices({ running, atLogin, release, account }: State): p.Option<Action>[] {
  const options: p.Option<Action>[] = running
    ? [
        { value: "open", label: "Open the studio", hint: "in your browser" },
        { value: "restart", label: "Restart" },
        { value: "stop", label: "Stop", hint: "your data is kept" },
      ]
    : [
        { value: "start", label: "Start in the background", hint: "and open the studio" },
        { value: "foreground", label: "Start in this terminal", hint: "Ctrl-C stops it" },
      ];
  options.push({
    value: "update",
    label: "Update",
    hint: release?.newer ? `${release.latest} is out` : release?.latest ? "up to date" : undefined,
  });
  if (!("unavailable" in atLogin)) {
    options.push({
      value: "service",
      label: "Start at login",
      hint: atLogin.on ? "on" : "off",
    });
  }
  options.push(
    {
      value: "connect",
      label: "Connect AI apps",
      hint: "add your wizards as an MCP server in Claude, Cursor, Codex…",
    },
    {
      value: "account",
      label: "Account",
      hint:
        account.kind === "linked"
          ? `signed in as ${describeAccount(account)}`
          : describeAccount(account),
    },
    { value: "status", label: "Status", hint: "what’s installed, and any problems" },
    { value: "setup", label: "Setup", hint: "account, AI client, ffmpeg, start at login" },
    {
      value: "uninstall",
      label: "Uninstall",
      hint: "remove it from this computer; asks about your data first",
    },
    { value: "help", label: "Help", hint: "every command" },
    { value: "quit", label: "Quit", hint: running ? "engenty wizards keeps running" : undefined },
  );
  return options;
}

/** Whether it starts at login. Esc goes back to the menu. */
async function serviceSettings(paths: Layout, atLogin: Autostart) {
  if ("unavailable" in atLogin) {
    return;
  }
  const on = await p.select<boolean>({
    message: "Start at login?",
    initialValue: atLogin.on,
    options: [
      {
        value: true,
        label: "Yes",
        hint: "runs in the background whenever you log in to this computer",
      },
      { value: false, label: "No", hint: "only when you start it" },
    ],
  });
  if (p.isCancel(on) || on === atLogin.on) {
    return;
  }
  try {
    await setAutostart(paths, on);
  } catch (error) {
    p.log.warn(`Couldn’t change start at login: ${(error as Error).message}`);
  }
}

/** The commands used most, for when the menu ends. */
function commands(): string {
  const name = command();
  return [
    [`${name} start`, "start engenty wizards and open the studio"],
    [`${name} studio`, "open the studio, starting engenty wizards if needed"],
    [`${name} stop`, "stop engenty wizards (your data is kept)"],
    [`${name} status`, "show what’s installed and running"],
    [`${name} update`, "install the latest version"],
    [`${name} --version`, "print the version you have"],
    [`${name} help`, "list every command"],
  ]
    .map(([line, what]) => `${cyan(line.padEnd(name.length + 12))}${dim(what)}`)
    .join("\n");
}

/**
 * `wizards` on a terminal: what runs, and a menu of what the commands do. The first time, the
 * setup runs first. Returns the exit code; "Start in this terminal" ends it with the runtime in the
 * foreground.
 */
export async function menu(
  paths: Layout,
  setupOptions: SetupOptions,
  help: string,
): Promise<number> {
  if (!readInstallNote(paths).setupAt) {
    if (!(await setup(paths, { ...setupOptions, next: "menu" }))) {
      return 130;
    }
  }

  p.intro(`${badge("engenty wizards")} ${dim(packageVersion())}`);
  for (;;) {
    const spinner = busy("Checking status…");
    const state = await look(paths);
    spinner.stop(report(state));

    const action = await p.select<Action>({
      message: "What would you like to do?",
      options: choices(state),
    });
    if (p.isCancel(action) || action === "quit") {
      p.outro(dim(`${cmd()} opens this menu again. ${cmd("help")} lists every command.`));
      return 0;
    }
    switch (action) {
      case "start":
        await start(paths, { open: true, background: true });
        break;
      case "foreground":
        p.outro("Starting engenty wizards here…");
        return start(paths, { open: true });
      case "open":
        await open(paths, false);
        break;
      case "restart":
        await restart(paths);
        break;
      case "stop":
        await stop(paths);
        break;
      case "update": {
        // What runs restarts into the new version.
        if ((await update(paths, { restart: true })) !== 0) {
          break;
        }
        // This menu is still the old version, so it ends here.
        p.note(commands(), "Updated");
        p.outro(dim(`${cmd()} opens this menu again, in the new version.`));
        return 0;
      }
      case "service":
        await serviceSettings(paths, state.atLogin);
        break;
      case "connect":
        await connectCommand(paths, [], false);
        break;
      case "account":
        await accountMenu(paths);
        break;
      case "status":
        await status(paths, true);
        break;
      case "setup":
        await setup(paths, setupOptions);
        break;
      case "uninstall": {
        // Its own process, as `wizards uninstall` is: this one's modules write to the install.
        const { status: code } = spawnSync(
          process.execPath,
          [join(packageRoot, "bin", "wizards.mjs"), "uninstall"],
          { stdio: "inherit" },
        );
        // 130: the person said no, so the menu goes on.
        if (code !== 130) {
          return code ?? 1;
        }
        break;
      }
      case "help":
        console.log(help);
        break;
    }
  }
}
