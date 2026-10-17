import { execFile, execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import { installedByScript, type Layout, packageRoot } from "./home.js";
import { findOnPath, macAppPresent } from "./machine.js";
import { bad, cmd, dim, ok, tilde } from "./ui.js";

const run = promisify(execFile);

/**
 * The wizards in the person's own AI apps: `wizards connect` writes this install's MCP
 * server into each app's config, as the command `wizards mcp` (stdio). Every app starts
 * servers that way; the command finds the running runtime itself and signs in with the data
 * folder's secret, so a config holds neither a port nor a key.
 */

/** The name the server has in every app's config. */
export const SERVER_NAME = "engenty-wizards";

export interface ServerCommand {
  command: string;
  args: string[];
  /** `ENGENTY_HOME` of an install that is not in `~/.engenty`: the app starts it there. */
  env?: Record<string, string>;
}

/**
 * How an app starts this install's MCP server. An install made by install.sh has a command that
 * stays where it is across updates; any other copy is started by its Node and its script. The
 * studio connects apps too: from the runtime, which is not the command.
 */
export function serverCommand(
  paths: Layout,
  script = join(packageRoot, "bin", "wizards.mjs"),
): ServerCommand {
  const moved = dirname(paths.home) !== join(homedir(), ".engenty");
  const env = moved ? { env: { ENGENTY_HOME: dirname(paths.home) } } : {};
  if (installedByScript(paths)) {
    return { command: join(paths.bin, "wizards"), args: ["mcp"], ...env };
  }
  return { command: process.execPath, args: [script, "mcp"], ...env };
}

// --- editing config files -----------------------------------------------------

type Json = Record<string, unknown>;

/** A JSON config with the server set under `at` (e.g. ["mcpServers"]); null when it is no JSON. */
export function withJsonServer(
  text: string | null,
  at: string[],
  entry: unknown,
  name = SERVER_NAME,
): string | null {
  let root: Json;
  try {
    root = text?.trim() ? (JSON.parse(text) as Json) : {};
  } catch {
    return null;
  }
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    return null;
  }
  let node = root;
  for (const key of at) {
    const next = node[key];
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      node[key] = {};
    }
    node = node[key] as Json;
  }
  node[name] = entry;
  return `${JSON.stringify(root, null, 2)}\n`;
}

/** The same config without the server; null when it is no JSON. */
export function withoutJsonServer(text: string, at: string[], name = SERVER_NAME): string | null {
  let root: Json;
  try {
    root = JSON.parse(text) as Json;
  } catch {
    return null;
  }
  let node: unknown = root;
  for (const key of at) {
    node = (node as Json | undefined)?.[key];
  }
  if (node && typeof node === "object") {
    delete (node as Json)[name];
  }
  return `${JSON.stringify(root, null, 2)}\n`;
}

export function jsonHasServer(text: string, at: string[], name = SERVER_NAME): boolean {
  try {
    let node: unknown = JSON.parse(text);
    for (const key of at) {
      node = (node as Json | undefined)?.[key];
    }
    return Boolean(node && typeof node === "object" && name in (node as Json));
  } catch {
    return false;
  }
}

const tomlString = (value: string) => JSON.stringify(value);

/** A TOML config (Codex) without the server's tables `[mcp_servers.<name>]` and below. */
export function withoutTomlServer(text: string, name = SERVER_NAME): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const table = line.match(/^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/)?.[1];
    if (table !== undefined) {
      const key = table.replaceAll('"', "");
      skipping = key === `mcp_servers.${name}` || key.startsWith(`mcp_servers.${name}.`);
    }
    if (!skipping) {
      out.push(line);
    }
  }
  return out.join("\n").replace(/\n{3,}$/, "\n\n");
}

