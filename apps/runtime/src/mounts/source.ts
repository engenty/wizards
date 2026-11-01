import { basename } from "node:path";
import type {
  PluginKnowledgeSource,
  PluginSourceFound,
  PluginSourceInfo,
} from "@engenty/wizards/plugin";
import { featureOn } from "@engenty/wizards-shared/features";
import { spaceFileLimit } from "@engenty/wizards-shared/spaces";
import { and, eq, like } from "drizzle-orm";
import { db, knownTenants, schema, withTenant } from "../db/client.js";
import { documentMime } from "../documents/parse.js";
import { currentFeatures } from "../features.js";
import { managed } from "../manage.js";
import { CORE, registerCoreSource, runDueSources, startSource } from "../services/space-sources.js";
import { onMountChanged, readerOf } from "./mounts.js";

/**
 * „Aus Dateien übernehmen“ (docs/plans/media-and-files.md, step 8): the core's kind of source of
 * Knowledge on a mount of Dateien. It takes a folder of a mount, or the whole mount, into a folder
 * of Knowledge, copied and read as an upload is: `.md` and `.txt` become pages, tables and
 * documents are read as uploads are, a directory's `README.md` or `index.md` is its folder's
 * text. It reads through the mount's reader and runs again when the mount tells of a change in
 * its folder.
 *
 * Its address is the wizards' path of the folder: `dateien/<mount>/<folder>`.
 */

export const KIND = "dateien";

/** Read as pages of their own: their text is the page. */
const PAGE = /\.(md|markdown|txt)$/i;
/** A folder's text. */
const FOLDER_TEXT = /^(readme|index)\.md$/i;

/** The mount and the folder in it an address names. */
export function parseAddress(address: string): { slug: string; folder: string } | null {
  const [head, slug, ...rest] = address
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .split("/");
  return head === "dateien" && slug ? { slug, folder: rest.filter(Boolean).join("/") } : null;
}

export const addressOf = (slug: string, folder = "") =>
  ["dateien", slug, ...folder.split("/").filter(Boolean)].join("/");

async function mountOf(source: PluginSourceInfo) {
  const at = parseAddress(source.address);
  const mount = at
    ? await db.query.spaceMount.findFirst({
        where: and(
          eq(schema.spaceMount.spaceId, source.space),
          eq(schema.spaceMount.slug, at.slug),
        ),
      })
    : null;
  if (!(at && mount)) {
    throw new Error(`Dateien has no folder "${source.address}".`);
  }
  return { mount, folder: at.folder };
}

/** A file's path below the source's folder. */
const below = (folder: string, path: string) => (folder ? path.slice(folder.length + 1) : path);

/** What a list says changed with the bytes: the source's version, else size and time. */
const fingerprintOf = (e: { version: string | null; size: number; modified: number }) =>
  e.version ?? `${e.size}:${e.modified}`;

/** A page's title: its first heading, else the file's name without its ending. */
function titleOf(markdown: string, name: string): string {
  const heading = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return (heading || name.replace(/\.[a-z0-9]{1,8}$/i, "")).slice(0, 120);
}

export const fromDateien: PluginKnowledgeSource = {
  kind: KIND,
  match: (address) => (parseAddress(address) ? address.trim().replace(/^\/+|\/+$/g, "") : null),
  reader: {
    async list(source, ctx) {
      const { mount, folder } = await mountOf(source);
      const found: PluginSourceFound[] = [];
      for await (const entry of readerOf(mount).list(folder || undefined, {
        signal: ctx.signal,
      })) {
        const parts = below(folder, entry.path).split("/");
        const name = parts[parts.length - 1];
        found.push({
          address: entry.path,
          title: name,
          fingerprint: fingerprintOf(entry),
          // A README stands for its folder; any other file is named by its own part.
          path: FOLDER_TEXT.test(name) ? parts.slice(0, -1) : parts,
        });
      }
      return found;
    },
    async read(source, entry, ctx) {
      const { mount, folder } = await mountOf(source);
      const reader = readerOf(mount);
      const now = await reader.stat(entry.address);
      if (!now) {
        throw new Error(`"${entry.address}" is not in the folder any more.`);
      }
      const fingerprint = fingerprintOf(now);
      const name = basename(entry.address);
      const mime = documentMime(name, now.mime ?? "") || "application/octet-stream";
      const limit = spaceFileLimit("document", mime);
      if (now.size > limit) {
        return {
          kind: "failed",
          note: `Larger than ${Math.round(limit / 1_000_000)} MB.`,
          fingerprint,
        };
      }
      const data = await reader.read(entry.address, { signal: ctx.signal });
      if (PAGE.test(name)) {
        const markdown = Buffer.from(data).toString("utf8");
        if (!FOLDER_TEXT.test(name)) {
          return { kind: "page", title: titleOf(markdown, name), markdown, fingerprint };
        }
        // A README is called as its folder.
        const parts = below(folder, entry.address).split("/");
        const dir = parts.at(-2) ?? basename(folder || mount.name);
        return { kind: "page", title: titleOf(markdown, dir), markdown, fingerprint, folder: true };
      }
      return { kind: "document", name, mime, data, fingerprint };
    },
  },
};

const on = async () =>
  !managed &&
  featureOn(await currentFeatures(), "dateien") &&
  featureOn(await currentFeatures(), "knowledgeTree");

/** Sources run this often as well, for a change no watcher told of. */
const DUE_MS = 15 * 60_000;

/**
 * The kind in the core's list, and its sources run when their mount changes under their folder
 * (and daily besides, as their `everyHours` says).
 */
export function startFileSources() {
  registerCoreSource({ ...fromDateien, everyHours: 24 }, on);
  onMountChanged((mount, paths) => {
    void (async () => {
      const rows = await db.query.spaceSource.findMany({
        where: and(
          eq(schema.spaceSource.spaceId, mount.spaceId),
          eq(schema.spaceSource.plugin, CORE),
          eq(schema.spaceSource.kind, KIND),
          eq(schema.spaceSource.state, "taken"),
          like(schema.spaceSource.address, `dateien/${mount.slug}%`),
        ),
      });
      for (const row of rows) {
        const at = parseAddress(row.address);
        if (
          at?.slug === mount.slug &&
          paths.some((p) => !at.folder || p === at.folder || p.startsWith(`${at.folder}/`))
        ) {
          startSource(row.id);
        }
      }
    })().catch((err) => console.error("[sources] dateien", err));
  });
  if (managed) {
    return;
  }
  setInterval(async () => {
    for (const tenant of await knownTenants()) {
      await withTenant(tenant, () => runDueSources(CORE)).catch((err) =>
        console.error(`[sources] due ${tenant}`, err),
      );
    }
  }, DUE_MS).unref();
}
