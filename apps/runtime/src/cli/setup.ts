import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir, totalmem } from "node:os";
import { delimiter, join } from "node:path";
import * as p from "@clack/prompts";
import { LOCAL_DECISION_MODEL } from "../decision-model.js";
import { accountStep } from "./account.js";
import { autostartForStatus, setAutostart } from "./autostart.js";
import { installClient, installCommand } from "./clients.js";
import { appStates, connectApps } from "./connect.js";
import { runLogged } from "./exec.js";
import {
  command,
  installedByScript,
  isCheckout,
  type Layout,
  packageVersion,
  readInstallNote,
  writeInstallNote,
} from "./home.js";
import {
  CLIENTS,
  type Client,
  type ClientState,
  detectClients,
  findChrome,
  findFfmpeg,
  findOnPath,
  suggestedClient,
  vendorApp,
} from "./machine.js";
import {
  appAsksForPassword,
  DECISION_MODEL_GB,
  decisionModelProblem,
  freeGb,
  installOllama,
  ollamaState,
  pullModel,
  servesDecisions,
  startOllama,
} from "./ollama.js";
import { runningRuntime, settings } from "./start.js";
import { badge, busy, cmd, cyan, dim, tilde } from "./ui.js";

export interface SetupOptions {
  /** Ask nothing and install nothing optional: say what is there and what is missing. */
  yes: boolean;
  /** Clients to install without asking (`--client codex`). */
  clients: string[];
  /** No account: nothing leaves this computer (`--local`; the docs explain it). */
  local: boolean;
  /**
   * What follows the setup when it runs the first time: the menu, or the start. That one
   * shows the way on, so the setup ends short instead of with every command.
   */
  next?: "menu" | "start";
}

/** The studio as an app of its own: Chrome (or Edge) installs it from the page. */
const CHROME_APP =
  "Tip: in Chrome or Edge you can install the studio as an app, with its own window and icon. Use the offer at the top of the studio, or the install icon in the address bar.";

function cancelled<T>(value: T | symbol): value is symbol {
  if (p.isCancel(value)) {
    p.cancel(`Setup stopped. To run it again: ${cmd("setup")}`);
    return true;
  }
  return false;
}

async function install(client: Client, paths: Layout): Promise<boolean> {
  const task = p.taskLog({ title: `Installing ${client.name}`, limit: 6 });
  task.message(dim(installCommand(client, paths)));
  const { code, tail } = await installClient(client, paths, (line) => task.message(line));
  const installed = (await detectClients(paths)).find((state) => state.client.id === client.id);
  if (code === 0 && installed?.path) {
    task.success(`${client.name} ${installed.version ?? ""} installed`.trim());
    return true;
  }
  task.error(
    `${client.name} didn’t install${code === 0 ? ": its command isn’t on the PATH" : ""}. ${tail.split("\n").pop() ?? ""}`,
  );
  return false;
}

