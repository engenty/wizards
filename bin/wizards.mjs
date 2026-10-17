#!/usr/bin/env node
// The `wizards` command. Kept to what every Node understands, so that an old one gets a new
// one installed instead of a syntax error.
//
// The same file is two things. In the npm package `wizards` (`npx wizards`, `npm install -g
// wizards`) it is the launcher, with nothing beside it but the installer (install.sh) and no
// dependencies: on macOS and Linux it installs engenty wizards into ~/.engenty/wizards with that
// installer (its own Node, the runtime @engenty/wizards-runtime, the `wizards` command), brings an
// older install there up to its own version, and hands the command to it. In the runtime, which
// the installer puts there, it is the command itself.
//
// Only --version needs no install. A copy with the runtime beside it (a checkout, the runtime from
// npm) runs --help, validate and mcp here as well, as long as this Node can.
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
const wrapper = join(home, "bin", "wizards");
/** The runtime's npm package. Up to 0.7.4 it was `wizards` itself; that name is the launcher now. */
const RUNTIME = "@engenty/wizards-runtime";
/** Whether this copy is the runtime, or the launcher without it. */
const hasRuntime = existsSync(join(root, "apps", "runtime", "dist", "cli", "main.js"));
/** The installer: beside the launcher, or in the runtime's built SPA. */
const installer = [join(root, "install.sh"), join(root, "apps", "web", "dist", "install.sh")].find(
  (file) => existsSync(file),
);
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

/**
 * The version of the runtime the installed command starts; null without one. `runtime/current`
 * since 0.6.3, `runtime/` itself before; the runtime under its name, or as `wizards` up to 0.7.4.
 * A `wizards` without the runtime is the launcher, which an update of 0.7.4 or older fetches.
 */
function installedVersion() {
  if (!existsSync(wrapper)) {
    return null;
  }
  for (const prefix of [join(runtime, "current"), runtime]) {
    for (const name of [RUNTIME, "wizards"]) {
      const dir = join(prefix, "node_modules", name);
      if (existsSync(join(dir, "apps", "runtime"))) {
        return versionOf(dir);
      }
    }
  }
  return null;
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
    if (!key.startsWith("npm_") && !["INIT_CWD", "NODE", "COLOR"].includes(key)) {
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
  if (!installer) {
    return false;
  }
  const result = spawnSync("bash", [installer, "--no-setup"], {
    // A command whose output is read (validate --json, mcp) keeps its stdout to itself.
    stdio: ["ignore", quiet ? 2 : "inherit", "inherit"],
    env: {
      ...terminalEnv(),
      // The runtime of this version, from npm; ENGENTY_WIZARDS_PACKAGE stays an override for tests.
      ENGENTY_WIZARDS_PACKAGE: process.env.ENGENTY_WIZARDS_PACKAGE || `${RUNTIME}@${version}`,
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

/** Runs the installed command with these arguments; its exit code. */
function handOver() {
  return new Promise((done) => {
    const child = spawn(wrapper, args, { stdio: "inherit", env: terminalEnv() });
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
const own = versionOf(root) || "0.0.0";
const quiet = RUN_HERE.includes(command);
const checkout = existsSync(join(root, "pnpm-workspace.yaml"));
// Windows has no installer yet, and the setup, the service and the AI clients are written for
// macOS and Linux: it says so instead of half working. What needs no install still runs.
if (process.platform === "win32" && !checkout && !(hasRuntime && RUN_HERE.includes(command))) {
  console.error(
    "engenty wizards for Windows is coming soon.\n\n" +
      "Until then it runs in WSL (Windows Subsystem for Linux). In PowerShell:\n\n" +
      "  wsl --install\n\n" +
      "then, in the Ubuntu terminal that opens:\n\n" +
      "  curl -fsSL https://engenty.ai/install.sh | bash\n\n" +
      "https://engenty.ai/docs/user/install\n",
  );
  process.exit(1);
}
if (isInstall() && !hasRuntime) {
  // The launcher in the install's place: an update of 0.7.4 or older fetched `wizards`, the
  // runtime's name then, and its next start switched to it. The installer it carries brings the
  // runtime of this version, and the command it writes starts that one from now on.
  console.error(`Completing the update to engenty wizards ${own}…`);
  if (!install(own, quiet) || !installedVersion()) {
    console.error(
      `The update didn’t complete. To install engenty wizards again:\n\n` +
        "  curl -fsSL https://engenty.ai/install.sh | bash\n",
    );
    process.exit(1);
  }
  // This process takes the new command's place: a login item keeps waiting on the same pid.
  try {
    process.execve?.(wrapper, [wrapper, ...args], process.env);
  } catch {
    // It waits for the new command instead (below).
  }
  process.exit(await handOver());
}
const fromNpm = process.platform !== "win32" && !checkout && !isInstall();
if (fromNpm && command === "uninstall" && !hasRuntime) {
  // The install's own uninstall takes it away; it never updates first. An install the update
  // left without its runtime gets it back (above, in the installed command) and then uninstalls.
  if (!existsSync(wrapper)) {
    console.error(`There is no engenty wizards in ${tilde(home)} to uninstall.`);
    process.exit(0);
  }
  process.exit(await handOver());
}
if (
  fromNpm &&
  command !== "uninstall" &&
  (!hasRuntime || !currentNode || !RUN_HERE.includes(command))
) {
  const installed = installedVersion();
  if (!installed || older(installed, own)) {
    const running = installed && runs();
    if (install(own, quiet)) {
      // What runs is still the old version: it starts again as the new one.
      if (running) {
        spawnSync(wrapper, ["restart"], {
          stdio: ["ignore", quiet ? 2 : "inherit", "inherit"],
          env: terminalEnv(),
        });
      }
    } else if (hasRuntime && currentNode && !installed) {
      console.error(
        `The install into ${tilde(home)} failed; this time engenty wizards runs from npm.\n`,
      );
    }
  } else if (older(own, installed)) {
    console.error(
      `${tilde(home)} has engenty wizards ${installed}, newer than ${own}; that one runs.`,
    );
  }
  if (installedVersion()) {
    process.exit(await handOver());
  }
  if (!hasRuntime) {
    console.error(
      `engenty wizards couldn’t be installed into ${tilde(home)}. The installer on its own:\n\n` +
        "  curl -fsSL https://engenty.ai/install.sh | bash\n",
    );
    process.exit(1);
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
      "  curl -fsSL https://engenty.ai/install.sh | bash\n",
  );
  process.exit(1);
}
// The uninstall has an entry of its own: main.js makes the install and data folders as it loads.
await import(
  command === "uninstall"
    ? "../apps/runtime/dist/cli/uninstall-main.js"
    : "../apps/runtime/dist/cli/main.js"
);
