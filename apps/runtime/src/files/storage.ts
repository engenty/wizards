import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { AssetRef } from "@engenty/wizards-shared/run";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema } from "../db/client.js";
import { env } from "../env.js";
import { currentTenant } from "../tenants/tenant.js";
import { objects } from "./objects.js";

const assetKey = (file: string) => `assets/${file}`;

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "audio/webm": "weba",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "text/html": "html",
  "text/markdown": "md",
  "text/plain": "txt",
  "application/json": "json",
  "application/pdf": "pdf",
};

export function extFor(mime: string): string {
  return EXT[mime] ?? "bin";
}

export interface SaveAssetInput {
  runId?: string | null;
  stepId?: string | null;
  kind: string;
  mime: string;
  name: string;
  data: Uint8Array | string;
  /** Media a model made or changed; travels with the asset's reference. */
  ai?: AssetRef["ai"];
}

export async function saveAsset(input: SaveAssetInput): Promise<AssetRef> {
  const id = nanoid(16);
  const bytes =
    typeof input.data === "string" ? Buffer.from(input.data, "utf8") : Buffer.from(input.data);
  const file = `${id}.${extFor(input.mime)}`;
  await objects.put(assetKey(file), bytes);
  await db.insert(schema.asset).values({
    id,
    tenantId: currentTenant(),
    runId: input.runId ?? null,
    stepId: input.stepId ?? null,
    kind: input.kind,
    mime: input.mime,
    name: input.name,
    path: file,
    size: bytes.byteLength,
  });
  return {
    id,
    kind: input.kind,
    mime: input.mime,
    name: input.name,
    ...(input.ai ? { ai: input.ai } : {}),
  };
}

export async function loadAsset(id: string) {
  const row = await db.query.asset.findFirst({ where: eq(schema.asset.id, id) });
  if (!row) {
    return null;
  }
  const data = await objects.get(assetKey(row.path));
  return data ? { row, data } : null;
}

export async function loadAssetText(id: string): Promise<string> {
  const found = await loadAsset(id);
  return found ? found.data.toString("utf8") : "";
}

/**
 * Generated HTML points at images as `asset://ID`; previews and downloads get them
 * inlined as data URIs, so every file stands on its own. Only the tenant's assets resolve.
 */
export async function inlineAssetRefs(html: string): Promise<string> {
  const ids = [...new Set([...html.matchAll(/asset:\/\/([A-Za-z0-9_-]{6,40})/g)].map((m) => m[1]))];
  let out = html;
  for (const id of ids) {
    const found = await loadAsset(id);
    const uri = found?.row.mime.startsWith("image/")
      ? `data:${found.row.mime};base64,${found.data.toString("base64")}`
      : "";
    out = out.split(`asset://${id}`).join(uri);
  }
  return out;
}

/** Gives an asset new content under the id it has: what points to it keeps pointing to it. */
export async function replaceAsset(
  id: string,
  input: { mime: string; name: string; data: Uint8Array },
) {
  const row = await db.query.asset.findFirst({ where: eq(schema.asset.id, id) });
  if (!row) {
    return;
  }
  const bytes = Buffer.from(input.data);
  const file = `${id}-${nanoid(6)}.${extFor(input.mime)}`;
  await objects.put(assetKey(file), bytes);
  await db
    .update(schema.asset)
    .set({ mime: input.mime, name: input.name, path: file, size: bytes.byteLength })
    .where(eq(schema.asset.id, id));
  await objects.remove(assetKey(row.path));
}

/** Deletes one asset: its file and its row. */
export async function removeAsset(id: string) {
  const row = await db.query.asset.findFirst({ where: eq(schema.asset.id, id) });
  if (row) {
    await objects.remove(assetKey(row.path));
    await db.delete(schema.asset).where(eq(schema.asset.id, id));
  }
}

/** Deletes every file a run made (uploads, results, renders, film folders) and their rows. */
export async function removeAssetFiles(runId: string) {
  const rows = await db.query.asset.findMany({ where: eq(schema.asset.runId, runId) });
  for (const row of rows) {
    await objects.remove(assetKey(row.path));
  }
  await db.delete(schema.asset).where(eq(schema.asset.runId, runId));
  // The folders its films were made in (../film/project.ts).
  if (/^[A-Za-z0-9_-]+$/.test(runId)) {
    await rm(join(env.dataDir, "films", runId), { recursive: true, force: true });
  }
}
