import { createHash } from "node:crypto";
import type { PluginMountEntry, PluginMountReader } from "@engenty/wizards/plugin";
import { mergeText } from "@engenty/wizards-shared/text-merge";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { assertRwx, decide, forbidden, type Subject } from "../broker/rwx.js";
import { db, schema } from "../db/client.js";
import { getBlob, putBlob, releaseBlob } from "../files/blobs.js";
import { notFound, ServiceError } from "../services/errors.js";
import { mountFile, mountRow, readerOf, writtenAtSource } from "./mounts.js";

/**
 * Editing a mounted file and „Veröffentlichen“ (docs/plans/media-and-files.md, section 3), as
 * peer-it's Publish does it: an edit stays a draft in engenty, with the file as it was read
 * (`base`); „Veröffentlichen“ writes it through the mount's reader with that version. Changed at
 * the source meanwhile, a text is merged with the change (diff3, text-merge) and written when the
 * merge is clean; else the draft holds what stands there now, and the person compares, keeps
 * theirs („Meine behalten“) or takes the source's („Ihre übernehmen“).
 *
 * Only where the mount allows writing, and only for whom the broker allows `w` on it (its rules
 * give it to the people who see it, never to a wizard). A text file (Markdown, plain text) is
 * edited as text; any other file is replaced by an upload.
 */

type MountRow = typeof schema.spaceMount.$inferSelect;
type FileRow = typeof schema.spaceMountFile.$inferSelect;
type DraftRow = typeof schema.spaceMountDraft.$inferSelect;
type Base = DraftRow["base"];

/** Larger text files are replaced, not edited in the studio. */
const MAX_EDIT_BYTES = 2 * 1024 * 1024;

/** Whether a file is edited as text: Markdown and plain text. */
export function editsAsText(file: Pick<FileRow, "name" | "mime" | "size">): boolean {
  return (
    file.size <= MAX_EDIT_BYTES &&
    (/^text\/(markdown|plain|x-markdown)$/.test(file.mime) ||
      /\.(md|markdown|txt)$/i.test(file.name))
  );
}

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

/** UTF-8 text, or null where the bytes are not. */
function textOf(data: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return null;
  }
}

/** The file as it stands at the source: its entry, bytes and hash, read without a change between. */
async function current(reader: PluginMountReader, path: string, id?: string | null) {
  const opts = id ? { id } : {};
  for (let i = 0; i < 3; i++) {
    const before = await reader.stat(path, opts);
    if (!before) {
      throw new ServiceError("not_found", `"${path}" is not in the folder any more.`);
    }
    const data = await reader.read(path, opts);
    const after = await reader.stat(path, opts);
    if (after && after.size === before.size && after.modified === before.modified) {
      const base: Base = {
        size: after.size,
        modified: after.modified,
        version: after.version,
        hash: sha256(data),
      };
      return { base, data };
    }
  }
  throw new ServiceError("refused", `"${path}" keeps changing. Try again in a moment.`);
}

/**
 * Refused unless the mount allows writing and the broker gives `who` `w` on it. A run's wizard
 * never writes to a mount: what it wants changed, a person publishes.
 */
async function requireWrite(spaceId: string, mount: MountRow, who: Subject[]) {
  if (!mount.writable) {
    throw new ServiceError("read_only", "This folder is read only.");
  }
  if (who.some((s) => s.kind === "wizard")) {
    throw forbidden({ kind: "mount", id: mount.id }, "w");
  }
  // An AI working for a person writes where the person may and the mount lets agents write drafts.
  const agents = who.filter((s) => s.kind === "agent");
  const people = who.filter((s) => s.kind !== "agent");
  await assertRwx(spaceId, people, { kind: "mount", id: mount.id }, "w");
  if (agents.length) {
    await assertRwx(spaceId, agents, { kind: "mount", id: mount.id }, "w");
  }
}

/** „Veröffentlichen“ is a person's: an AI working for one leaves drafts. */
function requirePerson(mount: MountRow, who: Subject[]) {
  if (who.some((s) => s.kind === "agent")) {
    throw forbidden({ kind: "mount", id: mount.id }, "w");
  }
}

