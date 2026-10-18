import {
  cleanPath,
  isTextMime,
  mimeForPath,
  WORKSPACE_LIMITS,
  type WorkspaceFile,
} from "@engenty/wizards-shared/workspace";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { getBlob, putBlob } from "../files/blobs.js";
import { emitDraftChanged, filesChanged } from "./draft-events.js";
import { notFound, ServiceError } from "./errors.js";
import { ownedWizard, writableWizard } from "./wizards.js";

/** The draft's workspace, sorted by path — the same shape publishing and runs snapshot. */
export async function draftFiles(wizardId: string): Promise<WorkspaceFile[]> {
  const rows = await db.query.wizardFile.findMany({
    where: eq(schema.wizardFile.wizardId, wizardId),
    orderBy: [asc(schema.wizardFile.path)],
  });
  return rows.map(({ path, hash, mime, size }) => ({ path, hash, mime, size }));
}

export async function listFiles(userId: string, wizardId: string) {
  const w = await ownedWizard(userId, wizardId);
  return draftFiles(w.id);
}

function requirePath(raw: string): string {
  const path = cleanPath(raw);
  if (!path) {
    throw new ServiceError(
      "invalid",
      `"${raw}" is not a valid file path (letters, digits, - _ . and /, no "..").`,
    );
  }
  return path;
}

export async function readFile(userId: string, wizardId: string, rawPath: string) {
  const w = await ownedWizard(userId, wizardId);
  const path = requirePath(rawPath);
  const row = await db.query.wizardFile.findFirst({
    where: and(eq(schema.wizardFile.wizardId, w.id), eq(schema.wizardFile.path, path)),
  });
  if (!row) {
    throw notFound();
  }
  return { file: row, data: await getBlob(row.hash) };
}

/** Reads a file as text for a model; binary files are described, not dumped. */
export async function readFileText(userId: string, wizardId: string, rawPath: string) {
  const { file, data } = await readFile(userId, wizardId, rawPath);
  if (!isTextMime(file.mime)) {
    return { path: file.path, mime: file.mime, size: file.size, text: null };
  }
  return { path: file.path, mime: file.mime, size: file.size, text: data.toString("utf8") };
}

export async function writeFile(
  userId: string,
  wizardId: string,
  rawPath: string,
  content: Uint8Array | string,
  mime?: string,
): Promise<WorkspaceFile> {
  const w = await writableWizard(userId, wizardId);
  const path = requirePath(rawPath);
  const data = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
  if (data.byteLength > WORKSPACE_LIMITS.fileBytes) {
    throw new ServiceError("invalid", `${path} is larger than 5 MB.`);
  }
  const files = await draftFiles(w.id);
  const others = files.filter((f) => f.path !== path);
  if (others.length >= WORKSPACE_LIMITS.files) {
    throw new ServiceError("invalid", "The workspace already holds 200 files.");
  }
  if (others.reduce((n, f) => n + f.size, 0) + data.byteLength > WORKSPACE_LIMITS.totalBytes) {
    throw new ServiceError("invalid", "The workspace would be larger than 25 MB.");
  }
  const hash = await putBlob(data);
  const file: WorkspaceFile = {
    path,
    hash,
    mime: mime && mime !== "application/octet-stream" ? mime : mimeForPath(path),
    size: data.byteLength,
  };
  await db
    .insert(schema.wizardFile)
    .values({ wizardId: w.id, ...file })
    .onConflictDoUpdate({
      target: [schema.wizardFile.wizardId, schema.wizardFile.path],
      set: { hash: file.hash, mime: file.mime, size: file.size, updatedAt: new Date() },
    });
  await touch(w.id);
  emitDraftChanged(filesChanged(w, path));
  return file;
}

/**
 * Keeps the bytes of files that are about to become a wizard's workspace, checked against the
 * workspace limits, and says how their rows look — without touching the wizard yet. Bytes that
 * nothing comes to refer to take no harm.
 */
