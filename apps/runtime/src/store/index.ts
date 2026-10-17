import { note } from "@engenty-wizards/shared/run";
import {
  firstRowAt,
  type ListDef,
  type ListRow,
  newCells,
  patchCells,
  rowKey,
  STORE_LIMITS,
  type StoreFile,
} from "@engenty-wizards/shared/store";
import { cleanPath, mimeForPath } from "@engenty-wizards/shared/workspace";
import { and, asc, eq, inArray, like, lt, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema } from "../db/client.js";
import { env } from "../env.js";
import { getBlob, putBlob } from "../files/blobs.js";
import { seal, unseal } from "../secrets/crypto.js";
import { StoreError } from "./errors.js";
import { deleteSharedRows, saveSharedRows, sharedRows } from "./shared-lists.js";

/** Whose store: one wizard, one person. */
export interface StoreScope {
  wizardId: string;
  holder: string;
}

export { StoreError };

/** The person a run belongs to: the signed-in admin, else the visitor of the shared link. */
export function holderOf(run: { id: string; userId: string | null; visitorId: string | null }) {
  if (run.userId) {
    return `u:${run.userId}`;
  }
  return run.visitorId ? `v:${run.visitorId}` : `r:${run.id}`;
}

export function scopeOf(run: {
  id: string;
  wizardId: string;
  userId: string | null;
  visitorId: string | null;
}): StoreScope {
  return { wizardId: run.wizardId, holder: holderOf(run) };
}

/** Marks the store as in use; stores nobody came back to are cleaned up. */
export async function touchStore(scope: StoreScope) {
  await db
    .insert(schema.storeHolder)
    .values({ ...scope, usedAt: new Date() })
    .onConflictDoUpdate({
      target: [schema.storeHolder.wizardId, schema.storeHolder.holder],
      set: { usedAt: new Date() },
    });
}

// --- lists -------------------------------------------------------------------

const inList = (scope: StoreScope, list: string) =>
  and(
    eq(schema.storeRow.wizardId, scope.wizardId),
    eq(schema.storeRow.holder, scope.holder),
    eq(schema.storeRow.list, list),
  );

function toRow(r: typeof schema.storeRow.$inferSelect): ListRow {
  return { id: r.id, cells: r.cells, updatedAt: r.updatedAt.toISOString() };
}

/** The rows of a list: the person's, or every run's where the list is shared. */
export async function listRows(scope: StoreScope, def: ListDef): Promise<ListRow[]> {
  if (def.shared) {
    return sharedRows(scope.wizardId, def);
  }
  const rows = await db.query.storeRow.findMany({
    where: inList(scope, def.id),
    orderBy: [asc(schema.storeRow.createdAt), asc(schema.storeRow.id)],
  });
  return rows.map(toRow);
}

/**
 * Saves rows into a list. With a key column, a row whose key is already there is updated — only
 * the columns given change, so a step can add "how to get the invoice" without wiping the rest.
 * A row with a bad value is refused as a whole (`TableColumnValueError` names the column).
 */
export async function saveRows(
  scope: StoreScope,
  def: ListDef,
  input: Record<string, unknown>[],
): Promise<{ added: number; updated: number }> {
  if (def.shared) {
    return saveSharedRows(scope.wizardId, def, input);
  }
  let added = 0;
  let updated = 0;
  const existing = await db.query.storeRow.findMany({ where: inList(scope, def.id) });
  const byKey = new Map(existing.filter((r) => r.key).map((r) => [r.key as string, r]));
  let count = existing.length;
  const at = firstRowAt(existing);
  for (const raw of input) {
    const key = rowKey(def, raw);
    const hit = key ? byKey.get(key) : undefined;
    if (hit) {
      const cells = patchCells(def, hit.cells, raw);
      await db
        .update(schema.storeRow)
        .set({ cells, updatedAt: new Date() })
        .where(eq(schema.storeRow.id, hit.id));
      hit.cells = cells;
      updated++;
      continue;
    }
    const cells = newCells(def, raw);
    if (Object.values(cells).every((v) => v === null)) {
      continue;
    }
    if (count >= STORE_LIMITS.rowsPerList) {
      throw new StoreError(`List "${def.id}" is full (${STORE_LIMITS.rowsPerList} rows).`);
    }
    const row = {
      id: nanoid(14),
      ...scope,
      list: def.id,
      key,
      cells,
      createdAt: new Date(at + added),
    };
    await db.insert(schema.storeRow).values(row);
    if (key) {
      byKey.set(key, { ...row, updatedAt: new Date() });
    }
    count++;
    added++;
  }
  await touchStore(scope);
  return { added, updated };
}

