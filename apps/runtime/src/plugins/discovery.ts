import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";
import type { PluginManifest } from "@engenty/wizards/plugin";
import { PLUGIN_ID } from "@engenty-wizards/shared/definition";
import { z } from "zod";

/**
 * Finding plugins. A folder of plugins holds, in any mix:
 *
 *   notify.ts                    one file: the server half, its id is the file's name
 *   contacts/engenty.plugin.json a folder with a manifest: `src/plugin.ts`, `dist/client.js`
 *   hello/index.ts               a folder without one: the server half, its id is the folder's name
 *   node_modules/<package>       packages installed there that carry a manifest
 */

export const MANIFEST_FILE = "engenty.plugin.json";

/** Further fields (an engenty module's `provides`, `capabilities`, …) are kept as they are. */
const manifestSchema = z.looseObject({
  id: z.string().regex(PLUGIN_ID),
  name: z.string().min(1),
  version: z.string().default("0.0.0"),
  description: z.string().optional(),
  server: z.string().optional(),
  studio: z.string().optional(),
  styles: z.string().optional(),
  features: z
    .record(
      z.string().regex(/^[a-z][a-zA-Z0-9]*$/),
      z.union([
        z.boolean(),
        z.object({
          kind: z.enum(["release", "plan"]).optional(),
          default: z.boolean().optional(),
          label: z.string().max(80).optional(),
          hint: z.string().max(300).optional(),
        }),
      ]),
    )
    .optional(),
});

export interface PluginSource {
  id: string;
  manifest: PluginManifest;
  /** The plugin's folder; for a plugin of one file, the folder the file is in. */
  root: string;
  /** The server half. Null: the plugin only adds to the studio. */
  entry: string | null;
  /** The built studio half and its styles, where the plugin has them. */
  studio: string | null;
  styles: string | null;
  /** The plugin is this one file. */
  single: boolean;
  /** A Pro module installed from the linked account (pro.ts); it loads only while the plan has it. */
  pro?: boolean;
}

export interface PluginProblem {
  path: string;
  message: string;
}

/** `.mjs` is left out: Node keeps such a file once imported, so a reload would not read it again. */
const CODE = new Set([".ts", ".js"]);
const SERVER_ENTRIES = ["src/plugin.ts", "src/plugin.js", "dist/plugin.js"];
const INDEX_ENTRIES = ["index.ts", "index.js"];

const isDir = (path: string) => statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
const firstExisting = (root: string, names: string[]) =>
  names.map((name) => join(root, name)).find((path) => existsSync(path)) ?? null;

/** A path of the manifest must stay inside the plugin's folder. */
function inside(root: string, relative: string): string | null {
  const path = resolve(root, relative);
  return path.startsWith(root + sep) && existsSync(path) ? path : null;
}

function fromManifest(root: string): PluginSource {
  const parsed = manifestSchema.safeParse(
    JSON.parse(readFileSync(join(root, MANIFEST_FILE), "utf8")),
  );
  if (!parsed.success) {
    throw new Error(`${MANIFEST_FILE}: ${z.prettifyError(parsed.error)}`);
  }
  const manifest = parsed.data as PluginManifest;
  const entry = manifest.server
    ? inside(root, manifest.server)
    : firstExisting(root, SERVER_ENTRIES);
  if (manifest.server && !entry) {
    throw new Error(`"server": ${manifest.server} is not a file of the plugin.`);
  }
  return {
    id: manifest.id,
    manifest,
    root,
    entry,
    studio: inside(root, manifest.studio ?? "dist/client.js"),
    styles: inside(root, manifest.styles ?? "dist/client.css"),
    single: false,
  };
}

/** A plugin without a manifest: its id is the name of its file or folder. */
function bare(id: string, root: string, entry: string, single: boolean): PluginSource {
  if (!PLUGIN_ID.test(id)) {
    throw new Error(`"${id}" is no plugin id: lower case, digits and "-", starting with a letter.`);
  }
  return {
    id,
    manifest: { id, name: id, version: "0.0.0" },
    root,
    entry,
    studio: null,
    styles: null,
    single,
  };
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

function sourceAt(path: string): PluginSource | null {
  if (!isDir(path)) {
    const ext = extname(path);
    return CODE.has(ext) && !path.endsWith(".d.ts")
      ? bare(basename(path, ext), resolve(path, ".."), path, true)
      : null;
  }
  if (existsSync(join(path, MANIFEST_FILE))) {
    return fromManifest(path);
  }
  const index = firstExisting(path, INDEX_ENTRIES);
  return index ? bare(basename(path), path, index, false) : null;
}

/** The plugins in these folders. Of two with one id the first found stays. */
export function discoverPlugins(dirs: string[]): {
  found: PluginSource[];
  problems: PluginProblem[];
} {
  const found = new Map<string, PluginSource>();
  const problems: PluginProblem[] = [];
  const take = (path: string) => {
    try {
      const source = sourceAt(path);
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
