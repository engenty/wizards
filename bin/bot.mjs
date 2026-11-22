// `wizards bot`: wizards.bot, a home for your own agent, on this computer. The home is the program
// of github.com/engenty/wizards-bot; this installs a release of it, runs it as a service of yours
// and pairs your devices with it (docs/hosted.md of that repo, "Contract", points 2 and 9).
//
// It lives beside the launcher, not in the runtime: `npx wizards bot install` works without
// engenty wizards, and the runtime carries the same file, so its `wizards bot` is this one too.
// Like bin/wizards.mjs it needs nothing but Node, curl and tar, and runs on an older Node: the
// home gets a Node of its own when this one is too old.
//
//   ~/.engenty/wizards/bot/<version>/   the release, unpacked and installed with npm
//   ~/.engenty/wizards/bot/current      names the version that runs; the one before stays
//   ~/.engenty/wizards/bot/bot.json     the port and the Node it runs with
//   ~/.engenty/wizards/bin/wizards-bot  the command, linked into ~/.local/bin
//   ~/.wizards-bot/                     the home's data (WIZARDS_BOT_DATA moves it)
//
// For tests: WIZARDS_BOT_TARBALL (a path or an address of a tarball instead of the release's),
// ENGENTY_HOME, WIZARDS_BOT_DATA.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";

/** The Node install.sh brings; the home gets the same where it needs one. */
export const NODE_VERSION = "26.12.0";
const REPO = "engenty/wizards-bot";
export const PORT = 4747;
export const LABEL = "com.engenty.wizards.bot";
export const LINK_LABEL = "com.engenty.wizards.bot.link";
export const UNIT = "wizards-bot.service";
export const LINK_UNIT = "wizards-bot-link.service";
/** How long the home may take to answer on /health after it starts. */
const HEALTH_WAIT = 90_000;

const tty = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";
const paint = (code) => (text) => (tty ? `\u001b[${code}m${text}\u001b[0m` : text);
const cyan = paint(36);
const dim = paint(2);
const green = paint(32);
const red = paint(31);
const bold = paint(1);

/** Something went wrong in a way the person can act on: its message is all they see. */
class Refusal extends Error {}

/** Where everything goes; ENGENTY_HOME and WIZARDS_BOT_DATA move it, as for the home itself. */
export function layout(env = process.env) {
  const user = homedir();
  const home = join(resolve((env.ENGENTY_HOME || "").trim() || join(user, ".engenty")), "wizards");
  const bot = join(home, "bot");
  const config = env.XDG_CONFIG_HOME || join(user, ".config");
  return {
    user,
    home,
    bot,
    current: join(bot, "current"),
    settings: join(bot, "bot.json"),
    command: join(home, "bin", "wizards-bot"),
    wizards: join(home, "bin", "wizards"),
    pathLink: join(user, ".local", "bin", "wizards-bot"),
    tools: join(home, "tools"),
    logs: join(home, "logs"),
    log: join(home, "logs", "bot.log"),
    linkLog: join(home, "logs", "bot-link.log"),
    installLog: join(home, "logs", "bot-install.log"),
    data: (env.WIZARDS_BOT_DATA || "").trim() || join(user, ".wizards-bot"),
    agent: join(user, "Library", "LaunchAgents", `${LABEL}.plist`),
    linkAgent: join(user, "Library", "LaunchAgents", `${LINK_LABEL}.plist`),
    unit: join(config, "systemd", "user", UNIT),
    linkUnit: join(config, "systemd", "user", LINK_UNIT),
  };
}

const tilde = (path) =>
  path === homedir() || path.startsWith(homedir() + sep)
    ? `~${path.slice(homedir().length)}`
    : path;

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** The installed version: the one `current` names, or null. */
export function installedVersion(paths) {
  try {
    return readJson(join(paths.bot, readlinkSync(paths.current), "package.json"))?.version || null;
  } catch {
    return null;
  }
}

/** Whether a Node version runs the home: 24.11 or newer. */
export function newEnough(version) {
  const [major, minor] = String(version).replace(/^v/, "").split(".").map(Number);
  return major > 24 || (major === 24 && minor >= 11);
}

/** Whether version a is older than b, by major, minor and patch. */
export function older(a, b) {
  const pa = a.split(/[.+-]/).map(Number);
  const pb = b.split(/[.+-]/).map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) {
      return (pa[i] || 0) < (pb[i] || 0);
    }
  }
  return false;
}

/** `ada`, `ada.wizards.bot` or a whole address, as the address of a home. */
export function homeAddress(text) {
  const address = String(text).trim().replace(/\/+$/, "");
  if (/^https?:\/\//.test(address)) {
    return address;
  }
  return address.includes(".") || address.includes(":")
    ? `https://${address}`
    : `https://${address}.wizards.bot`;
}