/** Changes cells of one row (the person edited it). A shared list is never the person's. */
export async function updateRow(
  scope: StoreScope,
  def: ListDef,
  rowId: string,
  patch: Record<string, unknown>,
): Promise<boolean> {
  if (def.shared) {
    return false;
  }
  const row = await db.query.storeRow.findFirst({
    where: and(inList(scope, def.id), eq(schema.storeRow.id, rowId)),
  });
  if (!row) {
    return false;
  }
  const cells = patchCells(def, row.cells, patch);
  const key = rowKey(def, cells);
  const clash =
    key && key !== row.key
      ? await db.query.storeRow.findFirst({
          where: and(inList(scope, def.id), eq(schema.storeRow.key, key)),
        })
      : null;
  if (clash) {
    throw new StoreError(note("entryAlreadyExists"));
  }
  await db
    .update(schema.storeRow)
    .set({ cells, key, updatedAt: new Date() })
    .where(eq(schema.storeRow.id, rowId));
  return true;
}

/** Deletes rows by id, or by the value of the key column. */
export async function deleteRows(scope: StoreScope, def: ListDef, idsOrKeys: string[]) {
  if (def.shared) {
    return deleteSharedRows(scope.wizardId, def, idsOrKeys);
  }
  if (!idsOrKeys.length) {
    return 0;
  }
  const keys = idsOrKeys.map((k) => k.trim().toLowerCase());
  const byId = await db
    .delete(schema.storeRow)
    .where(and(inList(scope, def.id), inArray(schema.storeRow.id, idsOrKeys)))
    .returning({ id: schema.storeRow.id });
  const byKey = await db
    .delete(schema.storeRow)
    .where(and(inList(scope, def.id), inArray(schema.storeRow.key, keys)))
    .returning({ id: schema.storeRow.id });
  return byId.length + byKey.length;
}

// --- files -------------------------------------------------------------------

const ownFiles = (scope: StoreScope) =>
  and(eq(schema.storeFile.wizardId, scope.wizardId), eq(schema.storeFile.holder, scope.holder));

