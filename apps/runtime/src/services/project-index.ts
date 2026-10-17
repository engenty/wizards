import type { PluginIndexEntry } from "@engenty/wizards/plugin";
import { formatTableCell } from "@engenty-wizards/shared/engenty/data-tables";
import type { KnowledgeHit, KnowledgeSearch, Where } from "@engenty-wizards/shared/knowledge";
import { embedMany } from "ai";
import { and, eq, inArray, isNotNull, isNull, type SQL, sql } from "drizzle-orm";
import { db, schema, withTenant } from "../db/client.js";
import { createSearchChunks } from "../engenty/search-index/chunks.js";
import { getBlob, putBlob } from "../files/blobs.js";
import { embeddingModel } from "../models.js";
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
 */

type FileRow = typeof schema.projectFile.$inferSelect;
type ChunkInsert = typeof schema.projectChunk.$inferInsert;

const CHUNK = { mode: "paragraph" as const, max_chunk_length: 1200, overlap: 120 };
/** Units of one item; a longer one keeps its start. */
const MAX_UNITS = 2000;
/** A section longer than this is cut at paragraphs into parts about PART_CHARS long. */
const SECTION_CHARS = 2400;
const PART_CHARS = 1800;
/** What the keywords and the vectors hand on to the classifier. */
const CANDIDATES = 24;

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
  await db.delete(schema.projectChunk).where(eq(schema.projectChunk.fileId, fileId));
}

export async function documentText(file: FileRow): Promise<string> {
  return file.textHash ? (await getBlob(file.textHash)).toString("utf8") : "";
}

/** Keeps a document's text, for a step that reads the file itself. */
export async function keepText(text: string) {
  return putBlob(Buffer.from(text, "utf8"));
}

/**
 * Replaces the units `scope` held with `units`. A unit whose text has not changed keeps its
 * vector: editing one row of a long table embeds one row.
 */
async function writeUnits(scope: SQL, units: Omit<ChunkInsert, "embedding" | "model">[]) {
  const before = await db
    .select({
      text: schema.projectChunk.text,
      embedding: schema.projectChunk.embedding,
      model: schema.projectChunk.model,
    })
    .from(schema.projectChunk)
    .where(scope);
  const resolved = await embeddingModel().catch(() => null);
  const kept = new Map(
    before
      .filter((b) => b.embedding && b.model && b.model === resolved?.ref)
      .map((b) => [b.text, b.embedding as Buffer]),
  );
  const missing = [...new Set(units.map((u) => u.text).filter((t) => !kept.has(t)))];
  // Without an embedding model, or when it fails, the keywords still find the unit.
  const embedded = await embed(missing).catch((err) => {
    console.error("[project-index] embedding failed", err);
    return null;
  });
  if (embedded) {
    for (const [i, text] of missing.entries()) {
      kept.set(text, vectorBytes(embedded.vectors[i]));
    }
  }
  const model = embedded?.model ?? (kept.size ? (resolved?.ref ?? null) : null);
  await db.delete(schema.projectChunk).where(scope);
  for (let i = 0; i < units.length; i += 100) {
    await db.insert(schema.projectChunk).values(
      units.slice(i, i + 100).map((u) => {
        const vector = kept.get(u.text) ?? null;
        return { ...u, embedding: vector, model: vector ? model : null };
      }),
    );
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
  const scope = eq(schema.projectChunk.pageId, pageId);
  const page = await db.query.spacePage.findFirst({ where: eq(schema.spacePage.id, pageId) });
  if (!page || page.wizardId) {
    await db.delete(schema.projectChunk).where(scope);
    return;
  }
  const [tree, categories] = await Promise.all([
    pageTree(page.projectId),
    categoryRows(page.projectId),
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
        projectId: page.projectId,
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
    ? inArray(schema.projectChunk.rowId, rowIds)
    : eq(schema.projectChunk.tableId, tableId);
  if (!table || table.wizardId) {
    await db.delete(schema.projectChunk).where(scope);
    return;
  }
  const rows = await db.query.spaceTableRow.findMany({
    where: rowIds
      ? and(eq(schema.spaceTableRow.tableId, table.id), inArray(schema.spaceTableRow.id, rowIds))
      : eq(schema.spaceTableRow.tableId, table.id),
  });
  const categories = await categoryRows(table.projectId);
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
      projectId: table.projectId,
      tableId: table.id,
      rowId: row.id,
      heading: table.format === "faq" ? (cells[0]?.[1] ?? null) : null,
      idx: i,
      text: `${head([table.title], [...tableLines, ...own])}\n\n${body}`,
    };
  });
  await writeUnits(scope, units);
}

