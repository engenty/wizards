import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { accountState, describeAccount } from "./account.js";
import { type Autostart, autostartForStatus, autostartState, setAutostart } from "./autostart.js";
import { autoUpdatePolicy, updateNotice } from "./autoupdate.js";
import { installedByScript, isCheckout, type Layout, packageRoot, packageVersion } from "./home.js";
import { detectClients, findChrome, findFfmpeg, nodeIsCurrent } from "./machine.js";
import { findWizardsProcesses, stopProcesses } from "./processes.js";
import { installedEngines } from "./sandbox.js";
import { entryUrl, runningRuntime, settings, startInBackground } from "./start.js";
import { bad, badge, cmd, cyan, dim, no, ok, tilde } from "./ui.js";

/**
 * What is installed and what runs. With `checks` (`doctor`) it also says what is wrong and
 * returns 1 when something is.
 */
export async function status(paths: Layout, checks: boolean): Promise<number> {
  const { dataDir } = settings(paths);
  const [running, clients, ffmpeg, atLogin, account] = await Promise.all([
    runningRuntime(dataDir),
    detectClients(paths),
    findFfmpeg(),
    autostartForStatus(paths),
    accountState(),
  ]);
  const chrome = findChrome();
  const row = (label: string, value: string) => console.log(`  ${label.padEnd(9)} ${value}`);

  console.log(`\n${badge("engenty wizards")} ${dim(packageVersion())}\n`);
  row(
    "Install",
    installedByScript()
      ? tilde(paths.home)
      : `${tilde(packageRoot)} ${dim(isCheckout() ? "(a checkout)" : "(npm)")}`,
  );
  row("Data", tilde(dataDir));
  row("Node", `${process.version} ${dim(tilde(process.execPath))}`);
  row(
    "Running",
    running
      ? `${ok} ${cyan(running.url)} ${dim(`pid ${running.pid}, since ${new Date(running.startedAt).toLocaleString()}`)}`
      : `${no} not running`,
  );
  if (!("unavailable" in atLogin)) {
    row("At login", atLogin.on ? `${ok} starts ${dim(`(${atLogin.how})`)}` : `${no} doesn’t start`);
  }
  if (installedByScript(paths)) {
    const policy = autoUpdatePolicy(paths, { installed: true });
    row(
      "Updates",
      policy.on ? `${ok} automatic` : `${no} ${policy.reason} ${dim(`(${cmd("autoupdate on")})`)}`,
    );
  }
  row("Account", `${account.kind === "linked" ? ok : no} ${describeAccount(account)}`);
  for (const { client, path, version } of clients) {
    row(
      client.name.split(" ")[0],
      path ? `${ok} ${version} ${dim(tilde(path))}` : `${no} not installed`,
    );
  }
  row(
    "Browser",
    chrome ? `${ok} ${dim(tilde(chrome))}` : `${no} not found (needed for PDF and PNG)`,
  );
  row("ffmpeg", ffmpeg.path ? `${ok} ${ffmpeg.version ?? ""}` : `${no} not found (needed for MP4)`);
  const engines = installedEngines(paths);
  row(
    "Sandbox",
    engines.length
      ? engines
          .map(({ label, version, current }) =>
            version === current
              ? `${ok} ${label} ${version}`
              : `${no} ${label} ${version} is outdated (${cmd("sandbox add")} installs ${current})`,
          )
          .join(", ")
      : `${no} not installed (${cmd("sandbox add")} lets AI steps run code)`,
  );
  const { updated, pending } = updateNotice(paths, packageVersion());
  if (updated) {
    console.log(`\n  ${ok} Updated to ${updated.to}. What changed: ${cyan(updated.notes)}`);
  } else if (pending) {
    console.log(`\n  ${ok} Version ${pending.version} is downloaded; it runs from the next start.`);
  }
  console.log("");
  if (!checks) {
    return 0;
  }

  const problems: string[] = [];
  if (!nodeIsCurrent()) {
    problems.push(`Node ${process.version} is too old. engenty wizards needs 24.11 or newer.`);
  }
  for (const part of ["apps/runtime/dist/index.js", "apps/web/dist/index.html", "plugin"]) {
    if (!existsSync(join(packageRoot, part))) {
      problems.push(`${part} is missing from this install (${tilde(packageRoot)}).`);
    }
  }
  try {
    mkdirSync(paths.home, { recursive: true });
    accessSync(paths.home, constants.W_OK);
  } catch {
    problems.push(`${tilde(paths.home)} can’t be written to.`);
  }
  if (!clients.some((state) => state.path)) {
    console.log(
      `  ${no} No AI client. The studio needs an API key, Ollama or Apple Intelligence (Mac only) instead. ${dim(`To install one: ${cmd("setup")}`)}`,
    );
  }
  for (const problem of problems) {
    console.log(`  ${bad} ${problem}`);
  }
  if (!problems.length) {
    console.log(`  ${ok} No problems found.`);
  }
  console.log("");
  return problems.length ? 1 : 0;
}