export function withTomlServer(text: string | null, server: ServerCommand, name = SERVER_NAME) {
  const rest = withoutTomlServer(text ?? "", name).trimEnd();
  const table = [
    `[mcp_servers.${name}]`,
    `command = ${tomlString(server.command)}`,
    `args = [${server.args.map(tomlString).join(", ")}]`,
    // A run waits up to 45 s for a step; the default of 60 s leaves room for it.
    "tool_timeout_sec = 120",
    ...(server.env
      ? [
          `env = { ${Object.entries(server.env)
            .map(([key, value]) => `${key} = ${tomlString(value)}`)
            .join(", ")} }`,
        ]
      : []),
  ].join("\n");
  return `${rest ? `${rest}\n\n` : ""}${table}\n`;
}

export function tomlHasServer(text: string, name = SERVER_NAME): boolean {
  return text.split("\n").some((line) => line.trim() === `[mcp_servers.${name}]`);
}

/** Goose's YAML: the server's block below `extensions:`, at two spaces. */
export function withoutYamlExtension(text: string, name = SERVER_NAME): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (line === `  ${name}:`) {
      skipping = true;
      continue;
    }
    if (skipping && line.trim() && !line.startsWith("   ")) {
      skipping = false;
    }
    if (!skipping) {
      out.push(line);
    }
  }
  return out.join("\n");
}

export function withYamlExtension(text: string | null, server: ServerCommand, name = SERVER_NAME) {
  const quote = (value: string) => JSON.stringify(value);
  const block = [
    `  ${name}:`,
    `    name: ${name}`,
    "    type: stdio",
    `    cmd: ${quote(server.command)}`,
    `    args: [${server.args.map(quote).join(", ")}]`,
    "    enabled: true",
    "    timeout: 300",
    ...(server.env
      ? [
          "    envs:",
          ...Object.entries(server.env).map(([key, value]) => `      ${key}: ${quote(value)}`),
        ]
      : []),
  ];
  const lines = withoutYamlExtension(text ?? "", name).split("\n");
  const at = lines.findIndex((line) => /^extensions:\s*(\{\s*\})?\s*$/.test(line));
  if (at === -1) {
    const rest = lines.join("\n").trimEnd();
    return `${rest ? `${rest}\n` : ""}extensions:\n${block.join("\n")}\n`;
  }
  lines[at] = "extensions:";
  lines.splice(at + 1, 0, ...block);
  return lines.join("\n");
}

export function yamlHasExtension(text: string, name = SERVER_NAME): boolean {
  return text.split("\n").includes(`  ${name}:`);
}

// --- the apps -------------------------------------------------------------------

export type Outcome =
  | { ok: true; message: string }
  | { ok: false; message: string; snippet?: string };

export interface App {
  id: string;
  name: string;
  /** Shows a run as a widget (MCP Apps), not only as text. */
  widgets: boolean;
  /** Where the entry goes, for the person to see. */
  where: string;
  installed(): boolean;
  connected(): Promise<boolean>;
  connect(server: ServerCommand): Promise<Outcome>;
  disconnect(): Promise<Outcome>;
}

const home = homedir();
const appData = process.env.APPDATA || join(home, "AppData", "Roaming");

/** A folder below the per-user application data: Library/Application Support, %APPDATA%, ~/.config. */
function appSupport(...parts: string[]): string {
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", ...parts);
  }
  if (process.platform === "win32") {
    return join(appData, ...parts);
  }
  return join(process.env.XDG_CONFIG_HOME || join(home, ".config"), ...parts);
}

/** Claude Desktop's main process, as `ps` (macOS) or `tasklist` (Windows) names it. */
const CLAUDE_DESKTOP_PROCESS = {
  darwin: /\/Claude\.app\/Contents\/MacOS\/Claude$/m,
  win32: /^"?Claude\.exe"?,/im,
} as const;

/** Whether an app's process runs; false where it cannot be told (Linux, no `ps`). */
export function processRunning(
  names: Partial<Record<NodeJS.Platform, RegExp>>,
  platform: NodeJS.Platform = process.platform,
  list: () => string = () =>
    platform === "win32"
      ? execFileSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8" })
      : execFileSync("ps", ["-axo", "comm"], { encoding: "utf8" }),
): boolean {
  const pattern = names[platform];
  if (!pattern) {
    return false;
  }
  try {
    return pattern.test(list());
  } catch {
    return false;
  }
}

const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : null);

