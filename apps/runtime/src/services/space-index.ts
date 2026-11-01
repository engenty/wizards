import type { PluginIndexEntry } from "@engenty/wizards/plugin";
import { formatTableCell } from "@engenty/wizards-shared/engenty/data-tables";
import { featureOn } from "@engenty/wizards-shared/features";
import type { KnowledgeHit, KnowledgeSearch, Where } from "@engenty/wizards-shared/knowledge";
import { embedMany } from "ai";
import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import {
  brokerOn,
  forbidden,
  pageResources,
  readable,
  readsEverything,
  type Subject,
  tableResources,
} from "../broker/rwx.js";
import { db, schema, withTenant } from "../db/client.js";
import { createSearchChunks } from "../engenty/search-index/chunks.js";
import { currentFeatures } from "../features.js";
import { getBlob, putBlob } from "../files/blobs.js";
import { jpegOf, MAX_PAGE_PICTURES, pdfPages } from "../files/pictures.js";
import { embeddingModel } from "../models.js";
import { unitTexts, usableMounts } from "../mounts/mounts.js";
import { pluginIdsOf } from "../plugins/registry.js";
import { currentTenant } from "../tenants/tenant.js";
import { ServiceError } from "./errors.js";
import { filePaths, pageTree, tablePaths } from "./knowledge.js";
import { judgeRelevance, MIN_RELEVANCE } from "./relevance.js";
import {
  categoryLines,
  categoryRows,
  type Filtered,
  filterItems,
  itemCategoriesOf,
} from "./space-categories.js";

/**
 * The index of Knowledge. Units follow the structure: a section of a page under its headings, a row
 * of a table, a file, the summary of a category's value, and the texts plugins put in. A unit
 * is never cut in the middle of a paragraph, and its text starts with where it stands and the
 * categories of its item, so keywords and vectors both see the context.
 *
 * A unit is kept three times: its words in an FTS5 table, its trigrams in another (codes, parts of
 * compounds), its meaning as a vector where an embedding model is set up. A search filters by
 * categories first, merges what the three find by rank, asks a classifier which candidates help
 * answer the question, and gives items, each with its best section.
 *
 * Where the embedding model takes pictures (EmbeddingGemma 2, while `knowledgeMedia` is on), a
 * picture file and the first pages of a PDF are units of their own too, whose vector is of the
 * picture: a question finds a photo by what it shows. Their vectors come in the background.
 */

type FileRow = typeof schema.spaceFile.$inferSelect;
type ChunkInsert = typeof schema.spaceChunk.$inferInsert;
type Unit = Omit<ChunkInsert, "embedding" | "model">;

const CHUNK = { mode: "paragraph" as const, max_chunk_length: 1200, overlap: 120 };
/** Units of one item; a longer one keeps its start. */
const MAX_UNITS = 2000;
/** A section longer than this is cut at paragraphs into parts about PART_CHARS long. */
const SECTION_CHARS = 2400;
const PART_CHARS = 1800;
/** What the keywords and the vectors hand on to the classifier. */
const CANDIDATES = 24;
/**
 * How far the nearest unit has to stand out from the median one to count (cosine), as peer-it
 * has it: the nearest units are near even for a question the space knows nothing of.
 */
const MIN_LEAD = 0.08;

const vectorBytes = (v: readonly number[]) => Buffer.from(new Float32Array(v).buffer);

async function embed(texts: string[]): Promise<{ vectors: number[][]; model: string } | null> {
  const resolved = await embeddingModel();
  if (!resolved || !texts.length) {
    return null;
  }
  const result = await embedMany({ model: resolved.model, values: texts, maxParallelCalls: 4 });
  return { vectors: result.embeddings.map((e) => Array.from(e)), model: resolved.ref };
}

export async function dropIndex(fileId: string) {
  await db.delete(schema.spaceChunk).where(eq(schema.spaceChunk.fileId, fileId));
}

export async function documentText(file: FileRow): Promise<string> {
  return file.textHash ? (await getBlob(file.textHash)).toString("utf8") : "";
}

/** Keeps a document's text, for a step that reads the file itself. */
export async function keepText(text: string) {
  return putBlob(Buffer.from(text, "utf8"));
}

/** A picture unit is the same picture while its kind, page and fingerprint (`ref`) are. */
const pictureKey = (u: { kind?: string | null; sheet?: number | null; ref?: string | null }) =>
  `${u.kind}|${u.sheet}|${u.ref}`;

/**
 * Replaces the units `scope` held with `units`. A unit whose text has not changed keeps its
 * vector: editing one row of a long table embeds one row. A picture keeps its vector while it is
 * the same picture; a new one gets it in the background (`queuePictures`).
 */
async function writeUnits(scope: SQL, units: Unit[]) {
  const before = await db
    .select({
      text: schema.spaceChunk.text,
      embedding: schema.spaceChunk.embedding,
      model: schema.spaceChunk.model,
      kind: schema.spaceChunk.kind,
      sheet: schema.spaceChunk.sheet,
      ref: schema.spaceChunk.ref,
    })
    .from(schema.spaceChunk)
    .where(scope);
  const resolved = await embeddingModel().catch(() => null);
  const current = before.filter((b) => b.embedding && b.model && b.model === resolved?.ref);
  const kept = new Map(current.filter((b) => !b.kind).map((b) => [b.text, b.embedding as Buffer]));
  const pictures = new Map(
    current.filter((b) => b.kind).map((b) => [pictureKey(b), b.embedding as Buffer]),
  );
  const missing = [
    ...new Set(
      units
        .filter((u) => !u.kind)
        .map((u) => u.text)
        .filter((t) => !kept.has(t)),
    ),
  ];
  // Without an embedding model, or when it fails, the keywords still find the unit.
  const embedded = await embed(missing).catch((err) => {
    console.error("[space-index] embedding failed", err);
    return null;
  });
  if (embedded) {
    for (const [i, text] of missing.entries()) {
      kept.set(text, vectorBytes(embedded.vectors[i]));
    }
  }
  const model = embedded?.model ?? (kept.size ? (resolved?.ref ?? null) : null);
  await db.delete(schema.spaceChunk).where(scope);
  for (let i = 0; i < units.length; i += 100) {
    await db.insert(schema.spaceChunk).values(
      units.slice(i, i + 100).map((u) => {
        if (u.kind) {
          const vector = pictures.get(pictureKey(u)) ?? null;
          return { ...u, embedding: vector, model: vector ? (resolved?.ref ?? null) : null };
        }
        const vector = kept.get(u.text) ?? null;
        return { ...u, embedding: vector, model: vector ? model : null };
      }),
    );
  }
  if (units.some((u) => u.kind && !pictures.has(pictureKey(u)))) {
    queuePictures();
  }
}