/** The PATH without what npm put in for running this command. */
function cleanPath(env = process.env) {
  return (env.PATH || "")
    .split(delimiter)
    .filter((dir) => dir && !/[\\/](node_modules[\\/]\.bin|node-gyp-bin)$/.test(dir))
    .join(delimiter);
}

function onPath(name) {
  for (const dir of cleanPath().split(delimiter)) {
    const file = join(dir, name);
    if (existsSync(file)) {
      return file;
    }
  }
  return null;
}

/** Runs a command; its output goes to the install log. Throws with the log's end when it fails. */
function logged(paths, file, args, options = {}) {
  mkdirSync(paths.logs, { recursive: true });
  writeFileSync(paths.installLog, `\n$ ${file} ${args.join(" ")}\n`, { flag: "a" });
  const result = spawnSync(file, args, { encoding: "utf8", ...options });
  writeFileSync(paths.installLog, `${result.stdout || ""}${result.stderr || ""}`, { flag: "a" });
  if (result.status !== 0) {
    const tail = `${result.stdout || ""}${result.stderr || ""}${result.error?.message || ""}`
      .trim()
      .split("\n")
      .slice(-12)
      .map((line) => `   ${line}`)
      .join("\n");
    throw new Refusal(
      `${tail ? `${dim(tail)}\n` : ""}${file.split(sep).pop()} ${args[0]} failed. The whole log: ${tilde(paths.installLog)}`,
    );
  }
  return result.stdout || "";
}

function step(text, detail) {
  console.log(`${green("◇")}  ${text}${detail ? `  ${dim(detail)}` : ""}`);
}

function note(text) {
  console.log(`${dim("…")}  ${text}`);
}

// --- the release -----------------------------------------------------------------------------

