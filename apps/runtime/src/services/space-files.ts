import type { CategoryInput } from "@engenty/wizards-shared/knowledge";
import { note } from "@engenty/wizards-shared/run";
import {
  SPACE_LIMITS,
  type SpaceFileKind,
  type SpaceFileView,
  spaceFileLimit,
} from "@engenty/wizards-shared/spaces";
import { generateText } from "ai";
import { and, asc, count, eq, max } from "drizzle-orm";
import { nanoid } from "nanoid";
import { assertRwx, type Subject } from "../broker/rwx.js";
import { db, schema } from "../db/client.js";
import { documentMime, UnreadableDocument } from "../documents/parse.js";
import { getBlob, putBlob, releaseBlob } from "../files/blobs.js";
import { checkUpload } from "../files/upload-check.js";
import { embeddingModel, textModel } from "../models.js";
import { spaceFileChanged } from "../plugins/events.js";
import { prompt } from "../prompts.js";
import { dropLinks, putLink } from "../tenants/control.js";
import { safeFetch } from "../tools/net-guard.js";
import { requireWritableSpace } from "./access.js";
import { notFound, ServiceError } from "./errors.js";
import { convertDocument, fillCategories } from "./knowledge-model.js";
import { type ItemRef, setItemCategories } from "./space-categories.js";
import { dropIndex, indexedFile, keepText, queueIndex } from "./space-index.js";

export type SpaceFileRow = typeof schema.spaceFile.$inferSelect;

/** Reading a file takes seconds to a few minutes; a row still `pending` after this was cut off. */
const STALE_MS = 15 * 60_000;

const SEEN_BY_MODEL = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export function fileView(row: SpaceFileRow): SpaceFileView {
  const stale = row.status === "pending" && Date.now() - row.updatedAt.getTime() > STALE_MS;
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    mime: row.mime,
    size: row.size,
    description: row.description,
    source: row.source,
    status: stale ? "failed" : row.status,
    error: stale ? "Reading was interrupted. Read it in again." : row.error,
    indexed: row.indexed,
    pages: row.pages,
    chars: row.chars,
    createdAt: row.createdAt.toISOString(),
  };
}

export function spaceFiles(spaceId: string, kind?: SpaceFileKind) {
  return db.query.spaceFile.findMany({
    where: kind
      ? and(eq(schema.spaceFile.spaceId, spaceId), eq(schema.spaceFile.kind, kind))
      : eq(schema.spaceFile.spaceId, spaceId),
    orderBy: [asc(schema.spaceFile.position), asc(schema.spaceFile.createdAt)],
  });
}

export async function spaceFile(spaceId: string, fileId: string): Promise<SpaceFileRow> {
  const row = await db.query.spaceFile.findFirst({
    where: and(eq(schema.spaceFile.id, fileId), eq(schema.spaceFile.spaceId, spaceId)),
  });
  if (!row) {
    throw notFound();
  }
  return row;
}

/** A file's bytes, from the blob store; null when they are not there. */
export async function spaceFileBytes(row: SpaceFileRow): Promise<Buffer | null> {
  return row.hash ? getBlob(row.hash).catch(() => null) : null;
}

/**
 * A file's bytes. A document's go out only to a `who` the broker lets read it (broker/rwx.ts),
 * and to nobody when none is given; a logo, pattern or asset is the brand's, not Knowledge, and
 * asks nobody.
 */
export async function spaceFileContent(spaceId: string, fileId: string, who: Subject[] = []) {
  const row = await spaceFile(spaceId, fileId);
  if (row.kind === "document") {
    await assertRwx(spaceId, who, { kind: "document", id: row.id }, "r");
  }
  const data = await spaceFileBytes(row);
  if (!data) {
    throw notFound();
  }
  return { row, data };
}

/**
 * Assets are what wizards put into what they make: pictures, clips, recordings, and files to
 * hand on as they are — PDFs, fonts, Lottie animations (JSON), 3D models.
 */
const ASSET_TYPES = /^((image|video|audio|font)\/|application\/(pdf|json)$|model\/gltf)/;

function accepts(kind: SpaceFileKind, mime: string): boolean {
  if (kind === "logo" || kind === "pattern") {
    return mime.startsWith("image/");
  }
  if (kind === "asset") {
    return ASSET_TYPES.test(mime);
  }
  return true;
}

