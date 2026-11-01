/**
 * The pictures of a page a plugin writes (`server.spaceData.putPage` `images`), copied into the
 * space: each fetched once, its bytes kept once by their hash, the Markdown pointed at the copy as
 * `asset://ID`, the outside address kept as the file's `source`. A copy is a space file of the
 * kind `picture`: found in the search by what it shows, shown in its page, no item of Wissen's
 * tree. One no page shows any more goes with the plugin's next write.
 * docs/plans/media-and-files.md, section 1.
 */
import { featureOn } from "@engenty/wizards-shared/features";
import { and, eq, inArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema } from "../db/client.js";
import { currentFeatures } from "../features.js";
import { blobThumb, putBlob } from "../files/blobs.js";
import { checkUpload, pictureSize } from "../files/upload-check.js";
import { fetchWebImage } from "../files/web-images.js";
import { describePicture, removeOriginFiles } from "./space-files.js";
import { queueIndex, seenAsPicture } from "./space-index.js";

/** Pictures one page keeps, and below what a picture is a button or a bullet, not content. */
const MAX_PICTURES = 30;
const MIN_BYTES = 10_000;
const MIN_SIDE = 200;
const PARALLEL = 4;

export interface PageImage {
  url: string;
  alt?: string;
}

const ASSET_REF = /asset:\/\/([A-Za-z0-9_-]{6,40})/g;

/** The ids of the space's files a page's Markdown shows as `asset://ID`. */
export const shownFiles = (markdown: string) =>
  new Set([...markdown.matchAll(ASSET_REF)].map((m) => m[1]));

/** Whether a plugin's pages keep copies of their pictures: the switch `knowledgeMedia`. */
export async function copiesPictures(): Promise<boolean> {
  return featureOn(await currentFeatures(), "knowledgeMedia");
}

/** One picture from the web into the space, or the copy it has of the same bytes; null when it is none. */
async function copyPicture(
  origin: string,
  spaceId: string,
  label: string | null,
  image: PageImage,
  signal?: AbortSignal,
): Promise<string | null> {
  const fetched = await fetchWebImage(image.url, signal);
  if (!fetched || fetched.data.byteLength < MIN_BYTES || fetched.mime === "image/svg+xml") {
    return null;
  }
  const size = pictureSize(fetched.data, fetched.mime);
  if (!size || Math.min(size.width, size.height) < MIN_SIDE) {
    return null;
  }
  const name = decodeURIComponent(new URL(image.url).pathname.split("/").pop() || "bild");
  // The bytes say what it is; a picture is drawn again without its metadata.
  const checked = await checkUpload({
    name,
    mime: fetched.mime,
    data: fetched.data,
    fallbackName: "bild",
  }).catch(() => null);
  if (!checked?.mime.startsWith("image/")) {
    return null;
  }
  const hash = await putBlob(checked.data);
  const originKey = `picture:${hash}`;
  const scope = and(
    eq(schema.spaceFile.spaceId, spaceId),
    eq(schema.spaceFile.origin, origin),
    eq(schema.spaceFile.originKey, originKey),
  );
  const had = await db.query.spaceFile.findFirst({ where: scope, columns: { id: true } });
  if (had) {
    return had.id;
  }
  const seen = await seenAsPicture(checked.mime);
  const [row] = await db
    .insert(schema.spaceFile)
    .values({
      id: nanoid(16),
      spaceId,
      kind: "picture",
      name: checked.name,
      mime: checked.mime,
      size: checked.data.byteLength,
      hash,
      description: image.alt?.trim().slice(0, 600) ?? "",
      source: image.url,
      origin,
      originKey,
      originLabel: label,
      // Where the embedding model doesn't see pictures, a sentence says what it shows first.
      status: seen ? "ready" : "pending",
    })
    .onConflictDoNothing()
    .returning();
  if (!row) {
    // Another page of the same run kept the same bytes a moment before.
    return (
      (await db.query.spaceFile.findFirst({ where: scope, columns: { id: true } }))?.id ?? null
    );
  }
  void blobThumb(hash, row.mime).catch(() => null);
  if (seen) {
    queueIndex(`f:${row.id}`);
  } else {
    describePicture(row);
  }
  return row.id;
}