async function writable(spaceId: string, mountId: string, who: Subject[]) {
  const mount = await mountRow(spaceId, mountId, who);
  await requireWrite(spaceId, mount, who);
  return mount;
}

async function writableFile(spaceId: string, fileId: string, who: Subject[]) {
  const found = await mountFile(spaceId, fileId, who);
  await requireWrite(spaceId, found.mount, who);
  return found;
}

const draftOf = (fileId: string) =>
  db.query.spaceMountDraft.findFirst({ where: eq(schema.spaceMountDraft.fileId, fileId) });

export interface DraftView {
  /** How it is edited: as text, or replaced by an upload. */
  edit: "text" | "replace";
  /** Whether a draft is kept; else `text` is the file as it stands. */
  draft: boolean;
  /** The draft's text, or the file's; null for a file replaced by an upload. */
  text: string | null;
  /** The text the file had when it was read: a draft saved again from it names it. */
  baseText: string | null;
  /** The file as it was read: what the draft is saved with. */
  base: Base;
  /** What stands at the source now, where it changed since and the merge was not clean. */
  conflict: { text: string | null } | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

const viewOf = (draft: DraftRow): DraftView => ({
  edit: draft.blob ? "replace" : "text",
  draft: true,
  text: draft.text,
  baseText: draft.baseText,
  base: draft.base,
  conflict: draft.conflict ? { text: draft.conflict.text ?? null } : null,
  updatedAt: draft.updatedAt.toISOString(),
  updatedBy: draft.updatedBy,
});

/** The draft of a file, else the file as it stands now, to edit. */
export async function openDraft(
  spaceId: string,
  fileId: string,
  who: Subject[],
): Promise<DraftView> {
  const { mount, file } = await writableFile(spaceId, fileId, who);
  const draft = await draftOf(file.id);
  if (draft) {
    return viewOf(draft);
  }
  const text = editsAsText(file);
  const now = text ? await current(await readerOf(mount), file.path, file.sourceId) : null;
  const words = now ? textOf(now.data) : null;
  if (now && words !== null) {
    return {
      edit: "text",
      draft: false,
      text: words,
      baseText: words,
      base: now.base,
      conflict: null,
      updatedAt: null,
      updatedBy: null,
    };
  }
  const stat = await (await readerOf(mount)).stat(
    file.path,
    file.sourceId ? { id: file.sourceId } : {},
  );
  return {
    edit: "replace",
    draft: false,
    text: null,
    baseText: null,
    base: { size: stat?.size ?? 0, modified: stat?.modified ?? 0, version: null, hash: "" },
    conflict: null,
    updatedAt: null,
    updatedBy: null,
  };
}

/**
 * Keeps a text as the file's draft. The first save names the file as it was opened (`base`, with
 * its text); later ones keep the draft's base. Back to the text it was read as, the draft goes.
 */
export async function saveDraft(
  userId: string,
  spaceId: string,
  fileId: string,
  who: Subject[],
  input: { text: string; base?: Base; baseText?: string },
): Promise<DraftView | null> {
  const { mount, file } = await writableFile(spaceId, fileId, who);
  if (!editsAsText(file)) {
    throw new ServiceError("invalid", `"${file.name}" is not edited as text.`);
  }
  const draft = await draftOf(file.id);
  const d = schema.spaceMountDraft;
  if (draft) {
    if (draft.blob) {
      throw new ServiceError("refused", `"${file.name}" has a replacement waiting.`);
    }
    if (input.text === draft.baseText && !draft.conflict) {
      await db.delete(d).where(eq(d.id, draft.id));
      return null;
    }
    await db
      .update(d)
      .set({ text: input.text, updatedBy: userId, updatedAt: new Date() })
      .where(eq(d.id, draft.id));
    return viewOf((await draftOf(file.id)) as DraftRow);
  }
  const { base, baseText } = input;
  if (!base || baseText === undefined || sha256(Buffer.from(baseText)) !== base.hash) {
    throw new ServiceError("invalid", "The draft needs the file as it was opened.");
  }
  if (input.text === baseText) {
    return null;
  }
  await db.insert(d).values({
    id: nanoid(12),
    spaceId,
    mountId: mount.id,
    fileId: file.id,
    base,
    text: input.text,
    baseText,
    mime: file.mime,
    createdBy: userId,
    updatedBy: userId,
  });
  return viewOf((await draftOf(file.id)) as DraftRow);
}

/** Keeps an upload as the file's draft: it replaces the file as it stands now. */
export async function replaceDraft(
  userId: string,
  spaceId: string,
  fileId: string,
  who: Subject[],
  data: Uint8Array,
  mime: string,
): Promise<DraftView> {
  const { mount, file } = await writableFile(spaceId, fileId, who);
  const old = await draftOf(file.id);
  const { base } = old?.blob ? old : await current(await readerOf(mount), file.path, file.sourceId);
  const blob = await putBlob(data);
  const d = schema.spaceMountDraft;
  if (old) {
    await db
      .update(d)
      .set({
        base,
        text: null,
        baseText: null,
        blob,
        mime,
        updatedBy: userId,
        updatedAt: new Date(),
      })
      .where(eq(d.id, old.id));
    if (old.blob !== blob) {
      await releaseBlob(old.blob);
    }
  } else {
    await db.insert(d).values({
      id: nanoid(12),
      spaceId,
      mountId: mount.id,
      fileId: file.id,
      base,
      blob,
      mime,
      createdBy: userId,
      updatedBy: userId,
    });
  }
  return viewOf((await draftOf(file.id)) as DraftRow);
}

async function dropDraft(draft: DraftRow) {
  await db.delete(schema.spaceMountDraft).where(eq(schema.spaceMountDraft.id, draft.id));
  await releaseBlob(draft.blob);
}

/** Throws the draft away: „Verwerfen“, and „Ihre übernehmen“ in a conflict. */
export async function discardDraft(spaceId: string, fileId: string, who: Subject[]) {
  const { file } = await writableFile(spaceId, fileId, who);
  const draft = await draftOf(file.id);
  if (draft) {
    await dropDraft(draft);
  }
}

export type PublishResult =
  | { ok: true; merged: boolean }
  | { ok: false; conflict: { text: string | null } };

const isConflict = (err: unknown) => (err as { code?: string })?.code === "conflict";

/**
 * Writes a draft to the source with the version it was read at. A change there meanwhile: a text
 * is merged with it and written when clean; else the draft keeps what stands there now.
 */
async function publish(mount: MountRow, file: FileRow, draft: DraftRow): Promise<PublishResult> {
  const reader = await readerOf(mount);
  const id = file.sourceId ? { id: file.sourceId } : {};
  const d = schema.spaceMountDraft;
  let row = draft;
  let merged = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    const data = row.blob ? await getBlob(row.blob) : Buffer.from(row.text ?? "");
    const expected: PluginMountEntry = {
      path: file.path,
      size: row.base.size,
      modified: row.base.modified,
      version: row.base.version,
      ...id,
    };
    let entry: PluginMountEntry | null = null;
    // A source without versions (a folder) is checked by the bytes as well: its time and size
    // can stay the same through a change.
    const stale =
      row.base.version === null &&
      sha256(await reader.read(file.path, id).catch(() => new Uint8Array())) !== row.base.hash;
    if (!stale) {
      try {
        entry = await reader.write(file.path, data, expected);
      } catch (err) {
        if (!isConflict(err)) {
          throw err;
        }
      }
    }
    if (entry) {
      await dropDraft(row);
      await writtenAtSource(file.id, entry);
      return { ok: true, merged };
    }
    const now = await current(reader, file.path, file.sourceId);
    const theirs = row.blob ? null : textOf(now.data);
    if (row.text !== null && row.baseText !== null && theirs !== null) {
      const merge = mergeText(row.baseText, row.text, theirs);
      if (merge.clean) {
        await db
          .update(d)
          .set({ base: now.base, text: merge.text, baseText: theirs, conflict: null })
          .where(eq(d.id, row.id));
        row = (await draftOf(file.id)) as DraftRow;
        merged = true;
        continue;
      }
    }
    await db
      .update(d)
      .set({ conflict: { ...now.base, ...(theirs !== null ? { text: theirs } : {}) } })
      .where(eq(d.id, row.id));
    return { ok: false, conflict: { text: theirs } };
  }
  throw new ServiceError("refused", `"${file.path}" keeps changing. Try again in a moment.`);
}

