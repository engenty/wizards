import type { Lang } from "@engenty-wizards/shared/definition";
import {
  type TableColumn,
  TableColumnValueError,
  tableColumnsSchema,
} from "@engenty-wizards/shared/engenty/data-tables";
import type { CategoryInput } from "@engenty-wizards/shared/knowledge";
import { note } from "@engenty-wizards/shared/run";
import {
  editCells,
  SPACE_DATA_LIMITS,
  type SpaceData,
  type SpacePage,
  type SpaceTable,
} from "@engenty-wizards/shared/space-data";
import { rowKey } from "@engenty-wizards/shared/store";
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, max } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema } from "../db/client.js";
import { saidOf } from "../model-errors.js";
import { currentTenant } from "../tenants/tenant.js";
import { serverText } from "../texts.js";
import { projectWritable, requireWritableProject } from "./access.js";
import { notFound, ServiceError } from "./errors.js";
import { filePaths, freeSlug, knowledgePage, pageTree, tablePaths } from "./knowledge.js";
import { queueIndex } from "./project-index.js";
import { ownedProject } from "./projects.js";
import { itemCategoriesOf, setItemCategories, syncTableRowCategories } from "./space-categories.js";

/**
 * The tables and pages a space keeps: its own — Knowledge, written by people and by plugins — or
 * one of its wizards' — Data, written by its runs. Every write checks that the space may be
 * changed here; a read-only space (a local install's) shows them only. What Knowledge holds is
 * indexed on every write, a moment after it.
 */

type TableRow = typeof schema.spaceTable.$inferSelect;
type PageRow = typeof schema.spacePage.$inferSelect;