async function clientsStep(
  paths: Layout,
  options: SetupOptions,
  interactive: boolean,
): Promise<boolean | "cancelled"> {
  const spinner = busy("Looking for AI clients on this computer…");
  const found = await detectClients(paths);
  const installed = found.filter((state) => state.path);
  const missing = found.filter((state) => !state.path);
  spinner.stop(
    installed.length
      ? `Found AI clients: ${installed.map((s) => `${s.client.name} ${s.version}`).join(", ")}.`
      : "No AI client on this computer yet.",
  );

  if (!installed.length) {
    p.log.message(
      dim(
        "engenty wizards runs its AI through an AI client, like Claude Code or Codex, on a subscription you already have.",
      ),
    );
  }

  let wanted: ClientState[] = missing.filter((s) => options.clients.includes(s.client.id));
  // With a client already here, setup asks nothing more; another one is a `--client` away.
  if (interactive && !installed.length && missing.length && !wanted.length) {
    const suggested = suggestedClient(missing);
    // A client whose app is on this Mac comes first: its subscription is most likely paid for.
    const offered = [...missing].sort(
      (a, b) => Number(!vendorApp(a.client)) - Number(!vendorApp(b.client)),
    );
    const answer = await p.multiselect({
      message: "Which AI client should be installed? (space to choose, enter to continue)",
      options: offered.map(({ client }) => {
        const app = vendorApp(client);
        return {
          value: client.id,
          label: client.name,
          hint: [
            `${client.account} subscription`,
            app ? `the ${app} app is on this Mac` : "",
            client.id === suggested?.client.id ? "recommended" : "",
          ]
            .filter(Boolean)
            .join(", "),
        };
      }),
      initialValues: suggested ? [suggested.client.id] : [],
      required: false,
    });
    if (cancelled(answer)) {
      return "cancelled";
    }
    wanted = missing.filter((s) => answer.includes(s.client.id));
  }
  let any = installed.length > 0;
  for (const { client } of wanted) {
    any = (await install(client, paths)) || any;
  }
  if (any) {
    p.log.info("Sign in to the AI client on the first page of the studio.");
  } else {
    p.log.warn(
      `No AI client yet. The first page of the studio can install one, or you can use an API key (Vercel AI Gateway, OpenAI, Anthropic) or a local model (Ollama).\n${dim(
        `To install ${CLIENTS.map((c) => c.name).join(", ")} here later: ${cmd("setup")}`,
      )}`,
    );
  }
  return any;
}

async function toolsStep(interactive: boolean): Promise<"cancelled" | undefined> {
  const chrome = findChrome();
  if (chrome) {
    p.log.success(`Browser for PDF and PNG exports: ${dim(tilde(chrome))}`);
  } else {
    p.log.warn(
      "No Chrome, Edge or Chromium found. PDF and PNG exports and browser steps need one.\nhttps://www.google.com/chrome",
    );
  }
  const ffmpeg = await findFfmpeg();
  if (ffmpeg.path) {
    p.log.success(`ffmpeg ${ffmpeg.version ?? ""} for videos`.replace("  ", " "));
    return;
  }
  const brew = findOnPath("brew", process.env.PATH ?? "");
  if (!interactive || !brew) {
    p.log.warn(
      `No ffmpeg found. MP4 videos of animated widgets need it.${brew ? `\n${dim(`To install it: ${cyan("brew install ffmpeg")}`)}` : ""}`,
    );
    return;
  }
  const answer = await p.confirm({
    message: "No ffmpeg (for MP4 videos of animated widgets). Install it with Homebrew?",
    initialValue: false,
  });
  if (cancelled(answer)) {
    return "cancelled";
  }
  if (answer) {
    const task = p.taskLog({ title: "Installing ffmpeg", limit: 6 });
    const { code, tail } = await runLogged(brew, ["install", "ffmpeg"], {
      onLine: (line) => task.message(line),
    });
    if (code === 0) {
      task.success("ffmpeg installed");
    } else {
      task.error(`ffmpeg didn’t install. ${tail.split("\n").pop() ?? ""}`);
    }
  }
}

const gb = (bytes: number) => (bytes / 2 ** 30).toFixed(1);

/**
 * A decision model on this computer: Ollama with Cloudflare's Clef-flash. It answers a wizard's
 * decisions (which branch, which option) without a key or credits. Asked, never assumed: it is a
 * download of about 11 GB.
 */