/** „Veröffentlichen“ for one file's draft. */
export async function publishDraft(
  spaceId: string,
  fileId: string,
  who: Subject[],
): Promise<PublishResult> {
  const { mount, file } = await writableFile(spaceId, fileId, who);
  requirePerson(mount, who);
  const draft = await draftOf(file.id);
  if (!draft) {
    throw notFound();
  }
  if (draft.conflict) {
    return { ok: false, conflict: { text: draft.conflict.text ?? null } };
  }
  return publish(mount, file, draft);
}

/**
 * „Meine behalten“: the draft over what stands at the source now. It takes the source's version
 * as its base and is written; changed there once more, the conflict comes back.
 */
export async function keepMine(
  spaceId: string,
  fileId: string,
  who: Subject[],
): Promise<PublishResult> {
  const { mount, file } = await writableFile(spaceId, fileId, who);
  requirePerson(mount, who);
  const draft = await draftOf(file.id);
  if (!draft?.conflict) {
    throw notFound();
  }
  const { text, ...base } = draft.conflict;
  const d = schema.spaceMountDraft;
  await db
    .update(d)
    .set({ base, baseText: text ?? draft.baseText, conflict: null, updatedAt: new Date() })
    .where(eq(d.id, draft.id));
  return publish(mount, file, (await draftOf(file.id)) as DraftRow);
}

