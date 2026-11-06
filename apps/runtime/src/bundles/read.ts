import type {
  BundleChoice,
  BundleFormat,
  BundleLeftOut,
  BundleLeftOutReason,
} from "@engenty/wizards-shared/bundles";
import { SKILL_LIMITS, SKILL_NAME, skillNameOf } from "@engenty/wizards-shared/skills";
import { unzipSync } from "fflate";
import { ServiceError } from "../services/errors.js";
import { asText, checkContent, contentOf, type SkillIntake } from "../services/skills.js";
import type { ServerKey } from "../texts.js";

/**
 * Reads a plugin for Claude Code or Cursor out of a zip (docs/plans/capabilities-next.md, piece
 * 4): a repository's archive or an uploaded file. Nothing here asks the network or the database.
 *
 * The formats, as their own docs describe them (code.claude.com/docs/en/plugins-reference,
 * cursor.com/docs/reference/plugins, November 2026):
 *
 * - Claude Code: `.claude-plugin/plugin.json` (optional; `name` where it is there), MCP servers in
 *   `.mcp.json` and in the manifest's `mcpServers` (a path, a map, or a list of either; a later
 *   name replaces an earlier one), skills in `skills/<name>/SKILL.md` plus the folders the
 *   manifest's `skills` names.
 * - Cursor: `.cursor-plugin/plugin.json`, MCP servers in `mcp.json` unless the manifest's
 *   `mcpServers` says otherwise, skills in `skills/` unless the manifest's `skills` says otherwise.
 *   Cursor also reads a `plugin.json` at the root (the open Agent Plugin format).
 * - Both: a repository of several plugins lists them in `marketplace.json` beside the manifest;
 *   a `SKILL.md` at the root of a plugin without `skills/` is its one skill.
 *
 * Taken are servers over http (streamable HTTP, SSE) and skills. Everything else is named as
 * left out: commands, agents, hooks, rules, servers started on the command line.
 */

const refuse = (server: ServerKey, params?: Record<string, string | number>) =>
  new ServiceError("invalid", { server, params });

/** Never listed: an archive with more files than this. */
const MAX_NAMES = 50_000;
/** A manifest, an MCP file, a hooks file: none is larger. */
const CONFIG_BYTES = 1_000_000;
/** As an uploaded skill: the files of one skill's folder that are looked at. */
const SKILL_ENTRIES = 500;
/** What one plugin may bring. */
export const BUNDLE_LIMITS = { servers: 20, skills: 60, leftOut: 200, headers: 10 } as const;

/** What tells a plugin's root: a zip with these at its top is not unwrapped. */
const ROOT_SIGN =
  /^(\.claude-plugin\/|\.cursor-plugin\/|plugin\.json$|\.mcp\.json$|mcp\.json$|skills\/|SKILL\.md$)/;

/**
 * A zip's files by path, read on request. The one folder around everything (a repository's
 * archive has one, a zipped folder too) is taken off. Paths that leave the archive and the Mac's
 * resource forks are not there.
 */
export class Archive {
  /** Every file's path and its size unpacked. */
  readonly files = new Map<string, number>();
  private readonly prefix: string;
  private readonly cache = new Map<string, Uint8Array>();

  constructor(private readonly data: Uint8Array) {
    const names: [string, number][] = [];
    let seen = 0;
    try {
      unzipSync(data, {
        filter: (f) => {
          seen++;
          if (seen <= MAX_NAMES && !f.name.endsWith("/")) {
            names.push([f.name, f.originalSize]);
          }
          return false;
        },
      });
    } catch {
      throw refuse("bundleUploadKind");
    }
    if (seen > MAX_NAMES) {
      throw refuse("bundleTooLarge", { mb: MAX_ARCHIVE_MB });
    }
    const kept = names.filter(([name]) => {
      const parts = name.split("/");
      return !(
        name.startsWith("/") ||
        name.includes("\\") ||
        parts.includes("..") ||
        parts.includes("__MACOSX")
      );
    });
    const tops = new Set(kept.map(([name]) => name.split("/")[0]));
    const wrapped =
      tops.size === 1 &&
      kept.every(([name]) => name.includes("/")) &&
      !kept.some(([name]) => ROOT_SIGN.test(name));
    this.prefix = wrapped ? `${[...tops][0]}/` : "";
    for (const [name, size] of kept) {
      this.files.set(name.slice(this.prefix.length), size);
    }
  }