/** A wizard of the space, or null for the space's own. */
async function ownerOf(projectId: string, wizardId: string | null | undefined) {
  if (!wizardId) {
    return null;
  }
  const w = await db.query.wizard.findFirst({
    where: and(eq(schema.wizard.id, wizardId), eq(schema.wizard.projectId, projectId)),
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

/** Data: the tables and pages the space's wizards keep, and the wizards to name whose they are. */
export async function listSpaceData(userId: string, projectId: string): Promise<SpaceData> {
  const project = await ownedProject(userId, projectId);
  const [tables, rows, pages, wizards] = await Promise.all([
    db.query.spaceTable.findMany({
      where: and(
        eq(schema.spaceTable.projectId, project.id),
        isNotNull(schema.spaceTable.wizardId),
      ),
      orderBy: [asc(schema.spaceTable.title)],
      columns: { id: true, wizardId: true, list: true, title: true, updatedAt: true },
    }),
    db
      .select({ tableId: schema.spaceTableRow.tableId, n: count() })
      .from(schema.spaceTableRow)
      .innerJoin(schema.spaceTable, eq(schema.spaceTable.id, schema.spaceTableRow.tableId))
      .where(eq(schema.spaceTable.projectId, project.id))
      .groupBy(schema.spaceTableRow.tableId),
    db.query.spacePage.findMany({
      where: and(eq(schema.spacePage.projectId, project.id), isNotNull(schema.spacePage.wizardId)),
      orderBy: [asc(schema.spacePage.title)],
      columns: { id: true, wizardId: true, title: true, updatedAt: true },
    }),
    db.query.wizard.findMany({
      where: eq(schema.wizard.projectId, project.id),
      orderBy: [desc(schema.wizard.updatedAt)],
      columns: { id: true, title: true },
    }),
  ]);
  return {
    tables: tables.map((t) => ({
      ...t,
      rows: rows.find((r) => r.tableId === t.id)?.n ?? 0,
      updatedAt: t.updatedAt.toISOString(),
    })),
    pages: pages.map((p) => ({ ...p, updatedAt: p.updatedAt.toISOString() })),
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
  await requireWritableProject(table.projectId);
  return table;
}

/** A person changed a table: when a plugin wrote it, the plugin no longer does. */
async function touchTable(table: TableRow) {
  await db
    .update(schema.spaceTable)
    .set({ updatedAt: new Date(), ...(table.origin && !table.kept ? { kept: true } : {}) })
    .where(eq(schema.spaceTable.id, table.id));
}

async function tableCount(projectId: string) {
  const [{ n }] = await db
    .select({ n: count() })
    .from(schema.spaceTable)
    .where(eq(schema.spaceTable.projectId, projectId));
  if (n >= SPACE_DATA_LIMITS.tables) {
    throw new ServiceError("refused", note("spaceMostTables", { count: SPACE_DATA_LIMITS.tables }));
  }
}

export async function createTable(
  userId: string,
  projectId: string,
  input: { title: string; wizardId?: string | null; columns?: unknown; format?: "faq" | null },
  lang: Lang = "en",
) {
  const project = await ownedProject(userId, projectId);
  await requireWritableProject(project.id);
  await tableCount(project.id);
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
  const wizardId = await ownerOf(project.id, input.wizardId);
  const title = input.title.trim() || serverText(lang, "tableTitle");
  await db.insert(schema.spaceTable).values({
    id,
    tenantId: currentTenant(),
    projectId: project.id,
    wizardId,
    title,
    slug: wizardId ? null : await freeSlug(project.id, title, "table"),
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
    ? await db.query.projectFile.findFirst({
        where: eq(schema.projectFile.id, table.fileId),
        columns: { id: true, name: true, mime: true },
      })
    : undefined;
  return {
    path: (await tablePaths(table.projectId)).get(table.id) ?? "",
    categories: (await itemCategoriesOf([{ tableId: table.id }])).get(`t:${table.id}`) ?? [],
    origin: table.origin,
    originLabel: table.originLabel,
    kept: table.kept,
    review: table.review,
    file: file ?? null,
  };
}

export async function getTable(userId: string, tableId: string): Promise<SpaceTable> {
  const table = await tableRow(tableId);
  const project = await ownedProject(userId, table.projectId);
  const rows = await db.query.spaceTableRow.findMany({
    where: eq(schema.spaceTableRow.tableId, table.id),
    orderBy: [asc(schema.spaceTableRow.createdAt), asc(schema.spaceTableRow.id)],
  });
  return {
    id: table.id,
    projectId: table.projectId,
    wizardId: table.wizardId,
    list: table.list,
    title: table.title,
    format: table.format,
    columns: table.columns,
    rows: rows.map((r) => ({ id: r.id, cells: r.cells, updatedAt: r.updatedAt.toISOString() })),
    readOnly: !(await projectWritable(project)),
    knowledge: await tableKnowledge(table),
  };
}

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
    patch.wizardId !== undefined ? await ownerOf(table.projectId, patch.wizardId) : table.wizardId;
  const changed =
    title !== table.title || patch.columns !== undefined || patch.format !== undefined;
  await db
    .update(schema.spaceTable)
    .set({
      title,
      wizardId,
      ...(title !== table.title || wizardId !== table.wizardId
        ? { slug: wizardId ? null : await freeSlug(table.projectId, title, "table", table.id) }
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
  projectId: string;
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
    const { removeProjectFile } = await import("./project-files.js");
    await removeProjectFile(item.projectId, item.fileId).catch(() => undefined);
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
  return { id: row.id, cells: value };
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

async function pageCount(projectId: string, more = 1) {
  const [{ n }] = await db
    .select({ n: count() })
    .from(schema.spacePage)
    .where(eq(schema.spacePage.projectId, projectId));
  if (n + more > SPACE_DATA_LIMITS.pages) {
    throw new ServiceError("refused", note("spaceMostPages", { count: SPACE_DATA_LIMITS.pages }));
  }
}

/** A page of the space's own that a sub-page may stand under: never one of its own sub-pages. */
async function parentOf(projectId: string, parentId: string | null | undefined, pageId?: string) {
  if (!parentId) {
    return null;
  }
  const parent = await db.query.spacePage.findFirst({
    where: and(eq(schema.spacePage.id, parentId), eq(schema.spacePage.projectId, projectId)),
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

async function nextPosition(projectId: string, parentId: string | null) {
  const [{ last }] = await db
    .select({ last: max(schema.spacePage.position) })
    .from(schema.spacePage)
    .where(
      and(
        eq(schema.spacePage.projectId, projectId),
        isNull(schema.spacePage.wizardId),
        parentId ? eq(schema.spacePage.parentId, parentId) : isNull(schema.spacePage.parentId),
      ),
    );
  return (last ?? -1) + 1;
}

export async function createPage(
  userId: string,
  projectId: string,
  input: { title: string; wizardId?: string | null; parentId?: string | null; markdown?: string },
) {
  const project = await ownedProject(userId, projectId);
  await requireWritableProject(project.id);
  await pageCount(project.id);
  const id = nanoid(12);
  const wizardId = await ownerOf(project.id, input.wizardId);
  const parentId = wizardId ? null : await parentOf(project.id, input.parentId);
  const title = input.title.trim() || "Seite";
  await db.insert(schema.spacePage).values({
    id,
    tenantId: currentTenant(),
    projectId: project.id,
    wizardId,
    parentId,
    position: wizardId ? 0 : await nextPosition(project.id, parentId),
    title,
    slug: wizardId ? null : await freeSlug(project.id, title, { parentId }),
    markdown: checkMarkdown(input.markdown ?? ""),
  });
  if (!wizardId) {
    queueIndex(`p:${id}`);
  }
  return { id };
}

export async function getPage(userId: string, pageId: string): Promise<SpacePage> {
  const page = await pageRow(pageId);
  const project = await ownedProject(userId, page.projectId);
  return {
    id: page.id,
    projectId: page.projectId,
    wizardId: page.wizardId,
    title: page.title,
    markdown: page.markdown,
    updatedAt: page.updatedAt.toISOString(),
    readOnly: !(await projectWritable(project)),
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
  },
) {
  const page = await pageRow(pageId);
  await requireWritableProject(page.projectId);
  const title = patch.title !== undefined ? patch.title.trim() || page.title : page.title;
  const wizardId =
    patch.wizardId !== undefined ? await ownerOf(page.projectId, patch.wizardId) : page.wizardId;
  const parentId =
    wizardId !== null
      ? null
      : patch.parentId !== undefined
        ? await parentOf(page.projectId, patch.parentId, page.id)
        : page.parentId;
  const moved = title !== page.title || wizardId !== page.wizardId || parentId !== page.parentId;
  const edited = moved || (patch.markdown !== undefined && patch.markdown !== page.markdown);
  await db
    .update(schema.spacePage)
    .set({
      title,
      wizardId,
      parentId,
      ...(moved
        ? {
            slug: wizardId ? null : await freeSlug(page.projectId, title, { parentId }, page.id),
            ...(parentId !== page.parentId
              ? { position: await nextPosition(page.projectId, parentId) }
              : {}),
          }
        : {}),
      ...(patch.markdown !== undefined ? { markdown: checkMarkdown(patch.markdown) } : {}),
      ...(patch.review === null ? { review: null } : {}),
      ...(edited && page.origin ? { kept: true } : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.spacePage.id, page.id));
  if (moved) {
    queueIndex(`P:${page.id}`);
  } else if (edited) {
    queueIndex(`p:${page.id}`);
  }
}

export async function deletePage(_userId: string, pageId: string) {
  const page = await pageRow(pageId);
  await requireWritableProject(page.projectId);
  await db.delete(schema.spacePage).where(eq(schema.spacePage.id, page.id));
  await dropOriginal(page);
}

/** Puts a page's sub-pages into the order of `ids`. */
export async function orderSubPages(_userId: string, pageId: string, ids: string[]) {
  const page = await pageRow(pageId);
  await requireWritableProject(page.projectId);
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
export async function runPages(projectId: string, wizardId: string) {
  return db.query.spacePage.findMany({
    where: and(eq(schema.spacePage.projectId, projectId), eq(schema.spacePage.wizardId, wizardId)),
    columns: { id: true, wizardId: true, title: true, markdown: true, updatedAt: true },
    orderBy: [asc(schema.spacePage.title)],
  });
}

/** Writes a page of the run's wizard: a new one, or the one with this title, replaced or added to. */
export async function writeRunPage(
  projectId: string,
  wizardId: string,
  input: { title: string; markdown: string; append?: boolean },
) {
  const title = input.title.trim();
  if (!title) {
    throw new ServiceError("invalid", note("pageNeedsTitle"));
  }
  const existing = (
    await db.query.spacePage.findMany({
      where: and(
        eq(schema.spacePage.projectId, projectId),
        eq(schema.spacePage.wizardId, wizardId),
      ),
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
    .where(eq(schema.spacePage.projectId, projectId));
  if (n >= SPACE_DATA_LIMITS.pages) {
    throw new ServiceError("refused", note("spaceMostPages", { count: SPACE_DATA_LIMITS.pages }));
  }
  const id = nanoid(12);
  await db.insert(schema.spacePage).values({
    id,
    tenantId: currentTenant(),
    projectId,
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
  const project = await db.query.project.findFirst({
    where: and(eq(schema.project.id, space), eq(schema.project.tenantId, currentTenant())),
    columns: { id: true },
  });
  if (!project) {
    throw new ServiceError("not_found", note("unknownSpace", { space }));
  }
  await requireWritableProject(project.id);
  return project.id;
}

/** Keeps the original of what a plugin wrote: a document of the space under the same key. */
async function originalFile(
  origin: string,
  projectId: string,
  key: string,
  label: string | null,
  original: NonNullable<OriginPageInput["original"]>,
  text: string,
) {
  const { putOriginFile } = await import("./project-files.js");
  return putOriginFile(origin, {
    space: projectId,
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
  const projectId = await originSpace(input.space);
  const key = input.key.trim().slice(0, 300);
  const existing = await db.query.spacePage.findFirst({
    where: and(
      eq(schema.spacePage.projectId, projectId),
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
          eq(schema.spacePage.projectId, projectId),
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
    ? await originalFile(origin, projectId, key, label, input.original, markdown)
    : (existing?.fileId ?? null);
  const position =
    input.position ?? existing?.position ?? (await nextPosition(projectId, parentId));
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
        ...(moved ? { slug: await freeSlug(projectId, title, { parentId }, existing.id) } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.spacePage.id, existing.id));
  } else {
    await pageCount(projectId);
    id = nanoid(12);
    await db.insert(schema.spacePage).values({
      id,
      tenantId: currentTenant(),
      projectId,
      parentId,
      position,
      title,
      slug: await freeSlug(projectId, title, { parentId }),
      markdown,
      origin,
      originKey: key,
      originLabel: label,
      fileId,
      review: input.review ?? null,
    });
  }
  const set = input.categories
    ? await setItemCategories(projectId, { pageId: id as string }, input.categories, "origin")
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
  const projectId = await originSpace(input.space);
  const key = input.key.trim().slice(0, 300);
  const existing = await db.query.spaceTable.findFirst({
    where: and(
      eq(schema.spaceTable.projectId, projectId),
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
    ? await originalFile(origin, projectId, key, label, input.original, csv)
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
          ? { slug: await freeSlug(projectId, title, "table", existing.id) }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.spaceTable.id, existing.id));
    await db.delete(schema.spaceTableRow).where(eq(schema.spaceTableRow.tableId, existing.id));
  } else {
    await tableCount(projectId);
    id = nanoid(12);
    await db.insert(schema.spaceTable).values({
      id,
      tenantId: currentTenant(),
      projectId,
      title,
      slug: await freeSlug(projectId, title, "table"),
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
    await setItemCategories(projectId, { tableId: id as string }, input.categories, "origin");
  }
  await syncTableRowCategories(id as string);
  queueIndex(`t:${id}`);
  return { id: id as string, state: "written" };
}

/** What a plugin wrote into a space, by its keys. */
export async function listOrigin(origin: string, space: string) {
  const projectId = await originSpace(space);
  const [pages, tables, files] = await Promise.all([
    // What a document of the plugin was read into stands behind the document, not on its own.
    db.query.spacePage.findMany({
      where: and(
        eq(schema.spacePage.projectId, projectId),
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
        eq(schema.spaceTable.projectId, projectId),
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
    db.query.projectFile.findMany({
      where: and(
        eq(schema.projectFile.projectId, projectId),
        eq(schema.projectFile.origin, origin),
      ),
      columns: { id: true, originKey: true, name: true, updatedAt: true },
    }),
  ]);
  const [tree, tPaths, fPaths] = await Promise.all([
    pageTree(projectId),
    tablePaths(projectId),
    filePaths(projectId),
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
  const projectId = await originSpace(space);
  const pages = await db
    .delete(schema.spacePage)
    .where(
      and(
        eq(schema.spacePage.projectId, projectId),
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
        eq(schema.spaceTable.projectId, projectId),
        eq(schema.spaceTable.origin, origin),
        eq(schema.spaceTable.kept, false),
        key === undefined ? undefined : eq(schema.spaceTable.originKey, key),
      ),
    )
    .returning({ id: schema.spaceTable.id });
  const { removeOriginFiles } = await import("./project-files.js");
  const files = await removeOriginFiles(origin, projectId, key);
  return pages.length + tables.length + files;
}