export interface MountDraft {
  fileId: string;
  path: string;
  conflict: boolean;
  updatedAt: string;
  updatedBy: string | null;
}

/** A mount's drafts, for whom may write it; none where it is read only. */
export async function mountDrafts(
  spaceId: string,
  mountId: string,
  who: Subject[],
): Promise<MountDraft[]> {
  const mount = await mountRow(spaceId, mountId, who);
  if (!mount.writable || !(await decide(spaceId, who, { kind: "mount", id: mount.id }, "w")).ok) {
    return [];
  }
  const rows = await db
    .select({
      fileId: schema.spaceMountDraft.fileId,
      path: schema.spaceMountFile.path,
      conflict: schema.spaceMountDraft.conflict,
      updatedAt: schema.spaceMountDraft.updatedAt,
      updatedBy: schema.spaceMountDraft.updatedBy,
    })
    .from(schema.spaceMountDraft)
    .innerJoin(schema.spaceMountFile, eq(schema.spaceMountFile.id, schema.spaceMountDraft.fileId))
    .where(eq(schema.spaceMountDraft.mountId, mount.id));
  return rows
    .map((r) => ({ ...r, conflict: r.conflict !== null, updatedAt: r.updatedAt.toISOString() }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** „Veröffentlichen“ for every draft of a mount that has no conflict. */
export async function publishMount(spaceId: string, mountId: string, who: Subject[]) {
  const mount = await writable(spaceId, mountId, who);
  requirePerson(mount, who);
  const drafts = await db.query.spaceMountDraft.findMany({
    where: eq(schema.spaceMountDraft.mountId, mount.id),
  });
  let published = 0;
  const conflicts: string[] = [];
  for (const draft of drafts.filter((x) => !x.conflict)) {
    const file = await db.query.spaceMountFile.findFirst({
      where: and(
        eq(schema.spaceMountFile.id, draft.fileId),
        eq(schema.spaceMountFile.mountId, mount.id),
      ),
    });
    if (!file) {
      continue;
    }
    const result = await publish(mount, file, draft);
    if (result.ok) {
      published++;
    } else {
      conflicts.push(file.id);
    }
  }
  return { published, conflicts };
}