/** The release to install: its version, the tarball's address and its checksum, if GitHub has one. */
export function findRelease(version) {
  const tag = version ? `tags/v${version.replace(/^v/, "")}` : "latest";
  const url = `https://api.github.com/repos/${REPO}/releases/${tag}`;
  const result = spawnSync(
    "curl",
    ["-fsSL", "-H", "Accept: application/vnd.github+json", "-H", "User-Agent: wizards", url],
    { encoding: "utf8" },
  );
  const release = result.status === 0 ? JSON.parse(result.stdout) : null;
  if (!release?.tag_name) {
    throw new Refusal(
      version
        ? `wizards.bot ${version} wasn’t found at https://github.com/${REPO}/releases.`
        : `No release of wizards.bot was found at https://github.com/${REPO}/releases.`,
    );
  }
  const found = release.tag_name.replace(/^v/, "");
  const name = `wizards-bot-${found}.tgz`;
  const asset = (release.assets || []).find((item) => item.name === name);
  if (!asset) {
    throw new Refusal(`The release ${found} of wizards.bot has no ${name} yet.`);
  }
  const digest = typeof asset.digest === "string" ? asset.digest : "";
  return {
    version: found,
    url: asset.browser_download_url,
    sha256: digest.startsWith("sha256:") ? digest.slice(7) : null,
  };
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** Copies or downloads a tarball to `to`, checking its checksum where there is one. */
function fetchFile(paths, from, to, checksum) {
  if (/^https?:\/\//.test(from)) {
    logged(paths, "curl", ["-fsSL", "-o", to, from]);
  } else {
    copyFileSync(resolve(from), to);
  }
  if (checksum && sha256(to) !== checksum) {
    throw new Refusal(`The download of ${from} doesn’t match its checksum.`);
  }
}

// --- Node ------------------------------------------------------------------------------------

function nodeVersion(file) {
  const result = spawnSync(file, ["--version"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * The Node the home runs with: the one the wizards installer brought, yours if it is 24.11 or
 * newer, or else one of its own, as the installer gets it (into the same place, so the two share
 * it). `brought` says this command downloaded it.
 */
function findNode(paths) {
  const ours = join(paths.tools, "node", "bin", "node");
  for (const file of [ours, onPath("node")]) {
    const version = file && existsSync(file) ? nodeVersion(file) : null;
    if (version && newEnough(version)) {
      return { node: file, brought: false };
    }
  }
  downloadNode(paths);
  return { node: ours, brought: true };
}

function machine() {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Refusal(`${process.platform} isn’t supported: macOS and Linux are.`);
  }
  let arch = process.arch;
  // A terminal under Rosetta says x64 on a Mac with Apple silicon.
  if (
    process.platform === "darwin" &&
    spawnSync("sysctl", ["-n", "sysctl.proc_translated"], { encoding: "utf8" }).stdout?.trim() ===
      "1"
  ) {
    arch = "arm64";
  }
  if (arch !== "arm64" && arch !== "x64") {
    throw new Refusal(`${arch} isn’t supported: arm64 and x64 are.`);
  }
  return `${process.platform}-${arch}`;
}

function downloadNode(paths) {
  const name = `node-v${NODE_VERSION}-${machine()}`;
  const dist = `https://nodejs.org/dist/v${NODE_VERSION}`;
  note(`Downloading Node ${NODE_VERSION} for the home`);
  mkdirSync(paths.tools, { recursive: true });
  const tmp = mkdtempSync(join(paths.tools, ".node."));
  try {
    const tarball = join(tmp, "node.tar.gz");
    logged(paths, "curl", ["-fsSL", "-o", tarball, `${dist}/${name}.tar.gz`]);
    const sums = logged(paths, "curl", ["-fsSL", `${dist}/SHASUMS256.txt`]);
    const expected = sums
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .find(([, file]) => file === `${name}.tar.gz`)?.[0];
    if (!expected || expected !== sha256(tarball)) {
      throw new Refusal("The Node download doesn’t match its checksum from nodejs.org.");
    }
    mkdirSync(join(tmp, "node"));
    logged(paths, "tar", ["-xzf", tarball, "-C", join(tmp, "node"), "--strip-components", "1"]);
    // The headers are for compiling addons, which nothing here does.
    rmSync(join(tmp, "node", "include"), { recursive: true, force: true });
    const dir = join(paths.tools, `node-v${NODE_VERSION}`);
    rmSync(dir, { recursive: true, force: true });
    renameSync(join(tmp, "node"), dir);
    pointTo(join(paths.tools, "node"), `node-v${NODE_VERSION}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  step(
    `Node ${NODE_VERSION}`,
    `${tilde(join(paths.tools, "node"))}, checksum from nodejs.org matches`,
  );
}

/** A symlink at `link` to `target`, replaced in one move. */
function pointTo(link, target) {
  const next = `${link}.next`;
  rmSync(next, { force: true });
  symlinkSync(target, next);
  renameSync(next, link);
}

// --- the program -----------------------------------------------------------------------------

/** The folder in an unpacked tarball that holds package.json: its top, or `package/` (npm pack). */
function packageRoot(dir) {
  if (existsSync(join(dir, "package.json"))) {
    return dir;
  }
  const entries = readdirSync(dir);
  const only = entries.length === 1 ? join(dir, entries[0]) : null;
  if (only && existsSync(join(only, "package.json"))) {
    return only;
  }
  return null;
}

/** The home's command in its package.json, relative to it. */
function binOf(manifest) {
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.["wizards-bot"];
  if (!bin) {
    throw new Refusal("The tarball’s package.json names no wizards-bot command.");
  }
  return bin;
}

/**
 * Unpacks a tarball into bot/<version> and installs what it depends on with npm. A version is
 * either all there or not at all: it is put together in a staging folder first. `current` names
 * it afterwards; this version and the one before stay, older ones go.
 */
function installProgram(paths, source, node) {
  mkdirSync(paths.bot, { recursive: true });
  // What an install that was stopped halfway left behind.
  for (const name of readdirSync(paths.bot)) {
    if (name.startsWith(".staging-")) {
      rmSync(join(paths.bot, name), { recursive: true, force: true });
    }
  }
  const stage = mkdtempSync(join(paths.bot, ".staging-"));
  try {
    const tarball = join(stage, "wizards-bot.tgz");
    note(`${/^https?:\/\//.test(source.from) ? "Downloading" : "Copying"} ${source.label}`);
    fetchFile(paths, source.from, tarball, source.sha256);
    mkdirSync(join(stage, "unpacked"));
    logged(paths, "tar", ["-xzf", tarball, "-C", join(stage, "unpacked")]);
    const root = packageRoot(join(stage, "unpacked"));
    if (!root) {
      throw new Refusal(`${source.label} holds no package.json.`);
    }
    const manifest = readJson(join(root, "package.json"));
    const version = manifest?.version;
    if (!version) {
      throw new Refusal(`${source.label} has no version in its package.json.`);
    }
    const bin = binOf(manifest);
    const npm = join(dirname(node), "npm");
    if (!existsSync(npm)) {
      throw new Refusal(`npm wasn’t found next to ${tilde(node)}.`);
    }
    note(`Installing wizards.bot ${version} with npm (about a minute)`);
    logged(paths, npm, ["install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"], {
      cwd: root,
      env: { ...process.env, PATH: `${dirname(node)}${delimiter}${cleanPath()}` },
    });
    if (!existsSync(join(root, bin))) {
      throw new Refusal(`${source.label} has no ${bin}, the command its package.json names.`);
    }
    const dir = join(paths.bot, version);
    const previous = installedVersion(paths);
    // The version that is there already steps aside in one move and goes once the new one is in.
    const aside = existsSync(dir) ? join(stage, "aside") : null;
    if (aside) {
      renameSync(dir, aside);
    }
    renameSync(root, dir);
    pointTo(paths.current, version);
    for (const name of readdirSync(paths.bot)) {
      if (/^\d/.test(name) && name !== version && name !== previous) {
        rmSync(join(paths.bot, name), { recursive: true, force: true });
      }
    }
    step(`wizards.bot ${version}`, tilde(dir));
    return { version, bin };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

const quote = (text) => `'${String(text).replaceAll("'", "'\\''")}'`;

/** The command `wizards-bot`: the home's own CLI with its Node, its port and its data folder. */
export function commandText(paths, settings) {
  return [
    "#!/bin/sh",
    "# wizards.bot, written by `wizards bot install`; `wizards bot update` writes it again.",
    `export WIZARDS_BOT_PORT="\${WIZARDS_BOT_PORT:-${settings.port}}"`,
    `export WIZARDS_BOT_DATA="\${WIZARDS_BOT_DATA:-${settings.data.replaceAll('"', '\\"')}}"`,
    `exec ${quote(settings.node)} ${quote(join(paths.current, settings.bin))} "$@"`,
    "",
  ].join("\n");
}

function writeCommand(paths, settings) {
  mkdirSync(dirname(paths.command), { recursive: true });
  writeFileSync(paths.command, commandText(paths, settings));
  chmodSync(paths.command, 0o755);
  mkdirSync(dirname(paths.pathLink), { recursive: true });
  let there = null;
  try {
    there = lstatSync(paths.pathLink);
  } catch {
    // nothing of that name yet
  }
  // Something else of that name is not ours to replace.
  if (there && !there.isSymbolicLink()) {
    step(
      "Command",
      `${tilde(paths.command)} (${tilde(paths.pathLink)} exists and was left as it is)`,
    );
    return;
  }
  pointTo(paths.pathLink, paths.command);
  step("Command", tilde(paths.pathLink));
}

function saveSettings(paths, settings) {
  writeFileSync(paths.settings, `${JSON.stringify(settings, null, 2)}\n`);
}

// --- the service -----------------------------------------------------------------------------

const xml = (text) =>
  String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** The environment a service gets: your PATH (for Ollama, Claude and Codex) and your home folder. */
function serviceEnv(paths) {
  return { PATH: cleanPath(), HOME: paths.user };
}

/** The LaunchAgent: `wizards-bot <args>`, started at login and again when it fails. */
export function agentText(paths, label, args, log) {
  const env = serviceEnv(paths);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${[paths.command, ...args].map((arg) => `    <string>${xml(arg)}</string>\n`).join("")}  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env)
  .map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>\n`)
  .join("")}  </dict>
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
</dict>
</plist>
`;
}

/** The systemd user service: `wizards-bot <args>`, started at login and again when it fails. */
export function unitText(paths, description, args) {
  const quoted = (text) => `"${String(text).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  const env = serviceEnv(paths);
  return [
    "[Unit]",
    `Description=${description}`,
    `Documentation=https://github.com/${REPO}`,
    "",
    "[Service]",
    `ExecStart=${[paths.command, ...args].map(quoted).join(" ")}`,
    ...Object.entries(env).map(([key, value]) => `Environment=${quoted(`${key}=${value}`)}`),
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

const uid = () => (process.getuid ? process.getuid() : 0);

function systemctl(args) {
  return spawnSync("systemctl", ["--user", ...args], { encoding: "utf8" });
}

function systemdHere() {
  return Boolean(onPath("systemctl")) && systemctl(["show-environment"]).status === 0;
}

/** The two services: the home, and the link to a home elsewhere. */
function services(paths) {
  return {
    home: {
      label: LABEL,
      unit: UNIT,
      agent: paths.agent,
      unitFile: paths.unit,
      args: ["start"],
      log: paths.log,
      description: "wizards.bot, your home",
    },
    link: {
      label: LINK_LABEL,
      unit: LINK_UNIT,
      agent: paths.linkAgent,
      unitFile: paths.linkUnit,
      args: ["link"],
      log: paths.linkLog,
      description: "wizards.bot, this computer’s models for your home",
    },
  };
}

/** Takes a LaunchAgent out of launchd and waits until it is gone. */
async function bootout(service) {
  const target = `gui/${uid()}/${service.label}`;
  spawnSync("launchctl", ["bootout", target], { encoding: "utf8" });
  for (let tries = 0; tries < 50; tries++) {
    if (spawnSync("launchctl", ["print", target], { encoding: "utf8" }).status !== 0) {
      return;
    }
    await pause(100);
  }
}

/** Writes a service and starts it, or starts it again. False where nothing can run it here. */
async function startService(paths, service) {
  mkdirSync(paths.logs, { recursive: true });
  if (process.platform === "darwin") {
    mkdirSync(dirname(service.agent), { recursive: true });
    writeFileSync(service.agent, agentText(paths, service.label, service.args, service.log));
    await bootout(service);
    // launchd may still be letting the old one go: it refuses with error 5 meanwhile.
    let result = null;
    for (let tries = 0; tries < 10; tries++) {
      result = spawnSync("launchctl", ["bootstrap", `gui/${uid()}`, service.agent], {
        encoding: "utf8",
      });
      if (result.status === 0) {
        break;
      }
      await pause(500);
    }
    if (result.status !== 0) {
      throw new Refusal(`launchctl couldn’t start ${service.label}: ${result.stderr.trim()}`);
    }
    return true;
  }
  if (!systemdHere()) {
    return false;
  }
  mkdirSync(dirname(service.unitFile), { recursive: true });
  writeFileSync(service.unitFile, unitText(paths, service.description, service.args));
  systemctl(["daemon-reload"]);
  const result = systemctl(["enable", service.unit]);
  const restart = systemctl(["restart", service.unit]);
  if (result.status !== 0 || restart.status !== 0) {
    throw new Refusal(
      `systemctl couldn’t start ${service.unit}: ${`${result.stderr}${restart.stderr}`.trim()}`,
    );
  }
  return true;
}

/** Stops a service and takes it away. */
async function removeService(service) {
  if (process.platform === "darwin") {
    await bootout(service);
    rmSync(service.agent, { force: true });
    return;
  }
  if (existsSync(service.unitFile)) {
    systemctl(["disable", "--now", service.unit]);
    rmSync(service.unitFile, { force: true });
    systemctl(["daemon-reload"]);
  }
}

/** Stops a service and leaves it there. */
async function stopService(service) {
  if (process.platform === "darwin") {
    await bootout(service);
  } else if (existsSync(service.unitFile)) {
    systemctl(["stop", service.unit]);
  }
}

/** Whether a service is there, and how it is called. */
function serviceThere(service) {
  if (process.platform === "darwin") {
    return existsSync(service.agent) ? `a LaunchAgent, ${service.label}` : null;
  }
  return existsSync(service.unitFile) ? `a systemd user service, ${service.unit}` : null;
}

/** Whether the service runs now. */
function serviceRuns(service) {
  if (process.platform === "darwin") {
    const result = spawnSync("launchctl", ["print", `gui/${uid()}/${service.label}`], {
      encoding: "utf8",
    });
    return result.status === 0 && /\bstate = running\b/.test(result.stdout);
  }
  return systemctl(["is-active", service.unit]).stdout?.trim() === "active";
}

// --- the port and the home's answer ----------------------------------------------------------

function portFree(port) {
  return new Promise((done) => {
    const server = createServer();
    server.once("error", () => done(false));
    server.listen({ port, host: "0.0.0.0" }, () => server.close(() => done(true)));
  });
}

/** The first free port from `start` on. */
export async function freePort(start) {
  for (let port = start; port < start + 100; port++) {
    if (await portFree(port)) {
      return port;
    }
  }
  throw new Refusal(`No port from ${start} to ${start + 99} is free.`);
}

/** Whether the home answers on /health with 200. */
export function healthy(port) {
  return new Promise((done) => {
    const req = request({ host: "127.0.0.1", port, path: "/health", timeout: 2000 }, (res) => {
      res.resume();
      done(res.statusCode === 200);
    });
    req.on("error", () => done(false));
    req.on("timeout", () => {
      req.destroy();
      done(false);
    });
    req.end();
  });
}

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

async function waitForHealth(paths, port) {
  const until = Date.now() + HEALTH_WAIT;
  while (Date.now() < until) {
    if (await healthy(port)) {
      return;
    }
    await pause(500);
  }
  throw new Refusal(
    `The home didn’t answer at http://localhost:${port}/health within ${HEALTH_WAIT / 1000} seconds. Its log: ${tilde(paths.log)}`,
  );
}

function openBrowser(url) {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  if (!onPath(opener)) {
    return false;
  }
  const child = spawn(opener, [url], { stdio: "ignore", detached: true });
  child.on("error", () => undefined);
  child.unref();
  return true;
}

// --- the commands ----------------------------------------------------------------------------

function windowsRefusal() {
  if (process.platform === "win32") {
    throw new Refusal(
      "wizards.bot doesn’t install on Windows yet. It runs on macOS and Linux, and on Windows in WSL.",
    );
  }
}

function notInstalled() {
  return new Refusal(
    `wizards.bot isn’t installed on this computer. To install it: ${cyan("wizards bot install")}`,
  );
}

/** What to install: the tarball WIZARDS_BOT_TARBALL names, or a release. */
function source(version) {
  const tarball = (process.env.WIZARDS_BOT_TARBALL || "").trim();
  if (tarball) {
    return { from: tarball, label: /^https?:/.test(tarball) ? tarball : tilde(resolve(tarball)) };
  }
  const release = findRelease(version);
  return {
    from: release.url,
    label: `wizards.bot ${release.version}`,
    version: release.version,
    sha256: release.sha256,
  };
}

/**
 * Installs a version and (re)starts the home with it. The home keeps its port; a new home gets
 * 4747 (or `--port`), or the next free one from there.
 */
async function put(paths, options, from) {
  const saved = readJson(paths.settings) || {};
  const home = services(paths).home;
  const { node, brought } = findNode(paths);
  const { version, bin } = installProgram(paths, from, node);
  // The home that runs gives its port free first.
  await stopService(home);
  const wanted = options.port || saved.port || PORT;
  for (let tries = 0; tries < 20 && wanted === saved.port && !(await portFree(wanted)); tries++) {
    await pause(250);
  }
  const port = await freePort(wanted);
  const settings = {
    version,
    bin,
    port,
    node,
    data: paths.data,
    // A Node this command downloaded goes with the home, unless engenty wizards uses it too.
    nodeBrought:
      Boolean(saved.nodeBrought || brought) && node === join(paths.tools, "node", "bin", "node"),
  };
  saveSettings(paths, settings);
  writeCommand(paths, settings);
  if (!(await startService(paths, home))) {
    console.log(
      `\nThe home doesn’t start by itself here: systemd --user isn’t available. Start it with ${cyan("wizards-bot start")}.`,
    );
    return { settings, running: false };
  }
  note(`Starting the home on port ${port}`);
  await waitForHealth(paths, port);
  step("Home", `http://localhost:${port}, ${serviceThere(home)}`);
  return { settings, running: true };
}

async function install(paths, options) {
  windowsRefusal();
  const installed = installedVersion(paths);
  console.log(`${bold("wizards.bot")}  ${dim(`into ${tilde(paths.bot)}`)}`);
  const from = source(options.version);
  if (installed && from.version && installed === from.version && !options.version) {
    note(`wizards.bot ${installed} is installed already: installing it again`);
  }
  const { running } = await put(paths, options, from);
  if (running) {
    await setup(paths, options);
  }
}

/** Prints the output of `wizards-bot pair` (the QR, the code) and opens the pairing link. */
async function setup(paths, options) {
  windowsRefusal();
  const settings = readJson(paths.settings);
  if (!settings || !installedVersion(paths)) {
    throw notInstalled();
  }
  if (options.link) {
    return link(paths, settings, options);
  }
  if (!(await healthy(settings.port))) {
    throw new Refusal(
      `The home doesn’t run. ${cyan("wizards bot status")} says more, its log is ${tilde(paths.log)}.`,
    );
  }
  const result = spawnSync(paths.command, ["pair"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Refusal(`wizards-bot pair failed: ${(result.stderr || result.stdout).trim()}`);
  }
  const code = /^Code:\s+(\S+)/m.exec(result.stdout)?.[1];
  // The QR and the address for your phone; the browser on this computer uses localhost.
  process.stdout.write(`\n${result.stdout.replace(/^Browser:.*\n/m, "")}`);
  const url = `http://localhost:${settings.port}/${code ? `#code=${code}` : ""}`;
  if (!options.open || !openBrowser(url)) {
    console.log(`\nThe home’s setup: ${url}`);
  } else {
    console.log(`\nOpened the home’s setup in your browser: ${url}`);
  }
}

/**
 * `setup --link <address> <code>`: pairs this computer with a home elsewhere, then keeps
 * `wizards-bot link` running as a service, so that home uses this computer's models while it is on.
 */
async function link(paths, settings, options) {
  const [where, code] = options.link;
  if (!where || !code) {
    throw new Refusal(
      `Give your home’s address and a code from it: ${cyan("wizards bot setup --link ada K7QM-2RXD")}`,
    );
  }
  const address = homeAddress(where);
  const file = join(settings.data, "link.json");
  const before = existsSync(file) ? statSync(file).mtimeMs : 0;
  note(`Pairing this computer with ${address}`);
  const child = spawn(paths.command, ["link", address, code], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let said = "";
  child.stdout.on("data", (chunk) => {
    said += chunk;
  });
  child.stderr.on("data", (chunk) => {
    said += chunk;
  });
  let exited = null;
  child.on("exit", (status) => {
    exited = status ?? 1;
  });
  const until = Date.now() + 30_000;
  while (exited === null && Date.now() < until) {
    if (existsSync(file) && statSync(file).mtimeMs > before) {
      break;
    }
    await pause(200);
  }
  const paired = existsSync(file) && statSync(file).mtimeMs > before;
  if (exited === null) {
    child.kill("SIGTERM");
  }
  if (!paired) {
    throw new Refusal(
      `This computer couldn’t pair with ${address}${said.trim() ? `: ${said.trim().split("\n").pop()}` : "."}`,
    );
  }
  const service = services(paths).link;
  if (!(await startService(paths, service))) {
    console.log(
      `\nPaired with ${address}. systemd --user isn’t available here: keep ${cyan("wizards-bot link")} running yourself.`,
    );
    return;
  }
  step(`Linked to ${address}`, serviceThere(service));
  console.log(`\nYour home at ${address} uses this computer’s models while this computer is on.`);
}

async function status(paths) {
  const version = installedVersion(paths);
  const settings = readJson(paths.settings);
  if (!version || !settings) {
    console.log(
      `wizards.bot isn’t installed on this computer. To install it: ${cyan("wizards bot install")}`,
    );
    return;
  }
  const { home, link: linked } = services(paths);
  const answers = await healthy(settings.port);
  const how = serviceThere(home);
  console.log(`wizards.bot ${version}  ${dim(tilde(join(paths.bot, version)))}`);
  console.log(
    `  ${answers ? green("running") : red("not running")}  http://localhost:${settings.port}${how ? dim(`  (${how})`) : ""}`,
  );
  console.log(`  data     ${tilde(settings.data)}`);
  console.log(`  command  ${tilde(paths.command)}`);
  const linkFile = readJson(join(settings.data, "link.json"));
  if (linkFile?.home && serviceThere(linked)) {
    console.log(
      `  linked   ${linkFile.home}  ${serviceRuns(linked) ? green("running") : red("not running")}`,
    );
  }
  if (!answers) {
    console.log(`\nIts log: ${tilde(paths.log)}`);
  }
}

async function update(paths, options) {
  windowsRefusal();
  const installed = installedVersion(paths);
  if (!installed) {
    throw notInstalled();
  }
  const from = source(options.version);
  if (from.version && !options.version && !older(installed, from.version)) {
    console.log(`wizards.bot ${installed} is the newest version.`);
    return;
  }
  const { settings, running } = await put(paths, options, from);
  // A link that runs starts again with the new version.
  const linked = services(paths).link;
  if (serviceThere(linked)) {
    await startService(paths, linked);
  }
  console.log(
    `\nwizards.bot ${installed === settings.version ? `${installed} is installed again` : `went from ${installed} to ${settings.version}`}. Your data is kept${running ? ", and the home runs" : ""}.`,
  );
}

function ask(question) {
  return new Promise((done) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      done(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

/** Removes a folder if nothing is left in it. */
function dropEmpty(dir) {
  try {
    rmdirSync(dir);
  } catch {
    // not empty, or not there
  }
}

async function uninstall(paths, options) {
  const settings = readJson(paths.settings) || {};
  const { home, link: linked } = services(paths);
  const there =
    existsSync(paths.bot) ||
    existsSync(paths.command) ||
    serviceThere(home) ||
    serviceThere(linked);
  const data = settings.data || paths.data;
  if (!there && !options.purge) {
    console.log("wizards.bot isn’t installed on this computer.");
    return;
  }
  let purge = false;
  if (options.purge && existsSync(data)) {
    if (options.yes) {
      purge = true;
    } else if (process.stdin.isTTY) {
      purge = await ask(
        `Also delete your home’s data in ${tilde(data)}: its agents, conversations, devices and keys? This can’t be undone. [y/N] `,
      );
    } else {
      throw new Refusal("--purge asks first. Run it in a terminal, or add --yes.");
    }
  }
  for (const service of [linked, home]) {
    const how = serviceThere(service);
    if (how) {
      await removeService(service);
      step("Stopped and removed", how);
    }
  }
  try {
    if (
      lstatSync(paths.pathLink).isSymbolicLink() &&
      readlinkSync(paths.pathLink) === paths.command
    ) {
      rmSync(paths.pathLink);
    }
  } catch {
    // no link
  }
  rmSync(paths.command, { force: true });
  rmSync(paths.bot, { recursive: true, force: true });
  for (const log of [paths.log, paths.linkLog, paths.installLog]) {
    rmSync(log, { force: true });
  }
  // A Node this command brought goes too, unless engenty wizards is installed and uses it.
  if (settings.nodeBrought && !existsSync(paths.wizards)) {
    for (const name of existsSync(paths.tools) ? readdirSync(paths.tools) : []) {
      if (name === "node" || name.startsWith("node-v")) {
        rmSync(join(paths.tools, name), { recursive: true, force: true });
      }
    }
  }
  step("Removed the program", tilde(paths.bot));
  for (const dir of [
    paths.tools,
    paths.logs,
    dirname(paths.command),
    paths.home,
    dirname(paths.home),
  ]) {
    dropEmpty(dir);
  }
  if (purge) {
    rmSync(data, { recursive: true, force: true });
    console.log(`\nwizards.bot is off this computer, and its data in ${tilde(data)} is deleted.`);
  } else if (existsSync(data)) {
    console.log(
      `\nwizards.bot is off this computer. Your home’s data stays in ${tilde(data)}: ${cyan("wizards bot install")} picks it up again.`,
    );
  } else {
    console.log("\nwizards.bot is off this computer.");
  }
}

// --- the command line ------------------------------------------------------------------------

const HELP = `${bold("wizards bot")}: wizards.bot, your own agent in a home of your own, on this computer

Commands
  ${cyan("wizards bot install")}     install the home, start it with your computer and open its setup
  ${cyan("wizards bot setup")}       open the home’s setup and show a code to pair your phone
  ${cyan("wizards bot setup --link <address> <code>")}
                          link this computer to your home on wizards.bot: it uses this
                          computer’s models while it’s on (e.g. --link ada K7QM-2RXD)
  ${cyan("wizards bot status")}      show the installed version, whether it runs and its address
  ${cyan("wizards bot update")}      install the newest version and restart the home, your data is kept
  ${cyan("wizards bot uninstall")}   take the home off this computer, your data in ~/.wizards-bot is kept
                          (--purge deletes it too, after asking)

Options
  --version <v>   install this version instead of the newest
  --port <n>      the port for a new home (default 4747, or the next free one)
  --no-open       don’t open the browser
  --yes, -y       don’t ask

The program goes into ~/.engenty/wizards/bot (ENGENTY_HOME moves it), the command
wizards-bot into ~/.local/bin. On a Mac the home runs as a LaunchAgent, on Linux as a
systemd user service.
`;

/** Reads `wizards bot <command> [options]`. */
export function parse(argv) {
  const options = {
    command: "",
    open: true,
    yes: false,
    purge: false,
    link: null,
    version: null,
    port: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.command = "help";
      return options;
    } else if (arg === "--no-open") {
      options.open = false;
    } else if (arg === "--yes" || arg === "-y") {
      options.yes = true;
    } else if (arg === "--purge") {
      options.purge = true;
    } else if (arg === "--link") {
      options.link = [argv[i + 1], argv[i + 2]];
      i += 2;
    } else if (arg === "--version") {
      options.version = (argv[++i] || "").replace(/^v/, "");
      if (!options.version) {
        throw new Refusal("--version needs a version, e.g. --version 0.1.0");
      }
    } else if (arg === "--port") {
      options.port = Number(argv[++i]);
      if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
        throw new Refusal("--port needs a port, e.g. --port 4747");
      }
    } else if (arg.startsWith("-")) {
      throw new Refusal(`Unknown option ${arg}. ${cyan("wizards bot --help")} lists them.`);
    } else if (!options.command) {
      options.command = arg;
    } else {
      throw new Refusal(`One command at a time: ${options.command} or ${arg}.`);
    }
  }
  return options;
}

const COMMANDS = { install, setup, status, update, uninstall };

/** `wizards bot …`; its exit code. */
export async function main(argv, env = process.env) {
  try {
    const options = parse(argv);
    if (!options.command || options.command === "help") {
      console.log(HELP);
      return 0;
    }
    const run = COMMANDS[options.command];
    if (!run) {
      throw new Refusal(
        `wizards bot has no command ${options.command}. ${cyan("wizards bot --help")} lists them.`,
      );
    }
    await run(layout(env), options);
    return 0;
  } catch (error) {
    if (!(error instanceof Refusal)) {
      throw error;
    }
    console.error(`${red("■")}  ${error.message}`);
    return 1;
  }
}