/**
 * Copies the pictures of a page into the space and points its Markdown at the copies:
 * `![alt](https://…)` becomes `![alt](asset://ID)`. A picture the Markdown doesn't show is added
 * at its end. A picture copied for another page of the plugin before (the same address, or the
 * same bytes) is not fetched again. What can't be fetched, or is an icon, stays as it was.
 */
export async function copyPagePictures(
  origin: string,
  input: {
    space: string;
    label?: string | null;
    markdown: string;
    images: PageImage[];
    signal?: AbortSignal;
  },
): Promise<string> {
  const list = [
    ...new Map(
      input.images.filter((i) => /^https?:\/\//i.test(i.url)).map((i) => [i.url, i]),
    ).values(),
  ].slice(0, MAX_PICTURES);
  if (!list.length) {
    return input.markdown;
  }
  const label = input.label?.trim().slice(0, 120) || null;
  const ids = new Map<string, string>();
  const known = await db.query.spaceFile.findMany({
    where: and(
      eq(schema.spaceFile.spaceId, input.space),
      eq(schema.spaceFile.origin, origin),
      eq(schema.spaceFile.kind, "picture"),
      inArray(
        schema.spaceFile.source,
        list.map((i) => i.url),
      ),
    ),
    columns: { id: true, source: true },
  });
  for (const k of known) {
    ids.set(k.source as string, k.id);
  }
  const missing = list.filter((i) => !ids.has(i.url));
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, missing.length) }, async () => {
      while (next < missing.length && !input.signal?.aborted) {
        const image = missing[next++];
        const id = await copyPicture(origin, input.space, label, image, input.signal).catch(
          (err) => {
            console.error(`[plugin ${origin}] picture`, image.url, err);
            return null;
          },
        );
        if (id) {
          ids.set(image.url, id);
        }
      }
    }),
  );
  const shown = new Set<string>();
  const markdown = input.markdown.replace(
    /!\[([^\]\n]*)\]\(\s*<?(https?:\/\/[^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g,
    (whole, alt: string, url: string) => {
      const id = ids.get(url);
      if (!id) {
        return whole;
      }
      shown.add(url);
      return `![${alt || list.find((i) => i.url === url)?.alt?.trim() || ""}](asset://${id})`;
    },
  );
  const added = list
    .filter((i) => ids.has(i.url) && !shown.has(i.url))
    .map((i) => `![${(i.alt ?? "").replace(/[[\]\n]/g, " ").trim()}](asset://${ids.get(i.url)})`);
  return added.length ? `${markdown.trimEnd()}\n\n${added.join("\n\n")}\n` : markdown;
}

/** Takes out those of the plugin's pictures `ids` that no page of the space shows any more. */
export async function dropUnshownPictures(origin: string, spaceId: string, ids: Iterable<string>) {
  const list = [...new Set(ids)];
  if (!list.length) {
    return;
  }
  const rows = await db.query.spaceFile.findMany({
    where: and(
      eq(schema.spaceFile.spaceId, spaceId),
      eq(schema.spaceFile.origin, origin),
      eq(schema.spaceFile.kind, "picture"),
      inArray(schema.spaceFile.id, list),
    ),
    columns: { id: true, originKey: true },
  });
  for (const row of rows) {
    const shown = await db.query.spacePage.findFirst({
      where: and(
        eq(schema.spacePage.spaceId, spaceId),
        sql`instr(${schema.spacePage.markdown}, ${`asset://${row.id}`}) > 0`,
      ),
      columns: { id: true },
    });
    if (!shown && row.originKey) {
      await removeOriginFiles(origin, spaceId, row.originKey);
    }
  }
}
