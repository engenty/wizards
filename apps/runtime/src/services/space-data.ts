import type { Lang } from "@engenty/wizards-shared/definition";
import {
  type TableColumn,
  TableColumnValueError,
  tableColumnsSchema,
} from "@engenty/wizards-shared/engenty/data-tables";
import type { CategoryInput } from "@engenty/wizards-shared/knowledge";
import { note } from "@engenty/wizards-shared/run";
import {
  editCells,
  SPACE_DATA_LIMITS,
  type SpaceData,
  type SpacePage,
  type SpaceTable,
  type SpaceTableRow,
} from "@engenty/wizards-shared/space-data";
import { rowKey } from "@engenty/wizards-shared/store";
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, max } from "drizzle-orm";
import { nanoid } from "nanoid";
import { assertRwx, pageResources, readable, type Subject, tableResources } from "../broker/rwx.js";
import { db, schema } from "../db/client.js";
import { saidOf } from "../model-errors.js";
import { currentTenant } from "../tenants/tenant.js";
import { serverText } from "../texts.js";
import { requireWritableSpace, spaceWritable } from "./access.js";
import { notFound, ServiceError } from "./errors.js";
import { filePaths, freeSlug, knowledgePage, pageTree, tablePaths } from "./knowledge.js";
import { itemCategoriesOf, setItemCategories, syncTableRowCategories } from "./space-categories.js";
import { queueIndex } from "./space-index.js";
import { ownedSpace } from "./spaces.js";

/**
 * The tables and pages a space keeps: its own — Knowledge, written by people and by plugins — or
 * one of its wizards' — Data, written by its runs. Every write checks that the space may be
 * changed here; a read-only space (a local install's) shows them only. What Knowledge holds is
 * indexed on every write, a moment after it.
 */

type TableRow = typeof schema.spaceTable.$inferSelect;
type PageRow = typeof schema.spacePage.$inferSelect;

/** A wizard of the space, or null for the space's own. */
async function ownerOf(spaceId: string, wizardId: string | null | undefined) {
  if (!wizardId) {
    return null;
  }
  const w = await db.query.wizard.findFirst({
    where: and(eq(schema.wizard.id, wizardId), eq(schema.wizard.spaceId, spaceId)),
    columns: { id: true },
  });
  if (!w) {
    throw new ServiceError("invalid", note("wizardNotSpace"));
  }
  return w.id;
}

function cellError(err: unknown): never {
  if (err instanceof TableColumnValueError) {
    throw new ServiceError("invalid", saidOf(err), { column: err.columnId });
  }
  throw err;
}

export function checkColumns(columns: unknown): TableColumn[] {
  const parsed = tableColumnsSchema.safeParse(columns);
  if (!parsed.success) {
    throw new ServiceError("invalid", parsed.error.issues[0]?.message ?? note("invalidColumns"));
  }
  return parsed.data;
}

/**
 * Data: the tables and pages the space's wizards keep that `who` may read, and the wizards to
 * name whose they are.
 */
export async function listSpaceData(
  userId: string,
  spaceId: string,
  who: Subject[],
): Promise<SpaceData> {
  const space = await ownedSpace(userId, spaceId);
  const [tables, rows, pages, wizards] = await Promise.all([
    db.query.spaceTable.findMany({
      where: and(eq(schema.spaceTable.spaceId, space.id), isNotNull(schema.spaceTable.wizardId)),
      orderBy: [asc(schema.spaceTable.title)],
      columns: { id: true, wizardId: true, list: true, title: true, updatedAt: true },
    }),
    db
      .select({ tableId: schema.spaceTableRow.tableId, n: count() })
      .from(schema.spaceTableRow)
      .innerJoin(schema.spaceTable, eq(schema.spaceTable.id, schema.spaceTableRow.tableId))
      .where(eq(schema.spaceTable.spaceId, space.id))
      .groupBy(schema.spaceTableRow.tableId),
    db.query.spacePage.findMany({
      where: and(eq(schema.spacePage.spaceId, space.id), isNotNull(schema.spacePage.wizardId)),
      orderBy: [asc(schema.spacePage.title)],
      columns: { id: true, wizardId: true, title: true, updatedAt: true },
    }),
    db.query.wizard.findMany({
      where: eq(schema.wizard.spaceId, space.id),
      orderBy: [desc(schema.wizard.updatedAt)],
      columns: { id: true, title: true },
    }),
  ]);
  const [okTables, okPages] = await Promise.all([
    readable(space.id, who, await tableResources(tables.map((t) => t.id))),
    readable(space.id, who, await pageResources(pages.map((p) => p.id))),
  ]);
  return {
    tables: tables
      .filter((t) => okTables.has(t.id))
      .map((t) => ({
        ...t,
        rows: rows.find((r) => r.tableId === t.id)?.n ?? 0,
        updatedAt: t.updatedAt.toISOString(),
      })),
    pages: pages
      .filter((p) => okPages.has(p.id))
      .map((p) => ({ ...p, updatedAt: p.updatedAt.toISOString() })),
    wizards,
  };
}

// --- tables --------------------------------------------------------------------

async function tableRow(tableId: string): Promise<TableRow> {
  const table = await db.query.spaceTable.findFirst({
    where: and(eq(schema.spaceTable.id, tableId), eq(schema.spaceTable.tenantId, currentTenant())),
  });
  if (!table) {
    throw notFound();
  }
  return table;
}

async function writableTable(tableId: string): Promise<TableRow> {
  const table = await tableRow(tableId);
  await requireWritableSpace(table.spaceId);
  return table;
}

