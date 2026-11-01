import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { objects } from "./objects.js";
import { hasThumb, makeThumb } from "./thumbs.js";

/**
 * Content-addressed file store for workspaces, skills and the space's files: a blob never
 * changes, so snapshots are just lists of hashes, and the same bytes are stored once.
 */
const blobKey = (hash: string) => `blobs/${hash.slice(0, 2)}/${hash}`;

export async function putBlob(data: Uint8Array): Promise<string> {
  const hash = createHash("sha256").update(data).digest("hex");
  const key = blobKey(hash);
  if (!(await objects.has(key))) {
    await objects.put(key, data);
  }
  return hash;
}

export async function getBlob(hash: string): Promise<Buffer> {
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error("bad blob hash");
  }
  const data = await objects.get(blobKey(hash));
  if (!data) {
    throw new Error("blob missing");
  }
  return data;
}

/** Whether the store has the bytes of this hash. */
export async function hasBlob(hash: string): Promise<boolean> {
  return /^[a-f0-9]{64}$/.test(hash) && objects.has(blobKey(hash));
}

/** Keeps bytes that arrived for a hash, after checking they are what the hash says. */
export async function putBlobOf(hash: string, data: Uint8Array): Promise<void> {
  if (createHash("sha256").update(data).digest("hex") !== hash) {
    throw new Error("blob does not match its hash");
  }
  if (!(await objects.has(blobKey(hash)))) {
    await objects.put(blobKey(hash), data);
  }
}

/** What is made from a blob (a thumbnail), under its hash; it goes with the blob. */
const derivedPrefix = (hash: string) => `derived/${hash}/`;
const thumbKey = (hash: string) => `${derivedPrefix(hash)}thumb.jpg`;

/**
 * The 320 px JPEG of a blob that is a picture or a PDF (thumbs.ts): kept the first time it is
 * asked for, made then when it isn't there yet (bytes that arrived by sync, or before a crash).
 * One that doesn't decode is kept as empty, so it is tried once. Null when there is none.
 */
export async function blobThumb(hash: string, mime: string): Promise<Buffer | null> {
  if (!hasThumb(mime) || !/^[a-f0-9]{64}$/.test(hash)) {
    return null;
  }
  const kept = await objects.get(thumbKey(hash));
  if (kept) {
    return kept.byteLength ? kept : null;
  }
  const data = await objects.get(blobKey(hash));
  if (!data) {
    return null;
  }
  const thumb = await makeThumb(data, mime);
  await objects.put(thumbKey(hash), thumb ?? new Uint8Array());
  return thumb;
}

/**
 * Whether a row of this tenant still names the hash: a space file (its bytes or its text), a
 * workspace or kept file, a published version's or a run's workspace, a skill's file.
 */
async function blobInUse(hash: string): Promise<boolean> {
  const like = `%"${hash}"%`;
  const found = await db.all(sql`
    SELECT 1 FROM space_file WHERE hash = ${hash} OR text_hash = ${hash}
    UNION ALL SELECT 1 FROM wizard_file WHERE hash = ${hash}
    UNION ALL SELECT 1 FROM store_file WHERE hash = ${hash}
    UNION ALL SELECT 1 FROM wizard_version WHERE files LIKE ${like}
    UNION ALL SELECT 1 FROM run WHERE files LIKE ${like}
    UNION ALL SELECT 1 FROM space_skill WHERE blob_files LIKE ${like}
    LIMIT 1`);
  return found.length > 0;
}

/** Deletes a blob and what was made from it once no row names it any more. */
export async function releaseBlob(hash: string | null | undefined): Promise<void> {
  if (!hash || !/^[a-f0-9]{64}$/.test(hash) || (await blobInUse(hash))) {
    return;
  }
  await objects.remove(blobKey(hash));
  await objects.removePrefix(derivedPrefix(hash));
}