export async function addSpaceFile(
  spaceId: string,
  input: {
    kind: SpaceFileKind;
    name: string;
    mime: string;
    data: Uint8Array;
    description?: string;
    source?: string;
  },
): Promise<SpaceFileRow> {
  await requireWritableSpace(spaceId);
  const declared = documentMime(input.name, input.mime) || "application/octet-stream";
  if (!accepts(input.kind, declared)) {
    throw new ServiceError(
      "invalid",
      input.kind === "logo"
        ? note("logoImagePngSvg")
        : input.kind === "pattern"
          ? note("patternImageSvgPng")
          : note("filesGoHere"),
    );
  }
  const limit = spaceFileLimit(input.kind, declared);
  if (!input.data.byteLength || input.data.byteLength > limit) {
    throw new ServiceError(
      "invalid",
      note("chooseFileUpTo", { mb: Math.round(limit / 1_000_000) }),
    );
  }
  // The bytes say what the file is; a picture is drawn again without its metadata.
  const checked = await checkUpload({
    name: input.name,
    mime: declared,
    data: input.data,
    fallbackName: "datei",
  });
  const { mime, data, name } = checked;
  const scope = and(eq(schema.spaceFile.spaceId, spaceId), eq(schema.spaceFile.kind, input.kind));
  const [{ n, last }] = await db
    .select({ n: count(), last: max(schema.spaceFile.position) })
    .from(schema.spaceFile)
    .where(scope);
  if (n >= SPACE_LIMITS.files[input.kind]) {
    throw new ServiceError(
      "refused",
      note("roomMostFiles", { count: SPACE_LIMITS.files[input.kind] }),
    );
  }
  const hash = await putBlob(data);
  const description = input.description?.trim().slice(0, 600) ?? "";
  const work = input.kind === "document" || (!description && SEEN_BY_MODEL.includes(mime));
  const [row] = await db
    .insert(schema.spaceFile)
    .values({
      id: nanoid(16),
      spaceId,
      kind: input.kind,
      name,
      mime,
      size: data.byteLength,
      hash,
      description,
      source: input.source ?? null,
      position: (last ?? -1) + 1,
      status: work ? "pending" : "ready",
    })
    .returning();
  if (input.kind === "logo") {
    // Logos are shown on public pages, where only the control database knows the tenant.
    await putLink(row.id, "logo", row.id);
  }
  if (work) {
    void prepare(row);
  } else if (indexedFile(row)) {
    queueIndex(`f:${row.id}`);
  }
  return row;
}

/**
 * Fetches a file from a public web address into the space, as an upload of it would add it.
 * A drawing a page holds inline comes as a `data:image/svg+xml` address. A web page where a
 * picture was asked for is refused with the reason `page`.
 */
export async function addSpaceFileFromUrl(
  spaceId: string,
  input: { url: string; kind: SpaceFileKind; description?: string; signal?: AbortSignal },
): Promise<SpaceFileRow> {
  const { url, kind, signal } = input;
  const inline = url.match(/^data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)$/);
  if (inline) {
    return addSpaceFile(spaceId, {
      kind,
      name: `${kind}.svg`,
      mime: "image/svg+xml",
      data: new Uint8Array(Buffer.from(inline[1], "base64")),
      description: input.description,
    });
  }
  const res = await safeFetch(url, {
    headers: { "user-agent": "Mozilla/5.0 (compatible; engenty-wizards/0.1)" },
    signal: AbortSignal.any([AbortSignal.timeout(60_000), ...(signal ? [signal] : [])]),
  }).catch(() => {
    throw new ServiceError("invalid", note("addressNotReached"));
  });
  if (!res.ok) {
    throw new ServiceError("invalid", note("addressResponded", { status: res.status }));
  }
  const mime = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (mime === "text/html" && kind !== "document") {
    await res.body?.cancel();
    throw new ServiceError("invalid", note("addressLeadsWebPage"), {
      reason: "page",
      url: res.url,
    });
  }
  if (Number(res.headers.get("content-length") ?? 0) > spaceFileLimit(kind, mime)) {
    throw new ServiceError("invalid", note("addressFileTooLarge"));
  }
  const data = new Uint8Array(await res.arrayBuffer());
  const name = decodeURIComponent(new URL(res.url).pathname.split("/").pop() || kind);
  return addSpaceFile(spaceId, {
    kind,
    name,
    mime,
    data,
    description: input.description,
    source: res.url,
  });
}

// --- reading, describing, indexing -------------------------------------------------

/** Files are worked through two at a time: each costs model calls. */
let running = 0;
const waiting: (() => void)[] = [];