/** A person changed a table: when a plugin wrote it, the plugin no longer does. */
async function touchTable(table: TableRow) {
  await db
    .update(schema.spaceTable)
    .set({ updatedAt: new Date(), ...(table.origin && !table.kept ? { kept: true } : {}) })
    .where(eq(schema.spaceTable.id, table.id));
}

async function tableCount(spaceId: string) {
  const [{ n }] = await db
    .select({ n: count() })
    .from(schema.spaceTable)
    .where(eq(schema.spaceTable.spaceId, spaceId));
  if (n >= SPACE_DATA_LIMITS.tables) {
    throw new ServiceError("refused", note("spaceMostTables", { count: SPACE_DATA_LIMITS.tables }));
  }
}

export async function createTable(
  userId: string,
  spaceId: string,
  input: {
    title: string;
    wizardId?: string | null;
    /** Its folder in Knowledge: a page of the space's own. */
    parentId?: string | null;
    columns?: unknown;
    format?: "faq" | null;
  },
  lang: Lang = "en",
) {
  const space = await ownedSpace(userId, spaceId);
  await requireWritableSpace(space.id);
  await tableCount(space.id);
  const columns = input.columns
    ? checkColumns(input.columns)
    : input.format === "faq"
      ? [
          { id: "question", name: serverText(lang, "faqQuestion"), type: "text" as const },
          {
            id: "answer",
            name: serverText(lang, "faqAnswer"),
            type: "text" as const,
            format: { style: "multiline" as const },
          },
        ]
      : [{ id: "name", name: "Name", type: "text" as const }];
  const id = nanoid(12);
  const wizardId = await ownerOf(space.id, input.wizardId);
  const parentId = wizardId ? null : await parentOf(space.id, input.parentId);
  const title = input.title.trim() || serverText(lang, "tableTitle");
  await db.insert(schema.spaceTable).values({
    id,
    tenantId: currentTenant(),
    spaceId: space.id,
    wizardId,
    parentId,
    position: wizardId ? 0 : await nextPosition(space.id, parentId),
    title,
    slug: wizardId ? null : await freeSlug(space.id, title, "table"),
    format: input.format ?? null,
    columns,
  });
  return { id };
}

async function tableKnowledge(table: TableRow): Promise<SpaceTable["knowledge"]> {
  if (table.wizardId) {
    return null;
  }
  const file = table.fileId
    ? await db.query.spaceFile.findFirst({
        where: eq(schema.spaceFile.id, table.fileId),
        columns: { id: true, name: true, mime: true },
      })
    : undefined;
  return {
    path: (await tablePaths(table.spaceId)).get(table.id) ?? "",
    categories: (await itemCategoriesOf([{ tableId: table.id }])).get(`t:${table.id}`) ?? [],
    origin: table.origin,
    originLabel: table.originLabel,
    kept: table.kept,
    review: table.review,
    file: file ?? null,
  };
}

export async function getTable(
  userId: string,
  tableId: string,
  who: Subject[],
): Promise<SpaceTable> {
  const header = await getTableHeader(userId, tableId, who);
  const rows = await db.query.spaceTableRow.findMany({
    where: eq(schema.spaceTableRow.tableId, header.id),
    orderBy: [asc(schema.spaceTableRow.createdAt), asc(schema.spaceTableRow.id)],
  });
  return { ...header, rows: rows.map(rowView) };
}

/** A table without its rows: what a change of its title or columns needs (live/views.ts). */
export async function getTableHeader(
  userId: string,
  tableId: string,
  who: Subject[],
): Promise<Omit<SpaceTable, "rows">> {
  const table = await tableRow(tableId);
  const space = await ownedSpace(userId, table.spaceId);
  await assertRwx(space.id, who, { kind: "table", id: table.id, fileId: table.fileId }, "r");
  return {
    id: table.id,
    spaceId: table.spaceId,
    wizardId: table.wizardId,
    list: table.list,
    title: table.title,
    format: table.format,
    columns: table.columns,
    readOnly: !(await spaceWritable(space)),
    knowledge: await tableKnowledge(table),
  };
}

/** One row of a table, as the table shows it; null when it is gone. */
export async function getRow(
  _userId: string,
  tableId: string,
  rowId: string,
  who: Subject[],
): Promise<SpaceTableRow | null> {
  const table = await tableRow(tableId);
  await assertRwx(table.spaceId, who, { kind: "table", id: table.id, fileId: table.fileId }, "r");
  const row = await db.query.spaceTableRow.findFirst({
    where: and(eq(schema.spaceTableRow.id, rowId), eq(schema.spaceTableRow.tableId, tableId)),
  });
  return row ? rowView(row) : null;
}

const rowView = (r: typeof schema.spaceTableRow.$inferSelect): SpaceTableRow => ({
  id: r.id,
  cells: r.cells,
  updatedAt: r.updatedAt.toISOString(),
});

/**
 * A new title, owner or columns. Rows keep their cells: a removed column's cells are dropped
 * the next time the row changes, and are not shown before. `review: null`: a person looked.
 */
