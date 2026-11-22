import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";
import { z } from "zod";
import { MANIFEST_FILE, PLUGIN_ID, type PluginManifest, pluginManifestSchema } from "./manifest.js";

/*
 * Finding plugins. A folder of plugins holds, in any mix:
 *
 *   notify.ts                    one file: the server half, its id is the file's name
 *   contacts/engenty.plugin.json a folder with a manifest
 *   hello/index.ts               a folder without one: the server half, its id is the folder's name
 *   node_modules/<package>       packages installed there that carry a manifest
 *
 * Names that begin with `.` or `_` are skipped. `.mjs` is left out: Node keeps such a file once
 * it is imported, so a host could not load it again.
 */

export interface PluginSource {
  id: string;
  manifest: PluginManifest;
  /** The plugin's folder; for a plugin of one file, the folder the file is in. */
  root: string;
  /** The server half. Null: the plugin brings no code, only skills or a studio half. */
  entry: string | null;
  /** The plugin is this one file. */
  single: boolean;
}

export interface PluginProblem {
  path: string;
  message: string;
}

export interface DiscoverOptions {
  /** The host's own manifest schema, a superset of `pluginManifestSchema`. */
  manifest?: z.ZodType<PluginManifest>;
  /** Where the server half is looked for when the manifest names none. */
  serverEntries?: string[];
}

const CODE = new Set([".ts", ".js"]);
const SERVER_ENTRIES = ["src/plugin.ts", "src/plugin.js", "dist/plugin.js"];
const INDEX_ENTRIES = ["index.ts", "index.js"];

const isDir = (path: string) => statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
const firstExisting = (root: string, names: string[]) =>
  names.map((name) => join(root, name)).find((path) => existsSync(path)) ?? null;

/** A path of the manifest, kept inside the plugin's folder: null when it leaves it or is missing. */
export function insidePlugin(root: string, relative: string): string | null {
  const path = resolve(root, relative);
  return path.startsWith(root + sep) && existsSync(path) ? path : null;
}

/** Reads and checks a folder's manifest. Throws with what is wrong. */
export function readManifest(
  root: string,
  schema: z.ZodType<PluginManifest> = pluginManifestSchema,
): PluginManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(root, MANIFEST_FILE), "utf8"));
  } catch (err) {
    throw new Error(`${MANIFEST_FILE}: ${(err as Error).message}`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${MANIFEST_FILE}: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

function fromManifest(root: string, options: DiscoverOptions): PluginSource {
  const manifest = readManifest(root, options.manifest);
  const entry = manifest.server
    ? insidePlugin(root, manifest.server)
    : firstExisting(root, options.serverEntries ?? SERVER_ENTRIES);
  if (manifest.server && !entry) {
    throw new Error(`"server": ${manifest.server} is not a file of the plugin.`);
  }
  if (manifest.skills && !insidePlugin(root, manifest.skills)) {
    throw new Error(`"skills": ${manifest.skills} is not a folder of the plugin.`);
  }
  return { id: manifest.id, manifest, root, entry, single: false };
}

/** A plugin without a manifest: its id is the name of its file or folder. */
function bare(id: string, root: string, entry: string, single: boolean): PluginSource {
  if (!PLUGIN_ID.test(id)) {
    throw new Error(`"${id}" is no plugin id: lower case, digits and "-", starting with a letter.`);
  }
  return { id, manifest: { id, name: id, version: "0.0.0" }, root, entry, single };
}

/** Packages below `node_modules` that are plugins: `<name>` and `@scope/<name>`. */
function packagesIn(nodeModules: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(nodeModules).sort()) {
    if (name.startsWith(".")) {
      continue;
    }
    const path = join(nodeModules, name);
    const candidates = name.startsWith("@")
      ? readdirSync(path)
          .sort()
          .map((child) => join(path, child))
      : [path];
    out.push(...candidates.filter((dir) => existsSync(join(dir, MANIFEST_FILE))));
  }
  return out;
}

function sourceAt(path: string, options: DiscoverOptions): PluginSource | null {
  if (!isDir(path)) {
    const ext = extname(path);
    return CODE.has(ext) && !path.endsWith(".d.ts")
      ? bare(basename(path, ext), resolve(path, ".."), path, true)
      : null;
  }
  if (existsSync(join(path, MANIFEST_FILE))) {
    return fromManifest(path, options);
  }
  const index = firstExisting(path, INDEX_ENTRIES);
  return index ? bare(basename(path), path, index, false) : null;
}

/** The plugins in these folders, in order. Of two with one id the first found stays. */
export function discoverPlugins(
  dirs: string[],
  options: DiscoverOptions = {},
): { found: PluginSource[]; problems: PluginProblem[] } {
  const found = new Map<string, PluginSource>();
  const problems: PluginProblem[] = [];
  const take = (path: string) => {
    try {
      const source = sourceAt(path, options);
      if (!source) {
        return;
      }
      const first = found.get(source.id);
      if (first) {
        problems.push({
          path,
          message: `Plugin "${source.id}" is already loaded from ${first.root}.`,
        });
        return;
      }
      found.set(source.id, source);
    } catch (err) {
      problems.push({ path, message: (err as Error).message });
    }
  };
  for (const dir of dirs) {
    if (!isDir(dir)) {
      continue;
    }
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith(".") || name.startsWith("_")) {
        continue;
      }
      const path = join(dir, name);
      if (name === "node_modules") {
        packagesIn(path).forEach(take);
      } else {
        take(path);
      }
    }
  }
  return { found: [...found.values()], problems };
}

/** The folder of a plugin's skills, when it has one: the manifest's `skills`, or `skills/`. */
export function skillsDir(source: PluginSource): string | null {
  if (source.single) {
    return null;
  }
  const path = insidePlugin(source.root, source.manifest.skills ?? "skills");
  return path && isDir(path) ? path : null;
}