// --- units ----------------------------------------------------------------------------

interface Section {
  heading: string[];
  sheet: number | null;
  body: string;
}

const SHEET = /^\s*<!--\s*S\.\s*(\d+)\s*-->\s*$/;

/** A page's Markdown cut at its headings; the page marks of its original say where each starts. */
export function sectionsOf(markdown: string): Section[] {
  const out: Section[] = [];
  const stack: { level: number; text: string }[] = [];
  let sheet: number | null = null;
  let current: Section & { lines: string[] } = { heading: [], sheet: null, body: "", lines: [] };
  let fence = false;
  const close = () => {
    const body = current.lines.join("\n").trim();
    if (body) {
      out.push({ heading: current.heading, sheet: current.sheet, body });
    }
  };
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
    }
    const mark = fence ? null : SHEET.exec(line);
    if (mark) {
      sheet = Number(mark[1]);
      if (current.lines.join("").trim()) {
        current.lines.push(`[S. ${sheet}]`);
      } else {
        current.sheet = sheet;
      }
      continue;
    }
    const h = fence ? null : /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      close();
      const level = h[1].length;
      while (stack.length && (stack.at(-1) as { level: number }).level >= level) {
        stack.pop();
      }
      stack.push({ level, text: h[2].trim() });
      current = { heading: stack.map((s) => s.text), sheet, body: "", lines: [] };
      continue;
    }
    current.lines.push(line);
  }
  close();
  return out;
}