function toFile(r: typeof schema.storeFile.$inferSelect): StoreFile {
  return {
    path: r.path,
    mime: r.mime,
    size: r.size,
    source: r.source,
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** Any name a model or a mail server comes up with, as a path the store accepts. */
export function storePath(raw: string): string {
  const path = raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ß/g, "ss")
    .split("/")
    .map((part) =>
      part
        .trim()
        .replace(/[^A-Za-z0-9_.-]+/g, "_")
        .replace(/^[._]+/, "")
        .slice(0, 80),
    )
    .filter(Boolean)
    .join("/");
  const clean = cleanPath(path);
  if (!clean) {
    throw new StoreError(`"${raw}" is not a usable file name.`);
  }
  return clean;
}

export async function storeFiles(scope: StoreScope, folder?: string): Promise<StoreFile[]> {
  const rows = await db.query.storeFile.findMany({
    where: folder
      ? and(ownFiles(scope), like(schema.storeFile.path, `${folder.replace(/\/+$/, "")}/%`))
      : ownFiles(scope),
    orderBy: [asc(schema.storeFile.path)],
  });
  return rows.map(toFile);
}

/** Whether the wizard keeps any file for the holder: one row, not the whole list. */
export async function hasStoreFiles(scope: StoreScope): Promise<boolean> {
  const row = await db.query.storeFile.findFirst({
    where: ownFiles(scope),
    columns: { path: true },
  });
  return row !== undefined;
}

export async function readStoreFile(scope: StoreScope, rawPath: string) {
  const path = cleanPath(rawPath);
  const row = path
    ? await db.query.storeFile.findFirst({
        where: and(ownFiles(scope), eq(schema.storeFile.path, path)),
      })
    : undefined;
  return row ? { file: toFile(row), data: await getBlob(row.hash) } : null;
}

export async function writeStoreFile(
  scope: StoreScope,
  rawPath: string,
  content: Uint8Array | string,
  meta: { mime?: string; source?: string } = {},
): Promise<StoreFile> {
  const path = storePath(rawPath);
  const data = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
  if (data.byteLength > STORE_LIMITS.fileBytes) {
    throw new StoreError(`${path} is larger than 15 MB.`);
  }
  const [usage] = await db
    .select({
      files: sql<number>`count(*)`,
      bytes: sql<number>`coalesce(sum(${schema.storeFile.size}), 0)`,
    })
    .from(schema.storeFile)
    .where(ownFiles(scope));
  if (
    usage.files >= STORE_LIMITS.files ||
    usage.bytes + data.byteLength > STORE_LIMITS.totalBytes
  ) {
    throw new StoreError("The wizard's storage is full.");
  }
  const hash = await putBlob(data);
  const mime =
    meta.mime && meta.mime !== "application/octet-stream" ? meta.mime : mimeForPath(path);
  const updatedAt = new Date();
  await db
    .insert(schema.storeFile)
    .values({ ...scope, path, hash, mime, size: data.byteLength, source: meta.source ?? null })
    .onConflictDoUpdate({
      target: [schema.storeFile.wizardId, schema.storeFile.holder, schema.storeFile.path],
      set: { hash, mime, size: data.byteLength, source: meta.source ?? null, updatedAt },
    });
  await touchStore(scope);
  return {
    path,
    mime,
    size: data.byteLength,
    source: meta.source ?? null,
    updatedAt: updatedAt.toISOString(),
  };
}

// --- secrets -----------------------------------------------------------------

const ownSecrets = (scope: StoreScope) =>
  and(eq(schema.storeSecret.wizardId, scope.wizardId), eq(schema.storeSecret.holder, scope.holder));

export interface StoredSecret<T> {
  provider: string;
  label: string;
  data: T;
  createdAt: Date;
}

export async function getSecret<T>(
  scope: StoreScope,
  slot: string,
): Promise<StoredSecret<T> | null> {
  const row = await db.query.storeSecret.findFirst({
    where: and(ownSecrets(scope), eq(schema.storeSecret.slot, slot)),
  });
  const data = row ? unseal<T>(row.data) : null;
  return row && data
    ? { provider: row.provider, label: row.label, data, createdAt: row.createdAt }
    : null;
}

export async function putSecret(
  scope: StoreScope,
  slot: string,
  provider: string,
  label: string,
  data: unknown,
) {
  const sealed = seal(data);
  await db
    .insert(schema.storeSecret)
    .values({ id: nanoid(14), ...scope, slot, provider, label, data: sealed })
    .onConflictDoUpdate({
      target: [schema.storeSecret.wizardId, schema.storeSecret.holder, schema.storeSecret.slot],
      set: { provider, label, data: sealed, updatedAt: new Date() },
    });
  await touchStore(scope);
}

export async function deleteSecret(scope: StoreScope, slot: string) {
  await db
    .delete(schema.storeSecret)
    .where(and(ownSecrets(scope), eq(schema.storeSecret.slot, slot)));
}

export async function listSecrets(scope: StoreScope) {
  const rows = await db.query.storeSecret.findMany({ where: ownSecrets(scope) });
  return rows.map((r) => ({
    slot: r.slot,
    provider: r.provider,
    label: r.label,
    createdAt: r.createdAt.toISOString(),
  }));
}

// --- everything --------------------------------------------------------------

/** Deletes everything the wizard keeps for this person. Blobs stay: other files may share them. */
export async function clearStore(scope: StoreScope) {
  await db
    .delete(schema.storeRow)
    .where(
      and(eq(schema.storeRow.wizardId, scope.wizardId), eq(schema.storeRow.holder, scope.holder)),
    );
  await db.delete(schema.storeFile).where(ownFiles(scope));
  await db.delete(schema.storeSecret).where(ownSecrets(scope));
  await db
    .delete(schema.storeHolder)
    .where(
      and(
        eq(schema.storeHolder.wizardId, scope.wizardId),
        eq(schema.storeHolder.holder, scope.holder),
      ),
    );
}

/** Stores nobody used for STORE_TTL_DAYS are deleted — a visitor's cookie is long gone by then. */
export async function purgeUnusedStores() {
  const cutoff = new Date(Date.now() - env.limits.storeTtlDays * 24 * 60 * 60 * 1000);
  const stale = await db.query.storeHolder.findMany({
    where: lt(schema.storeHolder.usedAt, cutoff),
  });
  for (const scope of stale) {
    await clearStore(scope);
  }
  return stale.length;
}