  has(path: string): boolean {
    return this.files.has(path);
  }

  /** The files in a folder and below, by their path in the archive. `""` is the archive itself. */
  under(dir: string): string[] {
    return [...this.files.keys()].filter((path) => path.startsWith(dir));
  }

  /** Unpacks files in one pass; one that is larger than `maxBytes` stays out. */
  load(paths: Iterable<string>, maxBytes: number): void {
    const want = new Set<string>();
    for (const path of paths) {
      const size = this.files.get(path);
      if (size !== undefined && size <= maxBytes && !this.cache.has(path)) {
        want.add(`${this.prefix}${path}`);
      }
    }
    if (!want.size) {
      return;
    }
    let found: Record<string, Uint8Array>;
    try {
      found = unzipSync(this.data, {
        filter: (f) => want.has(f.name) && f.originalSize <= maxBytes,
      });
    } catch {
      throw refuse("bundleUploadKind");
    }
    for (const [name, bytes] of Object.entries(found)) {
      this.cache.set(name.slice(this.prefix.length), bytes);
    }
  }

  bytes(path: string, maxBytes: number): Uint8Array | null {
    this.load([path], maxBytes);
    return this.cache.get(path) ?? null;
  }

  /** A small file as an object of JSON; null where it is not there, refused where it is no JSON. */
  json(path: string): Record<string, unknown> | null {
    if (!this.has(path)) {
      return null;
    }
    const bytes = this.bytes(path, CONFIG_BYTES);
    const text = bytes ? asText(bytes) : null;
    try {
      const value = text === null ? null : (JSON.parse(text) as unknown);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch {
      // Said below.
    }
    throw refuse("bundleManifestUnreadable", { file: path });
  }
}

/** The megabytes a repository's archive or an uploaded zip may weigh. */
export const MAX_ARCHIVE_MB = 60;

// --- what a plugin is made of -----------------------------------------------------------------

/** An MCP server over http, as the plugin names it. */
export interface PluginServer {
  key: string;
  url: string;
  transport: "http" | "sse";
  /** Headers with a fixed value: sent with every request. */
  headers: { name: string; value: string }[];
  /** A header whose value is a key the person gives: the sign-in the plugin asks for. */
  keyHeader: { name: string; scheme?: string } | null;
}

export interface PluginSkill {
  /** Its folder in the plugin: `skills/call-prep`; `.` for a plugin that is one skill. */
  path: string;
  intake: SkillIntake;
}

export interface ReadPlugin {
  format: BundleFormat;
  name: string;
  version: string | null;
  description: string | null;
  /** Its folder in the archive: `""`, or `customer-support/`. */
  root: string;
  servers: PluginServer[];
  skills: PluginSkill[];
  leftOut: BundleLeftOut[];
}

export type PluginRead = { plugin: ReadPlugin } | { choices: BundleChoice[] };

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

/** A path of a manifest as a folder or file below the plugin's root; null where it leaves it. */
function inside(path: string): string | null {
  const parts = path
    .trim()
    .replace(/^\.\//, "")
    .split("/")
    .filter((p) => p && p !== ".");
  return parts.includes("..") || path.startsWith("/") || path.includes("\\")
    ? null
    : parts.join("/");
}

/** A folder as a prefix: `""` for the root, `a/b/` else. */
const asDir = (path: string) => (path ? `${path.replace(/\/+$/, "")}/` : "");

interface Manifest {
  format: BundleFormat;
  data: Record<string, unknown>;
}

interface Marketplace {
  format: "claude" | "cursor";
  pluginRoot: string;
  plugins: Record<string, unknown>[];
}

function marketplaceAt(archive: Archive, dir: string): Marketplace | null {
  for (const format of ["claude", "cursor"] as const) {
    const data = archive.json(`${dir}.${format}-plugin/marketplace.json`);
    if (data) {
      const metadata = isObject(data.metadata) ? data.metadata : {};
      return {
        format,
        pluginRoot: inside(text(metadata.pluginRoot) ?? "") ?? "",
        plugins: list(data.plugins).filter(isObject),
      };
    }
  }
  return null;
}

/** `owner/name` out of a repository's address on GitHub, or of the short form itself. */
function repoOf(value: string): string | null {
  const m =
    /^(?:https?:\/\/(?:www\.)?github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(
      value.trim(),
    );
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Where a marketplace's entry lives: a folder of this archive, or another repository on GitHub. */
function entryPlace(
  market: Marketplace,
  dir: string,
  entry: Record<string, unknown>,
): { path: string } | { address: string } | null {
  const source = entry.source;
  if (typeof source === "string") {
    const bare = !source.includes("/");
    const path = inside(source);
    if (path === null) {
      return null;
    }
    // Cursor puts every source below `pluginRoot`, Claude Code only a bare name.
    const below = market.pluginRoot && (market.format === "cursor" || bare);
    return { path: `${dir}${below ? `${market.pluginRoot}/` : ""}${path}` };
  }
  if (!isObject(source)) {
    return null;
  }
  const ref = text(source.ref);
  if (source.source === "github") {
    const repo = repoOf(text(source.repo) ?? "");
    return repo ? { address: `https://github.com/${repo}${ref ? `/tree/${ref}` : ""}` } : null;
  }
  if (source.source === "git-subdir" || source.source === "url") {
    const repo = repoOf(text(source.url) ?? "");
    const path = inside(text(source.path) ?? "");
    if (!repo || path === null) {
      return null;
    }
    const tail = path ? `/tree/${ref ?? "HEAD"}/${path}` : ref ? `/tree/${ref}` : "";
    return { address: `https://github.com/${repo}${tail}` };
  }
  const path = inside(text(source.path) ?? "");
  return path ? { path: `${dir}${path}` } : null;
}

function manifestAt(archive: Archive, root: string): Manifest | null {
  const claude = archive.json(`${root}.claude-plugin/plugin.json`);
  if (claude) {
    return { format: "claude", data: claude };
  }
  const cursor = archive.json(`${root}.cursor-plugin/plugin.json`);
  if (cursor) {
    return { format: "cursor", data: cursor };
  }
  if (archive.has(`${root}plugin.json`)) {
    const open = archive.json(`${root}plugin.json`);
    if (open && text(open.name)) {
      return { format: "agent", data: open };
    }
  }
  return null;
}

/** Whether a folder holds what a plugin without a manifest is made of. */
const looksLikePlugin = (archive: Archive, root: string) =>
  archive.has(`${root}.mcp.json`) ||
  archive.has(`${root}mcp.json`) ||
  archive.has(`${root}SKILL.md`) ||
  archive.under(`${root}skills/`).some((path) => path.endsWith("/SKILL.md"));

// --- MCP servers ------------------------------------------------------------------------------

/** `${NAME:-default}` as its default; a value nobody gave stays as it is written. */
const withDefaults = (value: string) => value.replace(/\$\{[^}:]+:-([^}]*)\}/g, "$1");

const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
/** Headers a plugin never sets: the request's own, and the MCP session's. */
const OWN_HEADERS = new Set([
  "host",
  "content-length",
  "content-type",
  "connection",
  "transfer-encoding",
  "accept",
  "cookie",
  "mcp-session-id",
  "mcp-protocol-version",
]);

function headersOf(entry: Record<string, unknown>): Pick<PluginServer, "headers" | "keyHeader"> {
  const headers: PluginServer["headers"] = [];
  let keyHeader: PluginServer["keyHeader"] = null;
  for (const [name, raw] of Object.entries(isObject(entry.headers) ? entry.headers : {})) {
    if (typeof raw !== "string" || !HEADER_NAME.test(name) || OWN_HEADERS.has(name.toLowerCase())) {
      continue;
    }
    const value = withDefaults(raw);
    if (!value.includes("${")) {
      if (
        headers.length < BUNDLE_LIMITS.headers &&
        value.length <= 500 &&
        /^[^\r\n]+$/.test(value)
      ) {
        headers.push({ name, value });
      }
      continue;
    }
    // `Bearer ${TOKEN}` or `${TOKEN}`: a key the person gives, in this header.
    const key = /^(?:([A-Za-z][A-Za-z0-9-]{0,19}) )?\$\{[^}]+\}$/.exec(value.trim());
    if (key && !keyHeader) {
      keyHeader = { name, ...(key[1] ? { scheme: key[1] } : {}) };
    }
  }
  return { headers, keyHeader };
}

/** One entry of an MCP file: a server over http, or why it stays out. */
function serverOf(key: string, entry: Record<string, unknown>): PluginServer | BundleLeftOutReason {
  const type = (text(entry.type) ?? "").toLowerCase();
  if (entry.command !== undefined || type === "stdio" || type === "sdk") {
    return "stdio";
  }
  const url = withDefaults(text(entry.url) ?? text(entry.serverUrl) ?? "");
  if (type === "ws" || type === "websocket" || /^wss?:/i.test(url)) {
    return "socket";
  }
  if (!url) {
    return "noAddress";
  }
  if (url.includes("${")) {
    return "variable";
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "address";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "address";
  }
  return { key, url, transport: type === "sse" ? "sse" : "http", ...headersOf(entry) };
}

/** The servers of an MCP file: below `mcpServers`, or the file itself as the map. */
function serverMap(data: Record<string, unknown>): Record<string, unknown> {
  return isObject(data.mcpServers) ? data.mcpServers : data;
}

function readServers(
  archive: Archive,
  root: string,
  manifest: Manifest,
): { servers: PluginServer[]; leftOut: BundleLeftOut[] } {
  const found = new Map<string, PluginServer | BundleLeftOutReason>();
  const add = (map: Record<string, unknown>) => {
    for (const [key, entry] of Object.entries(map)) {
      if (isObject(entry) && key.length <= 100) {
        found.set(key, serverOf(key, entry));
      }
    }
  };
  const addFile = (path: string) => {
    const data = archive.json(`${root}${path}`);
    if (data) {
      add(serverMap(data));
    }
  };
  const declared = manifest.data.mcpServers;
  // Claude Code reads its file first and then what the manifest names; Cursor's manifest
  // replaces its file. Where a format's own file is missing, the other format's is read.
  if (manifest.format === "claude" || declared === undefined) {
    const [own, other] =
      manifest.format === "claude" ? [".mcp.json", "mcp.json"] : ["mcp.json", ".mcp.json"];
    addFile(archive.has(`${root}${own}`) ? own : other);
  }
  for (const shape of list(declared)) {
    if (isObject(shape)) {
      add(serverMap(shape));
    } else if (typeof shape === "string") {
      const path = inside(shape);
      if (/^https?:/i.test(shape) || /\.(mcpb|dxt)$/i.test(shape) || path === null) {
        found.set(shape.split("/").pop() ?? shape, "file");
      } else {
        addFile(path);
      }
    }
  }
  const servers: PluginServer[] = [];
  const leftOut: BundleLeftOut[] = [];
  for (const [key, server] of found) {
    if (typeof server === "string") {
      leftOut.push({ kind: "server", name: key, reason: server });
    } else if (servers.length >= BUNDLE_LIMITS.servers) {
      leftOut.push({ kind: "server", name: key, reason: "count" });
    } else {
      servers.push(server);
    }
  }
  return { servers, leftOut };
}

// --- skills -----------------------------------------------------------------------------------

/** The folders that hold a `SKILL.md`, in a skills folder and up to three folders below it. */
function skillDirs(archive: Archive, dir: string): string[] {
  if (archive.has(`${dir}SKILL.md`)) {
    return [dir];
  }
  const dirs = archive
    .under(dir)
    .filter((path) => path.endsWith("/SKILL.md"))
    .map((path) => path.slice(0, -"SKILL.md".length))
    .filter((skill) => skill.slice(dir.length).split("/").length <= 4)
    .sort();
  // A skill's folder is its own: a `SKILL.md` deeper inside it is one of its files.
  return dirs.filter((skill) => !dirs.some((other) => other !== skill && skill.startsWith(other)));
}

function readSkills(
  archive: Archive,
  root: string,
  manifest: Manifest,
  say: (err: unknown) => string,
): { skills: PluginSkill[]; leftOut: BundleLeftOut[] } {
  const declared = list(manifest.data.skills)
    .filter((p): p is string => typeof p === "string")
    .map(inside)
    .filter((p): p is string => p !== null)
    .map((p) => `${root}${asDir(p)}`);
  const standard = `${root}skills/`;
  const hasStandard = archive.under(standard).length > 0;
  // Claude Code adds the manifest's folders to `skills/`; for Cursor they stand in its place.
  const folders =
    manifest.format === "claude" || !declared.length ? [standard, ...declared] : declared;
  const dirs = new Set(folders.flatMap((folder) => skillDirs(archive, folder)));
  if (!(hasStandard || declared.length) && archive.has(`${root}SKILL.md`)) {
    dirs.add(root);
  }
  const visible = (path: string) => !path.split("/").some((part) => part.startsWith("."));
  const taken = [...dirs].sort().slice(0, BUNDLE_LIMITS.skills);
  const filesOf = new Map(
    taken.map((dir) => [
      dir,
      archive
        .under(dir)
        .filter((path) => visible(path.slice(dir.length)))
        .filter((path) => (archive.files.get(path) ?? 0) <= SKILL_LIMITS.blobFile)
        .slice(0, SKILL_ENTRIES),
    ]),
  );
  archive.load([...filesOf.values()].flat(), SKILL_LIMITS.blobFile);
  const skills: PluginSkill[] = [];
  const leftOut: BundleLeftOut[] = [...dirs]
    .sort()
    .slice(BUNDLE_LIMITS.skills)
    .map((dir) => ({ kind: "skill", name: dir.slice(root.length, -1) || ".", reason: "count" }));
  const names = new Set<string>();
  for (const dir of taken) {
    const path = dir.slice(root.length, -1) || ".";
    try {
      const intake = contentOf(
        (filesOf.get(dir) ?? []).map((file) => {
          const data = archive.bytes(file, SKILL_LIMITS.blobFile);
          return { path: file.slice(dir.length), text: data ? asText(data) : null, data };
        }),
      );
      // A name the format does not allow is made into one: from the name, else from the folder.
      const name = SKILL_NAME.test(intake.content.name)
        ? intake.content.name
        : skillNameOf(intake.content.name) || skillNameOf(path.split("/").pop() ?? "");
      const content = checkContent({ ...intake.content, name });
      if (names.has(content.name)) {
        throw refuse("skillNameTaken", { name: content.name });
      }
      names.add(content.name);
      skills.push({ path, intake: { ...intake, content } });
    } catch (err) {
      if (!(err instanceof ServiceError)) {
        throw err;
      }
      leftOut.push({ kind: "skill", name: path, reason: "invalid", detail: say(err) });
    }
  }
  return { skills, leftOut };
}

// --- what is not taken --------------------------------------------------------------------------

/** The Markdown files of a manifest's entry, or of the standard folder: by name, without ending. */
function namedFiles(
  archive: Archive,
  root: string,
  declared: unknown,
  standard: string,
  ending: RegExp,
): string[] {
  if (isObject(declared)) {
    return Object.keys(declared);
  }
  const paths =
    declared === undefined
      ? [standard]
      : list(declared)
          .filter((p): p is string => typeof p === "string")
          .map(inside)
          .filter((p): p is string => p !== null);
  const names: string[] = [];
  for (const path of paths) {
    const files = archive.has(`${root}${path}`)
      ? [`${root}${path}`]
      : archive.under(`${root}${asDir(path)}`);
    for (const file of files) {
      if (ending.test(file)) {
        const name = file.slice(root.length).replace(ending, "");
        names.push(name.startsWith(standard) ? name.slice(standard.length) : name);
      }
    }
  }
  return [...new Set(names)].sort();
}

/** The events a plugin's hooks listen to; `hooks` where the file names none. */
function hookNames(archive: Archive, root: string, declared: unknown): string[] {
  const events = new Set<string>();
  const add = (data: Record<string, unknown> | null) => {
    for (const event of Object.keys(isObject(data?.hooks) ? data.hooks : (data ?? {}))) {
      events.add(event);
    }
  };
  let any = false;
  const file = (path: string) => {
    if (archive.has(`${root}${path}`)) {
      any = true;
      try {
        add(archive.json(`${root}${path}`));
      } catch {
        // A hooks file nobody can read is still a hooks file the space does not take.
      }
    }
  };
  file("hooks/hooks.json");
  for (const shape of list(declared)) {
    if (isObject(shape)) {
      any = true;
      add(shape);
    } else if (typeof shape === "string") {
      const path = inside(shape);
      if (path) {
        file(path);
      }
    }
  }
  return events.size ? [...events].sort() : any ? ["hooks"] : [];
}

function readLeftOut(archive: Archive, root: string, manifest: Manifest): BundleLeftOut[] {
  const md = manifest.format === "claude" ? /\.md$/i : /\.(md|mdc|markdown|txt)$/i;
  const { data } = manifest;
  const out: BundleLeftOut[] = [
    ...namedFiles(archive, root, data.commands, "commands/", md).map(
      (name): BundleLeftOut => ({ kind: "command", name }),
    ),
    ...namedFiles(archive, root, data.agents, "agents/", /\.(md|mdc|markdown)$/i).map(
      (name): BundleLeftOut => ({ kind: "agent", name }),
    ),
    ...hookNames(archive, root, data.hooks).map((name): BundleLeftOut => ({ kind: "hook", name })),
    ...(manifest.format === "claude"
      ? []
      : namedFiles(archive, root, data.rules, "rules/", /\.(md|mdc|markdown)$/i).map(
          (name): BundleLeftOut => ({ kind: "rule", name }),
        )),
  ];
  const others: [string, boolean][] = [
    ["lsp", archive.has(`${root}.lsp.json`) || data.lspServers !== undefined],
    ["bin", archive.under(`${root}bin/`).length > 0],
    ["output-styles", archive.under(`${root}output-styles/`).length > 0],
    ["workflows", archive.under(`${root}workflows/`).length > 0],
    ["monitors", archive.under(`${root}monitors/`).length > 0],
    ["themes", archive.under(`${root}themes/`).length > 0],
  ];
  for (const [name, there] of others) {
    if (there) {
      out.push({ kind: "other", name });
    }
  }
  return out;
}

// --- the plugin -------------------------------------------------------------------------------

/**
 * The plugin in an archive: at its root or in `path`. A repository of several plugins answers
 * with the list to choose from, unless it lists exactly one that lives in it. `say` puts a
 * refusal into the reader's words, for a skill that is left out.
 */
export function readPlugin(
  archive: Archive,
  options: { path?: string; fallbackName: string; say: (err: unknown) => string },
): PluginRead {
  const asked = inside(options.path ?? "");
  if (asked === null) {
    throw refuse("bundleNoFolder", { path: options.path ?? "" });
  }
  let root = asDir(asked);
  if (root && !archive.under(root).length) {
    throw refuse("bundleNoFolder", { path: asked });
  }
  let manifest = manifestAt(archive, root);
  // The folder of one plugin in a repository of several: its entry there stands for a manifest.
  let entry: Record<string, unknown> | null = null;
  let entryFormat: "claude" | "cursor" = "claude";
  if (!manifest) {
    const market = marketplaceAt(archive, root);
    if (market) {
      const places = market.plugins.map((plugin) => ({
        plugin,
        place: entryPlace(market, root, plugin),
      }));
      const here = places.filter((p) => p.place && "path" in p.place);
      if (places.length === 1 && here.length === 1) {
        const only = here[0];
        root = asDir((only.place as { path: string }).path);
        entry = only.plugin;
        entryFormat = market.format;
        manifest = manifestAt(archive, root);
      } else {
        return {
          choices: places
            .filter((p) => p.place)
            .map(({ plugin, place }) => ({
              name: text(plugin.displayName) ?? text(plugin.name) ?? "",
              description: text(plugin.description)?.slice(0, 400) ?? null,
              path: place && "path" in place ? place.path : null,
              address: place && "address" in place ? place.address : null,
            }))
            .filter((choice) => choice.name)
            .slice(0, 200),
        };
      }
    } else if (root) {
      const above = marketplaceAt(archive, "");
      const listed = above?.plugins.find((plugin) => {
        const place = entryPlace(above, "", plugin);
        return place && "path" in place && asDir(place.path) === root;
      });
      if (above && listed) {
        entry = listed;
        entryFormat = above.format;
      }
    }
  }
  if (!manifest) {
    if (!(entry || looksLikePlugin(archive, root))) {
      throw refuse("bundleNoPlugin");
    }
    manifest = { format: entryFormat, data: entry ?? {} };
  }
  const { data } = manifest;
  const servers = readServers(archive, root, manifest);
  const skills = readSkills(archive, root, manifest, options.say);
  const version = data.version ?? entry?.version;
  return {
    plugin: {
      format: manifest.format,
      name: (
        text(data.displayName) ??
        text(data.name) ??
        text(entry?.name) ??
        (root ? root.slice(0, -1).split("/").pop() : null) ??
        options.fallbackName
      ).slice(0, 120),
      version:
        typeof version === "string" || typeof version === "number"
          ? String(version).slice(0, 60)
          : null,
      description: (text(data.description) ?? text(entry?.description))?.slice(0, 1000) ?? null,
      root,
      servers: servers.servers,
      skills: skills.skills,
      leftOut: [
        ...servers.leftOut,
        ...skills.leftOut,
        ...readLeftOut(archive, root, manifest),
      ].slice(0, BUNDLE_LIMITS.leftOut),
    },
  };
}
