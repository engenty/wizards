import type { RegistryHit } from "@engenty/wizards-shared/connectors";
import type { DiscoverBundle } from "@engenty/wizards-shared/discover";
import { officialSkill, type SkillHit } from "@engenty/wizards-shared/skills";
import { eq } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import { db, schema } from "../db/client.js";
import { createGuardedFetch } from "../engenty/connections-external/net/guarded-fetch.js";
import { Archive, type ReadPlugin, readPlugin } from "./read.js";

/**
 * Entdecken's one hit for a Connector that brings skills (docs/plans/capabilities-next.md,
 * piece 4). skills.sh names the repository each skill lives in. A repository whose root is a
 * plugin for Claude Code or Cursor with an MCP server over http holds both: its skills and the
 * service's connector are one thing to set up, not two. Only the plugin's manifest and MCP file
 * are read, from GitHub's raw host through the guarded fetch, and kept for an hour.
 *
 * Not found this way: a plugin in a folder of its repository, and one whose manifest keeps its
 * MCP servers in another file.
 */

const RAW = (process.env.GITHUB_RAW_URL ?? "https://raw.githubusercontent.com").replace(/\/+$/, "");
/** The files that tell a plugin with a server, at a repository's root. */
const FILES = [
  ".claude-plugin/plugin.json",
  ".cursor-plugin/plugin.json",
  ".mcp.json",
  "mcp.json",
] as const;
/** How many repositories one search looks into. */
const REPOS = 6;
const WAIT_MS = 4000;
const KEEP_MS = 60 * 60_000;
const MAX_BYTES = 300_000;

const known = new Map<string, { at: number; plugin: ReadPlugin | null }>();

async function fileOf(guarded: typeof fetch, repo: string, path: string): Promise<string | null> {
  try {
    const res = await guarded(`${RAW}/${repo}/HEAD/${path}`, {
      headers: { "user-agent": "engenty-wizards" },
      signal: AbortSignal.timeout(WAIT_MS),
    });
    if (!res.ok) {
      return null;
    }
    const text = await res.text();
    return text.length > MAX_BYTES ? null : text;
  } catch {
    return null;
  }
}

/** The plugin at a repository's root, as far as its manifest and MCP file tell; null: none. */
async function repoPlugin(repo: string): Promise<ReadPlugin | null> {
  const key = repo.toLowerCase();
  const hit = known.get(key);
  if (hit && Date.now() - hit.at < KEEP_MS) {
    return hit.plugin;
  }
  const guarded = createGuardedFetch();
  const texts = await Promise.all(FILES.map((path) => fileOf(guarded, repo, path)));
  const files: Record<string, Uint8Array> = {};
  FILES.forEach((path, i) => {
    const text = texts[i];
    if (text !== null) {
      files[path] = strToU8(text);
    }
  });
  let plugin: ReadPlugin | null = null;
  if (Object.keys(files).length) {
    try {
      const read = readPlugin(new Archive(zipSync(files)), {
        fallbackName: repo.split("/")[1] ?? repo,
        say: () => "",
      });
      plugin = "plugin" in read ? read.plugin : null;
    } catch {
      // A manifest nobody can read is no plugin to offer.
    }
  }
  if (known.size > 500) {
    known.clear();
  }
  known.set(key, { at: Date.now(), plugin });
  return plugin;
}

/** `owner/name` of a skill's address on skills.sh (`owner/name/skill`). */
const repoOf = (ref: string) => ref.split("/").slice(0, 2).join("/");

/**
 * The repositories among a search's skills that are a plugin with a server over http, each with
 * the hits it stands for: its skills, and the connectors of the service its server belongs to.
 */
export async function discoverBundles(
  spaceId: string,
  skills: SkillHit[],
  connectors: RegistryHit[],
): Promise<DiscoverBundle[]> {
  const repos = [...new Set(skills.map((s) => repoOf(s.ref)))]
    .filter((r) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r))
    .slice(0, REPOS);
  if (!repos.length) {
    return [];
  }
  const [plugins, have] = await Promise.all([
    Promise.all(repos.map(repoPlugin)),
    db
      .select({ origin: schema.spaceBundle.origin })
      .from(schema.spaceBundle)
      .where(eq(schema.spaceBundle.spaceId, spaceId)),
  ]);
  const added = new Set(
    have.flatMap((b) => (b.origin.kind === "github" ? [b.origin.repo.toLowerCase()] : [])),
  );
  const found: DiscoverBundle[] = [];
  repos.forEach((repo, i) => {
    const plugin = plugins[i];
    if (!plugin?.servers.length) {
      return;
    }
    const hosts = [...new Set(plugin.servers.map((s) => new URL(s.url).hostname.toLowerCase()))];
    found.push({
      repo,
      name: plugin.name,
      description: plugin.description,
      format: plugin.format,
      hosts,
      official: officialSkill(`${repo}/x`),
      added: added.has(repo.toLowerCase()),
      covers: {
        skills: skills.filter((s) => repoOf(s.ref) === repo).map((s) => s.ref),
        connectors: connectors
          .map((c) => c.domain)
          .filter((domain) => {
            const d = domain
              .trim()
              .toLowerCase()
              .replace(/^www\./, "");
            return hosts.some((host) => host === d || host.endsWith(`.${d}`));
          }),
      },
    });
  });
  return found;
}