/** A long section in parts at its paragraphs; a paragraph longer than a part at its sentences. */
function partsOf(body: string): string[] {
  if (body.length <= SECTION_CHARS) {
    return [body];
  }
  const pieces = body
    .split(/\n\s*\n/)
    .flatMap((p) =>
      p.length <= PART_CHARS ? [p] : (p.match(/[^.!?]+[.!?]+["»“)]?\s*|[^.!?]+$/g) ?? [p]),
    );
  const parts: string[] = [];
  let now = "";
  for (const piece of pieces) {
    if (now && now.length + piece.length > PART_CHARS) {
      parts.push(now.trim());
      now = "";
    }
    now += (now ? "\n\n" : "") + piece;
  }
  if (now.trim()) {
    parts.push(now.trim());
  }
  return parts;
}

const head = (titles: string[], lines: string[]) =>
  [titles.join(" › "), lines.length ? lines.join(" · ") : ""].filter(Boolean).join("\n");

async function indexPage(pageId: string) {
  const scope = eq(schema.spaceChunk.pageId, pageId);
  const page = await db.query.spacePage.findFirst({ where: eq(schema.spacePage.id, pageId) });
  if (!page || page.wizardId) {
    await db.delete(schema.spaceChunk).where(scope);
    return;
  }
  const [tree, categories] = await Promise.all([
    pageTree(page.spaceId),
    categoryRows(page.spaceId),
  ]);
  const node = tree.get(page.id);
  const lines = categoryLines(
    categories,
    (await itemCategoriesOf([{ pageId: page.id }])).get(`p:${page.id}`),
  );
  const prefix = head(node?.titles ?? [page.title], lines);
  const sections = sectionsOf(page.markdown);
  const units: Omit<ChunkInsert, "embedding" | "model">[] = [];
  // A page without text is still found by its title and categories.
  for (const section of sections.length ? sections : [{ heading: [], sheet: null, body: "" }]) {
    // A page's own first heading is its title: the path says it already.
    const path =
      section.heading[0]?.toLowerCase() === page.title.toLowerCase()
        ? section.heading.slice(1)
        : section.heading;
    const heading = path.join(" › ") || null;
    for (const part of partsOf(section.body)) {
      units.push({
        spaceId: page.spaceId,
        pageId: page.id,
        heading,
        sheet: section.sheet,
        idx: units.length,
        text: [prefix, heading ? `## ${heading}` : "", part].filter(Boolean).join("\n\n"),
      });
    }
  }
  await writeUnits(scope, units.slice(0, MAX_UNITS));
}

async function indexRows(tableId: string, rowIds?: string[]) {
  const table = await db.query.spaceTable.findFirst({ where: eq(schema.spaceTable.id, tableId) });
  const scope = rowIds
    ? inArray(schema.spaceChunk.rowId, rowIds)
    : eq(schema.spaceChunk.tableId, tableId);
  if (!table || table.wizardId) {
    await db.delete(schema.spaceChunk).where(scope);
    return;
  }
  const rows = await db.query.spaceTableRow.findMany({
    where: rowIds
      ? and(eq(schema.spaceTableRow.tableId, table.id), inArray(schema.spaceTableRow.id, rowIds))
      : eq(schema.spaceTableRow.tableId, table.id),
  });
  const categories = await categoryRows(table.spaceId);
  const cats = await itemCategoriesOf([
    { tableId: table.id },
    ...rows.map((r) => ({ rowId: r.id })),
  ]);
  const tableLines = categoryLines(categories, cats.get(`t:${table.id}`));
  const units = rows.map((row, i): Omit<ChunkInsert, "embedding" | "model"> => {
    const own = categoryLines(categories, cats.get(`r:${row.id}`)).filter(
      (l) => !tableLines.includes(l),
    );
    const cells = table.columns
      .map((c) => [c.name, formatTableCell(c, row.cells[c.id], "de")] as const)
      .filter(([, v]) => v);
    const body =
      table.format === "faq" && cells.length >= 2
        ? `${cells[0][1]}\n\n${cells
            .slice(1)
            .map(([, v]) => v)
            .join("\n\n")}`
        : cells.map(([name, v]) => `${name}: ${v}`).join("\n");
    return {
      spaceId: table.spaceId,
      tableId: table.id,
      rowId: row.id,
      heading: table.format === "faq" ? (cells[0]?.[1] ?? null) : null,
      idx: i,
      text: `${head([table.title], [...tableLines, ...own])}\n\n${body}`,
    };
  });
  await writeUnits(scope, units);
}

/** An image, video or sound among a space's assets: found by its name and description. */
const MEDIA_ASSET = /^(image|video|audio)\//;

/** Whether the index holds a file: a document, or an image, video or sound asset. */
export function indexedFile(file: { kind: string; mime: string }): boolean {
  return file.kind === "document" || (file.kind === "asset" && MEDIA_ASSET.test(file.mime));
}

/** The pictures the embedding model is shown: what @napi-rs/canvas reads. */
const PICTURE = /^image\/(png|jpeg|webp|gif)$/;

/** Whether the index embeds a picture of this type as a picture, by what it shows. */
export async function seenAsPicture(mime: string): Promise<boolean> {
  return PICTURE.test(mime) && Boolean((await embeddingModel().catch(() => null))?.embedImage);
}

/**
 * A file's units embedded as pictures, where the embedding model takes them: a picture file as
 * one, a PDF's first MAX_PAGE_PICTURES pages one each. Their words are the file's name, the page
 * and its categories. `ref` is the hash of the file's bytes: other bytes are another picture.
 */
async function pictureUnits(file: FileRow, lines: string[], from: number): Promise<Unit[]> {
  const pdf = file.mime === "application/pdf";
  if (
    !(file.hash && (PICTURE.test(file.mime) || pdf)) ||
    !(await embeddingModel().catch(() => null))?.embedImage
  ) {
    return [];
  }
  const unit = { spaceId: file.spaceId, fileId: file.id, ref: file.hash };
  if (!pdf) {
    return [
      {
        ...unit,
        kind: "image",
        heading: file.name,
        idx: from,
        text: head([file.name], ["picture", ...lines]),
      },
    ];
  }
  // Pages the PDF does not have go when their pictures are made.
  const pages = Math.min(file.pages ?? MAX_PAGE_PICTURES, MAX_PAGE_PICTURES);
  return Array.from({ length: pages }, (_, i) => ({
    ...unit,
    kind: "page" as const,
    heading: null,
    sheet: i + 1,
    idx: from + i,
    text: head([file.name, `S. ${i + 1}`], lines),
  }));
}

/** An asset stands in the index as one unit: its name, its kind, its categories, its description. */
async function indexAsset(file: typeof schema.spaceFile.$inferSelect) {
  const categories = await categoryRows(file.spaceId);
  const lines = categoryLines(
    categories,
    (await itemCategoriesOf([{ fileId: file.id }])).get(`f:${file.id}`),
  );
  const kind = file.mime.split("/")[0];
  await writeUnits(eq(schema.spaceChunk.fileId, file.id), [
    {
      spaceId: file.spaceId,
      fileId: file.id,
      heading: file.name,
      idx: 0,
      text: [head([file.name], [`${kind} asset`, ...lines]), file.description]
        .filter(Boolean)
        .join("\n\n"),
    },
    ...(await pictureUnits(file, lines, 1)),
  ]);
}

async function indexFile(fileId: string) {
  const file = await db.query.spaceFile.findFirst({ where: eq(schema.spaceFile.id, fileId) });
  if (!(file && indexedFile(file) && file.status === "ready")) {
    return;
  }
  if (file.kind === "asset") {
    return indexAsset(file);
  }
  const converted =
    (await db.query.spacePage.findFirst({
      where: eq(schema.spacePage.fileId, file.id),
      columns: { id: true },
    })) ??
    (await db.query.spaceTable.findFirst({
      where: eq(schema.spaceTable.fileId, file.id),
      columns: { id: true },
    }));
  const scope = eq(schema.spaceChunk.fileId, file.id);
  const categories = await categoryRows(file.spaceId);
  const lines = categoryLines(
    categories,
    (await itemCategoriesOf([{ fileId: file.id }])).get(`f:${file.id}`),
  );
  if (converted) {
    // Its text is the page's now; the file stands behind it as the original, found by its
    // pictures where the embedding model takes them.
    await writeUnits(scope, await pictureUnits(file, lines, 0));
    return;
  }
  const passages = await db
    .select({ heading: schema.spaceChunk.heading, kind: schema.spaceChunk.kind })
    .from(schema.spaceChunk)
    .where(scope);
  // Passages of a document read before Knowledge had pages stay until it is read again.
  if (passages.some((p) => p.heading === null && !p.kind)) {
    return;
  }
  await writeUnits(scope, [
    {
      spaceId: file.spaceId,
      fileId: file.id,
      heading: file.name,
      idx: 0,
      text: [head([file.name], lines), file.description].filter(Boolean).join("\n\n"),
    },
    ...(await pictureUnits(file, lines, 1)),
  ]);
}

async function indexValue(valueId: string) {
  const scope = eq(schema.spaceChunk.valueId, valueId);
  const value = await db.query.spaceCategoryValue.findFirst({
    where: eq(schema.spaceCategoryValue.id, valueId),
  });
  const category = value
    ? await db.query.spaceCategory.findFirst({
        where: eq(schema.spaceCategory.id, value.categoryId),
      })
    : undefined;
  if (!(value?.summary && category)) {
    await db.delete(schema.spaceChunk).where(scope);
    return;
  }
  const units = partsOf(value.summary).map((part, i) => ({
    spaceId: category.spaceId,
    valueId: value.id,
    heading: `${category.name}: ${value.value}`,
    idx: i,
    text: `${category.name}: ${value.value} — Summary\n\n${part}`,
  }));
  await writeUnits(scope, units);
}

/** Every page under a page. */
async function subPages(pageId: string): Promise<string[]> {
  const rows = await db.all<{ id: string }>(sql`
    WITH RECURSIVE tree(id) AS (
      SELECT id FROM space_page WHERE parent_id = ${pageId}
      UNION SELECT p.id FROM space_page p JOIN tree ON p.parent_id = tree.id
    ) SELECT id FROM tree`);
  return rows.map((r) => r.id);
}

/**
 * Brings one item's units up to date. `p:` a page, `P:` a page and its sub-pages (its title or
 * categories changed: they stand in theirs), `t:` a table's rows, `r:` one row, `f:` a file, `v:`
 * a value's summary.
 */
export async function indexItem(key: string) {
  const id = key.slice(2);
  switch (key[0]) {
    case "p":
      return indexPage(id);
    case "P":
      await indexPage(id);
      for (const sub of await subPages(id)) {
        await indexPage(sub);
      }
      return;
    case "t":
      return indexRows(id);
    case "r": {
      const row = await db.query.spaceTableRow.findFirst({
        where: eq(schema.spaceTableRow.id, id),
        columns: { tableId: true },
      });
      return row ? indexRows(row.tableId, [id]) : undefined;
    }
    case "f":
      return indexFile(id);
    case "v":
      return indexValue(id);
    default:
      return;
  }
}

// --- the queue ------------------------------------------------------------------------
// A page saves a moment after the person stops typing; the index follows a moment later, once
// per item however often it changed, one item after the other.

const INDEX_DELAY_MS = 1500;
const waiting = new Map<string, { tenant: string; key: string; timer: NodeJS.Timeout }>();
let working: Promise<void> = Promise.resolve();

function run(tenant: string, key: string) {
  working = working
    .then(() => withTenant(tenant, () => indexItem(key)))
    .catch((err) => console.error(`[space-index] ${key}`, err));
}

/** Indexes an item a moment from now; a change before then waits again. */
export function queueIndex(key: string) {
  const tenant = currentTenant();
  const id = `${tenant}|${key}`;
  const known = waiting.get(id);
  if (known) {
    clearTimeout(known.timer);
  }
  const timer = setTimeout(() => {
    waiting.delete(id);
    run(tenant, key);
  }, INDEX_DELAY_MS);
  timer.unref?.();
  waiting.set(id, { tenant, key, timer });
}

/** Indexes what waits now, and resolves when the index has caught up, pictures included. */
export async function flushIndex() {
  while (waiting.size) {
    for (const [id, entry] of [...waiting]) {
      clearTimeout(entry.timer);
      waiting.delete(id);
      run(entry.tenant, entry.key);
    }
    await working;
  }
  await working;
  await picturesRunning;
}

// --- pictures -----------------------------------------------------------------------------
// A picture's vector comes after its unit: a picture of a PDF page takes a second or more to
// make and embed, and the index of a page someone types in must not wait for it. Tenant after
// tenant, file after file, units without a vector of the embedding model at hand.

const picturesWaiting = new Set<string>();
let picturesRunning: Promise<void> | null = null;

/** Gives the pictures of the tenant at hand their vectors, soon. */
export function queuePictures() {
  picturesWaiting.add(currentTenant());
  if (picturesRunning) {
    return;
  }
  picturesRunning = (async () => {
    while (picturesWaiting.size) {
      const [tenant] = picturesWaiting;
      picturesWaiting.delete(tenant);
      await withTenant(tenant, embedPictures).catch((err) =>
        console.error("[space-index] pictures", err),
      );
    }
  })().finally(() => {
    picturesRunning = null;
  });
}

/** The pictures of the bytes `hash`, by page (0: a picture file itself), made when asked for. */
async function picturesOf(hash: string | null, pdf: boolean): Promise<Map<number, Buffer>> {
  const data = hash ? await getBlob(hash).catch(() => null) : null;
  if (!data) {
    return new Map();
  }
  return pdf
    ? new Map((await pdfPages(data)).map((p) => [p.page, p.jpeg]))
    : new Map([[0, await jpegOf(data)]]);
}

async function embedPictures() {
  const resolved = await embeddingModel().catch(() => null);
  const embedImage = resolved?.embedImage;
  if (!(resolved && embedImage)) {
    return;
  }
  const failed = new Set<string>();
  let inRow = 0;
  const started = Date.now();
  let done = 0;
  for (;;) {
    const todo = await db
      .select({
        id: schema.spaceChunk.id,
        fileId: schema.spaceChunk.fileId,
        kind: schema.spaceChunk.kind,
        sheet: schema.spaceChunk.sheet,
        ref: schema.spaceChunk.ref,
      })
      .from(schema.spaceChunk)
      .where(
        and(
          isNotNull(schema.spaceChunk.kind),
          isNotNull(schema.spaceChunk.fileId),
          or(isNull(schema.spaceChunk.model), ne(schema.spaceChunk.model, resolved.ref)),
          failed.size ? notInArray(schema.spaceChunk.fileId, [...failed]) : undefined,
        ),
      )
      .limit(MAX_PAGE_PICTURES);
    const fileId = todo[0]?.fileId;
    if (!fileId) {
      break;
    }
    const units = todo.filter((u) => u.fileId === fileId);
    try {
      const pictures = await picturesOf(units[0].ref, units[0].kind === "page");
      for (const u of units) {
        const jpeg = pictures.get(u.kind === "page" ? (u.sheet ?? 0) : 0);
        const which = and(
          eq(schema.spaceChunk.id, u.id),
          u.ref === null ? isNull(schema.spaceChunk.ref) : eq(schema.spaceChunk.ref, u.ref),
        );
        if (!jpeg) {
          // A page the PDF does not have, or a file that is gone.
          await db.delete(schema.spaceChunk).where(which);
          continue;
        }
        const vector = await embedImage(jpeg);
        await db
          .update(schema.spaceChunk)
          .set({ embedding: vectorBytes(vector), model: resolved.ref })
          .where(which);
        done++;
      }
      inRow = 0;
    } catch (err) {
      console.error("[space-index] picture", fileId, err);
      failed.add(fileId);
      // The model is not there or not working: the next start, or the next picture, tries again.
      if (++inRow >= 3) {
        break;
      }
    }
  }
  if (done) {
    console.log(
      `[space-index] embedded ${done} pictures with ${resolved.ref} in ${Math.round((Date.now() - started) / 1000)} s`,
    );
  }
}

// --- plugins' texts ---------------------------------------------------------------------

/** Puts a plugin's text into the space's index, in the place of what its key held. */
export async function putIndexEntry(plugin: string, entry: PluginIndexEntry) {
  const space = await db.query.space.findFirst({ where: eq(schema.space.id, entry.space) });
  if (!space) {
    throw new ServiceError("not_found", `There is no space "${entry.space}".`);
  }
  const text = `${entry.title.trim()}\n\n${entry.text.trim()}`;
  const chunks = createSearchChunks({ doc_id: `${plugin}:${entry.key}`, text, ...CHUNK }).slice(
    0,
    MAX_UNITS,
  );
  await writeUnits(
    and(
      eq(schema.spaceChunk.spaceId, entry.space),
      eq(schema.spaceChunk.plugin, plugin),
      eq(schema.spaceChunk.ref, entry.key),
    ) as SQL,
    chunks.map((c) => ({
      spaceId: entry.space,
      plugin,
      ref: entry.key,
      title: entry.title.trim().slice(0, 300),
      link: entry.link ?? null,
      idx: c.chunk_index,
      text: c.text,
    })),
  );
}

/** Takes a plugin's text out of the space's index; without a key, all of the plugin's texts. */
export async function removeIndexEntries(plugin: string, space: string, key?: string) {
  await db
    .delete(schema.spaceChunk)
    .where(
      and(
        eq(schema.spaceChunk.spaceId, space),
        eq(schema.spaceChunk.plugin, plugin),
        key === undefined ? undefined : eq(schema.spaceChunk.ref, key),
      ),
    );
}

/** Whether a plugin the tenant has put a text into the space's index. */
export async function hasIndexEntries(spaceId: string): Promise<boolean> {
  const plugins = [...(await pluginIdsOf(currentTenant()))];
  if (!plugins.length) {
    return false;
  }
  const found = await db.query.spaceChunk.findFirst({
    columns: { id: true },
    where: and(eq(schema.spaceChunk.spaceId, spaceId), inArray(schema.spaceChunk.plugin, plugins)),
  });
  return Boolean(found);
}

// --- search -------------------------------------------------------------------------------

const STOP = new Set(
  "der die das den dem des ein eine einen einem einer und oder aber ist sind war wie was wer wo für von mit auf aus bei zu zum zur im in an am es ich du wir ihr sie nicht auch gibt gibt's welche welcher welches the a an of to and or is are was for with on at by it this that what which".split(
    " ",
  ),
);

const wordsOf = (query: string) =>
  [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])]
    .filter((w) => !STOP.has(w))
    .slice(0, 16);

/** The question's words as an FTS5 query: any of them, also as the start of a longer word. */
function keywordQuery(query: string): string | null {
  const words = wordsOf(query);
  return words.length ? words.map((w) => `"${w}"*`).join(" OR ") : null;
}

/**
 * The question as a trigram query: each word of three letters or more anywhere in a unit, so
 * "Förderhöhe" finds "Höchstförderhöhe"; a code with digits also as it was written ("WIN 6").
 */
export function trigramQuery(query: string): string | null {
  const words = wordsOf(query).filter((w) => w.length >= 3);
  const codes = (query.match(/[\p{L}\p{N}][\p{L}\p{N}\-./ ]*\d[\p{L}\p{N}\-./]*/gu) ?? [])
    .map((c) => c.trim())
    .filter((c) => c.length >= 3 && c.includes(" "));
  const terms = [...new Set([...codes, ...words])].map((t) => `"${t.replace(/"/g, "")}"`);
  return terms.length ? terms.join(" OR ") : null;
}

interface Found {
  id: number;
  file_id: string | null;
  page_id: string | null;
  row_id: string | null;
  table_id: string | null;
  value_id: string | null;
  heading: string | null;
  sheet: number | null;
  plugin: string | null;
  ref: string | null;
  title: string | null;
  link: string | null;
  idx: number;
  text: string;
  kind: "image" | "page" | null;
  /** A unit of a file in Dateien: its text is not kept, but where it stands in the file. */
  mount_file_id: string | null;
  start: number | null;
  end: number | null;
}

const COLUMNS = sql.raw(
  'c.id, c.file_id, c.page_id, c.row_id, c.table_id, c.value_id, c.heading, c.sheet, c.plugin, c.ref, c.title, c.link, c.idx, c.text, c.kind, NULL AS mount_file_id, NULL AS start, NULL AS "end"',
);

/** A mounted file's unit as a `Found`: its text is read from the original for the first hits. */
const MOUNT_COLUMNS = sql.raw(
  "u.id, NULL AS file_id, NULL AS page_id, NULL AS row_id, NULL AS table_id, NULL AS value_id, u.heading, u.sheet, NULL AS plugin, NULL AS ref, NULL AS title, NULL AS link, u.idx, '' AS text, u.kind, u.file_id AS mount_file_id, u.start, u.\"end\"",
);

/** Units of the space's index and of its mounts have ids of their own. */
const unitKey = (u: Found) => (u.mount_file_id ? `m${u.id}` : `c${u.id}`);

/** A unit of the space's own Knowledge, or of a plugin's text while the tenant has that plugin. */
function searchable(plugins: string[]): SQL {
  return plugins.length
    ? sql`(c.plugin IS NULL OR c.plugin IN (${sql.join(
        plugins.map((p) => sql`${p}`),
        sql`, `,
      )}))`
    : sql`c.plugin IS NULL`;
}

const IN_LIMIT = 2000;

/** The units a filter leaves, as SQL while the lists are short; else null and checked after. */
function filtered(f: Filtered): SQL | null {
  const lists: [string, Set<string>][] = [
    ["c.page_id", f.pages],
    ["c.row_id", f.rows],
    ["c.file_id", f.files],
  ];
  if (lists.reduce((n, [, s]) => n + s.size, 0) > IN_LIMIT) {
    return null;
  }
  const parts = lists
    .filter(([, s]) => s.size)
    .map(
      ([column, s]) =>
        sql`${sql.raw(column)} IN (${sql.join(
          [...s].map((id) => sql`${id}`),
          sql`, `,
        )})`,
    );
  return parts.length ? sql`(${sql.join(parts, sql` OR `)})` : sql`0`;
}

const leaves = (f: Filtered, u: Found) =>
  (u.mount_file_id !== null && f.mounted.has(u.mount_file_id)) ||
  (u.page_id !== null && f.pages.has(u.page_id)) ||
  (u.row_id !== null && f.rows.has(u.row_id)) ||
  (u.file_id !== null && f.files.has(u.file_id));

/** The key of the item a unit belongs to: hits are grouped by it. */
function itemOf(u: Found): string {
  if (u.mount_file_id) {
    return `m:${u.mount_file_id}`;
  }
  if (u.page_id) {
    return `p:${u.page_id}`;
  }
  if (u.row_id) {
    return `r:${u.row_id}`;
  }
  if (u.value_id) {
    return `v:${u.value_id}`;
  }
  if (u.file_id) {
    return `f:${u.file_id}`;
  }
  return `x:${u.plugin}:${u.ref}`;
}

/**
 * What `who` may read among the units found: a page or file by its own rule, a row by its
 * table's, a value's summary (made of many items) only where they may read everything; a
 * plugin's text is not the broker's yet. Null while the switch is off: everything.
 */
async function readableUnits(
  spaceId: string,
  who: Subject[],
  units: Found[],
): Promise<((u: Found) => boolean) | null> {
  if (!(await brokerOn())) {
    return null;
  }
  const ids = (pick: (u: Found) => string | null) => [
    ...new Set(units.flatMap((u) => (pick(u) ? [pick(u) as string] : []))),
  ];
  const [pages, tables, files, all] = await Promise.all([
    pageResources(ids((u) => u.page_id)).then((r) => readable(spaceId, who, r)),
    tableResources(ids((u) => u.table_id)).then((r) => readable(spaceId, who, r)),
    readable(
      spaceId,
      who,
      ids((u) => u.file_id).map((id) => ({ kind: "document", id })),
    ),
    readsEverything(spaceId, who),
  ]);
  return (u) => {
    // A mount's units are searched only where the caller may use the mount.
    if (u.mount_file_id) {
      return true;
    }
    if (u.page_id) {
      return pages.has(u.page_id);
    }
    if (u.row_id) {
      return u.table_id !== null && tables.has(u.table_id);
    }
    if (u.value_id) {
      return all;
    }
    if (u.file_id) {
      return files.has(u.file_id);
    }
    return Boolean(u.plugin);
  };
}

/**
 * Searches Knowledge for `who`: items whose categories pass `where` and that they may read, then
 * the units the keywords, the trigrams and the vectors rank best, merged by rank (RRF), then the
 * classifier's judgement of each of the CANDIDATES best. Gives up to `limit` items with their
 * best section. `check: false` leaves the classifier out. While the `broker` switch is on, a call
 * without `who` is refused, and an item they may not read is in no hit, candidate or count.
 */
export async function searchKnowledge(
  spaceId: string,
  query: string,
  opts: {
    where?: Where;
    limit?: number;
    check?: boolean;
    signal?: AbortSignal;
    who?: Subject[];
  } = {},
): Promise<KnowledgeSearch> {
  const limit = Math.min(Math.max(1, opts.limit ?? 6), 12);
  const on = await brokerOn();
  if (on && !opts.who?.length) {
    throw forbidden({ kind: "document", id: "*" }, "r");
  }
  const filter = await filterItems(spaceId, opts.where);
  if (filter && !filter.size) {
    return { hits: [], candidates: 0, checked: false, filtered: 0 };
  }
  const plugins = [...(await pluginIdsOf(currentTenant()))];
  const inFilter = filter ? filtered(filter) : null;
  // A filter keeps plugins' texts and summaries out: they have no categories.
  const where = and(
    sql`c.space_id = ${spaceId}`,
    searchable(plugins),
    filter
      ? (inFilter ?? sql`(c.page_id IS NOT NULL OR c.row_id IS NOT NULL OR c.file_id IS NOT NULL)`)
      : undefined,
  ) as SQL;
  // What the rules or a long filter take out afterwards must not starve the candidates.
  const take = on || (filter && !inFilter) ? 300 : CANDIDATES;
  const lists: Found[][] = [];
  const words = keywordQuery(query);
  if (words) {
    lists.push(
      await db.all<Found>(sql`
        SELECT ${COLUMNS} FROM space_chunk_fts f JOIN space_chunk c ON c.id = f.rowid
        WHERE space_chunk_fts MATCH ${words} AND ${where}
        ORDER BY bm25(space_chunk_fts) LIMIT ${take}`),
    );
  }
  const grams = trigramQuery(query);
  if (grams) {
    lists.push(
      await db
        .all<Found>(sql`
          SELECT ${COLUMNS} FROM space_chunk_tri f JOIN space_chunk c ON c.id = f.rowid
          WHERE space_chunk_tri MATCH ${grams} AND ${where}
          ORDER BY bm25(space_chunk_tri) LIMIT ${take}`)
        .catch(() => []),
    );
  }
  const embedded = await embed([query]).catch(() => null);
  if (embedded) {
    const question = vectorBytes(embedded.vectors[0]);
    lists.push(
      featureOn(await currentFeatures(), "knowledgeMedia")
        ? await byMeaning(CHUNKS, where, embedded.model, question, take)
        : await db.all<Found>(sql`
            SELECT ${COLUMNS} FROM space_chunk c
            WHERE ${where} AND c.model = ${embedded.model}
            ORDER BY vector_distance_cos(c.embedding, ${question}) LIMIT ${take}`),
    );
  }
  // The mounts of Dateien the caller may use: their words and their vectors, beside Knowledge's.
  const mounts = await usableMounts(spaceId, opts.who ?? []);
  const mounted = filter ? [...filter.mounted] : null;
  if (mounts.length && !(mounted && !mounted.length)) {
    const inMounts = and(
      sql`u.mount_id IN (${sql.join(
        mounts.map((m) => sql`${m.id}`),
        sql`, `,
      )})`,
      mounted && mounted.length <= IN_LIMIT
        ? sql`u.file_id IN (${sql.join(
            mounted.map((id) => sql`${id}`),
            sql`, `,
          )})`
        : undefined,
    ) as SQL;
    for (const [table, q] of [
      ["space_mount_unit_fts", words],
      ["space_mount_unit_tri", grams],
    ] as const) {
      if (q) {
        lists.push(
          await db
            .all<Found>(sql`
              SELECT ${MOUNT_COLUMNS} FROM ${sql.raw(table)} f JOIN space_mount_unit u ON u.id = f.rowid
              WHERE ${sql.raw(table)} MATCH ${q} AND ${inMounts}
              ORDER BY bm25(${sql.raw(table)}) LIMIT ${take}`)
            .catch(() => []),
        );
      }
    }
    if (embedded) {
      lists.push(
        await byMeaning(
          MOUNT_UNITS,
          inMounts,
          embedded.model,
          vectorBytes(embedded.vectors[0]),
          take,
        ),
      );
    }
  }
  const allowed = await readableUnits(spaceId, opts.who ?? [], lists.flat());
  // Reciprocal rank fusion: a unit the lists rank high comes first.
  const scored = new Map<string, { unit: Found; score: number }>();
  for (const list of lists) {
    list
      .filter((u) => !filter || inFilter || leaves(filter, u))
      .filter((u) => !allowed || allowed(u))
      .slice(0, CANDIDATES)
      .forEach((unit, rank) => {
        const entry = scored.get(unitKey(unit)) ?? { unit, score: 0 };
        entry.score += 1 / (60 + rank);
        scored.set(unitKey(unit), entry);
      });
  }
  const candidates = [...scored.values()].sort((a, b) => b.score - a.score).slice(0, CANDIDATES);
  if (!candidates.length) {
    return { hits: [], candidates: 0, checked: false, filtered: filter?.size ?? null };
  }
  const described = await describe(
    spaceId,
    candidates.map((c) => c.unit),
    mounts,
  );
  // The classifier reads text; a picture, found by what it shows, keeps its place.
  const read = described.filter((d) => !d.picture);
  const scores =
    opts.check === false || !read.length
      ? null
      : await judgeRelevance(
          query,
          read.map((d) => ({
            title: d.title,
            path: d.path,
            categories: d.categories,
            heading: d.heading,
            text: d.text,
          })),
          opts.signal,
        );
  const judged = scores
    ? described.map((d) => (d.picture ? null : (scores[read.indexOf(d)] ?? null)))
    : null;
  const kept = described
    .map((hit, i) => ({ hit: { ...hit, relevance: judged?.[i] ?? null }, rank: i }))
    .filter(({ hit }) => hit.relevance === null || hit.relevance >= MIN_RELEVANCE);
  // The texts in the classifier's order, in the places texts held; pictures stay where they are.
  const texts = kept
    .filter(({ hit }) => !hit.picture)
    .sort((a, b) =>
      judged
        ? (b.hit.relevance ?? MIN_RELEVANCE) - (a.hit.relevance ?? MIN_RELEVANCE) || a.rank - b.rank
        : a.rank - b.rank,
    );
  let next = 0;
  const ranked = kept.map((k) => (k.hit.picture ? k : texts[next++]));
  // One hit per item: its best section.
  const seen = new Set<string>();
  const hits: KnowledgeHit[] = [];
  for (const { hit } of ranked) {
    if (seen.has(hit.key)) {
      continue;
    }
    seen.add(hit.key);
    hits.push(hit);
    if (hits.length >= limit) {
      break;
    }
  }
  return {
    hits,
    candidates: candidates.length,
    checked: judged !== null,
    filtered: filter?.size ?? null,
  };
}

/** Where `byMeaning` looks: Knowledge's units, or the mounts'. */
const CHUNKS = { from: sql.raw("space_chunk c"), alias: sql.raw("c"), columns: COLUMNS };
const MOUNT_UNITS = {
  from: sql.raw("space_mount_unit u"),
  alias: sql.raw("u"),
  columns: MOUNT_COLUMNS,
};

/**
 * The units nearest the question by meaning, where the nearest stand out: the best has to lead
 * the median unit by MIN_LEAD, and a unit counts from halfway between them up. Else none.
 */
async function byMeaning(
  of: typeof CHUNKS,
  where: SQL,
  model: string,
  question: Buffer,
  take: number,
) {
  const near = await db.all<{ id: number; d: number }>(sql`
    SELECT ${of.alias}.id, vector_distance_cos(${of.alias}.embedding, ${question}) AS d
    FROM ${of.from} WHERE ${where} AND ${of.alias}.model = ${model} ORDER BY d`);
  // Distances: 1 - cosine.
  const top = 1 - (near[0]?.d ?? 1);
  const median = 1 - (near[Math.floor(near.length / 2)]?.d ?? 1);
  if (top - median < MIN_LEAD) {
    return [];
  }
  const ids = near
    .filter((n) => 1 - n.d >= median + (top - median) / 2)
    .slice(0, take)
    .map((n) => n.id);
  const rows = await db.all<Found>(sql`
    SELECT ${of.columns} FROM ${of.from} WHERE ${of.alias}.id IN (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )})`);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => (byId.has(id) ? [byId.get(id) as Found] : []));
}

