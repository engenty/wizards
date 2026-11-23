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
// `wizards bot install <folder>` puts a home of its own into a folder, beside the one above and
// beside other folders: its own program, data, port and service, named after the folder.
//
//   <folder>/program/<version>/, current   the release
//   <folder>/wizards-bot.json              the port, the Node, the tunnel
//   <folder>/wizards-bot                   the command (not linked into ~/.local/bin)
//   <folder>/data/                         the home's data
//   <folder>/logs/
//
// The Node in ~/.engenty/wizards/tools is shared by all of them.
//
// `wizards bot tunnel` puts a home on the internet at https://<name>.wizards.host, through our relay
// (frp): frpc dials out from this computer, TLS ends here (bin/bot-tunnel.mjs). Its files are in
// the home's `tunnel/` folder: <folder>/tunnel, or <data>/tunnel for the home above.
//
// For tests: WIZARDS_BOT_TARBALL (a path or an address of a tarball instead of the release's),
// ENGENTY_HOME, WIZARDS_BOT_DATA, WIZARDS_ACCOUNT_URL (the account, https://account.engenty.ai),
// WIZARDS_BOT_FRPC (an frpc to use instead of downloading one).
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
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
import { connect, createServer } from "node:net";
import { homedir, hostname } from "node:os";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  AccountError,
  call,
  csrFor,
  frpcConfig,
  makeKey,
  orderCertificate,
  writeFileAtomic,
} from "./bot-tunnel.mjs";

/** The Node install.sh brings; the home gets the same where it needs one. */
export const NODE_VERSION = "26.12.0";
const REPO = "engenty/wizards-bot";
/** The port of the Bot Server of the wizards.bot Mac app: never taken by a home of this command. */
export const MAC_APP_PORT = 4747;
/** The first port a new home tries. */
export const PORT = 4748;
/** The ports Tailscale Funnel serves on. */
export const FUNNEL_PORTS = [443, 8443, 10000];
export const LABEL = "com.engenty.wizards.bot";
export const LINK_LABEL = "com.engenty.wizards.bot.link";
export const UNIT = "wizards-bot.service";
export const LINK_UNIT = "wizards-bot-link.service";
/** The account that gives out names at wizards.host and their certificates. */
export const ACCOUNT_URL = "https://account.engenty.ai";
/** frp (github.com/fatedier/frp, Apache-2.0): the relay's frps and this computer's frpc. */
export const FRP_VERSION = "0.72.0";
/** sha256 of frp's release files, from the release's frp_sha256_checksums.txt. */
export const FRP_SHA256 = {
  darwin_amd64: "60439dc6bf794c4182a1a4cac147d642f839d55201607208979eb23aecd09be9",
  darwin_arm64: "6e8576c5b6b9914a86850f6ff4fb81c5a09e706f91f70f64d5f398558bdc9db8",
  linux_amd64: "daf719b32ca2778770bb92955e231a07414d754378b9af328aa2642862479804",
  linux_arm64: "02180b857480302fd934e9ddbd50fe2f73229f99062f88756abc6de9df5e95cf",
  windows_amd64: "5197c1b69564089cdc229fc1260a0e25db1e722b1b7db45fe1542c3c43edf9ae",
};
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

/**
 * Where everything goes; ENGENTY_HOME and WIZARDS_BOT_DATA move it, as for the home itself. With
 * a folder, everything of that home goes into the folder (WIZARDS_BOT_DATA doesn't count there),
 * and its services are named after it, so homes in different folders don't replace each other.
 */
export function layout(env = process.env, folder = null) {
  const user = homedir();
  const home = join(resolve((env.ENGENTY_HOME || "").trim() || join(user, ".engenty")), "wizards");
  const config = env.XDG_CONFIG_HOME || join(user, ".config");
  const shared = {
    user,
    home,
    tools: join(home, "tools"),
    wizards: join(home, "bin", "wizards"),
    launchAgents: join(user, "Library", "LaunchAgents"),
    units: join(config, "systemd", "user"),
  };
  const services = (label, linkLabel, unit, linkUnit) => {
    const tunnelUnit = unit.replace(/\.service$/, "-tunnel.service");
    return {
      label,
      linkLabel,
      tunnelLabel: `${label}.tunnel`,
      unitName: unit,
      linkUnitName: linkUnit,
      tunnelUnitName: tunnelUnit,
      agent: join(shared.launchAgents, `${label}.plist`),
      linkAgent: join(shared.launchAgents, `${linkLabel}.plist`),
      tunnelAgent: join(shared.launchAgents, `${label}.tunnel.plist`),
      unit: join(shared.units, unit),
      linkUnit: join(shared.units, linkUnit),
      tunnelUnit: join(shared.units, tunnelUnit),
    };
  };
  if (folder) {
    const dir = resolve(folder);
    const id = folderId(dir);
    const logs = join(dir, "logs");
    return {
      ...shared,
      folder: dir,
      bot: join(dir, "program"),
      current: join(dir, "program", "current"),
      settings: join(dir, "wizards-bot.json"),
      command: join(dir, "wizards-bot"),
      pathLink: null,
      logs,
      log: join(logs, "bot.log"),
      linkLog: join(logs, "bot-link.log"),
      tunnelLog: join(logs, "bot-tunnel.log"),
      installLog: join(logs, "bot-install.log"),
      data: join(dir, "data"),
      tunnel: join(dir, "tunnel"),
      ...services(
        `${LABEL}.${id}`,
        `${LABEL}.${id}.link`,
        `wizards-bot-${id}.service`,
        `wizards-bot-${id}-link.service`,
      ),
    };
  }
  const bot = join(home, "bot");
  const data = (env.WIZARDS_BOT_DATA || "").trim() || join(user, ".wizards-bot");
  return {
    ...shared,
    folder: null,
    bot,
    current: join(bot, "current"),
    settings: join(bot, "bot.json"),
    command: join(home, "bin", "wizards-bot"),
    pathLink: join(user, ".local", "bin", "wizards-bot"),
    logs: join(home, "logs"),
    log: join(home, "logs", "bot.log"),
    linkLog: join(home, "logs", "bot-link.log"),
    tunnelLog: join(home, "logs", "bot-tunnel.log"),
    installLog: join(home, "logs", "bot-install.log"),
    data,
    tunnel: join(data, "tunnel"),
    ...services(LABEL, LINK_LABEL, UNIT, LINK_UNIT),
  };
}