/** Writes a config, keeping the version before it once next to it. */
function save(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file)) {
    copyFileSync(file, `${file}.before-engenty`);
  }
  writeFileSync(file, text);
}

function jsonApp(def: {
  id: string;
  name: string;
  widgets: boolean;
  file: string;
  /** The folder whose presence says the app is on this machine. */
  marker: string;
  /**
   * On a Mac, the app's bundle name (`Windsurf` for Windsurf.app): the folder alone outlives an
   * uninstalled app, so the bundle must be there too.
   */
  macApp?: string;
  at: string[];
  entry: (server: ServerCommand) => unknown;
  /**
   * The app writes this file from memory while it runs: a change made meanwhile is lost. Then
   * nothing is written and the person is told to quit the app first.
   */
  ownsFileWhileRunning?: () => boolean;
}): App {
  const running = (): Outcome | null =>
    def.ownsFileWhileRunning?.()
      ? {
          ok: false,
          message: `${def.name} is running and would overwrite its settings. Quit it completely, then try again.`,
        }
      : null;
  const snippet = (server: ServerCommand) =>
    JSON.stringify(
      def.at.reduceRight<unknown>((inner, key) => ({ [key]: inner }), {
        [SERVER_NAME]: def.entry(server),
      }),
      null,
      2,
    );
  return {
    id: def.id,
    name: def.name,
    widgets: def.widgets,
    where: def.file,
    installed: () =>
      existsSync(def.marker) &&
      (process.platform !== "darwin" || !def.macApp || macAppPresent(def.macApp)),
    connected: async () => jsonHasServer(read(def.file) ?? "", def.at),
    async connect(server) {
      const busy = running();
      if (busy) {
        return busy;
      }
      const next = withJsonServer(read(def.file), def.at, def.entry(server));
      if (next === null) {
        return {
          ok: false,
          message: `${tilde(def.file)} isn’t plain JSON (comments?). Add this to it yourself:`,
          snippet: snippet(server),
        };
      }
      save(def.file, next);
      return { ok: true, message: `added to ${tilde(def.file)}` };
    },
    async disconnect() {
      const text = read(def.file);
      if (!text || !jsonHasServer(text, def.at)) {
        return { ok: true, message: "wasn’t connected" };
      }
      const busy = running();
      if (busy) {
        return busy;
      }
      const next = withoutJsonServer(text, def.at);
      if (next === null) {
        return {
          ok: false,
          message: `${tilde(def.file)} isn’t plain JSON. Remove “${SERVER_NAME}” from it yourself.`,
        };
      }
      save(def.file, next);
      return { ok: true, message: `removed from ${tilde(def.file)}` };
    },
  };
}

const stdioEntry = (server: ServerCommand) => ({
  command: server.command,
  args: server.args,
  ...(server.env ? { env: server.env } : {}),
});

/** A command of an app: on the PATH, or among the clients this install brought. */
function appCommand(paths: Layout, name: string): string | null {
  return findOnPath(name, [join(paths.clients, "bin"), process.env.PATH ?? ""].join(delimiter));
}

