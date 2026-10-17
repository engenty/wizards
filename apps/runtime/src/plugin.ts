import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { marketplaceNameOf } from "@engenty-wizards/shared/claude-plugin";
import { zipSync } from "fflate";
import { env } from "./env.js";

/**
 * The Claude Code plugin for this deployment: the `plugin/` folder, served as a marketplace
 * (`url` source) whose one plugin is a zip (`archive` source), with this server's address as its
 * homepage, the package's version, and an `.mcp.json` that bundles this server. So every
 * deployment hands out its own plugin and no domain is baked into the repo, while the folder in
 * git is a valid plugin as it is: installed from GitHub, it uses the `engenty-wizards` server the
 * person configured.
 */

const here = dirname(fileURLToPath(import.meta.url));
/** The folder that holds `plugin/` and the root package.json: three levels above this file. */
const base = resolve(here, "../../..");
const root = existsSync(join(base, "plugin")) ? base : undefined;

export const PLUGIN_NAME = "wizards";
/** This deployment's marketplace, named after its host; `engenty` is the GitHub one. */
export const MARKETPLACE_NAME = marketplaceNameOf(env.appUrl);
export const pluginBase = `${env.appUrl}/api/claude-plugin`;

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)])),
  );
  return nested.flat();
}

let built: Promise<{ zip: Uint8Array; sha256: string; version: string }> | null = null;

export function pluginArchive() {
  built ??= (async () => {
    if (!root) {
      throw new Error("plugin/ folder missing");
    }
    const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const dir = join(root, "plugin");
    const files: Record<string, Uint8Array> = {};
    for (const path of (await filesUnder(dir)).sort()) {
      const name = relative(dir, path);
      let text = (await readFile(path, "utf8"))
        .replaceAll("{{APP_URL}}", env.appUrl)
        .replaceAll("{{VERSION}}", version);
      if (name === ".claude-plugin/plugin.json") {
        const manifest = JSON.parse(text);
        manifest.version = version;
        manifest.homepage = env.appUrl;
        text = `${JSON.stringify(manifest, null, 2)}\n`;
      }
      // Fixed timestamps keep the archive, and so its sha256, stable across restarts.
      files[name] = new TextEncoder().encode(text);
    }
    const mcp = {
      mcpServers: { "engenty-wizards": { type: "http", url: `${env.appUrl}/api/mcp` } },
    };
    files[".mcp.json"] = new TextEncoder().encode(`${JSON.stringify(mcp, null, 2)}\n`);
    const zip = zipSync(files, { level: 9, mtime: new Date("2026-01-01T00:00:00Z") });
    return { zip, sha256: createHash("sha256").update(zip).digest("hex"), version };
  })();
  return built;
}

export async function pluginMarketplace() {
  const { sha256, version } = await pluginArchive();
  return {
    name: MARKETPLACE_NAME,
    owner: { name: "engenty" },
    description: "engenty wizards for Claude Code, from this deployment",
    plugins: [
      {
        name: PLUGIN_NAME,
        description:
          "Build page-by-page AI wizards that people open on a shared link — designed, tested and published from Claude Code.",
        version,
        source: { source: "archive", url: `${pluginBase}/${PLUGIN_NAME}.zip`, sha256 },
      },
    ],
  };
}