async function indexFile(fileId: string) {
  const file = await db.query.projectFile.findFirst({ where: eq(schema.projectFile.id, fileId) });
  if (file?.kind !== "document" || file.status !== "ready") {
    return;
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
  const scope = eq(schema.projectChunk.fileId, file.id);
  if (converted) {
    // Its text is the page's now; the file stands behind it as the original.
    await db.delete(schema.projectChunk).where(scope);
    return;
  }
  const passages = await db
    .select({ heading: schema.projectChunk.heading, idx: schema.projectChunk.idx })
    .from(schema.projectChunk)
    .where(scope);
  // Passages of a document read before Knowledge had pages stay until it is read again.
  if (passages.some((p) => p.heading === null)) {
    return;
  }
  const categories = await categoryRows(file.projectId);
  const lines = categoryLines(
    categories,
    (await itemCategoriesOf([{ fileId: file.id }])).get(`f:${file.id}`),
  );
  await writeUnits(scope, [
    {
      projectId: file.projectId,
      fileId: file.id,
      heading: file.name,
      idx: 0,
      text: [head([file.name], lines), file.description].filter(Boolean).join("\n\n"),
    },
  ]);
}

async function indexValue(valueId: string) {
  const scope = eq(schema.projectChunk.valueId, valueId);
  const value = await db.query.spaceCategoryValue.findFirst({
    where: eq(schema.spaceCategoryValue.id, valueId),
  });
  const category = value
    ? await db.query.spaceCategory.findFirst({
        where: eq(schema.spaceCategory.id, value.categoryId),
      })
    : undefined;
  if (!(value?.summary && category)) {
    await db.delete(schema.projectChunk).where(scope);
    return;
  }
  const units = partsOf(value.summary).map((part, i) => ({
    projectId: category.projectId,
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
    .catch((err) => console.error(`[project-index] ${key}`, err));
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

/** Indexes what waits now, and resolves when the index has caught up. */
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
}

// --- plugins' texts ---------------------------------------------------------------------

/** Puts a plugin's text into the space's index, in the place of what its key held. */
export async function putIndexEntry(plugin: string, entry: PluginIndexEntry) {
  const space = await db.query.project.findFirst({ where: eq(schema.project.id, entry.space) });
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
      eq(schema.projectChunk.projectId, entry.space),
      eq(schema.projectChunk.plugin, plugin),
      eq(schema.projectChunk.ref, entry.key),
    ) as SQL,
    chunks.map((c) => ({
      projectId: entry.space,
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
    .delete(schema.projectChunk)
    .where(
      and(
        eq(schema.projectChunk.projectId, space),
        eq(schema.projectChunk.plugin, plugin),
        key === undefined ? undefined : eq(schema.projectChunk.ref, key),
      ),
    );
}

/** Whether a plugin the tenant has put a text into the space's index. */
export async function hasIndexEntries(projectId: string): Promise<boolean> {
  const plugins = [...(await pluginIdsOf(currentTenant()))];
  if (!plugins.length) {
    return false;
  }
  const found = await db.query.projectChunk.findFirst({
    columns: { id: true },
    where: and(
      eq(schema.projectChunk.projectId, projectId),
      inArray(schema.projectChunk.plugin, plugins),
    ),
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
}

const COLUMNS = sql.raw(
  "c.id, c.file_id, c.page_id, c.row_id, c.table_id, c.value_id, c.heading, c.sheet, c.plugin, c.ref, c.title, c.link, c.idx, c.text",
);

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
  (u.page_id !== null && f.pages.has(u.page_id)) ||
  (u.row_id !== null && f.rows.has(u.row_id)) ||
  (u.file_id !== null && f.files.has(u.file_id));

/** The key of the item a unit belongs to: hits are grouped by it. */
function itemOf(u: Found): string {
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
 * Searches Knowledge: items whose categories pass `where`, then the units the keywords, the
 * trigrams and the vectors rank best, merged by rank (RRF), then the classifier's judgement of
 * each of the CANDIDATES best. Gives up to `limit` items with their best section. `check: false`
 * leaves the classifier out.
 */
export async function searchKnowledge(
  projectId: string,
  query: string,
  opts: { where?: Where; limit?: number; check?: boolean; signal?: AbortSignal } = {},
): Promise<KnowledgeSearch> {
  const limit = Math.min(Math.max(1, opts.limit ?? 6), 12);
  const filter = await filterItems(projectId, opts.where);
  if (filter && !filter.size) {
    return { hits: [], candidates: 0, checked: false, filtered: 0 };
  }
  const plugins = [...(await pluginIdsOf(currentTenant()))];
  const inFilter = filter ? filtered(filter) : null;
  // A filter keeps plugins' texts and summaries out: they have no categories.
  const where = and(
    sql`c.project_id = ${projectId}`,
    searchable(plugins),
    filter
      ? (inFilter ?? sql`(c.page_id IS NOT NULL OR c.row_id IS NOT NULL OR c.file_id IS NOT NULL)`)
      : undefined,
  ) as SQL;
  const take = filter && !inFilter ? 300 : CANDIDATES;
  const lists: Found[][] = [];
  const words = keywordQuery(query);
  if (words) {
    lists.push(
      await db.all<Found>(sql`
        SELECT ${COLUMNS} FROM project_chunk_fts f JOIN project_chunk c ON c.id = f.rowid
        WHERE project_chunk_fts MATCH ${words} AND ${where}
        ORDER BY bm25(project_chunk_fts) LIMIT ${take}`),
    );
  }
  const grams = trigramQuery(query);
  if (grams) {
    lists.push(
      await db
        .all<Found>(sql`
          SELECT ${COLUMNS} FROM project_chunk_tri f JOIN project_chunk c ON c.id = f.rowid
          WHERE project_chunk_tri MATCH ${grams} AND ${where}
          ORDER BY bm25(project_chunk_tri) LIMIT ${take}`)
        .catch(() => []),
    );
  }
  const embedded = await embed([query]).catch(() => null);
  if (embedded) {
    lists.push(
      await db.all<Found>(sql`
        SELECT ${COLUMNS} FROM project_chunk c
        WHERE ${where} AND c.model = ${embedded.model}
        ORDER BY vector_distance_cos(c.embedding, ${vectorBytes(embedded.vectors[0])}) LIMIT ${take}`),
    );
  }
  // Reciprocal rank fusion: a unit the lists rank high comes first.
  const scored = new Map<number, { unit: Found; score: number }>();
  for (const list of lists) {
    list
      .filter((u) => !filter || inFilter || leaves(filter, u))
      .slice(0, CANDIDATES)
      .forEach((unit, rank) => {
        const entry = scored.get(unit.id) ?? { unit, score: 0 };
        entry.score += 1 / (60 + rank);
        scored.set(unit.id, entry);
      });
  }
  const candidates = [...scored.values()].sort((a, b) => b.score - a.score).slice(0, CANDIDATES);
  if (!candidates.length) {
    return { hits: [], candidates: 0, checked: false, filtered: filter?.size ?? null };
  }
  const described = await describe(
    projectId,
    candidates.map((c) => c.unit),
  );
  const judged =
    opts.check === false
      ? null
      : await judgeRelevance(
          query,
          described.map((d) => ({
            title: d.title,
            path: d.path,
            categories: d.categories,
            heading: d.heading,
            text: d.text,
          })),
          opts.signal,
        );
  const ranked = described
    .map((hit, i) => ({ hit: { ...hit, relevance: judged?.[i] ?? null }, rank: i }))
    .filter(({ hit }) => hit.relevance === null || hit.relevance >= MIN_RELEVANCE)
    .sort((a, b) =>
      judged
        ? (b.hit.relevance ?? MIN_RELEVANCE) - (a.hit.relevance ?? MIN_RELEVANCE) || a.rank - b.rank
        : a.rank - b.rank,
    );
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

/** What a step and the studio see of each unit: the item's path, title and categories. */
async function describe(projectId: string, units: Found[]): Promise<KnowledgeHit[]> {
  const pageIds = [...new Set(units.flatMap((u) => (u.page_id ? [u.page_id] : [])))];
  const rowIds = [...new Set(units.flatMap((u) => (u.row_id ? [u.row_id] : [])))];
  const fileIds = [...new Set(units.flatMap((u) => (u.file_id ? [u.file_id] : [])))];
  const valueIds = [...new Set(units.flatMap((u) => (u.value_id ? [u.value_id] : [])))];
  const [tree, tPaths, fPaths, categories, rows, files, values] = await Promise.all([
    pageIds.length ? pageTree(projectId) : new Map(),
    rowIds.length ? tablePaths(projectId) : new Map<string, string>(),
    fileIds.length ? filePaths(projectId) : new Map<string, string>(),
    categoryRows(projectId),
    rowIds.length
      ? db.query.spaceTableRow.findMany({
          where: inArray(schema.spaceTableRow.id, rowIds),
          columns: { id: true, tableId: true },
        })
      : [],
    fileIds.length
      ? db.query.projectFile.findMany({
          where: inArray(schema.projectFile.id, fileIds),
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
    };
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
export async function reindexSpace(projectId: string) {
  const [pages, tables, files, values] = await Promise.all([
    db.query.spacePage.findMany({
      where: and(eq(schema.spacePage.projectId, projectId), isNull(schema.spacePage.wizardId)),
      columns: { id: true },
    }),
    db.query.spaceTable.findMany({
      where: and(eq(schema.spaceTable.projectId, projectId), isNull(schema.spaceTable.wizardId)),
      columns: { id: true },
    }),
    db.query.projectFile.findMany({
      where: and(
        eq(schema.projectFile.projectId, projectId),
        eq(schema.projectFile.kind, "document"),
      ),
      columns: { id: true },
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
          eq(schema.spaceCategory.projectId, projectId),
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
  for (const f of files) {
    queueIndex(`f:${f.id}`);
  }
  for (const v of values) {
    queueIndex(`v:${v.id}`);
  }
}