export async function updateTable(
  _userId: string,
  tableId: string,
  patch: {
    title?: string;
    wizardId?: string | null;
    columns?: unknown;
    format?: "faq" | null;
    review?: null;
  },
) {
  const table = await writableTable(tableId);
  if (table.list && (patch.columns !== undefined || patch.wizardId !== undefined)) {
    throw new ServiceError("refused", note("tableBelongsOneWizard"));
  }
  const title = patch.title !== undefined ? patch.title.trim() || table.title : table.title;
  const wizardId =
    patch.wizardId !== undefined ? await ownerOf(table.spaceId, patch.wizardId) : table.wizardId;
  const changed =
    title !== table.title || patch.columns !== undefined || patch.format !== undefined;
  await db
    .update(schema.spaceTable)
    .set({
      title,
      wizardId,
      ...(title !== table.title || wizardId !== table.wizardId
        ? { slug: wizardId ? null : await freeSlug(table.spaceId, title, "table", table.id) }
        : {}),
      ...(patch.columns !== undefined ? { columns: checkColumns(patch.columns) } : {}),
      ...(patch.format !== undefined ? { format: patch.format } : {}),
      ...(patch.review === null ? { review: null } : {}),
      ...(changed && table.origin ? { kept: true } : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.spaceTable.id, table.id));
  if (changed || wizardId !== table.wizardId) {
    queueIndex(`t:${table.id}`);
  }
}

/** The file an item was read from goes with it, when it was uploaded and nothing else uses it. */
async function dropOriginal(item: {
  fileId: string | null;
  originKey: string | null;
  spaceId: string;
}) {
  if (!item.fileId || item.originKey) {
    return;
  }
  const used =
    (await db.query.spacePage.findFirst({
      where: eq(schema.spacePage.fileId, item.fileId),
      columns: { id: true },
    })) ??
    (await db.query.spaceTable.findFirst({
      where: eq(schema.spaceTable.fileId, item.fileId),
      columns: { id: true },
    }));
  if (!used) {
    const { removeSpaceFile } = await import("./space-files.js");
    await removeSpaceFile(item.spaceId, item.fileId).catch(() => undefined);
  }
}

export async function deleteTable(_userId: string, tableId: string) {
  const table = await writableTable(tableId);
  await db.delete(schema.spaceTable).where(eq(schema.spaceTable.id, table.id));
  await dropOriginal(table);
}

/** The key a row of a shared list is matched on; tables made in the studio have none. */
function keyOf(table: TableRow, cells: Record<string, unknown>) {
  return table.keyColumn
    ? rowKey(
        { id: table.list ?? "", title: table.title, columns: table.columns, key: table.keyColumn },
        cells,
      )
    : null;
}

/** A row of a shared list whose key another row has already is refused: runs match on it. */
async function refuseClash(tableId: string, key: string | null, rowId: string | null) {
  if (!key) {
    return;
  }
  const other = await db.query.spaceTableRow.findFirst({
    where: and(eq(schema.spaceTableRow.tableId, tableId), eq(schema.spaceTableRow.key, key)),
    columns: { id: true },
  });
  if (other && other.id !== rowId) {
    throw new ServiceError("invalid", note("entryAlreadyExists"));
  }
}

/** After a row of a table of Knowledge changed: its categories from its columns, its unit. */
async function rowChanged(table: TableRow, rowId: string) {
  if (table.wizardId) {
    return;
  }
  await syncTableRowCategories(table.id, [rowId]);
  queueIndex(`r:${rowId}`);
}

/** Adds a row; `cells` may leave columns empty, even required ones, to be filled later. */
export async function addTableRow(
  _userId: string,
  tableId: string,
  cells: Record<string, unknown> = {},
) {
  const table = await writableTable(tableId);
  const [{ n }] = await db
    .select({ n: count() })
    .from(schema.spaceTableRow)
    .where(eq(schema.spaceTableRow.tableId, table.id));
  if (n >= SPACE_DATA_LIMITS.rowsPerTable) {
    throw new ServiceError(
      "refused",
      note("tableMostRows", { count: SPACE_DATA_LIMITS.rowsPerTable }),
    );
  }
  let value: Record<string, unknown>;
  try {
    value = editCells(table.columns, {}, cells);
  } catch (err) {
    cellError(err);
  }
  const key = keyOf(table, value);
  await refuseClash(table.id, key, null);
  const row = { id: nanoid(14), tableId: table.id, key, cells: value, createdAt: new Date() };
  await db.insert(schema.spaceTableRow).values(row);
  await touchTable(table);
  await rowChanged(table, row.id);
  const saved = await db.query.spaceTableRow.findFirst({
    where: eq(schema.spaceTableRow.id, row.id),
  });
  return { id: row.id, cells: value, updatedAt: (saved?.updatedAt ?? new Date()).toISOString() };
}

/** Changes the cells named in `cells`; the others stay. */
export async function updateTableRow(
  _userId: string,
  tableId: string,
  rowId: string,
  cells: Record<string, unknown>,
) {
  const table = await writableTable(tableId);
  const row = await db.query.spaceTableRow.findFirst({
    where: and(eq(schema.spaceTableRow.id, rowId), eq(schema.spaceTableRow.tableId, table.id)),
  });
  if (!row) {
    throw notFound();
  }
  let value: Record<string, unknown>;
  try {
    value = editCells(table.columns, row.cells, cells);
  } catch (err) {
    cellError(err);
  }
  const key = keyOf(table, value);
  await refuseClash(table.id, key, row.id);
  await db
    .update(schema.spaceTableRow)
    .set({ cells: value, key, updatedAt: new Date() })
    .where(eq(schema.spaceTableRow.id, row.id));
  await touchTable(table);
  await rowChanged(table, row.id);
  return { id: row.id, cells: value };
}

export async function deleteTableRows(_userId: string, tableId: string, rowIds: string[]) {
  const table = await writableTable(tableId);
  if (!rowIds.length) {
    return;
  }
  await db
    .delete(schema.spaceTableRow)
    .where(
      and(eq(schema.spaceTableRow.tableId, table.id), inArray(schema.spaceTableRow.id, rowIds)),
    );
  await touchTable(table);
}

// --- pages ---------------------------------------------------------------------

async function pageRow(pageId: string): Promise<PageRow> {
  const page = await db.query.spacePage.findFirst({
    where: and(eq(schema.spacePage.id, pageId), eq(schema.spacePage.tenantId, currentTenant())),
  });
  if (!page) {
    throw notFound();
  }
  return page;
}

function checkMarkdown(markdown: string) {
  if (markdown.length > SPACE_DATA_LIMITS.pageChars) {
    throw new ServiceError(
      "refused",
      note("pageMostChars", { count: SPACE_DATA_LIMITS.pageChars }),
    );
  }
  return markdown;
}

async function pageCount(spaceId: string, more = 1) {
  const [{ n }] = await db
    .select({ n: count() })
    .from(schema.spacePage)
    .where(eq(schema.spacePage.spaceId, spaceId));
  if (n + more > SPACE_DATA_LIMITS.pages) {
    throw new ServiceError("refused", note("spaceMostPages", { count: SPACE_DATA_LIMITS.pages }));
  }
}

/** A page of the space's own that a sub-page may stand under: never one of its own sub-pages. */
async function parentOf(spaceId: string, parentId: string | null | undefined, pageId?: string) {
  if (!parentId) {
    return null;
  }
  const parent = await db.query.spacePage.findFirst({
    where: and(eq(schema.spacePage.id, parentId), eq(schema.spacePage.spaceId, spaceId)),
    columns: { id: true, wizardId: true, parentId: true },
  });
  if (!parent || parent.wizardId) {
    throw new ServiceError("invalid", note("pageNotSubpages"));
  }
  for (let at: string | null = parent.id; at && pageId; ) {
    if (at === pageId) {
      throw new ServiceError("invalid", note("pageNotOwnSubpage"));
    }
    const up: { parentId: string | null } | undefined = await db.query.spacePage.findFirst({
      where: eq(schema.spacePage.id, at),
      columns: { parentId: true },
    });
    at = up?.parentId ?? null;
  }
  return parent.id;
}

/**
 * The place after the last of a folder's contents: its sub-pages, tables and documents share one
 * order. `parentId` null: the top of Knowledge.
 */
async function nextPosition(spaceId: string, parentId: string | null) {
  const lasts = await Promise.all([
    db
      .select({ last: max(schema.spacePage.position) })
      .from(schema.spacePage)
      .where(
        and(
          eq(schema.spacePage.spaceId, spaceId),
          isNull(schema.spacePage.wizardId),
          parentId ? eq(schema.spacePage.parentId, parentId) : isNull(schema.spacePage.parentId),
        ),
      ),
    db
      .select({ last: max(schema.spaceTable.position) })
      .from(schema.spaceTable)
      .where(
        and(
          eq(schema.spaceTable.spaceId, spaceId),
          isNull(schema.spaceTable.wizardId),
          parentId ? eq(schema.spaceTable.parentId, parentId) : isNull(schema.spaceTable.parentId),
        ),
      ),
    db
      .select({ last: max(schema.spaceFile.position) })
      .from(schema.spaceFile)
      .where(
        and(
          eq(schema.spaceFile.spaceId, spaceId),
          eq(schema.spaceFile.kind, "document"),
          parentId ? eq(schema.spaceFile.parentId, parentId) : isNull(schema.spaceFile.parentId),
        ),
      ),
  ]);
  return Math.max(-1, ...lasts.map(([{ last }]) => last ?? -1)) + 1;
}

export async function createPage(
  userId: string,
  spaceId: string,
  input: { title: string; wizardId?: string | null; parentId?: string | null; markdown?: string },
) {
  const space = await ownedSpace(userId, spaceId);
  await requireWritableSpace(space.id);
  await pageCount(space.id);
  const id = nanoid(12);
  const wizardId = await ownerOf(space.id, input.wizardId);
  const parentId = wizardId ? null : await parentOf(space.id, input.parentId);
  const title = input.title.trim() || "Seite";
  await db.insert(schema.spacePage).values({
    id,
    tenantId: currentTenant(),
    spaceId: space.id,
    wizardId,
    parentId,
    position: wizardId ? 0 : await nextPosition(space.id, parentId),
    title,
    slug: wizardId ? null : await freeSlug(space.id, title, { parentId }),
    markdown: checkMarkdown(input.markdown ?? ""),
  });
  if (!wizardId) {
    queueIndex(`p:${id}`);
  }
  return { id };
}

export async function getPage(userId: string, pageId: string, who: Subject[]): Promise<SpacePage> {
  const page = await pageRow(pageId);
  const space = await ownedSpace(userId, page.spaceId);
  await assertRwx(space.id, who, { kind: "page", id: page.id, fileId: page.fileId }, "r");
  return pageView(page, space);
}

/** A page as the studio shows it, for one that was just read or written. */
async function pageView(page: PageRow, space: { origin: string | null }): Promise<SpacePage> {
  return {
    id: page.id,
    spaceId: page.spaceId,
    wizardId: page.wizardId,
    title: page.title,
    markdown: page.markdown,
    updatedAt: page.updatedAt.toISOString(),
    readOnly: !(await spaceWritable(space)),
    knowledge: page.wizardId ? null : await knowledgePage(page),
  };
}

/**
 * A new title, text, owner or place. A person who changes what a plugin wrote keeps the page:
 * the plugin no longer writes it. `review: null`: a person looked at it.
 */
export async function updatePage(
  _userId: string,
  pageId: string,
  patch: {
    title?: string;
    wizardId?: string | null;
    parentId?: string | null;
    markdown?: string;
    review?: null;
    /** The version the edit started from: a page changed after it is refused (409), not overwritten. */
    baseUpdatedAt?: string;
  },
) {
  const page = await pageRow(pageId);
  await requireWritableSpace(page.spaceId);
  if (patch.baseUpdatedAt && page.updatedAt.getTime() > Date.parse(patch.baseUpdatedAt)) {
    throw new ServiceError("revision_conflict", note("itemChangedMeantime"), {
      page: await pageView(page, await ownedSpace(_userId, page.spaceId)),
    });
  }
  const title = patch.title !== undefined ? patch.title.trim() || page.title : page.title;
  const wizardId =
    patch.wizardId !== undefined ? await ownerOf(page.spaceId, patch.wizardId) : page.wizardId;
  const parentId =
    wizardId !== null
      ? null
      : patch.parentId !== undefined
        ? await parentOf(page.spaceId, patch.parentId, page.id)
        : page.parentId;
  const moved = title !== page.title || wizardId !== page.wizardId || parentId !== page.parentId;
  const edited = moved || (patch.markdown !== undefined && patch.markdown !== page.markdown);
  const at = new Date();
  await db
    .update(schema.spacePage)
    .set({
      title,
      wizardId,
      parentId,
      ...(moved
        ? {
            slug: wizardId ? null : await freeSlug(page.spaceId, title, { parentId }, page.id),
            ...(parentId !== page.parentId
              ? { position: await nextPosition(page.spaceId, parentId) }
              : {}),
          }
        : {}),
      ...(patch.markdown !== undefined ? { markdown: checkMarkdown(patch.markdown) } : {}),
      ...(patch.review === null ? { review: null } : {}),
      ...(edited && page.origin ? { kept: true } : {}),
      updatedAt: at,
    })
    .where(eq(schema.spacePage.id, page.id));
  if (moved) {
    queueIndex(`P:${page.id}`);
  } else if (edited) {
    queueIndex(`p:${page.id}`);
  }
  return { updatedAt: at.toISOString() };
}

export async function deletePage(_userId: string, pageId: string) {
  const page = await pageRow(pageId);
  await requireWritableSpace(page.spaceId);
  await db.delete(schema.spacePage).where(eq(schema.spacePage.id, page.id));
  await dropOriginal(page);
}

/**
 * Moves an item of Knowledge (`p:`, `t:` or `f:` and its id) into a folder — a page of the
 * space's own, or the top for null — at `index` among the folder's contents, at the end when left
 * out. A page's path follows it; a table's and a file's do not.
 */
export async function moveKnowledgeItem(
  userId: string,
  spaceId: string,
  input: { key: string; parentId: string | null; index?: number },
) {
  const space = await ownedSpace(userId, spaceId);
  await requireWritableSpace(space.id);
  await placeItem(space.id, input.key, input.parentId);
  if (input.index !== undefined) {
    await orderFolder(space.id, input.parentId ?? null, input.key, input.index);
  }
}

/**
 * Puts an item of Knowledge into a folder of the space, at the end of its contents, unless it is
 * there. Moved, not edited: what a plugin or a source wrote stays theirs.
 */
export async function placeItem(spaceId: string, key: string, parentId: string | null) {
  const kind = key[0];
  const id = key.slice(2);
  const own = <T extends { spaceId: string }>(row: T | undefined) => {
    if (!row || row.spaceId !== spaceId) {
      throw notFound();
    }
    return row;
  };
  if (kind === "p") {
    const page = own(await pageRow(id));
    if (page.wizardId) {
      throw notFound();
    }
    const parent = await parentOf(spaceId, parentId, page.id);
    if (parent !== page.parentId) {
      await db
        .update(schema.spacePage)
        .set({
          parentId: parent,
          slug: await freeSlug(spaceId, page.title, { parentId: parent }, page.id),
          position: await nextPosition(spaceId, parent),
          updatedAt: new Date(),
        })
        .where(eq(schema.spacePage.id, page.id));
      queueIndex(`P:${page.id}`);
    }
  } else if (kind === "t") {
    const table = own(await tableRow(id));
    if (table.wizardId) {
      throw notFound();
    }
    const parent = await parentOf(spaceId, parentId);
    if (parent !== table.parentId) {
      await db
        .update(schema.spaceTable)
        .set({ parentId: parent, position: await nextPosition(spaceId, parent) })
        .where(eq(schema.spaceTable.id, table.id));
    }
  } else if (kind === "f") {
    const file = own(
      await db.query.spaceFile.findFirst({
        where: and(eq(schema.spaceFile.id, id), eq(schema.spaceFile.kind, "document")),
      }),
    );
    const parent = await parentOf(spaceId, parentId);
    if (parent !== file.parentId) {
      const position = await nextPosition(spaceId, parent);
      await db
        .update(schema.spaceFile)
        .set({ parentId: parent, position })
        .where(eq(schema.spaceFile.id, file.id));
      // What it was read into goes with it: its first page (its parts stay under that) and its
      // tables.
      const was = file.parentId
        ? eq(schema.spacePage.parentId, file.parentId)
        : isNull(schema.spacePage.parentId);
      for (const page of await db.query.spacePage.findMany({
        where: and(eq(schema.spacePage.fileId, file.id), was),
        columns: { id: true },
      })) {
        await placeItem(spaceId, `p:${page.id}`, parent);
      }
      await db
        .update(schema.spaceTable)
        .set({ parentId: parent, position })
        .where(eq(schema.spaceTable.fileId, file.id));
    }
  } else {
    throw notFound();
  }
}

/** Puts `key` at `index` among a folder's contents and numbers them all again. */
async function orderFolder(spaceId: string, parentId: string | null, key: string, index: number) {
  const [pages, tables, files] = await Promise.all([
    db.query.spacePage.findMany({
      where: and(
        eq(schema.spacePage.spaceId, spaceId),
        isNull(schema.spacePage.wizardId),
        parentId ? eq(schema.spacePage.parentId, parentId) : isNull(schema.spacePage.parentId),
      ),
      columns: { id: true, position: true, title: true },
    }),
    db.query.spaceTable.findMany({
      where: and(
        eq(schema.spaceTable.spaceId, spaceId),
        isNull(schema.spaceTable.wizardId),
        parentId ? eq(schema.spaceTable.parentId, parentId) : isNull(schema.spaceTable.parentId),
      ),
      columns: { id: true, position: true, title: true },
    }),
    db.query.spaceFile.findMany({
      where: and(
        eq(schema.spaceFile.spaceId, spaceId),
        eq(schema.spaceFile.kind, "document"),
        parentId ? eq(schema.spaceFile.parentId, parentId) : isNull(schema.spaceFile.parentId),
      ),
      columns: { id: true, position: true, name: true },
    }),
  ]);
  const all = [
    ...pages.map((p) => ({ key: `p:${p.id}`, position: p.position, title: p.title })),
    ...tables.map((t) => ({ key: `t:${t.id}`, position: t.position, title: t.title })),
    ...files.map((f) => ({ key: `f:${f.id}`, position: f.position, title: f.name })),
  ].sort((a, b) => a.position - b.position || a.title.localeCompare(b.title, "de"));
  const moving = all.find((i) => i.key === key);
  if (!moving) {
    return;
  }
  const rest = all.filter((i) => i !== moving);
  rest.splice(Math.max(0, Math.min(index, rest.length)), 0, moving);
  for (const [position, item] of rest.entries()) {
    const id = item.key.slice(2);
    const table =
      item.key[0] === "p"
        ? schema.spacePage
        : item.key[0] === "t"
          ? schema.spaceTable
          : schema.spaceFile;
    await db.update(table).set({ position }).where(eq(table.id, id));
  }
}

/** Puts a page's sub-pages into the order of `ids`. */
export async function orderSubPages(_userId: string, pageId: string, ids: string[]) {
  const page = await pageRow(pageId);
  await requireWritableSpace(page.spaceId);
  for (const [position, id] of ids.entries()) {
    await db
      .update(schema.spacePage)
      .set({ position })
      .where(and(eq(schema.spacePage.id, id), eq(schema.spacePage.parentId, page.id)));
  }
}

// --- what runs read and write --------------------------------------------------
// A run writes the pages of its own wizard, on the runtime it runs on: a run on the server writes
// the server's, also in a space a local install synced, which the studio there only shows. It
// reads its wizard's pages; the space's own are Knowledge, read by path.

/** The pages of a run's wizard. */
export async function runPages(spaceId: string, wizardId: string) {
  return db.query.spacePage.findMany({
    where: and(eq(schema.spacePage.spaceId, spaceId), eq(schema.spacePage.wizardId, wizardId)),
    columns: { id: true, wizardId: true, title: true, markdown: true, updatedAt: true },
    orderBy: [asc(schema.spacePage.title)],
  });
}

/** Writes a page of the run's wizard: a new one, or the one with this title, replaced or added to. */
export async function writeRunPage(
  spaceId: string,
  wizardId: string,
  input: { title: string; markdown: string; append?: boolean },
) {
  const title = input.title.trim();
  if (!title) {
    throw new ServiceError("invalid", note("pageNeedsTitle"));
  }
  const existing = (
    await db.query.spacePage.findMany({
      where: and(eq(schema.spacePage.spaceId, spaceId), eq(schema.spacePage.wizardId, wizardId)),
    })
  ).find((p) => p.title.toLowerCase() === title.toLowerCase());
  const markdown =
    existing && input.append
      ? `${existing.markdown.trimEnd()}\n\n${input.markdown.trim()}`
      : input.markdown;
  checkMarkdown(markdown);
  if (existing) {
    await db
      .update(schema.spacePage)
      .set({ markdown, updatedAt: new Date() })
      .where(eq(schema.spacePage.id, existing.id));
    return { id: existing.id, title: existing.title, chars: markdown.length, made: false };
  }
  const [{ n }] = await db
    .select({ n: count() })
    .from(schema.spacePage)
    .where(eq(schema.spacePage.spaceId, spaceId));
  if (n >= SPACE_DATA_LIMITS.pages) {
    throw new ServiceError("refused", note("spaceMostPages", { count: SPACE_DATA_LIMITS.pages }));
  }
  const id = nanoid(12);
  await db.insert(schema.spacePage).values({
    id,
    tenantId: currentTenant(),
    spaceId,
    wizardId,
    title: title.slice(0, 200),
    markdown,
  });
  return { id, title, chars: markdown.length, made: true };
}

// --- what plugins write ------------------------------------------------------------
// A plugin (`server.spaceData`) writes Knowledge under keys of its own: the same key again
// rewrites, never doubles. What a person changed since stays theirs.

export type OriginState = "written" | "kept";

export interface OriginPageInput {
  space: string;
  key: string;
  label?: string | null;
  title: string;
  markdown: string;
  /** The key of the page it stands under, written before by the same plugin. */
  parent?: string | null;
  position?: number;
  /** The file it was read from, kept as the evidence. */
  original?: { name: string; mime: string; data: Uint8Array } | null;
  categories?: CategoryInput;
  review?: string | null;
}

async function originSpace(space: string) {
  const row = await db.query.space.findFirst({
    where: and(eq(schema.space.id, space), eq(schema.space.tenantId, currentTenant())),
    columns: { id: true },
  });
  if (!row) {
    throw new ServiceError("not_found", note("unknownSpace", { space }));
  }
  await requireWritableSpace(row.id);
  return row.id;
}

/** Keeps the original of what a plugin wrote: a document of the space under the same key. */
async function originalFile(
  origin: string,
  spaceId: string,
  key: string,
  label: string | null,
  original: NonNullable<OriginPageInput["original"]>,
  text: string,
) {
  const { putOriginFile } = await import("./space-files.js");
  return putOriginFile(origin, {
    space: spaceId,
    key,
    label,
    name: original.name,
    mime: original.mime,
    data: original.data,
    text,
  });
}

export async function putOriginPage(
  origin: string,
  input: OriginPageInput,
): Promise<{ id: string; state: OriginState }> {
  const spaceId = await originSpace(input.space);
  const key = input.key.trim().slice(0, 300);
  const existing = await db.query.spacePage.findFirst({
    where: and(
      eq(schema.spacePage.spaceId, spaceId),
      eq(schema.spacePage.origin, origin),
      eq(schema.spacePage.originKey, key),
    ),
  });
  if (existing?.kept) {
    return { id: existing.id, state: "kept" };
  }
  const parent = input.parent
    ? await db.query.spacePage.findFirst({
        where: and(
          eq(schema.spacePage.spaceId, spaceId),
          eq(schema.spacePage.origin, origin),
          eq(schema.spacePage.originKey, input.parent),
        ),
        columns: { id: true },
      })
    : null;
  if (input.parent && !parent) {
    throw new ServiceError("invalid", note("noParentPage", { parent: input.parent }));
  }
  const title = input.title.replace(/\s+/g, " ").trim().slice(0, 200) || "Seite";
  const markdown = checkMarkdown(input.markdown);
  const label = input.label?.trim().slice(0, 120) || null;
  const parentId = parent?.id ?? null;
  const fileId = input.original
    ? await originalFile(origin, spaceId, key, label, input.original, markdown)
    : (existing?.fileId ?? null);
  const position = input.position ?? existing?.position ?? (await nextPosition(spaceId, parentId));
  let id = existing?.id;
  const moved = !existing || existing.title !== title || existing.parentId !== parentId;
  if (existing) {
    await db
      .update(schema.spacePage)
      .set({
        title,
        markdown,
        parentId,
        position,
        originLabel: label,
        fileId,
        review: input.review ?? null,
        ...(moved ? { slug: await freeSlug(spaceId, title, { parentId }, existing.id) } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.spacePage.id, existing.id));
  } else {
    await pageCount(spaceId);
    id = nanoid(12);
    await db.insert(schema.spacePage).values({
      id,
      tenantId: currentTenant(),
      spaceId,
      parentId,
      position,
      title,
      slug: await freeSlug(spaceId, title, { parentId }),
      markdown,
      origin,
      originKey: key,
      originLabel: label,
      fileId,
      review: input.review ?? null,
    });
  }
  const set = input.categories
    ? await setItemCategories(spaceId, { pageId: id as string }, input.categories, "origin")
    : { changed: false };
  queueIndex(`${moved || set.changed ? "P" : "p"}:${id}`);
  return { id: id as string, state: "written" };
}

export interface OriginTableInput {
  space: string;
  key: string;
  label?: string | null;
  title: string;
  columns: unknown;
  /** Cells by column id. */
  rows: Record<string, unknown>[];
  format?: "faq" | null;
  original?: { name: string; mime: string; data: Uint8Array } | null;
  categories?: CategoryInput;
  review?: string | null;
}

export async function putOriginTable(
  origin: string,
  input: OriginTableInput,
): Promise<{ id: string; state: OriginState }> {
  const spaceId = await originSpace(input.space);
  const key = input.key.trim().slice(0, 300);
  const existing = await db.query.spaceTable.findFirst({
    where: and(
      eq(schema.spaceTable.spaceId, spaceId),
      eq(schema.spaceTable.origin, origin),
      eq(schema.spaceTable.originKey, key),
    ),
  });
  if (existing?.kept) {
    return { id: existing.id, state: "kept" };
  }
  const columns = checkColumns(input.columns);
  if (input.rows.length > SPACE_DATA_LIMITS.rowsPerTable) {
    throw new ServiceError(
      "refused",
      note("tableMostRows", { count: SPACE_DATA_LIMITS.rowsPerTable }),
    );
  }
  let cells: Record<string, unknown>[];
  try {
    cells = input.rows.map((row) => editCells(columns, {}, row));
  } catch (err) {
    cellError(err);
  }
  const title = input.title.replace(/\s+/g, " ").trim().slice(0, 120) || "Tabelle";
  const label = input.label?.trim().slice(0, 120) || null;
  const csv = [
    columns.map((c) => c.name).join(","),
    ...cells.map((r) => columns.map((c) => String(r[c.id] ?? "")).join(",")),
  ].join("\n");
  const fileId = input.original
    ? await originalFile(origin, spaceId, key, label, input.original, csv)
    : (existing?.fileId ?? null);
  let id = existing?.id;
  if (existing) {
    await db
      .update(schema.spaceTable)
      .set({
        title,
        columns,
        format: input.format ?? null,
        originLabel: label,
        fileId,
        review: input.review ?? null,
        ...(existing.title !== title
          ? { slug: await freeSlug(spaceId, title, "table", existing.id) }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.spaceTable.id, existing.id));
    await db.delete(schema.spaceTableRow).where(eq(schema.spaceTableRow.tableId, existing.id));
  } else {
    await tableCount(spaceId);
    id = nanoid(12);
    await db.insert(schema.spaceTable).values({
      id,
      tenantId: currentTenant(),
      spaceId,
      title,
      slug: await freeSlug(spaceId, title, "table"),
      format: input.format ?? null,
      columns,
      origin,
      originKey: key,
      originLabel: label,
      fileId,
      review: input.review ?? null,
    });
  }
  const now = Date.now();
  for (let i = 0; i < cells.length; i += 200) {
    await db.insert(schema.spaceTableRow).values(
      cells.slice(i, i + 200).map((c, j) => ({
        id: nanoid(14),
        tableId: id as string,
        cells: c,
        // The order they came in: one millisecond apart.
        createdAt: new Date(now - cells.length + i + j),
      })),
    );
  }
  if (input.categories) {
    await setItemCategories(spaceId, { tableId: id as string }, input.categories, "origin");
  }
  await syncTableRowCategories(id as string);
  queueIndex(`t:${id}`);
  return { id: id as string, state: "written" };
}

/** What a plugin wrote into a space, by its keys. */
export async function listOrigin(origin: string, space: string) {
  const spaceId = await originSpace(space);
  const [pages, tables, files] = await Promise.all([
    // What a document of the plugin was read into stands behind the document, not on its own.
    db.query.spacePage.findMany({
      where: and(
        eq(schema.spacePage.spaceId, spaceId),
        eq(schema.spacePage.origin, origin),
        isNotNull(schema.spacePage.originKey),
      ),
      columns: {
        id: true,
        originKey: true,
        title: true,
        kept: true,
        review: true,
        updatedAt: true,
      },
    }),
    db.query.spaceTable.findMany({
      where: and(
        eq(schema.spaceTable.spaceId, spaceId),
        eq(schema.spaceTable.origin, origin),
        isNotNull(schema.spaceTable.originKey),
      ),
      columns: {
        id: true,
        originKey: true,
        title: true,
        kept: true,
        review: true,
        updatedAt: true,
      },
    }),
    db.query.spaceFile.findMany({
      where: and(eq(schema.spaceFile.spaceId, spaceId), eq(schema.spaceFile.origin, origin)),
      columns: { id: true, originKey: true, name: true, updatedAt: true },
    }),
  ]);
  const [tree, tPaths, fPaths] = await Promise.all([
    pageTree(spaceId),
    tablePaths(spaceId),
    filePaths(spaceId),
  ]);
  return [
    ...pages.map((p) => ({
      key: p.originKey as string,
      kind: "page" as const,
      id: p.id,
      title: p.title,
      path: tree.get(p.id)?.path ?? "",
      state: (p.kept ? "kept" : "written") as OriginState,
      review: p.review,
      updatedAt: p.updatedAt.toISOString(),
    })),
    ...tables.map((t) => ({
      key: t.originKey as string,
      kind: "table" as const,
      id: t.id,
      title: t.title,
      path: tPaths.get(t.id) ?? "",
      state: (t.kept ? "kept" : "written") as OriginState,
      review: t.review,
      updatedAt: t.updatedAt.toISOString(),
    })),
    ...files.map((f) => ({
      key: f.originKey as string,
      kind: "file" as const,
      id: f.id,
      title: f.name,
      path: fPaths.get(f.id) ?? "",
      state: "written" as OriginState,
      review: null,
      updatedAt: f.updatedAt.toISOString(),
    })),
  ];
}

/**
 * Takes out what a plugin wrote under a key, or without a key everything it wrote into the
 * space. What a person changed since stays. Returns how many items went.
 */
export async function removeOrigin(origin: string, space: string, key?: string) {
  const spaceId = await originSpace(space);
  const pages = await db
    .delete(schema.spacePage)
    .where(
      and(
        eq(schema.spacePage.spaceId, spaceId),
        eq(schema.spacePage.origin, origin),
        eq(schema.spacePage.kept, false),
        key === undefined ? undefined : eq(schema.spacePage.originKey, key),
      ),
    )
    .returning({ id: schema.spacePage.id });
  const tables = await db
    .delete(schema.spaceTable)
    .where(
      and(
        eq(schema.spaceTable.spaceId, spaceId),
        eq(schema.spaceTable.origin, origin),
        eq(schema.spaceTable.kept, false),
        key === undefined ? undefined : eq(schema.spaceTable.originKey, key),
      ),
    )
    .returning({ id: schema.spaceTable.id });
  const { removeOriginFiles } = await import("./space-files.js");
  const files = await removeOriginFiles(origin, spaceId, key);
  return pages.length + tables.length + files;
}
