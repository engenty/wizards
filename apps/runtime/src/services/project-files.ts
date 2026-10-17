import type { CategoryInput } from "@engenty-wizards/shared/knowledge";
import {
  PROJECT_LIMITS,
  type ProjectFileKind,
  type ProjectFileView,
  projectFileLimit,
} from "@engenty-wizards/shared/projects";
import { note } from "@engenty-wizards/shared/run";
import { generateText } from "ai";
import { and, asc, count, eq, max } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { documentMime, UnreadableDocument } from "../documents/parse.js";
import { loadAsset, removeAsset, replaceAsset, saveAsset } from "../files/storage.js";
import { embeddingModel, textModel } from "../models.js";
import { spaceFileChanged } from "../plugins/events.js";
import { dropLinks, putLink } from "../tenants/control.js";
import { safeFetch } from "../tools/net-guard.js";
import { requireWritableProject } from "./access.js";
import { notFound, ServiceError } from "./errors.js";
import { convertDocument, fillCategories } from "./knowledge-model.js";
import { dropIndex, keepText, queueIndex } from "./project-index.js";
import { type ItemRef, setItemCategories } from "./space-categories.js";

export type ProjectFileRow = typeof schema.projectFile.$inferSelect;

/** Reading a file takes seconds to a few minutes; a row still `pending` after this was cut off. */
const STALE_MS = 15 * 60_000;