async function decisionModelStep(
  paths: Layout,
  interactive: boolean,
): Promise<"cancelled" | undefined> {
  const state = await ollamaState();
  if (state.version && !servesDecisions(state.version)) {
    p.log.warn(
      `Ollama ${state.version} is too old for a decision model (it needs 0.35 or newer).\n${dim(`Update Ollama, then run ${cmd("setup")} again.`)}`,
    );
    return;
  }
  // Pulled is not enough: a newer Ollama may no longer run a model pulled in an older format.
  let broken: string | null = null;
  if (state.model) {
    const check = busy(`Checking ${state.model}…`);
    broken = await decisionModelProblem(state.model);
    if (!broken) {
      check.stop(`Decision model: ${state.model} ${dim(`in Ollama ${state.version}`)}`);
      return;
    }
    check.fail(`${state.model} doesn’t run in Ollama ${state.version}: ${broken}`);
  }
  const model = state.model ?? LOCAL_DECISION_MODEL;
  const what = state.path ? `Clef-flash into Ollama` : "Ollama with Clef-flash";
  if (!interactive) {
    p.log.info(
      dim(
        broken
          ? `To download it again: ${cyan(`ollama pull ${model}`)}`
          : `Optional: a decision model on this computer (${what}, about ${DECISION_MODEL_GB} GB). To add it: ${cmd("setup")}`,
      ),
    );
    return;
  }
  const free = await freeGb();
  if (free !== null && free < DECISION_MODEL_GB + 2) {
    p.log.warn(
      `There isn’t room for a decision model: it needs about ${DECISION_MODEL_GB + 2} GB and ${free} GB are free.`,
    );
    return;
  }
  const memory = Math.round(totalmem() / 2 ** 30);
  const answer = await p.confirm({
    message: broken
      ? `Download ${model} again, in the format this Ollama runs? About ${DECISION_MODEL_GB} GB.`
      : `Install a decision model on this computer? ${what} makes the wizards’ decisions (which branch, which option) here, without a key or credits. About ${DECISION_MODEL_GB} GB${memory < 16 ? `; it needs 16 GB of memory and this computer has ${memory}` : ""}.`,
    initialValue: Boolean(broken),
  });
  if (cancelled(answer)) {
    return "cancelled";
  }
  if (!answer) {
    p.log.info(dim(`To add it later: ${cmd("setup")}`));
    return;
  }

  let { path: ollama, version } = state;
  if (!ollama) {
    // On Linux Ollama's installer writes to this terminal itself, and may ask for a password.
    const task =
      process.platform === "linux" ? null : p.taskLog({ title: "Installing Ollama", limit: 6 });
    if (!task) {
      p.log.info("Ollama’s own installer runs now and asks for your password.");
    }
    const outcome = await installOllama(paths, (line) => task?.message(line));
    if (!outcome.ok) {
      const text = `Ollama didn’t install. ${outcome.message}`;
      task ? task.error(text) : p.log.error(text);
      return;
    }
    const installed = `Ollama installed ${dim(tilde(outcome.message))}`;
    task ? task.success(installed) : p.log.success(installed);
    // Linux's installer starts it as a service already.
    ({ path: ollama, version } = await ollamaState());
  }
  if (!version) {
    if (appAsksForPassword(ollama)) {
      p.log.info(
        "Ollama starts now and asks once for your Mac’s password, to put its `ollama` command in /usr/local/bin. Enter it, or cancel: Ollama runs either way.",
      );
    }
    const spinner = p.spinner();
    spinner.start("Waiting for Ollama");
    version = await startOllama(ollama, paths);
    if (!version) {
      spinner.error(`Ollama isn’t answering. Start it, then run ${cmd("setup")} again.`);
      return;
    }
    if (!servesDecisions(version)) {
      spinner.error(`Ollama ${version} is too old for a decision model (it needs 0.35 or newer).`);
      return;
    }
    spinner.stop(`Ollama ${version} is running`);
  }
  const spinner = p.spinner();
  spinner.start(`Downloading ${model}`);
  try {
    await pullModel(model, (done, total) =>
      spinner.message(`Downloading ${model}  ${gb(done)} of ${gb(total)} GB`),
    );
    spinner.stop(`Decision model: ${model} ${dim(`in Ollama ${version}`)}`);
  } catch (error) {
    spinner.error(
      `${model} didn’t download. ${(error as Error).message}\n${dim(`To try again: ${cyan(`ollama pull ${model}`)}`)}`,
    );
  }
}

/**
 * Starting at login: on a Mac a LaunchAgent starts the runtime, on Linux a systemd user
 * service does. Asked, never assumed; `autostart off` undoes it.
 */