/** A folder's name in its services: its own name, made safe, and a hash of its whole path. */
export function folderId(dir) {
  const slug =
    basename(dir)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "folder";
  return `${slug}-${createHash("sha256").update(dir).digest("hex").slice(0, 6)}`;
}

/** The Bot Server of the wizards.bot Mac app keeps its data here. */
const macAppData = (paths) => join(paths.user, ".engenty", "wizards-bot");

const tilde = (path) =>
  path === homedir() || path.startsWith(homedir() + sep)
    ? `~${path.slice(homedir().length)}`
    : path;

/** A folder as you'd type it in a terminal. */
const shellArg = (path) =>
  /^~?[\w./@+-]+$/.test(tilde(path)) ? tilde(path) : `'${path.replaceAll("'", "'\\''")}'`;

/** `wizards bot <command>` for this home: with its folder when it has one. */
const hint = (paths, command) =>
  cyan(`wizards bot ${command}${paths.folder ? ` ${shellArg(paths.folder)}` : ""}`);

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
    ...(settings.url
      ? [`export WIZARDS_BOT_URL="\${WIZARDS_BOT_URL:-${settings.url.replaceAll('"', '\\"')}}"`]
      : []),
    `exec ${quote(settings.node)} ${quote(join(paths.current, settings.bin))} "$@"`,
    "",
  ].join("\n");
}

function writeCommand(paths, settings) {
  mkdirSync(dirname(paths.command), { recursive: true });
  writeFileSync(paths.command, commandText(paths, settings));
  chmodSync(paths.command, 0o755);
  // A home in a folder keeps its command there: ~/.local/bin/wizards-bot is the other one's.
  if (!paths.pathLink) {
    step("Command", tilde(paths.command));
    return;
  }
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
export function agentText(paths, label, args, log, program = paths.command) {
  const env = serviceEnv(paths);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${[program, ...args].map((arg) => `    <string>${xml(arg)}</string>\n`).join("")}  </array>
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
export function unitText(paths, description, args, program = paths.command) {
  const quoted = (text) => `"${String(text).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  const env = serviceEnv(paths);
  return [
    "[Unit]",
    `Description=${description}`,
    `Documentation=https://github.com/${REPO}`,
    "",
    "[Service]",
    `ExecStart=${[program, ...args].map(quoted).join(" ")}`,
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

/** The three services: the home, the link to a home elsewhere, and the tunnel. */
function services(paths) {
  const where = paths.folder ? ` in ${tilde(paths.folder)}` : "";
  return {
    home: {
      label: paths.label,
      unit: paths.unitName,
      agent: paths.agent,
      unitFile: paths.unit,
      args: ["start"],
      log: paths.log,
      description: `wizards.bot, your home${where}`,
    },
    link: {
      label: paths.linkLabel,
      unit: paths.linkUnitName,
      agent: paths.linkAgent,
      unitFile: paths.linkUnit,
      args: ["link"],
      log: paths.linkLog,
      description: `wizards.bot, this computer’s models for your home${where}`,
    },
    tunnel: {
      label: paths.tunnelLabel,
      unit: paths.tunnelUnitName,
      agent: paths.tunnelAgent,
      unitFile: paths.tunnelUnit,
      // The Node the home runs with, set when the tunnel opens (tunnelService).
      program: null,
      args: [join(paths.tunnel, "run.mjs"), paths.tunnel],
      log: paths.tunnelLog,
      description: `wizards.bot, the tunnel of your home${where}`,
    },
  };
}

/** The tunnel's service, run by the home's Node. */
function tunnelService(paths, settings) {
  return { ...services(paths).tunnel, program: settings.node };
}

const unxml = (text) =>
  text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

function listDir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * The folders with a home of `wizards bot install <folder>` on this computer, read from their
 * services: a LaunchAgent or a systemd unit names the folder's command.
 */
export function folderInstalls(paths) {
  const found = [];
  if (process.platform === "darwin") {
    for (const name of listDir(paths.launchAgents)) {
      const id = /^com\.engenty\.wizards\.bot\.(.+)\.plist$/.exec(name)?.[1];
      if (!id || ["link", "tunnel"].includes(id) || /\.(link|tunnel)$/.test(id)) {
        continue;
      }
      const text = readFileSync(join(paths.launchAgents, name), "utf8");
      const command = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(
        text,
      )?.[1];
      if (command) {
        found.push(dirname(unxml(command)));
      }
    }
  } else {
    for (const name of listDir(paths.units)) {
      if (!/^wizards-bot-.+\.service$/.test(name) || /-(link|tunnel)\.service$/.test(name)) {
        continue;
      }
      const text = readFileSync(join(paths.units, name), "utf8");
      const command = /^ExecStart="((?:[^"\\]|\\.)*)"/m.exec(text)?.[1];
      if (command) {
        found.push(dirname(command.replace(/\\(.)/g, "$1")));
      }
    }
  }
  return found.filter((dir) => dir !== paths.folder).sort();
}

/**
 * The ports other homes of this command keep, running or not, and whose they are: the one in
 * ~/.engenty/wizards and those in folders. A home that is stopped gets its port back when it starts.
 */