async function slot<T>(run: () => Promise<T>): Promise<T> {
  if (running >= 2) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  running++;
  try {
    return await run();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

async function spaceLine(spaceId: string): Promise<string> {
  const p = await db.query.space.findFirst({ where: eq(schema.space.id, spaceId) });
  return [p?.brand.name || p?.name, p?.brand.about?.slice(0, 300)].filter(Boolean).join(" — ");
}

/** One sentence about a picture, for whoever picks among the space's files later. */
async function describeImage(row: SpaceFileRow, data: Uint8Array): Promise<string> {
  const seer = await textModel("low");
  const result = await generateText({
    model: seer.model,
    maxOutputTokens: 300,
    system: prompt("services", "describe.image"),
    messages: [
      {
        role: "user",
        content: [
          { type: "file", data, mediaType: row.mime, filename: row.name },
          {
            type: "text",
            text: `Space: ${await spaceLine(row.spaceId)}\nFile: ${row.name} (${row.kind})`,
          },
        ],
      },
    ],
  });
  return result.text.trim().slice(0, 600);
}

async function describeDocument(row: SpaceFileRow, text: string): Promise<string> {
  const reader = await textModel("classifier");
  const result = await generateText({
    model: reader.model,
    maxOutputTokens: 300,
    system: prompt("services", "describe.document"),
    prompt: `File: ${row.name}\n\n${text.slice(0, 6000)}`,
  });
  return result.text.trim().slice(0, 600);
}

/**
 * What a document became gets its categories from a model, where the space has some: the first
 * page or table it was read into, else the file itself.
 */
async function categorize(row: SpaceFileRow, items: string[], text: string) {
  const first = items[0];
  const ref: ItemRef = first?.startsWith("p:")
    ? { pageId: first.slice(2) }
    : first?.startsWith("t:")
      ? { tableId: first.slice(2) }
      : { fileId: row.id };
  const changed = await fillCategories(row.spaceId, ref, text || row.description, row.name).catch(
    (err) => {
      console.error("[space-file] categories", row.name, err);
      return false;
    },
  );
  if (changed) {
    queueIndex(first ? `${first[0] === "p" ? "P" : "t"}:${first.slice(2)}` : `f:${row.id}`);
  }
}

/**
 * Reads a new file. A document is read into Knowledge — a page, a page with sub-pages, a table per
 * sheet — and stays as the original behind it; one that reads into nothing stays a file, found
 * by its name and description. A file nobody described is described.
 */
async function prepare(row: SpaceFileRow) {
  await slot(async () => {
    const set = (values: Partial<SpaceFileRow>) =>
      db
        .update(schema.spaceFile)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(schema.spaceFile.id, row.id));
    try {
      const found = await spaceFileBytes(row);
      if (!found) {
        return;
      }
      const data = new Uint8Array(found);
      if (row.kind !== "document") {
        const description = await describeImage(row, data).catch(() => "");
        await set({ status: "ready", ...(description ? { description } : {}) });
        if (indexedFile(row)) {
          queueIndex(`f:${row.id}`);
        }
        spaceFileChanged("space.file.ready", row);
        return;
      }
      const { text, items, ...read } = await convertDocument(row, data);
      const description =
        row.description || (text ? await describeDocument(row, text).catch(() => "") : "");
      const embeddings = Boolean(await embeddingModel().catch(() => null));
      await set({
        ...read,
        indexed: embeddings ? "embeddings" : "keywords",
        status: "ready",
        error: null,
        description,
      });
      queueIndex(`f:${row.id}`);
      await categorize({ ...row, description }, items, text);
      spaceFileChanged("space.file.ready", row);
    } catch (err) {
      console.error("[space-file]", row.name, err);
      await set({
        status: "failed",
        error: err instanceof UnreadableDocument ? err.message : "Reading didn’t work. Try again.",
      });
    }
  });
}

export async function reindexSpaceFile(spaceId: string, fileId: string) {
  await requireWritableSpace(spaceId);
  const row = await spaceFile(spaceId, fileId);
  if (row.kind !== "document") {
    throw new ServiceError("invalid", note("onlyDocumentsIndex"));
  }
  const [pending] = await db
    .update(schema.spaceFile)
    .set({ status: "pending", error: null, updatedAt: new Date() })
    .where(eq(schema.spaceFile.id, row.id))
    .returning();
  void prepare(pending);
  return pending;
}

export async function updateSpaceFile(
  spaceId: string,
  fileId: string,
  patch: { name?: string; description?: string },
): Promise<SpaceFileRow> {
  await requireWritableSpace(spaceId);
  const row = await spaceFile(spaceId, fileId);
  const [updated] = await db
    .update(schema.spaceFile)
    .set({
      ...(patch.name?.trim() ? { name: patch.name.trim().slice(0, 120) } : {}),
      ...(patch.description !== undefined
        ? { description: patch.description.trim().slice(0, 600) }
        : {}),
    })
    .where(eq(schema.spaceFile.id, row.id))
    .returning();
  // Its name and description are what the index finds an asset by.
  if (indexedFile(updated) && (patch.name !== undefined || patch.description !== undefined)) {
    queueIndex(`f:${row.id}`);
  }
  return updated;
}

/** Puts the files of one kind into the order of `ids`; the first logo is the one end users see. */
export async function orderSpaceFiles(spaceId: string, kind: SpaceFileKind, ids: string[]) {
  await requireWritableSpace(spaceId);
  const rows = await spaceFiles(spaceId, kind);
  const order = [...ids.filter((id) => rows.some((r) => r.id === id))];
  for (const r of rows) {
    if (!order.includes(r.id)) {
      order.push(r.id);
    }
  }
  for (const [position, id] of order.entries()) {
    await db.update(schema.spaceFile).set({ position }).where(eq(schema.spaceFile.id, id));
  }
}

async function removeRow(row: SpaceFileRow) {
  await dropIndex(row.id);
  // What it was read into goes with it; what a person changed since stays.
  const { dropConverted } = await import("./knowledge-model.js");
  await dropConverted(row.id);
  await db.delete(schema.spaceFile).where(eq(schema.spaceFile.id, row.id));
  await releaseBlob(row.hash);
  await releaseBlob(row.textHash);
  if (row.kind === "logo" || row.mime.startsWith("font/")) {
    await dropLinks([row.id]);
  }
  spaceFileChanged("space.file.removed", row);
}

export async function removeSpaceFile(spaceId: string, fileId: string) {
  await requireWritableSpace(spaceId);
  await removeRow(await spaceFile(spaceId, fileId));
}

/** Before a space goes: its files leave the object store and the public links. */
export async function removeSpaceFiles(spaceId: string) {
  for (const row of await spaceFiles(spaceId)) {
    await removeRow(row);
  }
}

// --- what plugins keep as files ----------------------------------------------------

/**
 * A plugin's file of Knowledge (`server.spaceData.putFile`, or the original of a page it wrote):
 * a document of the space under the plugin's key. The same key again replaces it. `text`: what
 * a step reads of it; without one only its name and description are found.
 */
export async function putOriginFile(
  origin: string,
  input: {
    space: string;
    key: string;
    label?: string | null;
    name: string;
    mime: string;
    data: Uint8Array;
    description?: string;
    text?: string;
    categories?: CategoryInput;
  },
): Promise<string> {
  await requireWritableSpace(input.space);
  const key = input.key.trim().slice(0, 300);
  const existing = await db.query.spaceFile.findFirst({
    where: and(
      eq(schema.spaceFile.spaceId, input.space),
      eq(schema.spaceFile.origin, origin),
      eq(schema.spaceFile.originKey, key),
    ),
  });
  const mime = documentMime(input.name, input.mime) || "application/octet-stream";
  if (!input.data.byteLength || input.data.byteLength > spaceFileLimit("document", mime)) {
    throw new ServiceError("invalid", note("emptyTooLargeDocument", { name: input.name }));
  }
  const name = input.name.slice(0, 120) || "datei";
  const values = {
    name,
    mime,
    size: input.data.byteLength,
    hash: await putBlob(input.data),
    description: input.description?.trim().slice(0, 600) ?? existing?.description ?? "",
    originLabel: input.label?.trim().slice(0, 120) || null,
    status: "ready" as const,
    error: null,
    textHash: input.text ? await keepText(input.text) : null,
    chars: input.text?.length ?? null,
    updatedAt: new Date(),
  };
  let id = existing?.id;
  if (existing) {
    // New content under the id it has: pages that name it as their original keep it.
    await db.update(schema.spaceFile).set(values).where(eq(schema.spaceFile.id, existing.id));
    await releaseBlob(existing.hash);
    await releaseBlob(existing.textHash);
  } else {
    const [{ n, last }] = await db
      .select({ n: count(), last: max(schema.spaceFile.position) })
      .from(schema.spaceFile)
      .where(and(eq(schema.spaceFile.spaceId, input.space), eq(schema.spaceFile.kind, "document")));
    if (n >= SPACE_LIMITS.files.document) {
      throw new ServiceError(
        "refused",
        note("spaceMostDocuments", { count: SPACE_LIMITS.files.document }),
      );
    }
    id = nanoid(16);
    await db.insert(schema.spaceFile).values({
      id,
      spaceId: input.space,
      kind: "document",
      position: (last ?? -1) + 1,
      origin,
      originKey: key,
      ...values,
    });
  }
  if (input.categories) {
    await setItemCategories(input.space, { fileId: id as string }, input.categories, "origin");
  }
  queueIndex(`f:${id}`);
  return id as string;
}

/** Takes out a plugin's files, by key or all of them in the space; returns how many went. */
export async function removeOriginFiles(origin: string, spaceId: string, key?: string) {
  const rows = await db.query.spaceFile.findMany({
    where: and(
      eq(schema.spaceFile.spaceId, spaceId),
      eq(schema.spaceFile.origin, origin),
      key === undefined ? undefined : eq(schema.spaceFile.originKey, key),
    ),
  });
  for (const row of rows) {
    await removeRow(row);
  }
  return rows.length;
}