async function autostartStep(
  paths: Layout,
  interactive: boolean,
): Promise<"cancelled" | undefined> {
  const state = await autostartForStatus(paths);
  if ("unavailable" in state) {
    return;
  }
  if (state.on) {
    p.log.success(`Starts when you log in to this computer: ${dim(state.how)}`);
    return;
  }
  if (!interactive) {
    p.log.info(dim(`To start it when you log in to this computer: ${cmd("autostart on")}`));
    return;
  }
  const answer = await p.confirm({
    message:
      "Start engenty wizards when you log in to this computer? It runs as a background process, without a terminal window, so links and your AI apps can always reach it.",
    initialValue: true,
  });
  if (cancelled(answer)) {
    return "cancelled";
  }
  if (!answer) {
    p.log.info(dim(`To do it later: ${cmd("autostart on")}`));
    return;
  }
  try {
    const after = await setAutostart(paths, true);
    if ("on" in after && after.on) {
      p.log.success(`Starts when you log in to this computer: ${dim(after.how)}`);
    } else {
      p.log.warn("Couldn’t set it to start when you log in.");
    }
  } catch (error) {
    p.log.warn(`Couldn’t set it to start when you log in. ${(error as Error).message}`);
  }
}

/**
 * The wizards in the person's AI apps (Claude Desktop, Cursor, Codex …): offered for each app on
 * this machine that does not have them yet. Asked, never assumed; `disconnect` undoes it.
 */
async function appsStep(paths: Layout, interactive: boolean): Promise<"cancelled" | undefined> {
  const states = await appStates(paths);
  const connected = states.filter((s) => s.connected);
  const offered = states.filter((s) => s.installed && !s.connected);
  if (connected.length) {
    p.log.success(`Already in your AI apps: ${connected.map((s) => s.name).join(", ")}`);
  }
  if (!offered.length) {
    return;
  }
  if (!interactive) {
    p.log.info(
      dim(`To use your wizards in ${offered.map((s) => s.name).join(", ")}: ${cmd("connect")}`),
    );
    return;
  }
  const answer = await p.multiselect({
    message:
      "Add your wizards to these AI apps, as an MCP server in each app’s settings? (space to choose, enter to continue)",
    options: offered.map((s) => ({ value: s.id, label: s.name })),
    initialValues: offered.map((s) => s.id),
    required: false,
  });
  if (cancelled(answer)) {
    return "cancelled";
  }
  if (!answer.length) {
    p.log.info(dim(`To do it later: ${cmd("connect")}`));
    return;
  }
  for (const { app, outcome } of await connectApps(paths, answer)) {
    if (outcome.ok) {
      p.log.success(`${app.name}: ${dim(outcome.message)}`);
    } else {
      p.log.warn(`${app.name}: ${outcome.message}${outcome.snippet ? `\n${outcome.snippet}` : ""}`);
    }
  }
  p.log.info(dim("Restart those apps to see the wizards in them."));
}

/** The line that puts `~/.local/bin` on the PATH, and the shell file it belongs in. */
function pathLine(): { file: string; line: string } {
  const shell = process.env.SHELL ?? "";
  if (shell.endsWith("fish")) {
    return {
      file: join(homedir(), ".config/fish/config.fish"),
      line: "fish_add_path ~/.local/bin",
    };
  }
  const file = shell.endsWith("zsh")
    ? ".zshrc"
    : process.platform === "darwin"
      ? ".bash_profile"
      : ".bashrc";
  return { file: join(homedir(), file), line: 'export PATH="$HOME/.local/bin:$PATH"' };
}

/** An install made by install.sh has its command in `~/.local/bin`: is that on the PATH? */
async function pathStep(interactive: boolean): Promise<"cancelled" | undefined> {
  const local = join(homedir(), ".local", "bin");
  if (!installedByScript() || (process.env.PATH ?? "").split(delimiter).includes(local)) {
    return;
  }
  const { file, line } = pathLine();
  if (existsSync(file) && readFileSync(file, "utf8").includes(".local/bin")) {
    p.log.info(`Open a new terminal to use the ${cyan("wizards")} command.`);
    return;
  }
  const hint = `Until then, use ${cyan(tilde(join(local, "wizards")))}`;
  if (!interactive) {
    p.log.warn(
      `~/.local/bin isn’t on your PATH. Add this to ${tilde(file)}:\n${line}\n${dim(hint)}`,
    );
    return;
  }
  const answer = await p.confirm({
    message: `The wizards command is in ~/.local/bin, which isn’t on your PATH. Add it in ${tilde(file)}?`,
    initialValue: true,
  });
  if (cancelled(answer)) {
    return "cancelled";
  }
  if (answer) {
    appendFileSync(file, `\n# engenty wizards\n${line}\n`);
    p.log.success(`Added to ${tilde(file)}. Open a new terminal to use it.\n${dim(hint)}`);
  } else {
    p.log.info(hint);
  }
}