export function claimedPorts(paths, env = process.env) {
  const claimed = new Map();
  const others = folderInstalls(paths).map((dir) => layout(env, dir));
  if (paths.folder) {
    others.unshift(layout(env));
  }
  for (const other of others) {
    const port = readJson(other.settings)?.port;
    if (port) {
      claimed.set(
        port,
        other.folder
          ? `the Bot Server in ${tilde(other.folder)}`
          : "the Bot Server of `wizards bot install`",
      );
    }
  }
  return claimed;
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
    writeFileSync(
      service.agent,
      agentText(paths, service.label, service.args, service.log, service.program || undefined),
    );
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
  writeFileSync(
    service.unitFile,
    unitText(paths, service.description, service.args, service.program || undefined),
  );
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

/** Whether something takes connections on 127.0.0.1 at a port. */
function answers(port) {
  return new Promise((done) => {
    const socket = connect({ port, host: "127.0.0.1" });
    socket.setTimeout(1000);
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      done(false);
    });
    socket.once("error", () => done(false));
  });
}

/**
 * Whether a port is free: nothing listens on it, for the whole network or only on 127.0.0.1
 * (binding to 0.0.0.0 alone wouldn't tell the second on a Mac).
 */
export async function portFree(port) {
  const bindable = await new Promise((done) => {
    const server = createServer();
    server.once("error", () => done(false));
    server.listen({ port, host: "0.0.0.0" }, () => server.close(() => done(true)));
  });
  return bindable && !(await answers(port));
}

/** Who holds a port, as "<program> (pid <n>)", from lsof or ss; null when neither says. */
export function portHolder(port) {
  let pid = null;
  const lsof = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], {
    encoding: "utf8",
  });
  pid = /^p(\d+)/m.exec(lsof.stdout || "")?.[1] || null;
  if (!pid && process.platform === "linux") {
    const ss = spawnSync("ss", ["-ltnpH", `sport = :${port}`], { encoding: "utf8" });
    pid = /pid=(\d+)/.exec(ss.stdout || "")?.[1] || null;
  }
  if (!pid) {
    return null;
  }
  const command = spawnSync("ps", ["-o", "command=", "-p", pid], {
    encoding: "utf8",
  }).stdout?.trim();
  return `${programName(command || "")} (pid ${pid})`;
}

/** A process's command line as a short name: an app by its name, else the program and its script. */
export function programName(command) {
  const app = /\/([^/]+\.app)\/Contents\//.exec(command)?.[1];
  if (app) {
    return app;
  }
  const [program = "a program", script] = command.split(/\s+/);
  const name = program.split("/").pop();
  return script?.startsWith("/") ? `${name} ${tilde(script)}` : name;
}

/** Why a port can't be had: whose it is, or what holds it. */
function takenBy(port, claimed) {
  if (claimed.has(port)) {
    return `kept for ${claimed.get(port)}`;
  }
  const holder = portHolder(port);
  const mac = port === MAC_APP_PORT ? " (the port of the wizards.bot Mac app)" : "";
  return holder ? `taken by ${holder}${mac}` : `taken${mac}`;
}

/** The first free port from `start` on, past those other homes keep and past the Mac app's. */
export async function freePort(start, claimed = new Map(), skipped = []) {
  for (let port = start; port < start + 100; port++) {
    if (port === MAC_APP_PORT) {
      continue;
    }
    if (!claimed.has(port) && (await portFree(port))) {
      return port;
    }
    skipped.push(port);
  }
  throw new Refusal(`No port from ${start} to ${start + 99} is free.`);
}

/**
 * Refuses a --port that can't be had, before anything is downloaded: 4747, a port another home
 * keeps, or one something holds now. The home's own port is let through: it holds it itself.
 */
export async function checkPort(paths, options) {
  const saved = readJson(paths.settings) || {};
  const port = options.port;
  if (!port || port === saved.port) {
    return;
  }
  if (port === MAC_APP_PORT) {
    throw new Refusal(
      `${MAC_APP_PORT} is the port of the wizards.bot Mac app’s Bot Server. Pick another with --port, or leave it out.`,
    );
  }
  const claimed = claimedPorts(paths);
  if (claimed.has(port) || !(await portFree(port))) {
    throw new Refusal(
      `Port ${port} is ${takenBy(port, claimed)}. Pick another with --port, or leave it out to take the next free one.`,
    );
  }
}

/**
 * The port a home starts on: the one it had, the one asked for with --port, or the first free one
 * from 4748 on. A taken port is said with what holds it.
 */