/** Waits for a process to end; false when it still runs after `ms`. */
async function ended(pid: number, ms: number): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 100) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((wait) => setTimeout(wait, 100));
  }
  return false;
}

/**
 * Stops engenty wizards: the runtime that runs on this install's data folder, and every other
 * runtime or `start` of this install still about (an older `start --no-open` whose note another
 * one overwrote). `wizards mcp` processes belong to the AI apps and stay.
 */
export async function stop(paths: Layout): Promise<number> {
  const { dataDir } = settings(paths);
  const running = await runningRuntime(dataDir);
  const found = findWizardsProcesses(paths.home);
  const pids = [
    ...new Set([
      ...(running ? [running.pid] : []),
      ...found.filter((p) => p.kind === "runtime" || p.kind === "start").map((p) => p.pid),
    ]),
  ];
  if (!pids.length) {
    console.log("engenty wizards isn’t running.");
    return 0;
  }
  const left = await stopProcesses(pids);
  const stopped = pids.length - left.length;
  if (stopped) {
    console.log(
      pids.length === 1
        ? `Stopped (pid ${pids[0]}). Your data is kept.`
        : `Stopped ${stopped} processes (pid ${pids.filter((pid) => !left.includes(pid)).join(", ")}). Your data is kept.`,
    );
  }
  const apps = found.filter((p) => p.kind === "mcp").length;
  if (apps && !left.length) {
    console.log(
      dim(
        `${apps === 1 ? "An AI app connection still runs" : `${apps} AI app connections still run`}. Using a wizard there starts engenty wizards again.`,
      ),
    );
  }
  if (left.length) {
    console.error(
      `${left.length === 1 ? "A process" : `${left.length} processes`} of engenty wizards didn’t stop (pid ${left.join(", ")}). To stop ${left.length === 1 ? "it" : "them"}: ${cyan(`kill -9 ${left.join(" ")}`)}`,
    );
    return 1;
  }
  return 0;
}

/**
 * Stops the runtime and starts it again, the version on disk now. One the command started (a
 * terminal, the login item) is started again by that command, where it ran; any other is
 * stopped and started in the background. When nothing runs, it is started in the background.
 */
export async function restart(paths: Layout): Promise<number> {
  const { dataDir } = settings(paths);
  const running = await runningRuntime(dataDir);
  if (running?.restarts && process.platform !== "win32") {
    process.kill(running.pid, "SIGUSR2");
    for (let waited = 0; waited < 60_000; waited += 300) {
      await new Promise((wait) => setTimeout(wait, 300));
      const again = await runningRuntime(dataDir);
      if (again && again.pid !== running.pid) {
        console.log(`${ok} Restarted: ${cyan(again.url)} ${dim(`pid ${again.pid}`)}`);
        return 0;
      }
    }
    console.error("engenty wizards didn’t restart within a minute.");
    return 1;
  }
  if (running) {
    process.kill(running.pid, "SIGTERM");
    if (!(await ended(running.pid, 8000))) {
      console.error(`engenty wizards (pid ${running.pid}) didn’t stop within 8 seconds.`);
      return 1;
    }
  }
  const started = await startInBackground(paths);
  if (!started) {
    console.error(
      `engenty wizards didn’t start. Its log is in ${tilde(join(paths.logs, "runtime.log"))}.`,
    );
    return 1;
  }
  console.log(
    `${ok} ${running ? "Restarted" : "Started"}: ${cyan(started.url)} ${dim(`pid ${started.pid}, in the background`)}`,
  );
  if (!running) {
    console.log(`  Open the studio: ${cyan(entryUrl(started, paths))}`);
  }
  return 0;
}

/** `autostart [on|off]`: whether it starts at login, and the switch. */
export async function autostart(paths: Layout, value: string): Promise<number> {
  if (value && value !== "on" && value !== "off") {
    console.error(`Use ${cmd("autostart on")} or ${cmd("autostart off")}.`);
    return 2;
  }
  let state: Autostart;
  try {
    state = await autostartState(paths);
    if (value && !("unavailable" in state)) {
      state = await setAutostart(paths, value === "on");
    }
  } catch (error) {
    console.error(
      `Couldn’t ${value ? `turn start at login ${value}` : "check start at login"}: ${(error as Error).message}`,
    );
    return 1;
  }
  if ("unavailable" in state) {
    console.error(`Start at login isn’t available here: ${state.unavailable}.`);
    return value ? 1 : 0;
  }
  console.log(
    state.on
      ? `${ok} engenty wizards starts at login: ${state.how}.`
      : `${no} engenty wizards doesn’t start at login. ${dim(`To turn it on: ${cmd("autostart on")}`)}`,
  );
  if (state.on && process.platform === "linux") {
    console.log(dim(`  To start it even before anyone logs in: ${cyan("loginctl enable-linger")}`));
  }
  return value && state.on !== (value === "on") ? 1 : 0;
}