/** What a step and the studio see of each unit: the item's path, title and categories. */
async function describe(
  spaceId: string,
  units: Found[],
  mounts: { id: string; name: string; slug: string }[] = [],
): Promise<KnowledgeHit[]> {
  const pageIds = [...new Set(units.flatMap((u) => (u.page_id ? [u.page_id] : [])))];
  const rowIds = [...new Set(units.flatMap((u) => (u.row_id ? [u.row_id] : [])))];
  const fileIds = [...new Set(units.flatMap((u) => (u.file_id ? [u.file_id] : [])))];
  const valueIds = [...new Set(units.flatMap((u) => (u.value_id ? [u.value_id] : [])))];
  const mountFileIds = [
    ...new Set(units.flatMap((u) => (u.mount_file_id ? [u.mount_file_id] : []))),
  ];
  const mountFiles = mountFileIds.length
    ? await db.query.spaceMountFile.findMany({
        where: inArray(schema.spaceMountFile.id, mountFileIds),
        columns: { id: true, mountId: true, path: true, name: true },
      })
    : [];
  // A mounted file keeps no text: the passages found are read from the original (cache.ts).
  const mountUnits = units.filter((u) => u.mount_file_id && !u.kind);
  const mountTexts = new Map(
    (
      await unitTexts(
        mountUnits.map((u) => ({
          fileId: u.mount_file_id as string,
          heading: u.heading,
          start: u.start,
          end: u.end,
        })),
      )
    ).map((text, i) => [unitKey(mountUnits[i]), text]),
  );
  const [tree, tPaths, fPaths, categories, rows, files, values] = await Promise.all([
    pageIds.length ? pageTree(spaceId) : new Map(),
    rowIds.length ? tablePaths(spaceId) : new Map<string, string>(),
    fileIds.length ? filePaths(spaceId) : new Map<string, string>(),
    categoryRows(spaceId),
    rowIds.length
      ? db.query.spaceTableRow.findMany({
          where: inArray(schema.spaceTableRow.id, rowIds),
          columns: { id: true, tableId: true },
        })
      : [],
    fileIds.length
      ? db.query.spaceFile.findMany({
          where: inArray(schema.spaceFile.id, fileIds),
          columns: { id: true, name: true },
        })
      : [],
    valueIds.length
      ? db.query.spaceCategoryValue.findMany({
          where: inArray(schema.spaceCategoryValue.id, valueIds),
        })
      : [],
  ]);
  const tableIds = [...new Set(rows.map((r) => r.tableId))];
  const tables = tableIds.length
    ? await db.query.spaceTable.findMany({
        where: inArray(schema.spaceTable.id, tableIds),
        columns: { id: true, title: true },
      })
    : [];
  const cats = await itemCategoriesOf([
    ...pageIds.map((pageId) => ({ pageId })),
    ...rowIds.map((rowId) => ({ rowId })),
    ...tableIds.map((tableId) => ({ tableId })),
    ...fileIds.map((fileId) => ({ fileId })),
    ...mountFileIds.map((mountFileId) => ({ mountFileId })),
  ]);
  // The unit's text without the head it was indexed with: the step gets that as fields.
  const bodyOf = (u: Found) => {
    const parts = u.text.split("\n\n");
    if (!(u.page_id || u.row_id || u.value_id) || parts.length < 2) {
      return u.text;
    }
    const rest = parts.slice(1);
    return (rest[0].startsWith("## ") ? rest.slice(1) : rest).join("\n\n");
  };
  return units.map((u): KnowledgeHit => {
    const base = {
      key: itemOf(u),
      heading: u.heading,
      sheet: u.sheet,
      rowId: u.row_id,
      text: bodyOf(u),
      relevance: null,
      link: u.link,
      plugin: u.plugin,
      ...(u.kind ? { picture: u.kind } : {}),
    };
    if (u.mount_file_id) {
      const file = mountFiles.find((f) => f.id === u.mount_file_id);
      const mount = mounts.find((m) => m.id === file?.mountId);
      return {
        ...base,
        kind: "mounted",
        open: `m:${u.mount_file_id}`,
        path: file && mount ? `dateien/${mount.slug}/${file.path}` : "",
        title: file?.name ?? "",
        text: mountTexts.get(unitKey(u)) ?? "",
        categories: categoryLines(categories, cats.get(`m:${u.mount_file_id}`)),
        ...(mount ? { mount: { id: mount.id, name: mount.name } } : {}),
      };
    }
    if (u.page_id) {
      const node = tree.get(u.page_id);
      return {
        ...base,
        kind: "page",
        open: `p:${u.page_id}`,
        path: node?.path ?? "",
        title: node?.titles.join(" › ") ?? "",
        categories: categoryLines(categories, cats.get(`p:${u.page_id}`)),
      };
    }
    if (u.row_id) {
      const tableId = rows.find((r) => r.id === u.row_id)?.tableId ?? "";
      return {
        ...base,
        kind: "table",
        open: `t:${tableId}`,
        path: tPaths.get(tableId) ?? "",
        title: tables.find((t) => t.id === tableId)?.title ?? "",
        categories: [
          ...categoryLines(categories, cats.get(`t:${tableId}`)),
          ...categoryLines(categories, cats.get(`r:${u.row_id}`)),
        ].filter((l, i, all) => all.indexOf(l) === i),
      };
    }
    if (u.value_id) {
      const value = values.find((v) => v.id === u.value_id);
      const category = categories.find((c) => c.id === value?.categoryId);
      return {
        ...base,
        kind: "summary",
        open: `v:${u.value_id}`,
        path: "",
        title: `${category?.name}: ${value?.value} — Summary`,
        categories: [],
      };
    }
    if (u.file_id) {
      return {
        ...base,
        kind: "file",
        open: `f:${u.file_id}`,
        path: fPaths.get(u.file_id) ?? "",
        title: files.find((f) => f.id === u.file_id)?.name ?? "",
        categories: categoryLines(categories, cats.get(`f:${u.file_id}`)),
      };
    }
    return { ...base, kind: "plugin", open: null, path: "", title: u.title ?? "", categories: [] };
  });
}

