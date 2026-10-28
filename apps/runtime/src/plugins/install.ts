import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { PLUGIN_ID } from "@engenty/wizards-shared/definition";
import { managed } from "../manage.js";
import { MANIFEST_FILE } from "./discovery.js";
import {
  foundPlugins,
  installedPluginsDir,
  pluginOff,
  pluginProblems,
  reloadPlugin,
  setPluginOn,
} from "./loader.js";
import { filesOf, ProModuleError } from "./pro.js";

/*
 * Plugins someone installs in Settings › Plugins on a runtime that runs alone: a zip or a folder
 * of this computer, copied to `<DATA_DIR>/plugins/<id>/`. Nobody checked them: the studio says so
 * before it installs one. A plugin holds its manifest, `dist/` and `migrations/`, as a Pro
 * plugin's package does; its server half comes built.
 */

/** Larger packages are refused before they are read. */
export const MAX_PLUGIN = 30 * 1024 * 1024;
/** What a plugin may hold, besides its manifest. */
const PARTS = ["dist/", "migrations/"];

/** Installs a plugin from a zip; answers its id. */
export async function installPluginZip(zip: Uint8Array): Promise<string> {
  if (zip.length > MAX_PLUGIN) {
    throw new ProModuleError("The package is too large.", 400);
  }
  return put(filesOf(zip, 400));
}

/** Installs a copy of a plugin folder on this computer; answers its id. */
export async function installPluginFolder(path: string): Promise<string> {
  const root = resolve(path.replace(/^~(?=$|[/\\])/, homedir()));
  if (!existsSync(join(root, MANIFEST_FILE))) {
    throw new ProModuleError(`There is no ${MANIFEST_FILE} in this folder.`, 400, "no_plugin");
  }
  const files: Record<string, Uint8Array> = {};
  let size = 0;
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const name = relative(root, full).split("\\").join("/");
      if (entry.isDirectory()) {
        if (PARTS.some((part) => `${name}/`.startsWith(part) || part.startsWith(`${name}/`))) {
          await walk(full);
        }
      } else if (
        entry.isFile() &&
        (name === MANIFEST_FILE || PARTS.some((part) => name.startsWith(part)))
      ) {
        size += (await stat(full)).size;
        if (size > MAX_PLUGIN) {
          throw new ProModuleError("The plugin is too large.", 400);
        }
        files[name] = new Uint8Array(await readFile(full));
      }
    }
  };
  await walk(root);
  return put(files);
}

/** Its files in place of the old ones, then it loads; a plugin that does not load is taken out again. */
async function put(files: Record<string, Uint8Array>): Promise<string> {
  if (managed) {
    throw new ProModuleError("Not available here.", 404, "not_found");
  }
  let id: unknown;
  try {
    id = JSON.parse(new TextDecoder().decode(files[MANIFEST_FILE] ?? new Uint8Array()))?.id;
  } catch {
    id = null;
  }
  if (typeof id !== "string" || !PLUGIN_ID.test(id)) {
    throw new ProModuleError(`The plugin has no valid ${MANIFEST_FILE}.`, 400, "no_plugin");
  }
  const dir = installedPluginsDir();
  const target = join(dir, id);
  const other = foundPlugins().find((s) => s.id === id && dirname(s.root) !== dir);
  if (other) {
    throw new ProModuleError(`A plugin “${id}” is already there: ${other.root}.`, 409, "taken");
  }
  const fresh = join(dir, `.new-${id}-${randomBytes(4).toString("hex")}`);
  const old = join(dir, `.old-${id}-${randomBytes(4).toString("hex")}`);
  await mkdir(fresh, { recursive: true });
  try {
    for (const [path, data] of Object.entries(files)) {
      await mkdir(dirname(join(fresh, path)), { recursive: true });
      await writeFile(join(fresh, path), data);
    }
    if (existsSync(target)) {
      await rename(target, old);
    }
    await rename(fresh, target);
  } finally {
    await rm(fresh, { recursive: true, force: true });
    await rm(old, { recursive: true, force: true });
  }
  // Installing it again switches it on.
  if (pluginOff(id)) {
    await setPluginOn(id, true);
  }
  const loaded = await reloadPlugin(id);
  if (!loaded) {
    const problem = pluginProblems().find((p) => p.path.startsWith(target));
    await rm(target, { recursive: true, force: true });
    await reloadPlugin(id);
    throw new ProModuleError(
      problem ? problem.message : "The plugin did not load.",
      400,
      "not_loaded",
    );
  }
  return id;
}

/** Whether a plugin was installed here, so Settings › Plugins may remove it. */
export function installedHere(id: string): boolean {
  return foundPlugins().some((s) => s.id === id && dirname(s.root) === installedPluginsDir());
}

/** Removes a plugin installed here; its tables and what is in them stay. */
export async function removeInstalledPlugin(id: string): Promise<void> {
  if (!installedHere(id)) {
    throw new ProModuleError("This plugin was not installed here.", 404, "not_found");
  }
  await rm(join(installedPluginsDir(), id), { recursive: true, force: true });
  await reloadPlugin(id);
}