function claudeCode(paths: Layout): App {
  const file = join(home, ".claude.json");
  return {
    id: "claude-code",
    name: "Claude Code",
    widgets: false,
    where: "claude mcp (user scope)",
    installed: () => Boolean(appCommand(paths, "claude")),
    connected: async () => jsonHasServer(read(file) ?? "", ["mcpServers"]),
    async connect(server) {
      const claude = appCommand(paths, "claude");
      if (!claude) {
        return { ok: false, message: "The claude command wasn’t found." };
      }
      // Claude Code keeps rewriting its own file: its command changes it, not we.
      await run(claude, ["mcp", "remove", "--scope", "user", SERVER_NAME]).catch(() => undefined);
      try {
        await run(claude, [
          "mcp",
          "add",
          "--scope",
          "user",
          // The name before `-e`: claude's `-e` takes every value up to the next option, so a
          // name after it is read as one more variable.
          SERVER_NAME,
          ...Object.entries(server.env ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
          "--",
          server.command,
          ...server.args,
        ]);
        return { ok: true, message: "added with claude mcp add --scope user" };
      } catch (error) {
        // claude's own words say what was wrong; "Command failed: …" only repeats the command.
        const said = String((error as { stderr?: unknown }).stderr ?? "").trim();
        return { ok: false, message: (said || (error as Error).message).split("\n")[0] };
      }
    },
    async disconnect() {
      const claude = appCommand(paths, "claude");
      if (!claude) {
        return { ok: true, message: "wasn’t connected" };
      }
      await run(claude, ["mcp", "remove", "--scope", "user", SERVER_NAME]).catch(() => undefined);
      return { ok: true, message: "removed with claude mcp remove" };
    },
  };
}

function codex(): App {
  const dir = process.env.CODEX_HOME || join(home, ".codex");
  const file = join(dir, "config.toml");
  return {
    id: "codex",
    name: "Codex · ChatGPT app",
    widgets: false,
    where: file,
    installed: () => existsSync(dir),
    connected: async () => tomlHasServer(read(file) ?? ""),
    async connect(server) {
      save(file, withTomlServer(read(file), server));
      return { ok: true, message: `added to ${tilde(file)}` };
    },
    async disconnect() {
      const text = read(file);
      if (!text || !tomlHasServer(text)) {
        return { ok: true, message: "wasn’t connected" };
      }
      save(file, withoutTomlServer(text));
      return { ok: true, message: `removed from ${tilde(file)}` };
    },
  };
}

function goose(): App {
  const dir =
    process.platform === "win32"
      ? join(appData, "Block", "goose", "config")
      : join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "goose");
  const file = join(dir, "config.yaml");
  return {
    id: "goose",
    name: "Goose",
    widgets: true,
    where: file,
    installed: () => existsSync(dir),
    connected: async () => yamlHasExtension(read(file) ?? ""),
    async connect(server) {
      save(file, withYamlExtension(read(file), server));
      return { ok: true, message: `added to ${tilde(file)}` };
    },
    async disconnect() {
      const text = read(file);
      if (!text || !yamlHasExtension(text)) {
        return { ok: true, message: "wasn’t connected" };
      }
      save(file, withoutYamlExtension(text));
      return { ok: true, message: `removed from ${tilde(file)}` };
    },
  };
}

function openClaw(paths: Layout): App {
  const dir = join(home, ".openclaw");
  const file = join(dir, "openclaw.json");
  const json = jsonApp({
    id: "openclaw",
    name: "OpenClaw",
    widgets: false,
    file,
    marker: dir,
    at: ["mcp", "servers"],
    entry: stdioEntry,
  });
  return {
    ...json,
    // Its config is JSON5: its own command writes it when it is there.
    async connect(server) {
      const openclaw = appCommand(paths, "openclaw");
      if (!openclaw) {
        return json.connect(server);
      }
      try {
        await run(openclaw, [
          "mcp",
          "set",
          SERVER_NAME,
          "--command",
          server.command,
          "--args",
          ...server.args,
        ]);
        return { ok: true, message: "added with openclaw mcp set" };
      } catch (error) {
        return { ok: false, message: (error as Error).message.split("\n")[0] };
      }
    },
    async disconnect() {
      const openclaw = appCommand(paths, "openclaw");
      if (!openclaw) {
        return json.disconnect();
      }
      await run(openclaw, ["mcp", "unset", SERVER_NAME]).catch(() => undefined);
      return { ok: true, message: "removed with openclaw mcp unset" };
    },
  };
}