/** Puts every item of a space into the index again: after a sync, or a change of embedding model. */
export async function reindexSpace(spaceId: string) {
  const [pages, tables, files, values] = await Promise.all([
    db.query.spacePage.findMany({
      where: and(eq(schema.spacePage.spaceId, spaceId), isNull(schema.spacePage.wizardId)),
      columns: { id: true },
    }),
    db.query.spaceTable.findMany({
      where: and(eq(schema.spaceTable.spaceId, spaceId), isNull(schema.spaceTable.wizardId)),
      columns: { id: true },
    }),
    db.query.spaceFile.findMany({
      where: and(
        eq(schema.spaceFile.spaceId, spaceId),
        inArray(schema.spaceFile.kind, ["document", "asset"]),
      ),
      columns: { id: true, kind: true, mime: true },
    }),
    db
      .select({ id: schema.spaceCategoryValue.id })
      .from(schema.spaceCategoryValue)
      .innerJoin(
        schema.spaceCategory,
        eq(schema.spaceCategory.id, schema.spaceCategoryValue.categoryId),
      )
      .where(
        and(
          eq(schema.spaceCategory.spaceId, spaceId),
          isNotNull(schema.spaceCategoryValue.summary),
        ),
      ),
  ]);
  for (const p of pages) {
    queueIndex(`p:${p.id}`);
  }
  for (const t of tables) {
    queueIndex(`t:${t.id}`);
  }
  for (const f of files.filter(indexedFile)) {
    queueIndex(`f:${f.id}`);
  }
  for (const v of values) {
    queueIndex(`v:${v.id}`);
  }
}

