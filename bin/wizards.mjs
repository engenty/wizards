#!/usr/bin/env node
// The `wizards` command. Kept to what every Node understands, so that an old one gets a new
// one installed instead of a syntax error.
//
// A copy from npm (`npx wizards`, `npm install -g wizards`) is the way to the install, not the
// install itself. It installs engenty wizards into ~/.engenty/wizards with the installer it
// carries (apps/web/dist/install.sh, on Windows install.ps1: its own Node, the runtime, the
// `wizards` command), brings an older install there up to its own version, and hands the command
// to it.
// What needs no install (--version, --help, validate, mcp) runs here, as long as this Node can.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const [major, minor] = process.versions.node.split(".").map(Number);
const currentNode = major > 24 || (major === 24 && minor >= 11);

const args = process.argv.slice(2);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = join(
  resolve((process.env.ENGENTY_HOME || "").trim() || join(homedir(), ".engenty")),
  "wizards",
);
const runtime = join(home, "runtime");
const windows = process.platform === "win32";
const wrapper = join(home, "bin", windows ? "wizards.cmd" : "wizards");
// uninstall: never installs or hands over first; the install it takes away may no longer run.
const RUN_HERE = ["help", "validate", "mcp", "uninstall"];
const tilde = (path) =>
  path.startsWith(homedir() + sep) ? `~${path.slice(homedir().length)}` : path;

function versionOf(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version || null;
  } catch {
    return null;
  }
}

/** Whether version a is older than b, by major, minor and patch. */
function older(a, b) {
  const pa = a.split(/[.+-]/).map(Number);
  const pb = b.split(/[.+-]/).map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) {
      return (pa[i] || 0) < (pb[i] || 0);
    }
  }
  return false;
}

/** The command as cli/main.ts reads it: "" for the menu. */
function commandOf(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    return "help";
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    return "version";
  }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--client") {
      i++;
    } else if (!argv[i].startsWith("-")) {
      return argv[i];
    }
  }
  return "";
}

/** This copy is the one install.sh put into the home folder (Node names this file by its real path). */
function isInstall() {
  try {
    return root.startsWith(realpathSync(runtime) + sep);
  } catch {
    return false;
  }
}

/** The terminal's environment without what npm put in for running this command. */
function terminalEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    // PATH comes after, once: Windows calls it Path, and two of them would leave one to chance.
    if (
      !key.startsWith("npm_") &&
      !["INIT_CWD", "NODE", "COLOR"].includes(key) &&
      key.toUpperCase() !== "PATH"
    ) {
      env[key] = value;
    }
  }
  env.PATH = (process.env.PATH || "")
    .split(delimiter)
    .filter((dir) => !/[\\/](node_modules[\\/]\.bin|node-gyp-bin)$/.test(dir))
    .join(delimiter);
  return env;
}

/** The installer this copy carries, for its own version; true when it ran to its end. */
function install(version, quiet) {
  const installer = windows
    ? [
        "powershell.exe",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(root, "apps", "web", "dist", "install.ps1"),
        "-NoSetup",
      ]
    : ["bash", join(root, "apps", "web", "dist", "install.sh"), "--no-setup"];
  const result = spawnSync(installer[0], installer.slice(1), {
    // A command whose output is read (validate --json, mcp) keeps its stdout to itself.
    stdio: ["ignore", quiet ? 2 : "inherit", "inherit"],
    env: {
      ...terminalEnv(),
      // The same package npm just ran; ENGENTY_WIZARDS_PACKAGE stays an override for tests.
      ENGENTY_WIZARDS_PACKAGE: process.env.ENGENTY_WIZARDS_PACKAGE || `wizards@${version}`,
    },
  });
  return result.status === 0;
}

