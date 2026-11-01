import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { PluginMountEntry, PluginMountReader } from "@engenty/wizards/plugin";
import { featureOn } from "@engenty/wizards-shared/features";
import type { ItemCategory } from "@engenty/wizards-shared/knowledge";
import type { RwxRuleInput } from "@engenty/wizards-shared/rwx";
import { embedMany } from "ai";
import { and, asc, eq, inArray, isNotNull, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { readableMounts, type Subject, seedRwx } from "../broker/rwx.js";
import { db, knownTenants, schema, withTenant } from "../db/client.js";
import { documentMime, ownText, type ParsedDocument } from "../documents/parse.js";
import { currentFeatures } from "../features.js";
import { objects } from "../files/objects.js";
import { jpegOf, MAX_PAGE_PICTURES, pdfPages } from "../files/pictures.js";
import { hasThumb, makeThumb } from "../files/thumbs.js";
import { managed } from "../manage.js";
import { embeddingModel } from "../models.js";
import { currentRole, isAdminRole, MEMBERS_EDIT_ONLY } from "../services/access.js";
import { notFound, ServiceError } from "../services/errors.js";
import { itemCategoriesOf, putCategory, setItemCategories } from "../services/space-categories.js";
import { currentTenant } from "../tenants/tenant.js";
import { cachedText, keptText } from "./cache.js";
import { FolderReader, leftOut } from "./folder.js";
import { pathWords, textUnits, unitText } from "./units.js";

/**
 * Dateien (docs/plans/media-and-files.md, section 3): file trees another party owns, mounted in a
 * space and indexed where they live. A folder on this computer is the first kind; every kind
 * reads through the one `PluginMountReader`. Behind the `dateien` switch, and on a local install
 * only while the folder is the only kind.
 *
 * A mount is listed against its rows at start, hourly and when its watcher tells of a change; a
 * file that moved or was renamed keeps its row (found again by its size and time, else its hash),
 * so its categories stay. Indexing comes in three rounds, so words find a folder minutes after it
 * is mounted while the vectors come in the background: first every file's words and thumbnail,
 * then the vectors of the texts, then the pictures (EmbeddingGemma 2, where the model takes them).
 * No text is kept: what needs it reads the original again, through a bounded cache (cache.ts).
 */

type MountRow = typeof schema.spaceMount.$inferSelect;
type FileRow = typeof schema.spaceMountFile.$inferSelect;
type UnitInsert = typeof schema.spaceMountUnit.$inferInsert;

/** Larger files are listed and found by their name, not read. */
const MAX_READ_BYTES = 100 * 1024 * 1024;
/** Larger documents are not read for their text. */
const MAX_TEXT_BYTES = 50 * 1024 * 1024;
/** What has text of its own to read: documents, tables, mails, plain text. */
const TEXT =
  /^(application\/pdf|application\/json|message\/rfc822|text\/|application\/vnd\.openxmlformats-officedocument\.(wordprocessingml|spreadsheetml))/;
/** The pictures the embedding model is shown: what @napi-rs/canvas reads. */
const PICTURE = /^image\/(png|jpeg|webp|gif)$/;
/** A mount's tree is listed again this often, for what a watcher missed. */
const RESCAN_MS = 3600_000;
/** Changes a watcher tells of wait this long, so a copy of many files is one round. */
const SETTLE_MS = 2000;

export async function dateienOn(): Promise<boolean> {
  return featureOn(await currentFeatures(), "dateien");
}

/** Mounts exist only behind the switch, and a folder of this computer only on a local install. */
async function requireDateien(): Promise<void> {
  if (managed || !(await dateienOn())) {
    throw notFound();
  }
}

function requireAdmin(): void {
  if (!isAdminRole(currentRole())) {
    throw new ServiceError("forbidden", MEMBERS_EDIT_ONLY);
  }
}

// --- readers ------------------------------------------------------------------------------

interface Open {
  reader: PluginMountReader;
  cursor: string | null;
  stop?: () => void;
  timer?: NodeJS.Timeout;
}

/** The open mounts of this process, by id: their reader, its cursor, its watcher. */
const opened = new Map<string, Open>();

export function readerOf(mount: MountRow): PluginMountReader {
  let open = opened.get(mount.id);
  if (!open) {
    open = { reader: new FolderReader(mount.source.path), cursor: null };
    opened.set(mount.id, open);
  }
  return open.reader;
}

/** What is told of the paths of a mount that changed: new, changed, moved or gone. */
type ChangeListener = (mount: MountRow, paths: string[]) => void;
const changeListeners: ChangeListener[] = [];

/** Tells `listener` of every change a listing of a mount found, in the mount's tenant. */
export function onMountChanged(listener: ChangeListener) {
  changeListeners.push(listener);
}

/** Starts listening to a mount's source: a change asks for its changes a moment later. */
function watchMount(mount: MountRow) {
  readerOf(mount);
  const open = opened.get(mount.id) as Open;
  if (open.stop || !open.reader.watch) {
    return;
  }
  const tenant = currentTenant();
  open.stop = open.reader.watch(() => {
    clearTimeout(open.timer);
    open.timer = setTimeout(() => queue(tenant, mount.id, "changes"), SETTLE_MS);
    open.timer.unref?.();
  });
}

function closeMount(id: string) {
  const open = opened.get(id);
  clearTimeout(open?.timer);
  open?.stop?.();
  open?.reader.close?.();
  opened.delete(id);
}

const thumbKey = (mountId: string, fileId: string) => `derived/m/${mountId}/${fileId}.jpg`;

// --- the work: listing, indexing, vectors -------------------------------------------------
// One after the other in this process: what a watcher or a scan asks for first, then the next
// file to index, then the next vectors; tenant after tenant.

type JobKind = "scan" | "changes";
const jobs = new Map<string, { tenant: string; mountId: string; kind: JobKind }>();
const active = new Set<string>();
let working: Promise<void> | null = null;
/** Files that failed to embed in this process: not tried again until it restarts. */
const failed = new Set<string>();
/** Calls to the embedding model that failed one after the other: at 3 the vectors wait. */
let inRow = 0;
const MAX_IN_ROW = 3;

function queue(tenant: string, mountId: string, kind: JobKind) {
  const key = `${tenant}|${mountId}`;
  // A scan says everything a list of changes would.
  if (jobs.get(key)?.kind !== "scan") {
    jobs.set(key, { tenant, mountId, kind });
  }
  kick(tenant);
}

function kick(tenant: string) {
  active.add(tenant);
  inRow = 0;
  working ??= work()
    .catch((err) => console.error("[dateien]", err))
    .finally(() => {
      working = null;
      if (jobs.size) {
        kick([...jobs.values()][0].tenant);
      }
    });
}

async function work() {
  for (;;) {
    const [key, job] = [...jobs].find(([, j]) => j.kind === "changes") ?? [...jobs][0] ?? [];
    if (key && job) {
      jobs.delete(key);
      await withTenant(job.tenant, () =>
        job.kind === "scan" ? scanMount(job.mountId) : followChanges(job.mountId),
      ).catch((err) => console.error(`[dateien] ${job.kind} ${job.mountId}`, err));
      continue;
    }
    let progressed = false;
    for (const tenant of [...active]) {
      const did = await withTenant(
        tenant,
        async () => (await indexNext()) || (await embedTexts()) || (await embedPictures()),
      ).catch((err) => {
        console.error(`[dateien] ${tenant}`, err);
        return false;
      });
      if (did) {
        progressed = true;
      } else {
        active.delete(tenant);
      }
    }
    if (!progressed) {
      return;
    }
  }
}

/** Resolves once nothing waits: every mount listed, every file indexed, every vector made. */
export async function flushMounts() {
  while (working) {
    await working;
  }
}

/** At start: every tenant's mounts watched and listed again (a local install has one tenant). */
export async function startMounts() {
  if (managed) {
    return;
  }
  const scanAll = async () => {
    for (const tenant of await knownTenants()) {
      await withTenant(tenant, async () => {
        if (!(await dateienOn())) {
          return;
        }
        for (const mount of await db.query.spaceMount.findMany()) {
          watchMount(mount);
          queue(tenant, mount.id, "scan");
        }
      }).catch((err) => console.error(`[dateien] start ${tenant}`, err));
    }
  };
  await scanAll();
  setInterval(() => void scanAll(), RESCAN_MS).unref();
}

// --- listing -------------------------------------------------------------------------------

async function sourceThere(mount: MountRow): Promise<boolean> {
  return Boolean((await stat(mount.source.path).catch(() => null))?.isDirectory());
}

async function setStatus(mountId: string, status: MountRow["status"], error: string | null) {
  await db
    .update(schema.spaceMount)
    .set({ status, error, updatedAt: new Date() })
    .where(eq(schema.spaceMount.id, mountId));
}

/** Lists the whole tree against the rows. */
export async function scanMount(mountId: string) {
  const mount = await db.query.spaceMount.findFirst({ where: eq(schema.spaceMount.id, mountId) });
  if (!mount) {
    closeMount(mountId);
    return;
  }
  // A drive not plugged in, a folder moved: what was found stays found, nothing opens.
  if (!(await sourceThere(mount))) {
    await setStatus(mount.id, "away", null);
    return;
  }
  await setStatus(mount.id, "scanning", null);
  const reader = readerOf(mount);
  const open = opened.get(mount.id) as Open;
  open.cursor = (await reader.changes(null)).cursor;
  const listed: PluginMountEntry[] = [];
  for await (const entry of reader.list()) {
    listed.push(entry);
  }
  await reconcile(mount, listed, null);
  await db
    .update(schema.spaceMount)
    .set({ status: "ready", scannedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.spaceMount.id, mount.id));
}

/** What the watcher told of: the changes since the last round, or the whole tree again. */
async function followChanges(mountId: string) {
  const mount = await db.query.spaceMount.findFirst({ where: eq(schema.spaceMount.id, mountId) });
  const open = opened.get(mountId);
  if (!(mount && open)) {
    return;
  }
  const changes = await open.reader.changes(open.cursor);
  open.cursor = changes.cursor;
  if (changes.relist) {
    return scanMount(mountId);
  }
  await reconcile(mount, changes.changed, [...changes.gone, ...changes.changed.map((c) => c.path)]);
}

async function hashOf(reader: PluginMountReader, entry: PluginMountEntry) {
  if (entry.size > MAX_READ_BYTES) {
    return null;
  }
  const data = await reader.read(entry.path).catch(() => null);
  return data ? createHash("sha256").update(data).digest("hex") : null;
}

/**
 * Brings the rows in line with what the source listed. `under`: the paths the listing covers
 * (a change's), null for the whole tree. A file listed at a new path that a row no longer
 * listed has (same size and time, else same bytes) is that row, moved: it keeps its id.
 */
async function reconcile(mount: MountRow, listed: PluginMountEntry[], under: string[] | null) {
  const t = schema.spaceMountFile;
  const rows = await db.query.spaceMountFile.findMany({
    where: eq(t.mountId, mount.id),
    columns: { id: true, path: true, size: true, modified: true, hash: true },
  });
  const byPath = new Map(rows.map((r) => [r.path, r]));
  const seen = new Set(listed.map((e) => e.path));
  const covered = (path: string) =>
    under === null || under.some((p) => path === p || path.startsWith(`${p}/`));
  const gone = rows.filter((r) => covered(r.path) && !seen.has(r.path));
  const taken = new Set<string>();
  const fresh: (typeof t.$inferInsert)[] = [];
  const reader = readerOf(mount);
  const now = new Date();
  const changed: string[] = [];
  for (const entry of listed) {
    const mime = documentMime(entry.path, entry.mime ?? "");
    const row = byPath.get(entry.path);
    if (row) {
      if (row.size !== entry.size || row.modified !== entry.modified) {
        changed.push(entry.path);
        await db
          .update(t)
          .set({ size: entry.size, modified: entry.modified, status: "pending", updatedAt: now })
          .where(eq(t.id, row.id));
      }
      continue;
    }
    const alike = gone.filter((g) => g.size === entry.size && !taken.has(g.id));
    let moved = alike.find((g) => g.modified === entry.modified);
    if (!moved && alike.some((g) => g.hash)) {
      const hash = await hashOf(reader, entry);
      moved = alike.find((g) => g.hash && g.hash === hash);
    }
    if (moved) {
      taken.add(moved.id);
      changed.push(moved.path, entry.path);
      // Its words name its path: indexed again, from the cache, keeping its vectors.
      await db
        .update(t)
        .set({
          path: entry.path,
          name: basename(entry.path),
          mime,
          modified: entry.modified,
          status: "pending",
          updatedAt: now,
        })
        .where(eq(t.id, moved.id));
      continue;
    }
    fresh.push({
      id: nanoid(12),
      mountId: mount.id,
      spaceId: mount.spaceId,
      path: entry.path,
      name: basename(entry.path),
      mime,
      size: entry.size,
      modified: entry.modified,
    });
  }
  const removed = gone.filter((g) => !taken.has(g.id));
  for (let i = 0; i < removed.length; i += 500) {
    const ids = removed.slice(i, i + 500).map((r) => r.id);
    await db.delete(t).where(inArray(t.id, ids));
  }
  for (const r of removed) {
    await objects.remove(thumbKey(mount.id, r.id)).catch(() => undefined);
  }
  for (let i = 0; i < fresh.length; i += 200) {
    await db
      .insert(t)
      .values(fresh.slice(i, i + 200))
      .onConflictDoNothing();
  }
  if (fresh.length || taken.size || listed.length) {
    kick(currentTenant());
  }
  changed.push(...fresh.map((f) => f.path), ...removed.map((r) => r.path));
  if (changed.length) {
    for (const listener of changeListeners) {
      listener(mount, changed);
    }
  }
}

// --- indexing a file: words, thumbnail, units ------------------------------------------------

/** The folder of the first level a file lies in, or null for a file at the top. */
const firstFolder = (path: string) => (path.includes("/") ? path.split("/")[0] : null);

/** Files read at once: reading, hashing and drawing a thumbnail wait on the disk and a child. */
const INDEX_LANES = 3;

async function indexNext(): Promise<boolean> {
  const files = await db.query.spaceMountFile.findMany({
    where: eq(schema.spaceMountFile.status, "pending"),
    orderBy: [asc(schema.spaceMountFile.path)],
    limit: INDEX_LANES,
  });
  if (!files.length) {
    return false;
  }
  const mounts = await db.query.spaceMount.findMany({
    where: inArray(schema.spaceMount.id, [...new Set(files.map((f) => f.mountId))]),
  });
  await Promise.all(
    files.map(async (file) => {
      const mount = mounts.find((m) => m.id === file.mountId);
      if (!mount) {
        return;
      }
      try {
        await indexFile(mount, file);
      } catch (err) {
        await db
          .update(schema.spaceMountFile)
          .set({ status: "failed", error: String((err as Error).message ?? err).slice(0, 300) })
          .where(eq(schema.spaceMountFile.id, file.id));
      }
    }),
  );
  return true;
}

/** The text of a file's bytes, read without a model; through the cache. */
function textOf(file: Pick<FileRow, "name" | "mime">, hash: string, data?: Uint8Array) {
  return cachedText(hash, async () =>
    data ? ownText({ data, name: file.name, mime: file.mime }).catch(() => null) : null,
  );
}

const hasText = (file: Pick<FileRow, "mime" | "size">) =>
  TEXT.test(file.mime) && file.size <= MAX_TEXT_BYTES;

/** Reads a file once: its fingerprint, its words, its thumbnail, its units (vectors later). */
async function indexFile(mount: MountRow, file: FileRow) {
  const t = schema.spaceMountFile;
  const u = schema.spaceMountUnit;
  const reader = readerOf(mount);
  const big = file.size > MAX_READ_BYTES;
  const data = big ? null : await reader.read(file.path);
  const hash = data ? createHash("sha256").update(data).digest("hex") : null;
  const same = hash !== null && hash === file.hash;
  const parsed: ParsedDocument | null =
    hash && hasText(file) ? await textOf(file, hash, data ?? undefined) : null;
  const text = parsed?.markdown ?? "";
  const pages = parsed?.pages ?? null;
  const base = { spaceId: mount.spaceId, mountId: mount.id, fileId: file.id };
  const units: UnitInsert[] = [{ ...base, idx: 0 }];
  for (const unit of text ? textUnits(text) : []) {
    units.push({ ...base, idx: units.length, ...unit });
  }
  if (hash && PICTURE.test(file.mime)) {
    units.push({ ...base, idx: units.length, kind: "image" });
  } else if (hash && file.mime === "application/pdf") {
    for (let page = 1; page <= Math.min(pages ?? MAX_PAGE_PICTURES, MAX_PAGE_PICTURES); page++) {
      units.push({ ...base, idx: units.length, kind: "page", sheet: page });
    }
  }
  // The same bytes at another path: every vector but the name's stays.
  const before = same
    ? await db
        .select({
          kind: u.kind,
          sheet: u.sheet,
          start: u.start,
          end: u.end,
          embedding: u.embedding,
          model: u.model,
        })
        .from(u)
        .where(eq(u.fileId, file.id))
    : [];
  const key = (x: Pick<UnitInsert, "kind" | "sheet" | "start" | "end">) =>
    `${x.kind ?? ""}|${x.sheet ?? ""}|${x.start ?? ""}|${x.end ?? ""}`;
  const kept = new Map(before.filter((b) => b.start !== null || b.kind).map((b) => [key(b), b]));
  await db.delete(u).where(eq(u.fileId, file.id));
  const words: [number, string][] = [];
  for (let i = 0; i < units.length; i += 100) {
    const batch = units.slice(i, i + 100).map((unit) => {
      const old = kept.get(key(unit));
      return old ? { ...unit, embedding: old.embedding, model: old.model } : unit;
    });
    const ids = await db.insert(u).values(batch).returning({ id: u.id });
    ids.forEach(({ id }, j) => {
      const unit = batch[j];
      if (unit.idx === 0) {
        words.push([id, pathWords(file.path)]);
      } else if (!unit.kind) {
        words.push([
          id,
          unitText(text, unit as { heading: string | null; start: number; end: number }),
        ]);
      }
    });
  }
  for (let i = 0; i < words.length; i += 50) {
    const part = words.slice(i, i + 50);
    for (const table of ["space_mount_unit_fts", "space_mount_unit_tri"]) {
      await db.run(
        sql`INSERT INTO ${sql.raw(table)}(rowid, text) VALUES ${sql.join(
          part.map(([id, w]) => sql`(${id}, ${w})`),
          sql`, `,
        )}`,
      );
    }
  }
  let thumb = same && file.thumb;
  if (data && !thumb && hasThumb(file.mime)) {
    const made = await makeThumb(data, file.mime);
    if (made) {
      await objects.put(thumbKey(mount.id, file.id), made);
    }
    thumb = Boolean(made);
  }
  await db
    .update(t)
    .set({
      hash,
      pages,
      thumb,
      status: big || (!text && !hasThumb(file.mime)) ? "skipped" : "ready",
      error: null,
      updatedAt: new Date(),
    })
    .where(eq(t.id, file.id));
  const folder = firstFolder(file.path);
  if (mount.folderCategoryId && folder) {
    const category = await db.query.spaceCategory.findFirst({
      where: eq(schema.spaceCategory.id, mount.folderCategoryId),
    });
    if (category) {
      await setItemCategories(
        mount.spaceId,
        { mountFileId: file.id },
        { [category.name]: folder },
        "origin",
      );
    }
  }
}

// --- vectors -------------------------------------------------------------------------------

const vectorBytes = (v: readonly number[]) => Buffer.from(new Float32Array(v).buffer);

/** Units in one call to the embedding model. */
const EMBED_BATCH = 32;

const lacking = (model: string) =>
  or(isNull(schema.spaceMountUnit.model), ne(schema.spaceMountUnit.model, model));

/** The text of a file for its vectors: the cache, else its original read again. */
async function textForVectors(mount: MountRow, file: FileRow): Promise<string> {
  if (!(file.hash && hasText(file))) {
    return "";
  }
  const kept = await keptText(file.hash);
  if (kept !== undefined) {
    return kept?.markdown ?? "";
  }
  const data = await readerOf(mount).read(file.path);
  if (createHash("sha256").update(data).digest("hex") !== file.hash) {
    // Changed since: the next listing indexes it again.
    return "";
  }
  return (await textOf(file, file.hash, data))?.markdown ?? "";
}

/** The vectors of up to EMBED_BATCH passages and names, of the files that lack them. */
async function embedTexts(): Promise<boolean> {
  const resolved = await embeddingModel().catch(() => null);
  // The model is not there or not working: the next start, or the next change, tries again.
  if (!resolved || inRow >= MAX_IN_ROW) {
    return false;
  }
  const u = schema.spaceMountUnit;
  const todo = await db
    .select()
    .from(u)
    .where(
      and(
        isNull(u.kind),
        lacking(resolved.ref),
        failed.size ? notInArray(u.fileId, [...failed]) : undefined,
      ),
    )
    .orderBy(asc(u.fileId), asc(u.idx))
    .limit(EMBED_BATCH);
  if (!todo.length) {
    return false;
  }
  const fileIds = [...new Set(todo.map((x) => x.fileId))];
  const files = await db.query.spaceMountFile.findMany({
    where: inArray(schema.spaceMountFile.id, fileIds),
  });
  const mounts = await db.query.spaceMount.findMany({
    where: inArray(schema.spaceMount.id, [...new Set(files.map((f) => f.mountId))]),
  });
  const texts = new Map<string, string>();
  for (const file of files) {
    const mount = mounts.find((m) => m.id === file.mountId) as MountRow;
    texts.set(file.id, await textForVectors(mount, file).catch(() => ""));
  }
  const values = todo.map((unit) => {
    const file = files.find((f) => f.id === unit.fileId);
    if (!file) {
      return "";
    }
    if (unit.start === null || unit.end === null) {
      return pathWords(file.path);
    }
    return unitText(
      texts.get(file.id) ?? "",
      unit as { heading: string | null; start: number; end: number },
    );
  });
  try {
    const result = await embedMany({
      model: resolved.model,
      values: values.map((v) => v || " "),
      maxParallelCalls: 2,
    });
    for (const [i, unit] of todo.entries()) {
      await db
        .update(u)
        .set({ embedding: vectorBytes(Array.from(result.embeddings[i])), model: resolved.ref })
        .where(eq(u.id, unit.id));
    }
    inRow = 0;
  } catch (err) {
    console.error("[dateien] embedding failed", (err as Error).message);
    inRow++;
    for (const id of fileIds) {
      failed.add(id);
    }
  }
  return true;
}

/** The pictures of the next file whose picture units lack a vector of the model at hand. */
async function embedPictures(): Promise<boolean> {
  const resolved = await embeddingModel().catch(() => null);
  const embedImage = resolved?.embedImage;
  if (!(resolved && embedImage) || inRow >= MAX_IN_ROW) {
    return false;
  }
  const u = schema.spaceMountUnit;
  const first = await db
    .select({ fileId: u.fileId })
    .from(u)
    .where(
      and(
        isNotNull(u.kind),
        lacking(resolved.ref),
        failed.size ? notInArray(u.fileId, [...failed]) : undefined,
      ),
    )
    .limit(1);
  const fileId = first[0]?.fileId;
  if (!fileId) {
    return false;
  }
  const file = await db.query.spaceMountFile.findFirst({
    where: eq(schema.spaceMountFile.id, fileId),
  });
  const mount = file
    ? await db.query.spaceMount.findFirst({ where: eq(schema.spaceMount.id, file.mountId) })
    : undefined;
  if (!(file && mount)) {
    return true;
  }
  const units = await db
    .select({ id: u.id, kind: u.kind, sheet: u.sheet })
    .from(u)
    .where(and(eq(u.fileId, fileId), isNotNull(u.kind), lacking(resolved.ref)));
  try {
    const data = await readerOf(mount).read(file.path);
    const pictures =
      file.mime === "application/pdf"
        ? new Map((await pdfPages(data)).map((p) => [p.page, p.jpeg]))
        : new Map([[0, await jpegOf(data)]]);
    for (const unit of units) {
      const jpeg = pictures.get(unit.kind === "page" ? (unit.sheet ?? 0) : 0);
      if (!jpeg) {
        // A page the PDF does not have.
        await db.delete(u).where(eq(u.id, unit.id));
        continue;
      }
      await db
        .update(u)
        .set({ embedding: vectorBytes(await embedImage(jpeg)), model: resolved.ref })
        .where(eq(u.id, unit.id));
    }
    inRow = 0;
  } catch (err) {
    console.error("[dateien] picture", file.path, (err as Error).message);
    inRow++;
    failed.add(fileId);
  }
  return true;
}

// --- mounts for the studio -------------------------------------------------------------------

export interface MountView {
  id: string;
  name: string;
  slug: string;
  kind: MountRow["kind"];
  /** Where it lives, as its owner calls it: the folder's path. */
  where: string;
  status: MountRow["status"];
  error: string | null;
  files: number;
  bytes: number;
  /** Files not read yet. */
  pending: number;
  /** Text passages and pictures still without a vector. */
  vectorsPending: number;
  scannedAt: string | null;
  folderCategoryId: string | null;
}

function slugOf(name: string): string {
  return (
    name
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "ordner"
  );
}

async function viewOf(mounts: MountRow[]): Promise<MountView[]> {
  if (!mounts.length) {
    return [];
  }
  const ids = mounts.map((m) => m.id);
  const counts = await db.all<{ mount_id: string; n: number; bytes: number; pending: number }>(sql`
    SELECT mount_id, count(*) AS n, coalesce(sum(size), 0) AS bytes,
      sum(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending
    FROM space_mount_file WHERE mount_id IN (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )}) GROUP BY mount_id`);
  const resolved = await embeddingModel().catch(() => null);
  const vectors = resolved
    ? await db.all<{ mount_id: string; n: number }>(sql`
        SELECT mount_id, count(*) AS n FROM space_mount_unit
        WHERE mount_id IN (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )}) AND (model IS NULL OR model != ${resolved.ref})
          ${resolved.embedImage ? sql`` : sql`AND kind IS NULL`}
        GROUP BY mount_id`)
    : [];
  return mounts.map((m) => {
    const c = counts.find((x) => x.mount_id === m.id);
    return {
      id: m.id,
      name: m.name,
      slug: m.slug,
      kind: m.kind,
      where: m.source.path,
      status: m.status,
      error: m.error,
      files: c?.n ?? 0,
      bytes: c?.bytes ?? 0,
      pending: c?.pending ?? 0,
      vectorsPending: vectors.find((v) => v.mount_id === m.id)?.n ?? 0,
      scannedAt: m.scannedAt?.toISOString() ?? null,
      folderCategoryId: m.folderCategoryId,
    };
  });
}

/** The mounts of a space `who` may see. */
export async function listMounts(spaceId: string, who: Subject[]): Promise<MountView[]> {
  await requireDateien();
  const mounts = await db.query.spaceMount.findMany({
    where: eq(schema.spaceMount.spaceId, spaceId),
    orderBy: [asc(schema.spaceMount.createdAt)],
  });
  const ok = await readableMounts(
    spaceId,
    who,
    mounts.map((m) => m.id),
  );
  return viewOf(mounts.filter((m) => ok.has(m.id)));
}

/** A mount `who` may see, or not found. */
export async function mountRow(spaceId: string, mountId: string, who: Subject[]) {
  await requireDateien();
  const mount = await db.query.spaceMount.findFirst({
    where: and(eq(schema.spaceMount.id, mountId), eq(schema.spaceMount.spaceId, spaceId)),
  });
  if (!(mount && (await readableMounts(spaceId, who, [mount.id])).has(mount.id))) {
    throw notFound();
  }
  return mount;
}

export async function mountView(spaceId: string, mountId: string, who: Subject[]) {
  return (await viewOf([await mountRow(spaceId, mountId, who)]))[0];
}

/** Who sees a mount: everybody in the space, or its admins. Which wizards may use it. */
export type MountSee = "all" | "admins";
export type MountWizards = "all" | "none" | string[];

export interface MountInput {
  path: string;
  name?: string;
  see: MountSee;
  wizards: MountWizards;
  /** A category of the folders of the first level, by its name; none for none. */
  folderCategory?: string | null;
}

/** The rules a mount is written with: who sees it, which wizards may use it. */
function mountRules(mountId: string, see: MountSee, wizards: MountWizards): RwxRuleInput[] {
  const rule = (
    subjectKind: RwxRuleInput["subjectKind"],
    subjectId: string | null,
  ): RwxRuleInput => ({
    subjectKind,
    subjectId,
    resourceKind: "mount",
    resourceId: mountId,
    r: "allow",
    w: null,
    x: null,
  });
  const roles = see === "all" ? ["owner", "admin", "member"] : ["owner", "admin"];
  const ids = wizards === "all" ? ["*"] : wizards === "none" ? [] : wizards;
  return [...roles.map((r) => rule("role", r)), ...ids.map((id) => rule("wizard", id))];
}

async function writeRules(spaceId: string, mountId: string, rules: RwxRuleInput[], by: string) {
  const r = schema.rwxRule;
  // A space is seeded where it has no rules yet: a mount's rules first would leave it unseeded.
  if (
    !(await db.query.rwxRule.findFirst({ where: eq(r.spaceId, spaceId), columns: { id: true } }))
  ) {
    await seedRwx(spaceId);
  }
  await db
    .delete(r)
    .where(and(eq(r.spaceId, spaceId), eq(r.resourceKind, "mount"), eq(r.resourceId, mountId)));
  if (rules.length) {
    await db.insert(r).values(
      rules.map((x) => ({
        id: nanoid(12),
        tenantId: currentTenant(),
        spaceId,
        ...x,
        createdBy: by,
      })),
    );
  }
}

/** Mounts a folder of this computer in a space; listing and indexing go on in the background. */
export async function createMount(
  userId: string,
  spaceId: string,
  input: MountInput,
): Promise<MountView> {
  await requireDateien();
  requireAdmin();
  const path = resolve(input.path.replace(/^~(?=$|\/)/, homedir()));
  if (!(await stat(path).catch(() => null))?.isDirectory()) {
    throw new ServiceError("invalid", `There is no folder "${input.path}".`);
  }
  const mounts = await db.query.spaceMount.findMany({
    where: eq(schema.spaceMount.spaceId, spaceId),
  });
  if (mounts.some((m) => m.source.path === path)) {
    throw new ServiceError("refused", `"${path}" is mounted in this space already.`);
  }
  const name = input.name?.trim() || basename(path) || path;
  let slug = slugOf(name);
  for (let n = 2; mounts.some((m) => m.slug === slug); n++) {
    slug = `${slugOf(name)}-${n}`;
  }
  const category = input.folderCategory?.trim()
    ? await putCategory(spaceId, { name: input.folderCategory.trim(), type: "choice" })
    : null;
  const id = nanoid(12);
  await db.insert(schema.spaceMount).values({
    id,
    tenantId: currentTenant(),
    spaceId,
    name,
    slug,
    kind: "folder",
    source: { path },
    folderCategoryId: category?.id ?? null,
    createdBy: userId,
  });
  await writeRules(spaceId, id, mountRules(id, input.see, input.wizards), userId);
  const mount = (await db.query.spaceMount.findFirst({
    where: eq(schema.spaceMount.id, id),
  })) as MountRow;
  watchMount(mount);
  queue(currentTenant(), id, "scan");
  return (await viewOf([mount]))[0];
}

/** Who sees a mount and which wizards may use it, as its rules say. */
export async function mountAccess(
  spaceId: string,
  mountId: string,
): Promise<{ see: MountSee; wizards: MountWizards }> {
  const rules = await db.query.rwxRule.findMany({
    where: and(
      eq(schema.rwxRule.spaceId, spaceId),
      eq(schema.rwxRule.resourceKind, "mount"),
      eq(schema.rwxRule.resourceId, mountId),
    ),
  });
  const allowed = rules.filter((r) => r.r === "allow");
  const wizards = allowed.filter((r) => r.subjectKind === "wizard").map((r) => r.subjectId ?? "");
  return {
    see: allowed.some((r) => r.subjectKind === "role" && r.subjectId === "member")
      ? "all"
      : "admins",
    wizards: wizards.includes("*") ? "all" : wizards.length ? wizards : "none",
  };
}

export async function updateMount(
  userId: string,
  spaceId: string,
  mountId: string,
  who: Subject[],
  patch: { name?: string; see?: MountSee; wizards?: MountWizards },
): Promise<MountView> {
  requireAdmin();
  const mount = await mountRow(spaceId, mountId, who);
  if (patch.name?.trim()) {
    await db
      .update(schema.spaceMount)
      .set({ name: patch.name.trim(), updatedAt: new Date() })
      .where(eq(schema.spaceMount.id, mount.id));
  }
  if (patch.see || patch.wizards) {
    const now = await mountAccess(spaceId, mount.id);
    await writeRules(
      spaceId,
      mount.id,
      mountRules(mount.id, patch.see ?? now.see, patch.wizards ?? now.wizards),
      userId,
    );
  }
  return (
    await viewOf([
      (await db.query.spaceMount.findFirst({
        where: eq(schema.spaceMount.id, mount.id),
      })) as MountRow,
    ])
  )[0];
}

/** Lists a mount's tree again now: "Neu einlesen". */
export async function rescanMount(spaceId: string, mountId: string, who: Subject[]) {
  const mount = await mountRow(spaceId, mountId, who);
  watchMount(mount);
  queue(currentTenant(), mount.id, "scan");
}

/** Takes a mount out of the space: its rows, index, thumbnails and rules. The files stay. */
export async function deleteMount(spaceId: string, mountId: string) {
  await requireDateien();
  requireAdmin();
  const mount = await db.query.spaceMount.findFirst({
    where: and(eq(schema.spaceMount.id, mountId), eq(schema.spaceMount.spaceId, spaceId)),
  });
  if (!mount) {
    throw notFound();
  }
  closeMount(mount.id);
  await writeRules(spaceId, mount.id, [], "");
  await db.delete(schema.spaceMount).where(eq(schema.spaceMount.id, mount.id));
  await objects.removePrefix(`derived/m/${mount.id}/`);
}

// --- a mount's files ------------------------------------------------------------------------

export interface MountFileView {
  id: string;
  path: string;
  name: string;
  mime: string;
  size: number;
  modified: number;
  status: FileRow["status"];
  thumb: boolean;
  pages: number | null;
  /** The space's categories set on it, by category id. */
  categories: ItemCategory[];
}

const fileView = (f: FileRow, categories: ItemCategory[] = []): MountFileView => ({
  id: f.id,
  path: f.path,
  name: f.name,
  mime: f.mime,
  size: f.size,
  modified: f.modified,
  status: f.status,
  thumb: f.thumb,
  pages: f.pages,
  categories,
});

/** Every file of a mount, by path: the studio draws the tree from the paths. */
export async function mountFiles(spaceId: string, mountId: string, who: Subject[]) {
  const mount = await mountRow(spaceId, mountId, who);
  const files = await db.query.spaceMountFile.findMany({
    where: eq(schema.spaceMountFile.mountId, mount.id),
    orderBy: [asc(schema.spaceMountFile.path)],
  });
  const categories = await itemCategoriesOf(files.map((f) => ({ mountFileId: f.id })));
  return files.map((f) => fileView(f, categories.get(`m:${f.id}`)));
}

/** A file of a mount `who` may see. */
export async function mountFile(spaceId: string, fileId: string, who: Subject[]) {
  await requireDateien();
  const file = await db.query.spaceMountFile.findFirst({
    where: and(eq(schema.spaceMountFile.id, fileId), eq(schema.spaceMountFile.spaceId, spaceId)),
  });
  if (!file) {
    throw notFound();
  }
  const mount = await mountRow(spaceId, file.mountId, who);
  return { mount, file };
}

/** One file of a mount, with the mount it lives in: what a search hit (`m:<id>`) opens. */
export async function mountFileView(spaceId: string, fileId: string, who: Subject[]) {
  const { mount, file } = await mountFile(spaceId, fileId, who);
  const categories = await itemCategoriesOf([{ mountFileId: file.id }]);
  return { ...fileView(file, categories.get(`m:${file.id}`)), mountId: mount.id };
}

/** The file's bytes, read from where it lives: nothing of them is kept. */
export async function mountFileContent(spaceId: string, fileId: string, who: Subject[]) {
  const { mount, file } = await mountFile(spaceId, fileId, who);
  const data = await readerOf(mount)
    .read(file.path)
    .catch(() => {
      throw new ServiceError("not_found", `"${file.path}" is not in the folder any more.`);
    });
  return { file, data };
}

export async function mountFileThumb(spaceId: string, fileId: string, who: Subject[]) {
  const { mount, file } = await mountFile(spaceId, fileId, who);
  return file.thumb ? objects.get(thumbKey(mount.id, file.id)) : null;
}

/** A mounted file's text, read from the original through the cache; empty for a picture. */
export async function mountFileText(mount: MountRow, file: FileRow): Promise<string> {
  if (!hasText(file)) {
    return "";
  }
  const data = await readerOf(mount).read(file.path);
  const hash = createHash("sha256").update(data).digest("hex");
  return (await textOf(file, hash, data))?.markdown ?? "";
}

/**
 * The text of units found by a search, for snippets and the classifier: from the cache, else the
 * original read again. Empty where the source is away.
 */
export async function unitTexts(
  units: { fileId: string; heading: string | null; start: number | null; end: number | null }[],
): Promise<string[]> {
  const fileIds = [...new Set(units.map((x) => x.fileId))];
  const files = fileIds.length
    ? await db.query.spaceMountFile.findMany({
        where: inArray(schema.spaceMountFile.id, fileIds),
      })
    : [];
  const mounts = files.length
    ? await db.query.spaceMount.findMany({
        where: inArray(schema.spaceMount.id, [...new Set(files.map((f) => f.mountId))]),
      })
    : [];
  const texts = new Map<string, string>();
  for (const file of files) {
    const mount = mounts.find((m) => m.id === file.mountId) as MountRow;
    texts.set(file.id, await textForVectors(mount, file).catch(() => ""));
  }
  return units.map((x) => {
    const file = files.find((f) => f.id === x.fileId);
    if (!file) {
      return "";
    }
    return x.start === null || x.end === null
      ? pathWords(file.path)
      : unitText(
          texts.get(file.id) ?? "",
          x as { heading: string | null; start: number; end: number },
        );
  });
}

/** The mounts of a space a caller may use: ids with their name and slug. */
export async function usableMounts(spaceId: string, who: Subject[]) {
  if (managed || !(await dateienOn())) {
    return [];
  }
  const mounts = await db.query.spaceMount.findMany({
    where: eq(schema.spaceMount.spaceId, spaceId),
    columns: { id: true, name: true, slug: true },
  });
  const ok = await readableMounts(
    spaceId,
    who,
    mounts.map((m) => m.id),
  );
  return mounts.filter((m) => ok.has(m.id));
}

/** A mounted file by its path for a wizard: `dateien/<mount>/<path>`, among the mounts it may use. */
export async function fileByPath(spaceId: string, path: string, who: Subject[]) {
  const [, slug, ...rest] = path.replace(/^\/+/, "").split("/");
  const mount = (await usableMounts(spaceId, who)).find((m) => m.slug === slug);
  if (!mount) {
    return null;
  }
  const file = await db.query.spaceMountFile.findFirst({
    where: and(
      eq(schema.spaceMountFile.mountId, mount.id),
      eq(schema.spaceMountFile.path, rest.join("/")),
    ),
  });
  const row = await db.query.spaceMount.findFirst({ where: eq(schema.spaceMount.id, mount.id) });
  return file && row ? { mount: row, file } : null;
}

// --- choosing a folder ----------------------------------------------------------------------

/**
 * The system's folder dialog, where this computer has one: macOS `choose folder`, Windows'
 * FolderBrowserDialog, Linux `zenity`. Null when the person cancelled; `false` where there is no
 * dialog (the studio asks for a path instead).
 */
export async function pickFolder(prompt: string): Promise<string | null | false> {
  await requireDateien();
  const run = (cmd: string, args: string[]) =>
    new Promise<string | null | false>((done) => {
      execFile(cmd, args, { timeout: 10 * 60_000 }, (err, stdout) => {
        if (err) {
          // ENOENT: no such program. Else the person cancelled.
          done((err as NodeJS.ErrnoException).code === "ENOENT" ? false : null);
          return;
        }
        done(stdout.trim().replace(/\/$/, "") || null);
      });
    });
  switch (platform()) {
    case "darwin":
      return run("osascript", [
        "-e",
        `tell application (path to frontmost application as text) to POSIX path of (choose folder with prompt ${JSON.stringify(prompt)})`,
      ]);
    case "win32":
      return run("powershell.exe", [
        "-NoProfile",
        "-STA",
        "-Command",
        `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = ${JSON.stringify(prompt)}; if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }`,
      ]);
    default:
      return process.env.DISPLAY || process.env.WAYLAND_DISPLAY
        ? run("zenity", ["--file-selection", "--directory", `--title=${prompt}`])
        : false;
  }
}

/** Folders whose path starts with `typed`, for the path field. */
export async function completeFolder(typed: string): Promise<string[]> {
  await requireDateien();
  const full = typed.replace(/^~(?=$|\/)/, homedir()) || homedir();
  const [dir, start] = full.endsWith("/") ? [full, ""] : [dirname(full), basename(full)];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter(
      (e) =>
        e.isDirectory() && !leftOut(e.name) && e.name.toLowerCase().startsWith(start.toLowerCase()),
    )
    .map((e) => join(dir, e.name))
    .slice(0, 20);
}

/** What a folder holds, before it is mounted: counts, its folders of the first level, what is left out. */
export async function previewFolder(path: string) {
  await requireDateien();
  const root = resolve(path.replace(/^~(?=$|\/)/, homedir()));
  if (!(await stat(root).catch(() => null))?.isDirectory()) {
    throw new ServiceError("invalid", `There is no folder "${path}".`);
  }
  const reader = new FolderReader(root);
  let files = 0;
  let bytes = 0;
  const folders = new Set<string>();
  const first = new Map<string, number>();
  let top = 0;
  const signal = AbortSignal.timeout(20_000);
  try {
    for await (const entry of reader.list("", { signal })) {
      files++;
      bytes += entry.size;
      const parts = entry.path.split("/");
      for (let i = 1; i < parts.length; i++) {
        folders.add(parts.slice(0, i).join("/"));
      }
      if (parts.length > 1) {
        first.set(parts[0], (first.get(parts[0]) ?? 0) + 1);
      } else {
        top++;
      }
    }
  } catch {
    // A tree too large to count in time: what was counted, said as "at least".
  }
  // What the listing leaves out at the top, said in the review.
  const all = await readdir(root).catch(() => [] as string[]);
  return {
    path: root,
    name: basename(root),
    files,
    folders: folders.size,
    bytes,
    complete: !signal.aborted,
    top,
    first: [...first]
      .map(([name, count]) => ({ name, files: count }))
      .sort((a, b) => a.name.localeCompare(b.name, "de")),
    leftOut: all.filter(leftOut).length,
  };
}