/** Every space into the index again, with the embedding model that is set up now. */
export async function reindexAll() {
  const spaces = await db.query.space.findMany({ columns: { id: true } });
  for (const p of spaces) {
    await reindexSpace(p.id);
  }
}

/**
 * What the index lacks, added at start: image, video and sound assets it does not hold yet; where
 * the embedding model takes pictures, the picture files and PDFs without picture units, and the
 * pictures without a vector of the model at hand.
 */
export async function indexMissingAssets() {
  const rows = await db.all<{ id: string; kind: string; mime: string }>(sql`
    SELECT f.id, f.kind, f.mime FROM space_file f
    WHERE f.kind = 'asset' AND f.status = 'ready'
      AND NOT EXISTS (SELECT 1 FROM space_chunk c WHERE c.file_id = f.id)`);
  for (const row of rows.filter(indexedFile)) {
    queueIndex(`f:${row.id}`);
  }
  if (!(await embeddingModel().catch(() => null))?.embedImage) {
    return;
  }
  const unseen = await db.all<{ id: string; kind: string; mime: string }>(sql`
    SELECT f.id, f.kind, f.mime FROM space_file f
    WHERE f.kind IN ('asset', 'document') AND f.status = 'ready' AND f.hash IS NOT NULL
      AND (f.mime IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf'))
      AND NOT EXISTS (SELECT 1 FROM space_chunk c WHERE c.file_id = f.id AND c.kind IS NOT NULL)`);
  for (const row of unseen.filter(indexedFile)) {
    queueIndex(`f:${row.id}`);
  }
  queuePictures();
}