async function choosePort(paths, options, saved) {
  const claimed = claimedPorts(paths);
  const wanted = options.port || saved.port || null;
  if (wanted) {
    // The home that ran there a moment ago may still be letting go of it.
    for (let tries = 0; tries < 20 && wanted === saved.port && !(await portFree(wanted)); tries++) {
      await pause(250);
    }
    if (!claimed.has(wanted) && (await portFree(wanted))) {
      return wanted;
    }
    if (options.port) {
      throw new Refusal(
        `Port ${wanted} is ${takenBy(wanted, claimed)}. Pick another with --port, or leave it out to take the next free one.`,
      );
    }
  }
  const skipped = [];
  const port = await freePort(wanted ? wanted + 1 : PORT, claimed, skipped);
  for (const taken of [wanted, ...skipped].filter(Boolean).slice(0, 4)) {
    note(`Port ${taken} is ${takenBy(taken, claimed)}`);
  }
  return port;
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

function notInstalled(paths) {
  return new Refusal(
    paths.folder
      ? `No wizards.bot is installed in ${tilde(paths.folder)}. To install it there: ${hint(paths, "install")}`
      : `wizards.bot isn’t installed on this computer. To install it: ${cyan("wizards bot install")}`,
  );
}

/** The settings of an installed home, or a refusal that says how to install it. */
function installed(paths) {
  const settings = readJson(paths.settings);
  if (!settings || !installedVersion(paths)) {
    throw notInstalled(paths);
  }
  return settings;
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
 * `--port`, or the first free one from 4748 on (4747 is the Mac app's).
 */
async function put(paths, options, from) {
  const saved = readJson(paths.settings) || {};
  const home = services(paths).home;
  const { node, brought } = findNode(paths);
  const { version, bin } = installProgram(paths, from, node);
  // The home that runs gives its port free first.
  await stopService(home);
  const port = await choosePort(paths, options, saved);
  const settings = {
    version,
    bin,
    port,
    node,
    data: paths.data,
    // A Node this command downloaded goes with the home, unless engenty wizards or a home in a
    // folder uses it too. Homes in folders never take it away.
    nodeBrought:
      !paths.folder &&
      Boolean(saved.nodeBrought || brought) &&
      node === join(paths.tools, "node", "bin", "node"),
    ...(saved.url ? { url: saved.url } : {}),
    ...(saved.tunnel ? { tunnel: saved.tunnel } : {}),
  };
  saveSettings(paths, settings);
  writeCommand(paths, settings);
  const running = await startHome(paths, settings);
  // The tunnel keeps its name, with the home's port and this run.mjs.
  await refreshRelay(paths, settings);
  return { settings, running };
}

/** Starts the home's service again and waits for its answer; false where nothing can run it. */
async function startHome(paths, settings) {
  const home = services(paths).home;
  if (!(await startService(paths, home))) {
    console.log(
      `\nThe home doesn’t start by itself here: systemd --user isn’t available. Start it with ${cyan(`${paths.folder ? shellArg(paths.command) : "wizards-bot"} start`)}.`,
    );
    return false;
  }
  note(`Starting the home on port ${settings.port}`);
  await waitForHealth(paths, settings.port);
  step("Home", `http://localhost:${settings.port}, ${serviceThere(home)}`);
  return true;
}

/**
 * Whether a folder may hold a home: not your home folder itself, and not inside the folders the
 * other homes keep their program or data in.
 */
export function folderRefusal(paths) {
  const dir = paths.folder;
  const inside = (parent) => dir === parent || dir.startsWith(parent + sep);
  if (dir === paths.user || dir === sep) {
    return `${tilde(dir)} is too wide for a home: give it a folder of its own, e.g. ${cyan(`wizards bot install ${shellArg(join(dir, "wizards-bot"))}`)}`;
  }
  for (const [parent, whose] of [
    [macAppData(paths), "the data of the wizards.bot Mac app"],
    [layout().data, "the data of the home of `wizards bot install`"],
    [paths.home, "engenty wizards and the home of `wizards bot install`"],
  ]) {
    if (inside(parent)) {
      return `${tilde(parent)} holds ${whose}: pick a folder outside it.`;
    }
  }
  return null;
}

async function install(paths, options) {
  windowsRefusal();
  if (paths.folder) {
    const refusal = folderRefusal(paths);
    if (refusal) {
      throw new Refusal(refusal);
    }
  }
  await checkPort(paths, options);
  if (paths.folder) {
    mkdirSync(paths.folder, { recursive: true });
  }
  const before = installedVersion(paths);
  console.log(`${bold("wizards.bot")}  ${dim(`into ${tilde(paths.folder || paths.bot)}`)}`);
  const from = source(options.version);
  if (before && from.version && before === from.version && !options.version) {
    note(`wizards.bot ${before} is installed already: installing it again`);
  }
  const { running } = await put(paths, options, from);
  if (running) {
    await setup(paths, options);
  }
}

/** Prints the output of `wizards-bot pair` (the QR, the code) and opens the pairing link. */
async function setup(paths, options) {
  windowsRefusal();
  const settings = installed(paths);
  if (options.link) {
    return link(paths, settings, options);
  }
  if (!(await healthy(settings.port))) {
    throw new Refusal(
      `The home doesn’t run. ${hint(paths, "status")} says more, its log is ${tilde(paths.log)}.`,
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

/** One home's lines: its version, whether it runs, its address, its data, its tunnel. */
async function describe(paths, settings, version) {
  const { home, link: linked, tunnel: tunneled } = services(paths);
  const answers = await healthy(settings.port);
  const how = serviceThere(home);
  console.log(`wizards.bot ${version}  ${dim(tilde(paths.folder || join(paths.bot, version)))}`);
  console.log(
    `  ${answers ? green("running") : red("not running")}  http://localhost:${settings.port}${how ? dim(`  (${how})`) : ""}`,
  );
  if (settings.url) {
    const how =
      settings.tunnel?.by === "relay"
        ? `${dim("(our relay, ")}${serviceRuns(tunneled) ? green("running") : red("not running")}${dim(")")}`
        : dim("(Tailscale Funnel)");
    console.log(`  internet ${settings.url}  ${how}`);
  }
  console.log(`  data     ${tilde(settings.data)}`);
  console.log(`  command  ${tilde(paths.command)}`);
  const linkFile = readJson(join(settings.data, "link.json"));
  if (linkFile?.home && serviceThere(linked)) {
    console.log(
      `  linked   ${linkFile.home}  ${serviceRuns(linked) ? green("running") : red("not running")}`,
    );
  }
  if (!answers) {
    console.log(`  its log  ${tilde(paths.log)}`);
  }
}

/**
 * `status`: the home in ~/.engenty/wizards and a line for each home in a folder; `status <folder>`:
 * that folder's home.
 */
async function status(paths, _options, env) {
  const version = installedVersion(paths);
  const settings = readJson(paths.settings);
  if (paths.folder) {
    if (!version || !settings) {
      console.log(`No wizards.bot is installed in ${tilde(paths.folder)}.`);
      return;
    }
    await describe(paths, settings, version);
    return;
  }
  const folders = folderInstalls(paths);
  if (version && settings) {
    await describe(paths, settings, version);
  } else if (!folders.length) {
    console.log(
      `wizards.bot isn’t installed on this computer. To install it: ${cyan("wizards bot install")}`,
    );
    return;
  }
  if (folders.length) {
    console.log(
      `${version && settings ? "\n" : ""}In folders  ${dim("(wizards bot status <folder> says more)")}`,
    );
  }
  for (const dir of folders) {
    const there = layout(env, dir);
    const theirs = readJson(there.settings);
    const runs = theirs?.port ? await healthy(theirs.port) : false;
    console.log(
      `  ${tilde(dir)}  ${!theirs ? red("missing") : runs ? green("running") : red("not running")}${theirs?.port ? `  http://localhost:${theirs.port}` : ""}${theirs?.url ? `  ${theirs.url}` : ""}`,
    );
  }
}

/** `stop`: the home and its link stop until you log in again or start them. Nothing is removed. */
async function stop(paths) {
  installed(paths);
  const { home, link: linked, tunnel: tunneled } = services(paths);
  for (const service of [tunneled, linked, home]) {
    const how = serviceThere(service);
    if (how) {
      await stopService(service);
      step("Stopped", how);
    }
  }
  console.log(
    `\nIt starts again when you log in, or with ${hint(paths, "start")}. Its data and port are kept.`,
  );
}

/** `start`: starts a stopped home and its link again. */
async function start(paths) {
  windowsRefusal();
  const settings = installed(paths);
  const linked = services(paths).link;
  await startHome(paths, settings);
  if (serviceThere(linked)) {
    await startService(paths, linked);
  }
  if (settings.tunnel?.by === "relay" && serviceThere(services(paths).tunnel)) {
    await startService(paths, tunnelService(paths, settings));
  }
}

async function update(paths, options) {
  windowsRefusal();
  const before = installedVersion(paths);
  if (!before) {
    throw notInstalled(paths);
  }
  await checkPort(paths, options);
  const from = source(options.version);
  if (from.version && !options.version && !older(before, from.version)) {
    console.log(`wizards.bot ${before} is the newest version.`);
    return;
  }
  const { settings, running } = await put(paths, options, from);
  // A link that runs starts again with the new version.
  const linked = services(paths).link;
  if (serviceThere(linked)) {
    await startService(paths, linked);
  }
  console.log(
    `\nwizards.bot ${before === settings.version ? `${before} is installed again` : `went from ${before} to ${settings.version}`}. Your data is kept${running ? ", and the home runs" : ""}.`,
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

/**
 * `uninstall`: takes the home in ~/.engenty/wizards away; `uninstall <folder>` the one in that
 * folder, and the folder too once nothing else is in it. The data stays unless --purge.
 */
async function uninstall(paths, options) {
  const settings = readJson(paths.settings) || {};
  const { home, link: linked, tunnel: tunneled } = services(paths);
  const there =
    existsSync(paths.bot) ||
    existsSync(paths.command) ||
    serviceThere(home) ||
    serviceThere(linked) ||
    serviceThere(tunneled);
  const data = settings.data || paths.data;
  const where = paths.folder ? `${tilde(paths.folder)}` : "this computer";
  if (!there && !options.purge) {
    console.log(
      paths.folder
        ? `No wizards.bot is installed in ${where}.`
        : "wizards.bot isn’t installed on this computer.",
    );
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
  if (settings.tunnel) {
    await closeTunnel(paths, settings);
    step("Closed the tunnel", settings.url);
  }
  for (const service of [tunneled, linked, home]) {
    const how = serviceThere(service);
    if (how) {
      await removeService(service);
      step("Stopped and removed", how);
    }
  }
  if (paths.pathLink) {
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
  }
  rmSync(paths.command, { force: true });
  rmSync(paths.bot, { recursive: true, force: true });
  for (const log of [paths.log, paths.linkLog, paths.tunnelLog, paths.installLog]) {
    rmSync(log, { force: true });
  }
  step("Removed the program", tilde(paths.bot));
  if (paths.folder) {
    rmSync(paths.settings, { force: true });
    dropEmpty(paths.logs);
  } else {
    // A Node this command brought goes too, unless engenty wizards or a home in a folder uses it.
    if (settings.nodeBrought && !existsSync(paths.wizards) && !folderInstalls(paths).length) {
      for (const name of listDir(paths.tools)) {
        if (name === "node" || name.startsWith("node-v")) {
          rmSync(join(paths.tools, name), { recursive: true, force: true });
        }
      }
    }
    for (const dir of [
      paths.tools,
      paths.logs,
      dirname(paths.command),
      paths.home,
      dirname(paths.home),
    ]) {
      dropEmpty(dir);
    }
  }
  if (purge) {
    rmSync(data, { recursive: true, force: true });
  }
  if (paths.folder) {
    dropEmpty(paths.folder);
  }
  if (purge) {
    console.log(`\nwizards.bot is off ${where}, and its data in ${tilde(data)} is deleted.`);
  } else if (existsSync(data)) {
    console.log(
      `\nwizards.bot is off ${where}. Your home’s data stays in ${tilde(data)}: ${hint(paths, "install")} picks it up again.`,
    );
  } else {
    console.log(`\nwizards.bot is off ${where}.`);
  }
}

// --- the tunnel ------------------------------------------------------------------------------

/** The tailscale command: on PATH, or inside the Mac app. */
function tailscale() {
  const app = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
  return onPath("tailscale") || (process.platform === "darwin" && existsSync(app) ? app : null);
}

function tailscaleJson(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 15_000 });
  try {
    return result.status === 0 ? JSON.parse(result.stdout) : null;
  } catch {
    return null;
  }
}

/** How many devices are paired with a home, from `wizards-bot status`; null when it can't say. */
export function devicesIn(text) {
  const list = /^Devices\n((?: {2}.*\n?)*)/m.exec(text)?.[1];
  if (list === undefined) {
    return null;
  }
  const lines = list.split("\n").filter((line) => line.trim());
  return lines.length === 1 && lines[0].trim() === "none" ? 0 : lines.length;
}

/**
 * The Funnel port for a home: the one that already serves it, else the first of 443, 8443 and
 * 10000 that serves nothing. `serving` is `tailscale funnel status --json`.
 */
export function funnelPort(serving, host, port) {
  const target = new RegExp(`^(https?://)?(127\\.0\\.0\\.1|localhost):${port}/?$`);
  const web = serving?.Web || {};
  const tcp = serving?.TCP || {};
  const ours = FUNNEL_PORTS.find((https) =>
    target.test(web[`${host}:${https}`]?.Handlers?.["/"]?.Proxy || ""),
  );
  return ours || FUNNEL_PORTS.find((https) => !web[`${host}:${https}`] && !tcp[https]) || null;
}

/** Whether an address answers on /health from the internet's side, by curl. */
function reachable(url) {
  return (
    spawnSync("curl", ["-fsS", "--max-time", "10", "-o", "/dev/null", `${url}/health`]).status === 0
  );
}

/** `tailscale funnel …` for a home's port, in the background (it stays after a restart). */
const funnelArgs = (https, port) => [
  "funnel",
  "--bg",
  `--https=${https}`,
  `http://127.0.0.1:${port}`,
];

/** Takes a home's Funnel off, with the command that put it on and `off` after it. */
function closeFunnel(settings) {
  const command = tailscale();
  if (command && settings.tunnel?.https) {
    spawnSync(command, [...funnelArgs(settings.tunnel.https, settings.port), "off"], {
      encoding: "utf8",
      timeout: 15_000,
    });
  }
}

/** The account that gives out tunnel names: WIZARDS_ACCOUNT_URL, or account.engenty.ai. */
export function accountUrl(env = process.env) {
  return ((env.WIZARDS_ACCOUNT_URL || "").trim() || ACCOUNT_URL).replace(/\/+$/, "");
}

/** Whether a word can go before a team's name: `test01` in test01.ada.wizards.host. */
export function labelOk(label) {
  return /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/.test(label);
}

/**
 * Closes a home's tunnel, whichever it is: Funnel goes off; the relay's service goes, its key
 * is given back to the account (best effort) and the tunnel folder goes.
 */
async function closeTunnel(paths, settings) {
  if (settings.tunnel?.by === "relay") {
    await removeService(services(paths).tunnel);
    const saved = readJson(join(paths.tunnel, "tunnel.json"));
    if (saved?.key && saved.account) {
      try {
        await call(saved.account, "/v1/tunnels/key", { method: "DELETE", key: saved.key });
      } catch (error) {
        note(`The account didn’t take the tunnel’s key back: ${error.message}`);
      }
    }
    rmSync(paths.tunnel, { recursive: true, force: true });
    return;
  }
  closeFunnel(settings);
}

/** Refuses while the home doesn't run, or while no device is paired with it. */
async function requirePaired(paths, settings) {
  if (!(await healthy(settings.port))) {
    throw new Refusal(`The home doesn’t run. Start it first: ${hint(paths, "start")}`);
  }
  const said = spawnSync(paths.command, ["status"], { encoding: "utf8", timeout: 60_000 });
  const devices = devicesIn(said.stdout || "");
  if (!devices) {
    throw new Refusal(
      devices === 0
        ? `No device is paired with this home yet, so it stays off the internet. Pair your phone on this network first (${hint(paths, "setup")}), then run this again.`
        : `wizards-bot status didn’t say whether a device is paired, so the home stays off the internet.`,
    );
  }
}

/** frp's name for this computer: `darwin_arm64`, `linux_amd64` and so on. */
export function frpMachine(platform = process.platform, arch = machine().split("-")[1]) {
  return `${platform === "win32" ? "windows" : platform}_${arch === "x64" ? "amd64" : arch}`;
}

/**
 * frpc, in ~/.engenty/wizards/tools/frp/<version>, downloaded from frp's release and checked
 * against the checksum in FRP_SHA256. WIZARDS_BOT_FRPC names one to use instead.
 */
function findFrpc(paths, env = process.env) {
  const given = (env.WIZARDS_BOT_FRPC || "").trim();
  if (given) {
    return resolve(given);
  }
  const dir = join(paths.tools, "frp", FRP_VERSION);
  const frpc = join(dir, "frpc");
  if (existsSync(frpc)) {
    return frpc;
  }
  const name = `frp_${FRP_VERSION}_${frpMachine()}`;
  const checksum = FRP_SHA256[frpMachine()];
  if (!checksum) {
    throw new Refusal(`frp ${FRP_VERSION} has no frpc for ${frpMachine()} here.`);
  }
  note(`Downloading frpc ${FRP_VERSION} for the tunnel`);
  mkdirSync(join(paths.tools, "frp"), { recursive: true });
  const tmp = mkdtempSync(join(paths.tools, "frp", ".frp."));
  try {
    const tarball = join(tmp, "frp.tar.gz");
    fetchFile(
      paths,
      `https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/${name}.tar.gz`,
      tarball,
      checksum,
    );
    logged(paths, "tar", ["-xzf", tarball, "-C", tmp, `${name}/frpc`]);
    mkdirSync(dir, { recursive: true });
    renameSync(join(tmp, name, "frpc"), frpc);
    chmodSync(frpc, 0o755);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  step(`frpc ${FRP_VERSION}`, `${tilde(frpc)}, checksum matches`);
  return frpc;
}

/**
 * Signs in for a name: the account shows a code, you confirm it there, and this gets the
 * name's key. `label` asks for <label>.<team>.wizards.host.
 */
export async function signIn(account, { label, open = true, every } = {}) {
  const { data: started } = await call(account, "/v1/tunnels/start", {
    method: "POST",
    body: { ...(label ? { label } : {}), computer: hostname().replace(/\.local$/, "") },
  });
  console.log(
    `\nTo give this home its name, open ${cyan(started.url)}\nsign in to your wizards account and confirm the code ${bold(started.userCode)}.\n`,
  );
  if (open) {
    openBrowser(started.url);
  }
  const wait = every ?? (started.interval || 3) * 1000;
  const until = Date.now() + (started.expiresIn || 900) * 1000;
  while (Date.now() < until) {
    let answer;
    try {
      answer = await call(account, "/v1/tunnels/redeem", {
        method: "POST",
        body: { deviceCode: started.deviceCode },
      });
    } catch (error) {
      if (error instanceof AccountError) {
        throw new Refusal(
          error.code === "denied"
            ? "The name wasn’t given: it was declined on the account page."
            : error.code === "expired"
              ? "The code ran out before it was confirmed. Run this again for a new one."
              : error.message,
        );
      }
      throw error;
    }
    if (answer.status === 200 && answer.data.key) {
      return answer.data;
    }
    await pause(wait);
  }
  throw new Refusal("The code ran out before it was confirmed. Run this again for a new one.");
}

/** A port for frpc's admin API on 127.0.0.1, free now. */
async function adminPort() {
  for (let tries = 0; tries < 50; tries++) {
    const port = 20000 + (randomBytes(2).readUInt16BE(0) % 40000);
    if (await portFree(port)) {
      return port;
    }
  }
  throw new Refusal("No free port was found for frpc.");
}

/** Writes the tunnel's files for a home: tunnel.json, frpc.toml and run.mjs. */
export function writeTunnel(dir, tunnel) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileAtomic(join(dir, "tunnel.json"), `${JSON.stringify(tunnel, null, 2)}\n`, true);
  writeFileAtomic(join(dir, "frpc.toml"), frpcConfig({ ...tunnel, dir }), true);
  copyFileSync(fileURLToPath(new URL("./bot-tunnel.mjs", import.meta.url)), join(dir, "run.mjs"));
}

/** Gets the certificate for the tunnel's name into its folder. */
async function certificate(dir, tunnel) {
  const keyFile = join(dir, "key.pem");
  if (!existsSync(keyFile)) {
    writeFileAtomic(keyFile, makeKey(), true);
  }
  note(`Getting a certificate for ${tunnel.name} (Let’s Encrypt, up to a minute)`);
  try {
    const cert = await orderCertificate(
      tunnel.account,
      tunnel.key,
      csrFor(tunnel.name, readFileSync(keyFile, "utf8")),
    );
    writeFileAtomic(join(dir, "cert.pem"), cert);
  } catch (error) {
    if (error instanceof AccountError) {
      throw new Refusal(`No certificate for ${tunnel.name}: ${error.message}`);
    }
    throw error;
  }
  step("Certificate", `${tunnel.name}, the key stays on this computer`);
}

/**
 * `tunnel`: puts a home on the internet at https://<name>.wizards.host, through our relay. frpc
 * dials out (no port opens on the router), and TLS ends on this computer: the relay passes it on
 * by name, unread. It refuses while no device is paired: whoever reaches the address then still
 * needs a pairing code or a device's token. `--tailscale` uses Tailscale Funnel instead, and
 * `tunnel --off` closes either.
 */
async function tunnel(paths, options, env = process.env) {
  windowsRefusal();
  const settings = installed(paths);
  if (options.off) {
    if (!settings.tunnel) {
      console.log("This home isn’t on the internet: there’s no tunnel to close.");
      return;
    }
    await closeTunnel(paths, settings);
    const { url: _url, tunnel: _tunnel, ...rest } = settings;
    saveSettings(paths, rest);
    writeCommand(paths, rest);
    await startHome(paths, rest);
    step("Closed the tunnel", settings.url);
    console.log(
      `\nThe home is off the internet. Your devices reach it on this network again, at its local address.`,
    );
    return;
  }
  if (options.name && !labelOk(options.name)) {
    throw new Refusal(
      `--name takes lower-case letters, digits and dashes, up to 32: e.g. ${cyan("--name test01")}`,
    );
  }
  const by = options.tailscale ? "tailscale-funnel" : "relay";
  if (settings.tunnel && settings.tunnel.by !== by) {
    throw new Refusal(
      `This home is on the internet already, at ${settings.url}. Close that first: ${hint(paths, "tunnel --off")}`,
    );
  }
  await requirePaired(paths, settings);
  const next = options.tailscale
    ? await openFunnel(settings)
    : await openRelay(paths, settings, options, env);
  saveSettings(paths, next);
  // The home says this address in its pairing codes from now on.
  writeCommand(paths, next);
  await startHome(paths, next);
  const url = next.url;
  let answered = reachable(url);
  for (let tries = 0; tries < 12 && !answered; tries++) {
    await pause(5000);
    answered = reachable(url);
  }
  step(
    "On the internet",
    answered ? url : `${url} (it doesn’t answer yet: a new name takes a minute or two)`,
  );
  console.log(
    `\nOnly your paired devices get in; a new one needs a code from ${hint(paths, "setup")}, which now shows this address. A phone paired on this network still uses the local address: pair it again with that code to reach the home away from home. ${hint(paths, "tunnel --off")} closes it.`,
  );
}

/** The relay: a name from the account, a certificate for it, frpc as a service. */
async function openRelay(paths, settings, options, env) {
  const dir = paths.tunnel;
  const saved = readJson(join(dir, "tunnel.json"));
  const wanted = options.name;
  if (saved?.name && wanted && !saved.name.startsWith(`${wanted}.`)) {
    throw new Refusal(
      `This home’s tunnel is ${saved.name}. To take another name, close it first: ${hint(paths, "tunnel --off")}`,
    );
  }
  let tunnel = saved?.key ? saved : null;
  if (!tunnel) {
    const account = accountUrl(env);
    const given = await signIn(account, { label: wanted, open: options.open });
    tunnel = {
      account,
      name: given.name,
      key: given.key,
      server: given.server,
      serverPort: given.serverPort,
    };
    step("Name", given.name);
  }
  tunnel = {
    ...tunnel,
    frpc: findFrpc(paths, env),
    port: settings.port,
    adminPort: tunnel.adminPort || (await adminPort()),
    adminPassword: tunnel.adminPassword || randomBytes(18).toString("base64url"),
  };
  writeTunnel(dir, tunnel);
  await certificate(dir, tunnel);
  const service = tunnelService(paths, settings);
  if (!(await startService(paths, service))) {
    throw new Refusal(
      `systemd --user isn’t available here, so the tunnel can’t run as a service. Run it yourself: ${cyan(`${settings.node} ${join(dir, "run.mjs")} ${dir}`)}`,
    );
  }
  step("Tunnel", serviceThere(service));
  return { ...settings, url: `https://${tunnel.name}`, tunnel: { by: "relay", name: tunnel.name } };
}

/** Tailscale Funnel, at https://<computer>.<tailnet>.ts.net. */
async function openFunnel(settings) {
  const command = tailscale();
  if (!command) {
    throw new Refusal(
      "The tunnel goes through Tailscale Funnel. Install Tailscale (https://tailscale.com/download), sign in, then run this again.",
    );
  }
  const state = tailscaleJson(command, ["status", "--json"]);
  const host = String(state?.Self?.DNSName || "").replace(/\.$/, "");
  if (state?.BackendState !== "Running" || !host) {
    throw new Refusal(
      `Tailscale isn’t signed in, or isn’t running. Sign in (${cyan("tailscale up")}), then run this again.`,
    );
  }
  const https = funnelPort(
    tailscaleJson(command, ["funnel", "status", "--json"]),
    host,
    settings.port,
  );
  if (!https) {
    throw new Refusal(
      `Tailscale Funnel serves on 443, 8443 and 10000 only, and all three serve something else here. ${cyan("tailscale funnel status")} shows what.`,
    );
  }
  const url = `https://${host}${https === 443 ? "" : `:${https}`}`;
  note(`Opening ${url} with Tailscale Funnel`);
  // Tailscale may ask to turn Funnel on for this computer first, with a link: that goes to you.
  const opened = spawnSync(command, funnelArgs(https, settings.port), { stdio: "inherit" });
  if (opened.status !== 0) {
    throw new Refusal(
      `tailscale funnel didn’t open ${url}. ${cyan("tailscale funnel status")} says what it serves.`,
    );
  }
  return { ...settings, url, tunnel: { by: "tailscale-funnel", https } };
}

/** After an update: the relay's files with the home's port and this run.mjs, and frpc again. */
async function refreshRelay(paths, settings) {
  const saved = readJson(join(paths.tunnel, "tunnel.json"));
  if (settings.tunnel?.by !== "relay" || !saved) {
    return;
  }
  writeTunnel(paths.tunnel, { ...saved, port: settings.port });
  await startService(paths, tunnelService(paths, settings));
}

// --- the command line ------------------------------------------------------------------------

const HELP = `${bold("wizards bot")}: wizards.bot, your own agent in a home of your own, on this computer

Commands
  ${cyan("wizards bot install [folder]")}
                          install the home, start it with your computer and open its setup
  ${cyan("wizards bot setup")}       open the home’s setup and show a code to pair your phone
  ${cyan("wizards bot setup --link <address> <code>")}
                          link this computer to your home on wizards.bot: it uses this
                          computer’s models while it’s on (e.g. --link ada K7QM-2RXD)
  ${cyan("wizards bot status")}      show the installed version, whether it runs and its address,
                          and a line for each home in a folder
  ${cyan("wizards bot stop")}        stop the home until you log in again or start it
  ${cyan("wizards bot start")}       start it again
  ${cyan("wizards bot tunnel")}      put the home on the internet at https://<name>.wizards.host, once
                          a device is paired: sign in to your wizards account for the name
                          (--name test01 for test01.<name>.wizards.host, --tailscale for
                          Tailscale Funnel instead, --off closes it)
  ${cyan("wizards bot update")}      install the newest version and restart the home, your data is kept
  ${cyan("wizards bot uninstall")}   take the home off this computer, your data in ~/.wizards-bot is kept
                          (--purge deletes it too, after asking)

A folder
  ${cyan("wizards bot install .")} or ${cyan("wizards bot install ./test01")} puts a home of its own into that
  folder: program, data, port and service, beside the other homes. Every command takes the
  folder after it (${cyan("wizards bot status ./test01")}); without one, a command means the home in
  ~/.engenty/wizards.

Options
  --version <v>   install this version instead of the newest
  --port <n>      the port for a new home (default 4748, or the next free one; 4747 is the
                  Mac app’s)
  --no-open       don’t open the browser
  --off           with tunnel: close it
  --name <word>   with tunnel: the word before your name, for a second home
  --tailscale     with tunnel: Tailscale Funnel instead of wizards.host
  --yes, -y       don’t ask

The program goes into ~/.engenty/wizards/bot (ENGENTY_HOME moves it), the command
wizards-bot into ~/.local/bin. On a Mac the home runs as a LaunchAgent, on Linux as a
systemd user service.
`;

/** Reads `wizards bot <command> [folder] [options]`. */
export function parse(argv) {
  const options = {
    command: "",
    folder: null,
    open: true,
    yes: false,
    purge: false,
    off: false,
    tailscale: false,
    name: null,
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
    } else if (arg === "--off") {
      options.off = true;
    } else if (arg === "--tailscale") {
      options.tailscale = true;
    } else if (arg === "--name") {
      options.name = (argv[++i] || "").toLowerCase();
      if (!options.name) {
        throw new Refusal("--name needs a word, e.g. --name test01");
      }
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
        throw new Refusal("--port needs a port, e.g. --port 4748");
      }
    } else if (arg.startsWith("-")) {
      throw new Refusal(`Unknown option ${arg}. ${cyan("wizards bot --help")} lists them.`);
    } else if (!options.command) {
      options.command = arg;
    } else if (options.folder === null) {
      options.folder = arg;
    } else {
      throw new Refusal(`One folder at a time: ${options.folder} or ${arg}.`);
    }
  }
  return options;
}

const COMMANDS = { install, setup, status, stop, start, tunnel, update, uninstall };

/** `wizards bot …`; its exit code. */
export async function main(argv, env = process.env) {
  try {
    const options = parse(argv);
    if (!options.command || options.command === "help") {
      console.log(HELP);
      return 0;
    }
    const command = COMMANDS[options.command];
    if (!command) {
      throw new Refusal(
        `wizards bot has no command ${options.command}. ${cyan("wizards bot --help")} lists them.`,
      );
    }
    await command(layout(env, options.folder), options, env);
    return 0;
  } catch (error) {
    if (!(error instanceof Refusal)) {
      throw error;
    }
    console.error(`${red("■")}  ${error.message}`);
    return 1;
  }
}