export async function keepFiles(
  files: { path: string; mime?: string; data: Uint8Array }[],
): Promise<WorkspaceFile[]> {
  if (files.length > WORKSPACE_LIMITS.files) {
    throw new ServiceError("invalid", `A workspace holds up to ${WORKSPACE_LIMITS.files} files.`);
  }
  let total = 0;
  const kept: WorkspaceFile[] = [];
  for (const file of files) {
    const path = requirePath(file.path);
    if (file.data.byteLength > WORKSPACE_LIMITS.fileBytes) {
      throw new ServiceError("invalid", `${path} is larger than 5 MB.`);
    }
    total += file.data.byteLength;
    if (total > WORKSPACE_LIMITS.totalBytes) {
      throw new ServiceError("invalid", "The workspace would be larger than 25 MB.");
    }
    kept.push({
      path,
      hash: await putBlob(file.data),
      mime: file.mime && file.mime !== "application/octet-stream" ? file.mime : mimeForPath(path),
      size: file.data.byteLength,
    });
  }
  return kept;
}

/** Makes a wizard's workspace exactly `files` (kept with keepFiles): rows only, no bytes. */
export async function replaceFiles(wizardId: string, files: WorkspaceFile[]): Promise<void> {
  const paths = files.map((f) => f.path);
  const before = await draftFiles(wizardId);
  const gone = before.filter((f) => !paths.includes(f.path)).map((f) => f.path);
  if (gone.length) {
    await db
      .delete(schema.wizardFile)
      .where(and(eq(schema.wizardFile.wizardId, wizardId), inArray(schema.wizardFile.path, gone)));
  }
  for (const file of files) {
    await db
      .insert(schema.wizardFile)
      .values({ wizardId, ...file })
      .onConflictDoUpdate({
        target: [schema.wizardFile.wizardId, schema.wizardFile.path],
        set: { hash: file.hash, mime: file.mime, size: file.size, updatedAt: new Date() },
      });
  }
}

export async function deleteFile(userId: string, wizardId: string, rawPath: string) {
  const w = await writableWizard(userId, wizardId);
  const path = requirePath(rawPath);
  const gone = await db
    .delete(schema.wizardFile)
    .where(and(eq(schema.wizardFile.wizardId, w.id), eq(schema.wizardFile.path, path)))
    .returning({ path: schema.wizardFile.path });
  if (!gone.length) {
    throw notFound();
  }
  await touch(w.id);
  emitDraftChanged(filesChanged(w, path));
}

/** Copies a workspace onto another wizard (duplicate). Blobs are shared, only rows are new. */
export async function copyFiles(fromWizardId: string, toWizardId: string) {
  const files = await draftFiles(fromWizardId);
  if (files.length) {
    await db.insert(schema.wizardFile).values(files.map((f) => ({ wizardId: toWizardId, ...f })));
  }
}

/** The files a new wizard starts with (a starter's widget, price list, reference text). */
export async function seedFiles(wizardId: string, files: Record<string, string | Uint8Array>) {
  const rows: (WorkspaceFile & { wizardId: string })[] = [];
  for (const [path, content] of Object.entries(files)) {
    const data = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
    rows.push({
      wizardId,
      path: requirePath(path),
      hash: await putBlob(data),
      mime: mimeForPath(path),
      size: data.byteLength,
    });
  }
  if (rows.length) {
    await db.insert(schema.wizardFile).values(rows);
  }
}

async function touch(wizardId: string) {
  await db
    .update(schema.wizard)
    .set({ updatedAt: new Date() })
    .where(eq(schema.wizard.id, wizardId));
}

/** The content of one file of a snapshot (a run's or a version's), by path. */
export async function snapshotFile(files: WorkspaceFile[], path: string) {
  const file = files.find((f) => f.path === path);
  return file ? { file, data: await getBlob(file.hash) } : null;
}

export function sameFiles(a: WorkspaceFile[], b: WorkspaceFile[]): boolean {
  return a.length === b.length && a.every((f, i) => f.path === b[i].path && f.hash === b[i].hash);
}