/** The AI apps this install can connect to, in the order they are offered. */
export function apps(paths: Layout): App[] {
  const vscodeUser = appSupport("Code", "User");
  return [
    jsonApp({
      id: "claude-desktop",
      name: "Claude Desktop",
      widgets: true,
      file: join(appSupport("Claude"), "claude_desktop_config.json"),
      marker: appSupport("Claude"),
      macApp: "Claude",
      at: ["mcpServers"],
      entry: stdioEntry,
      ownsFileWhileRunning: () => processRunning(CLAUDE_DESKTOP_PROCESS),
    }),
    claudeCode(paths),
    codex(),
    jsonApp({
      id: "cursor",
      name: "Cursor",
      widgets: true,
      file: join(home, ".cursor", "mcp.json"),
      marker: join(home, ".cursor"),
      at: ["mcpServers"],
      entry: stdioEntry,
    }),
    jsonApp({
      id: "vscode",
      name: "VS Code (Copilot)",
      widgets: true,
      file: join(vscodeUser, "mcp.json"),
      marker: vscodeUser,
      macApp: "Visual Studio Code",
      at: ["servers"],
      entry: (server) => ({ type: "stdio", ...stdioEntry(server) }),
    }),
    jsonApp({
      id: "windsurf",
      name: "Windsurf",
      widgets: false,
      file: join(home, ".codeium", "windsurf", "mcp_config.json"),
      marker: join(home, ".codeium", "windsurf"),
      macApp: "Windsurf",
      at: ["mcpServers"],
      entry: stdioEntry,
    }),
    jsonApp({
      id: "antigravity",
      name: "Antigravity",
      widgets: false,
      // The app and its CLI (agy) read the same file.
      file: join(home, ".gemini", "config", "mcp_config.json"),
      marker: join(home, ".gemini", "config"),
      at: ["mcpServers"],
      entry: stdioEntry,
    }),
    goose(),
    openClaw(paths),
    jsonApp({
      id: "lm-studio",
      name: "LM Studio",
      widgets: false,
      file: join(home, ".lmstudio", "mcp.json"),
      marker: join(home, ".lmstudio"),
      at: ["mcpServers"],
      entry: stdioEntry,
    }),
  ];
}

export interface AppState {
  id: string;
  name: string;
  widgets: boolean;
  where: string;
  installed: boolean;
  connected: boolean;
}

export async function appStates(paths: Layout): Promise<AppState[]> {
  return Promise.all(
    apps(paths).map(async (app) => ({
      id: app.id,
      name: app.name,
      widgets: app.widgets,
      where: app.where,
      installed: app.installed(),
      connected: await app.connected(),
    })),
  );
}

/** `wizards connect [app …]` and `disconnect`: what was done, app by app. */
export async function connectCommand(paths: Layout, ids: string[], remove: boolean) {
  const unknown = ids.filter((id) => !apps(paths).some((app) => app.id === id));
  if (unknown.length) {
    console.error(
      `Unknown app ${unknown.map((id) => `“${id}”`).join(", ")}. Choose from: ${apps(paths)
        .map((app) => app.id)
        .join(", ")}.`,
    );
    return 2;
  }
  const results = await connectApps(paths, ids, remove);
  if (!results.length) {
    console.log(`No AI app found on this computer. Name one: ${cmd("connect cursor")}`);
    return 0;
  }
  for (const { app, outcome } of results) {
    console.log(`${outcome.ok ? ok : bad} ${app.name.padEnd(22)} ${dim(outcome.message)}`);
    if (!outcome.ok && outcome.snippet) {
      console.log(outcome.snippet);
    }
  }
  if (!remove && results.some((r) => r.outcome.ok)) {
    console.log("");
    console.log(dim("Restart the app (or reload its MCP servers) to see the wizards in it."));
    console.log(
      dim("Claude Desktop, Cursor, VS Code and Goose show a run as a widget, the others as text."),
    );
  }
  return results.every((r) => r.outcome.ok) ? 0 : 1;
}

/** Connects (or disconnects) the named apps; without names every app found on this machine. */
export async function connectApps(
  paths: Layout,
  ids: string[],
  remove = false,
): Promise<{ app: App; outcome: Outcome }[]> {
  const all = apps(paths);
  const picked = ids.length
    ? all.filter((app) => ids.includes(app.id))
    : all.filter((app) => app.installed());
  const server = serverCommand(paths);
  const out: { app: App; outcome: Outcome }[] = [];
  for (const app of picked) {
    const outcome = await (remove ? app.disconnect() : app.connect(server)).catch(
      (error: Error): Outcome => ({ ok: false, message: error.message }),
    );
    out.push({ app, outcome });
  }
  return out;
}