/** Whether a runtime of the install runs: the note it keeps in its data folder (running.ts). */
function runs() {
  let dataDir = (process.env.DATA_DIR || "").trim();
  try {
    const line = readFileSync(join(home, ".env"), "utf8").match(/^\s*DATA_DIR\s*=\s*(.*?)\s*$/m);
    dataDir = dataDir || (line ? line[1].replace(/^(['"])(.*)\1$/, "$2") : "");
  } catch {
    // no .env: the data folder is where it always is
  }
  try {
    const { pid } = JSON.parse(
      readFileSync(join(resolve(home, dataDir || "data"), "running.json"), "utf8"),
    );
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it runs, as somebody else.
    return error.code === "EPERM";
  }
}

/**
 * The installed command with these arguments. On Windows its Node and script, which is what
 * wizards.cmd runs: a .cmd file starts only through cmd.exe, which would read the arguments again.
 */
function installedCommand(argv) {
  return windows
    ? [
        join(home, "tools", "node", "node.exe"),
        [join(runtime, "node_modules", "wizards", "bin", "wizards.mjs"), ...argv],
      ]
    : [wrapper, argv];
}

/** Runs the installed command with these arguments; its exit code. */
function handOver() {
  return new Promise((done) => {
    const [file, argv] = installedCommand(args);
    const child = spawn(file, argv, { stdio: "inherit", env: terminalEnv() });
    // Ctrl-C reaches the installed command as well (same terminal); this one waits for it.
    process.on("SIGINT", () => undefined);
    process.on("SIGTERM", () => child.kill("SIGTERM"));
    child.on("error", (error) => {
      console.error(`${wrapper} did not start: ${error.message}`);
      done(127);
    });
    child.on("exit", (code) => done(code ?? 1));
  });
}

const command = commandOf(args);
if (command === "version") {
  console.log(versionOf(root));
  process.exit(0);
}
const checkout = existsSync(join(root, "pnpm-workspace.yaml"));
const fromNpm = !checkout && !isInstall();
if (fromNpm && command !== "uninstall" && (!currentNode || !RUN_HERE.includes(command))) {
  const own = versionOf(root) || "0.0.0";
  const installed = existsSync(wrapper)
    ? versionOf(join(runtime, "node_modules", "wizards"))
    : null;
  if (!installed || older(installed, own)) {
    const quiet = RUN_HERE.includes(command);
    const running = installed && runs();
    const installedRun = (argv) => {
      const [file, all] = installedCommand(argv);
      spawnSync(file, all, {
        stdio: ["ignore", quiet ? 2 : "inherit", "inherit"],
        env: terminalEnv(),
      });
    };
    // Windows keeps the files of a running program locked: the runtime stops for the update.
    if (running && windows) {
      installedRun(["stop"]);
    }
    const done = install(own, quiet);
    // What ran is still the old version: it starts again as the new one.
    if (running && windows) {
      installedRun(["start", "--background", "--no-open"]);
    } else if (running && done) {
      installedRun(["restart"]);
    }
    if (!done && currentNode && !installed) {
      console.error(
        `The install into ${tilde(home)} failed; this time engenty wizards runs from npm.\n`,
      );
    }
  } else if (older(own, installed)) {
    console.error(
      `${tilde(home)} has engenty wizards ${installed}, newer than ${own}; that one runs.`,
    );
  }
  if (existsSync(wrapper) && versionOf(join(runtime, "node_modules", "wizards"))) {
    process.exit(await handOver());
  }
}
if (!currentNode && command === "uninstall") {
  // The install's own Node, if it is still there, runs this copy's uninstall.
  const node = join(home, "tools", "node", "bin", "node");
  const result = existsSync(node)
    ? spawnSync(node, [fileURLToPath(import.meta.url), ...args], { stdio: "inherit" })
    : null;
  process.exit(result?.status ?? 1);
}
if (!currentNode) {
  console.error(
    `engenty wizards needs Node.js 24.11 or newer. This is ${process.version}.\n` +
      "The installer brings its own and leaves yours alone:\n\n" +
      (windows
        ? "  irm https://engenty.ai/install.ps1 | iex\n"
        : "  curl -fsSL https://engenty.ai/install.sh | bash\n"),
  );
  process.exit(1);
}
// The uninstall has an entry of its own: main.js makes the install and data folders as it loads.
await import(
  command === "uninstall"
    ? "../apps/runtime/dist/cli/uninstall-main.js"
    : "../apps/runtime/dist/cli/main.js"
);