const SEEN_BY_MODEL = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export function fileView(row: ProjectFileRow): ProjectFileView {
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

export function projectFiles(projectId: string, kind?: ProjectFileKind) {
  return db.query.projectFile.findMany({
    where: kind
      ? and(eq(schema.projectFile.projectId, projectId), eq(schema.projectFile.kind, kind))
      : eq(schema.projectFile.projectId, projectId),
    orderBy: [asc(schema.projectFile.position), asc(schema.projectFile.createdAt)],
  });
}

export async function projectFile(projectId: string, fileId: string): Promise<ProjectFileRow> {
  const row = await db.query.projectFile.findFirst({
    where: and(eq(schema.projectFile.id, fileId), eq(schema.projectFile.projectId, projectId)),
  });
  if (!row) {
    throw notFound();
  }
  return row;
}

export async function projectFileContent(projectId: string, fileId: string) {
  const row = await projectFile(projectId, fileId);
  const found = await loadAsset(row.id);
  if (!found) {
    throw notFound();
  }
  return { row, data: found.data };
}

/**
 * Assets are what wizards put into what they make: pictures, clips, recordings, and files to
 * hand on as they are — PDFs, fonts, Lottie animations (JSON), 3D models.
 */
const ASSET_TYPES = /^((image|video|audio|font)\/|application\/(pdf|json)$|model\/gltf)/;

function accepts(kind: ProjectFileKind, mime: string): boolean {
  if (kind === "logo" || kind === "pattern") {
    return mime.startsWith("image/");
  }
  if (kind === "asset") {
    return ASSET_TYPES.test(mime);
  }
  return true;
}

export async function addProjectFile(
  projectId: string,
  input: {
    kind: ProjectFileKind;
    name: string;
    mime: string;
    data: Uint8Array;
    description?: string;
    source?: string;
  },
): Promise<ProjectFileRow> {
  await requireWritableProject(projectId);
  const mime = documentMime(input.name, input.mime) || "application/octet-stream";
  if (!accepts(input.kind, mime)) {
    throw new ServiceError(
      "invalid",
      input.kind === "logo"
        ? note("logoImagePngSvg")
        : input.kind === "pattern"
          ? note("patternImageSvgPng")
          : note("filesGoHere"),
    );
  }
  const limit = projectFileLimit(input.kind, mime);
  if (!input.data.byteLength || input.data.byteLength > limit) {
    throw new ServiceError(
      "invalid",
      note("chooseFileUpTo", { mb: Math.round(limit / 1_000_000) }),
    );
  }
  const scope = and(
    eq(schema.projectFile.projectId, projectId),
    eq(schema.projectFile.kind, input.kind),
  );
  const [{ n, last }] = await db
    .select({ n: count(), last: max(schema.projectFile.position) })
    .from(schema.projectFile)
    .where(scope);
  if (n >= PROJECT_LIMITS.files[input.kind]) {
    throw new ServiceError(
      "refused",
      note("roomMostFiles", { count: PROJECT_LIMITS.files[input.kind] }),
    );
  }
  const name = input.name.slice(0, 120) || "datei";
  const ref = await saveAsset({
    kind: input.kind === "logo" ? "logo" : "project",
    mime,
    name,
    data: input.data,
  });
  const description = input.description?.trim().slice(0, 600) ?? "";
  const work = input.kind === "document" || (!description && SEEN_BY_MODEL.includes(mime));
  const [row] = await db
    .insert(schema.projectFile)
    .values({
      id: ref.id,
      projectId,
      kind: input.kind,
      name,
      mime,
      size: input.data.byteLength,
      description,
      source: input.source ?? null,
      position: (last ?? -1) + 1,
      status: work ? "pending" : "ready",
    })
    .returning();
  if (input.kind === "logo") {
    // Logos are shown on public pages, where only the control database knows the tenant.
    await putLink(ref.id, "logo", ref.id);
  }
  if (work) {
    void prepare(row);
  }
  return row;
}

/**
 * Fetches a file from a public web address into the project, as an upload of it would add it.
 * A drawing a page holds inline comes as a `data:image/svg+xml` address. A web page where a
 * picture was asked for is refused with the reason `page`.
 */
export async function addProjectFileFromUrl(
  projectId: string,
  input: { url: string; kind: ProjectFileKind; description?: string; signal?: AbortSignal },
): Promise<ProjectFileRow> {
  const { url, kind, signal } = input;
  const inline = url.match(/^data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)$/);
  if (inline) {
    return addProjectFile(projectId, {
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
  if (Number(res.headers.get("content-length") ?? 0) > projectFileLimit(kind, mime)) {
    throw new ServiceError("invalid", note("addressFileTooLarge"));
  }
  const data = new Uint8Array(await res.arrayBuffer());
  const name = decodeURIComponent(new URL(res.url).pathname.split("/").pop() || kind);
  return addProjectFile(projectId, {
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

async function projectLine(projectId: string): Promise<string> {
  const p = await db.query.project.findFirst({ where: eq(schema.project.id, projectId) });
  return [p?.brand.name || p?.name, p?.brand.about?.slice(0, 300)].filter(Boolean).join(" — ");
}

/** One sentence about a picture, for whoever picks among the project's files later. */
async function describeImage(row: ProjectFileRow, data: Uint8Array): Promise<string> {
  const seer = await textModel("standard");
  const result = await generateText({
    model: seer.model,
    maxOutputTokens: 300,
    system: [
      "You catalogue the files of a project. Describe the picture in ONE sentence of at most 25 words: what it shows, its style and colours, and what it suits (a logo on dark ground, a header image, a team photo, a product shot).",
      "Write in the language of the project's description; if unclear, English. No preamble, no quotes.",
    ].join("\n"),
    messages: [
      {
        role: "user",
        content: [
          { type: "file", data, mediaType: row.mime, filename: row.name },
          {
            type: "text",
            text: `Project: ${await projectLine(row.projectId)}\nFile: ${row.name} (${row.kind})`,
          },
        ],
      },
    ],
  });
  return result.text.trim().slice(0, 600);
}

async function describeDocument(row: ProjectFileRow, text: string): Promise<string> {
  const reader = await textModel("classifier");
  const result = await generateText({
    model: reader.model,
    maxOutputTokens: 300,
    system: [
      "You catalogue the documents of a project. Say in ONE sentence of at most 30 words what this document is and what can be looked up in it.",
      "Write in the document's language. No preamble, no quotes.",
    ].join("\n"),
    prompt: `File: ${row.name}\n\n${text.slice(0, 6000)}`,
  });
  return result.text.trim().slice(0, 600);
}

/**
 * What a document became gets its categories from a model, where the space has some: the first
 * page or table it was read into, else the file itself.
 */
async function categorize(row: ProjectFileRow, items: string[], text: string) {
  const first = items[0];
  const ref: ItemRef = first?.startsWith("p:")
    ? { pageId: first.slice(2) }
    : first?.startsWith("t:")
      ? { tableId: first.slice(2) }
      : { fileId: row.id };
  const changed = await fillCategories(row.projectId, ref, text || row.description, row.name).catch(
    (err) => {
      console.error("[project-file] categories", row.name, err);
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
async function prepare(row: ProjectFileRow) {
  await slot(async () => {
    const set = (values: Partial<ProjectFileRow>) =>
      db
        .update(schema.projectFile)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(schema.projectFile.id, row.id));
    try {
      const found = await loadAsset(row.id);
      if (!found) {
        return;
      }
      const data = new Uint8Array(found.data);
      if (row.kind !== "document") {
        const description = await describeImage(row, data).catch(() => "");
        await set({ status: "ready", ...(description ? { description } : {}) });
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
      console.error("[project-file]", row.name, err);
      await set({
        status: "failed",
        error: err instanceof UnreadableDocument ? err.message : "Reading didn’t work. Try again.",
      });
    }
  });
}

export async function reindexProjectFile(projectId: string, fileId: string) {
  await requireWritableProject(projectId);
  const row = await projectFile(projectId, fileId);
  if (row.kind !== "document") {
    throw new ServiceError("invalid", note("onlyDocumentsIndex"));
  }
  const [pending] = await db
    .update(schema.projectFile)
    .set({ status: "pending", error: null, updatedAt: new Date() })
    .where(eq(schema.projectFile.id, row.id))
    .returning();
  void prepare(pending);
  return pending;
}

export async function updateProjectFile(
  projectId: string,
  fileId: string,
  patch: { name?: string; description?: string },
): Promise<ProjectFileRow> {
  await requireWritableProject(projectId);
  const row = await projectFile(projectId, fileId);
  const [updated] = await db
    .update(schema.projectFile)
    .set({
      ...(patch.name?.trim() ? { name: patch.name.trim().slice(0, 120) } : {}),
      ...(patch.description !== undefined
        ? { description: patch.description.trim().slice(0, 600) }
        : {}),
    })
    .where(eq(schema.projectFile.id, row.id))
    .returning();
  return updated;
}

/** Puts the files of one kind into the order of `ids`; the first logo is the one end users see. */
export async function orderProjectFiles(projectId: string, kind: ProjectFileKind, ids: string[]) {
  await requireWritableProject(projectId);
  const rows = await projectFiles(projectId, kind);
  const order = [...ids.filter((id) => rows.some((r) => r.id === id))];
  for (const r of rows) {
    if (!order.includes(r.id)) {
      order.push(r.id);
    }
  }
  for (const [position, id] of order.entries()) {
    await db.update(schema.projectFile).set({ position }).where(eq(schema.projectFile.id, id));
  }
}

async function removeRow(row: ProjectFileRow) {
  await dropIndex(row.id);
  // What it was read into goes with it; what a person changed since stays.
  const { dropConverted } = await import("./knowledge-model.js");
  await dropConverted(row.id);
  await db.delete(schema.projectFile).where(eq(schema.projectFile.id, row.id));
  await removeAsset(row.id);
  if (row.kind === "logo") {
    await dropLinks([row.id]);
  }
  spaceFileChanged("space.file.removed", row);
}

export async function removeProjectFile(projectId: string, fileId: string) {
  await requireWritableProject(projectId);
  await removeRow(await projectFile(projectId, fileId));
}

/** Before a project goes: its files leave the object store and the public links. */
export async function removeProjectFiles(projectId: string) {
  for (const row of await projectFiles(projectId)) {
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
  await requireWritableProject(input.space);
  const key = input.key.trim().slice(0, 300);
  const existing = await db.query.projectFile.findFirst({
    where: and(
      eq(schema.projectFile.projectId, input.space),
      eq(schema.projectFile.origin, origin),
      eq(schema.projectFile.originKey, key),
    ),
  });
  const mime = documentMime(input.name, input.mime) || "application/octet-stream";
  if (!input.data.byteLength || input.data.byteLength > projectFileLimit("document", mime)) {
    throw new ServiceError("invalid", note("emptyTooLargeDocument", { name: input.name }));
  }
  const name = input.name.slice(0, 120) || "datei";
  const values = {
    name,
    mime,
    size: input.data.byteLength,
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
    await replaceAsset(existing.id, { mime, name, data: input.data });
    await db.update(schema.projectFile).set(values).where(eq(schema.projectFile.id, existing.id));
  } else {
    const [{ n, last }] = await db
      .select({ n: count(), last: max(schema.projectFile.position) })
      .from(schema.projectFile)
      .where(
        and(eq(schema.projectFile.projectId, input.space), eq(schema.projectFile.kind, "document")),
      );
    if (n >= PROJECT_LIMITS.files.document) {
      throw new ServiceError(
        "refused",
        note("spaceMostDocuments", { count: PROJECT_LIMITS.files.document }),
      );
    }
    const ref = await saveAsset({ kind: "project", mime, name, data: input.data });
    id = ref.id;
    await db.insert(schema.projectFile).values({
      id: ref.id,
      projectId: input.space,
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
export async function removeOriginFiles(origin: string, projectId: string, key?: string) {
  const rows = await db.query.projectFile.findMany({
    where: and(
      eq(schema.projectFile.projectId, projectId),
      eq(schema.projectFile.origin, origin),
      key === undefined ? undefined : eq(schema.projectFile.originKey, key),
    ),
  });
  for (const row of rows) {
    await removeRow(row);
  }
  return rows.length;
}