/** What runs now, and the commands to start, stop and check it from now on. */
async function howToUse(paths: Layout) {
  const [running, atLogin] = await Promise.all([
    runningRuntime(settings(paths).dataDir),
    autostartForStatus(paths),
  ]);
  const wizards = command();
  const row = (what: string, cmd: string, note = "") =>
    `${what.padEnd(9)}${cyan(cmd.padEnd(wizards.length + 12))}${note ? dim(note) : ""}`;
  p.log.message(
    [
      running
        ? `engenty wizards is running: ${cyan(running.url)}`
        : "engenty wizards isn’t running yet.",
      "unavailable" in atLogin || !atLogin.on
        ? ""
        : dim("It starts automatically when you log in to this computer."),
    ]
      .filter(Boolean)
      .join("\n"),
  );
  p.outro(
    [
      "From now on, in a terminal:",
      "",
      row("Start", `${wizards} start`, "runs in this terminal; Ctrl-C stops it"),
      row("", `${wizards} start -s`, "runs in the background; the terminal stays free"),
      row("Studio", `${wizards} studio`, "opens the studio, starting it first if needed"),
      row("Stop", `${wizards} stop`, "your data is kept"),
      row("Check", `${wizards} status`, "shows what’s running and where"),
      row("Restart", `${wizards} restart`),
      row("Menu", wizards, "everything in one menu"),
      "",
      dim("It’s installed, so there’s no need to run the installer again. To update: ") +
        cmd("update"),
    ].join("\n"),
  );
}

/**
 * The guided setup: the account this computer joins, then what this machine has, what is
 * missing, and what to install — an AI client to think with, ffmpeg, a decision model, starting at login. It
 * starts nothing; it ends with what runs and how to start, stop and check it. Returns false
 * when it was stopped.
 */
export async function setup(paths: Layout, options: SetupOptions): Promise<boolean> {
  const interactive = !options.yes && Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const version = packageVersion();
  p.intro(`${badge("engenty wizards")} ${dim(version)}`);
  p.log.message(
    [
      `Install  ${tilde(paths.home)}${installedByScript() ? "" : dim(`  (data; the code runs from ${isCheckout() ? "this checkout" : "npm"})`)}`,
      `Node     ${process.version}  ${dim(tilde(process.execPath))}`,
    ].join("\n"),
  );

  if ((await accountStep(paths, options, interactive)) === "cancelled") {
    return false;
  }
  if ((await clientsStep(paths, options, interactive)) === "cancelled") {
    return false;
  }
  if ((await toolsStep(interactive)) === "cancelled") {
    return false;
  }
  if ((await decisionModelStep(paths, interactive)) === "cancelled") {
    return false;
  }
  if ((await autostartStep(paths, interactive)) === "cancelled") {
    return false;
  }
  if ((await appsStep(paths, interactive)) === "cancelled") {
    return false;
  }
  if ((await pathStep(interactive)) === "cancelled") {
    return false;
  }
  writeInstallNote(
    {
      ...readInstallNote(paths),
      setupAt: new Date().toISOString(),
      version,
      unattended: !process.stdout.isTTY,
    },
    paths,
  );

  p.log.info(CHROME_APP);
  if (options.next) {
    p.outro(
      options.next === "start"
        ? "Setup is done. Starting engenty wizards…"
        : `Setup is done. ${dim(`${cmd("help")} lists every command.`)}`,
    );
    return true;
  }
  await howToUse(paths);
  return true;
}
