import {
  CATEGORY_TYPES,
  type CategoryCell,
  type CategoryInput,
  type CategoryType,
  dayOf,
  type ItemCategory,
  type SpaceCategory,
  type Where,
  type WhereValue,
} from "@engenty-wizards/shared/knowledge";
import { readNumber } from "@engenty-wizards/shared/numbers";
import { note } from "@engenty-wizards/shared/run";
import { and, asc, eq, inArray, isNotNull, or, type SQL, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema } from "../db/client.js";
import { currentTenant } from "../tenants/tenant.js";
import { requireWritableProject } from "./access.js";
import { notFound, ServiceError } from "./errors.js";
import { queueIndex } from "./project-index.js";

/**
 * Categories: typed properties that run across Knowledge. A choice keeps the values it met, in
 * their order; a date, a number, a short text and yes/no are kept typed on the item, so a filter
 * knows what "after" and "at least" mean. An item may have any number of categories, a choice
 * with several values one row per value.
 */

type CategoryRow = typeof schema.spaceCategory.$inferSelect;
type AssignRow = typeof schema.spaceItemCategory.$inferSelect;

/** An item a category is set on. */
export type ItemRef =
  | { pageId: string }
  | { rowId: string }
  | { tableId: string }
  | { fileId: string };

export function itemKey(ref: ItemRef): string {
  if ("pageId" in ref) {
    return `p:${ref.pageId}`;
  }
  if ("rowId" in ref) {
    return `r:${ref.rowId}`;
  }
  if ("tableId" in ref) {
    return `t:${ref.tableId}`;
  }
  return `f:${ref.fileId}`;
}

function keyOfRow(r: Pick<AssignRow, "pageId" | "rowId" | "tableId" | "fileId">): string {
  return r.pageId
    ? `p:${r.pageId}`
    : r.rowId
      ? `r:${r.rowId}`
      : r.tableId
        ? `t:${r.tableId}`
        : `f:${r.fileId}`;
}

function refWhere(ref: ItemRef): SQL {
  const t = schema.spaceItemCategory;
  if ("pageId" in ref) {
    return eq(t.pageId, ref.pageId);
  }
  if ("rowId" in ref) {
    return eq(t.rowId, ref.rowId);
  }
  if ("tableId" in ref) {
    return eq(t.tableId, ref.tableId);
  }
  return eq(t.fileId, ref.fileId);
}

// --- typed values ---------------------------------------------------------------

/** A number with what stands around it, as `readNumber` reads it: `38 h`, `19 %`, `1,5`. */
export function numberOf(value: unknown): number | null {
  return readNumber(value, { units: true });
}

/** A day, or a day and a time, as milliseconds (UTC, as written: no time zone is applied). */
export function dateOf(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  const day = dayOf(value);
  if (!day) {
    return null;
  }
  const [y, m, d] = day.split("-").map(Number);
  const time = typeof value === "string" ? /[T\s](\d{1,2}):(\d{2})/.exec(value) : null;
  const at = Date.UTC(y, m - 1, d, time ? Number(time[1]) : 0, time ? Number(time[2]) : 0);
  return Number.isNaN(at) ? null : at;
}

/** A date as it is shown and given to steps: `2026-03-14`, or `2026-03-14 07:30`. */
export function dateText(at: number): string {
  const iso = new Date(at).toISOString();
  return iso.slice(11, 16) === "00:00"
    ? iso.slice(0, 10)
    : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

function boolOf(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  const s = String(value ?? "")
    .trim()
    .toLowerCase();
  if (["ja", "yes", "true", "x", "1", "wahr", "y", "j"].includes(s)) {
    return true;
  }
  if (["nein", "no", "false", "0", "falsch", "n", "-"].includes(s)) {
    return false;
  }
  return null;
}

interface Typed {
  choice?: string;
  text?: string;
  num?: number;
  at?: number;
  bool?: boolean;
}

/** A value checked against its category's type; null when it is not one. */
function typed(category: Pick<CategoryRow, "type">, value: unknown): Typed | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  switch (category.type) {
    case "choice": {
      const s = String(value).replace(/\s+/g, " ").trim().slice(0, 200);
      return s ? { choice: s } : null;
    }
    case "text": {
      const s = String(value).replace(/\s+/g, " ").trim().slice(0, 300);
      return s ? { text: s } : null;
    }
    case "number": {
      const n = numberOf(value);
      return n === null ? null : { num: n };
    }
    case "date": {
      const at = dateOf(value);
      return at === null ? null : { at };
    }
    case "boolean": {
      const b = boolOf(value);
      return b === null ? null : { bool: b };
    }
    default:
      return null;
  }
}

function cellOf(row: AssignRow, values: Map<string, string>): CategoryCell | null {
  if (row.valueId) {
    return values.get(row.valueId) ?? null;
  }
  if (row.at !== null) {
    return dateText(row.at);
  }
  if (row.num !== null) {
    return row.num;
  }
  if (row.bool !== null) {
    return row.bool;
  }
  return row.text;
}

// --- the categories of a space ---------------------------------------------------

export async function categoryRows(projectId: string): Promise<CategoryRow[]> {
  return db.query.spaceCategory.findMany({
    where: eq(schema.spaceCategory.projectId, projectId),
    orderBy: [asc(schema.spaceCategory.position), asc(schema.spaceCategory.name)],
  });
}

/** A category by its name, as a step or a plugin writes it: case and spaces do not matter. */
function byName(rows: CategoryRow[], name: string): CategoryRow | undefined {
  const want = name.replace(/\s+/g, " ").trim().toLowerCase();
  return rows.find((c) => c.name.toLowerCase() === want);
}

const norm = (v: string) =>
  v
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");

/** Whether two values look like one written two ways: "Graz-Süd" and "Graz Süd". */
function alike(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  if (!(x && y)) {
    return false;
  }
  if (x === y) {
    return true;
  }
  if (Math.min(x.length, y.length) < 6 || Math.abs(x.length - y.length) > 1) {
    return false;
  }
  // One letter apart.
  let i = 0;
  while (i < x.length && x[i] === y[i]) {
    i++;
  }
  return (
    x.slice(i + 1) === y.slice(i + 1) ||
    x.slice(i) === y.slice(i + 1) ||
    x.slice(i + 1) === y.slice(i)
  );
}

/** The space's categories with their values, how many items have each, and their ranges. */
export async function listCategories(projectId: string): Promise<SpaceCategory[]> {
  const rows = await categoryRows(projectId);
  if (!rows.length) {
    return [];
  }
  const ids = rows.map((r) => r.id);
  const t = schema.spaceItemCategory;
  const [values, counts, ranges] = await Promise.all([
    db.all<{
      id: string;
      category_id: string;
      value: string;
      position: number;
      summary: number;
      n: number;
    }>(sql`
      SELECT v.id, v.category_id, v.value, v.position, v.summary IS NOT NULL AS summary,
        (SELECT count(*) FROM space_item_category i WHERE i.value_id = v.id) AS n
      FROM space_category_value v
      WHERE v.category_id IN (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )})
      ORDER BY v.position, v.value`),
    db
      .select({
        categoryId: t.categoryId,
        n: sql<number>`count(DISTINCT coalesce(${t.pageId}, ${t.rowId}, ${t.tableId}, ${t.fileId}))`,
      })
      .from(t)
      .where(inArray(t.categoryId, ids))
      .groupBy(t.categoryId),
    db
      .select({
        categoryId: t.categoryId,
        minNum: sql<number | null>`min(${t.num})`,
        maxNum: sql<number | null>`max(${t.num})`,
        minAt: sql<number | null>`min(${t.at})`,
        maxAt: sql<number | null>`max(${t.at})`,
      })
      .from(t)
      .where(inArray(t.categoryId, ids))
      .groupBy(t.categoryId),
  ]);
  return rows.map((c) => {
    const own = values.filter((v) => v.category_id === c.id);
    const range = ranges.find((r) => r.categoryId === c.id);
    const category: SpaceCategory = {
      id: c.id,
      name: c.name,
      type: c.type,
      unit: c.unit,
      multiple: c.multiple,
      ordered: c.ordered,
      hint: c.hint,
      origin: c.origin,
      proposed: c.proposed,
      tableId: c.tableId,
      columnId: c.columnId,
      count: counts.find((x) => x.categoryId === c.id)?.n ?? 0,
      values: own.map((v) => ({
        id: v.id,
        value: v.value,
        count: v.n,
        summary: Boolean(v.summary),
      })),
      range:
        c.type === "number" && range?.minNum !== null && range?.minNum !== undefined
          ? { min: range.minNum, max: range.maxNum ?? range.minNum }
          : c.type === "date" && range?.minAt !== null && range?.minAt !== undefined
            ? { min: dateText(range.minAt), max: dateText(range.maxAt ?? range.minAt) }
            : null,
      alike: [],
    };
    category.alike = alikeValues(category.values);
    return category;
  });
}

/** Pairs of a choice's values that look like one value written two ways, to offer merging. */
function alikeValues(list: { id: string; value: string }[]): [string, string][] {
  const pairs: [string, string][] = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (alike(list[i].value, list[j].value)) {
        pairs.push([list[i].id, list[j].id]);
      }
    }
  }
  return pairs.slice(0, 20);
}

export interface CategoryDraft {
  name: string;
  type: CategoryType;
  unit?: string | null;
  multiple?: boolean;
  ordered?: boolean;
  hint?: string | null;
  /** A choice's values, in their order. */
  values?: string[];
  /** A column of a table whose cells are its values. */
  tableId?: string | null;
  columnId?: string | null;
}

const MAX_CATEGORIES = 60;

function checkDraft(draft: CategoryDraft) {
  const name = draft.name.replace(/\s+/g, " ").trim().slice(0, 80);
  if (!name) {
    throw new ServiceError("invalid", note("categoryNeedsName"));
  }
  if (!CATEGORY_TYPES.includes(draft.type)) {
    throw new ServiceError("invalid", note("unknownCategoryType", { type: draft.type }));
  }
  return name;
}

async function addValues(categoryId: string, values: string[]) {
  const existing = await db.query.spaceCategoryValue.findMany({
    where: eq(schema.spaceCategoryValue.categoryId, categoryId),
    columns: { id: true, value: true, position: true },
  });
  let position = existing.reduce((max, v) => Math.max(max, v.position + 1), 0);
  const ids = new Map(existing.map((v) => [v.value, v.id]));
  for (const raw of values) {
    const value = raw.replace(/\s+/g, " ").trim().slice(0, 200);
    if (!value || ids.has(value)) {
      continue;
    }
    // Differently cased, it is the same value.
    const same = [...ids.keys()].find((v) => v.toLowerCase() === value.toLowerCase());
    if (same) {
      ids.set(value, ids.get(same) as string);
      continue;
    }
    const id = nanoid(12);
    await db
      .insert(schema.spaceCategoryValue)
      .values({ id, categoryId, value, position: position++ })
      .onConflictDoNothing();
    ids.set(value, id);
  }
  return ids;
}

/**
 * Adds a category, or, by a name the space has already, leaves that one as it is apart from
 * values it does not know yet. `proposed`: shown to be confirmed, never filled before.
 */
export async function putCategory(
  projectId: string,
  draft: CategoryDraft,
  opts: { origin?: string | null; proposed?: boolean } = {},
): Promise<CategoryRow> {
  const name = checkDraft(draft);
  const rows = await categoryRows(projectId);
  const known = byName(rows, name);
  if (known) {
    if (draft.values?.length && known.type === "choice") {
      await addValues(known.id, draft.values);
    }
    // A proposal taken again by its origin, or made by a person, is taken.
    if (known.proposed && !opts.proposed) {
      await db
        .update(schema.spaceCategory)
        .set({ proposed: false, updatedAt: new Date() })
        .where(eq(schema.spaceCategory.id, known.id));
      return { ...known, proposed: false };
    }
    return known;
  }
  if (rows.length >= MAX_CATEGORIES) {
    throw new ServiceError("refused", note("spaceMostCategories", { count: MAX_CATEGORIES }));
  }
  const id = nanoid(12);
  const [row] = await db
    .insert(schema.spaceCategory)
    .values({
      id,
      tenantId: currentTenant(),
      projectId,
      name,
      type: draft.type,
      unit: draft.type === "number" ? (draft.unit?.trim().slice(0, 20) ?? null) : null,
      multiple: draft.type === "choice" && Boolean(draft.multiple),
      ordered: draft.type === "choice" && Boolean(draft.ordered),
      hint: draft.hint?.trim().slice(0, 120) || null,
      origin: opts.origin ?? null,
      proposed: Boolean(opts.proposed),
      tableId: draft.tableId ?? null,
      columnId: draft.tableId ? (draft.columnId ?? null) : null,
      position: rows.reduce((max, r) => Math.max(max, r.position + 1), 0),
    })
    .returning();
  if (draft.type === "choice" && draft.values?.length) {
    await addValues(id, draft.values);
  }
  if (row.tableId && row.columnId && !row.proposed) {
    await syncColumnCategory(row);
  }
  return row;
}

export async function categoryRow(categoryId: string): Promise<CategoryRow> {
  const row = await db.query.spaceCategory.findFirst({
    where: and(
      eq(schema.spaceCategory.id, categoryId),
      eq(schema.spaceCategory.tenantId, currentTenant()),
    ),
  });
  if (!row) {
    throw notFound();
  }
  return row;
}

/** Every item that has the category: their text in the index starts with it. */
async function reindexHolders(categoryId: string) {
  const rows = await db
    .selectDistinct({
      pageId: schema.spaceItemCategory.pageId,
      rowId: schema.spaceItemCategory.rowId,
      tableId: schema.spaceItemCategory.tableId,
      fileId: schema.spaceItemCategory.fileId,
    })
    .from(schema.spaceItemCategory)
    .where(eq(schema.spaceItemCategory.categoryId, categoryId));
  const tables = new Set<string>();
  for (const r of rows) {
    if (r.rowId) {
      const row = await db.query.spaceTableRow.findFirst({
        where: eq(schema.spaceTableRow.id, r.rowId),
        columns: { tableId: true },
      });
      if (row) {
        tables.add(row.tableId);
      }
    } else if (r.tableId) {
      tables.add(r.tableId);
    } else {
      queueIndex(keyOfRow(r));
    }
  }
  for (const id of tables) {
    queueIndex(`t:${id}`);
  }
}

export async function updateCategory(
  categoryId: string,
  patch: {
    name?: string;
    unit?: string | null;
    multiple?: boolean;
    ordered?: boolean;
    hint?: string | null;
    proposed?: false;
    position?: number;
  },
) {
  const row = await categoryRow(categoryId);
  await requireWritableProject(row.projectId);
  const name =
    patch.name !== undefined ? checkDraft({ name: patch.name, type: row.type }) : row.name;
  if (name !== row.name) {
    const clash = byName(await categoryRows(row.projectId), name);
    if (clash && clash.id !== row.id) {
      throw new ServiceError("invalid", note("categoryAlreadyExists", { name }));
    }
  }
  await db
    .update(schema.spaceCategory)
    .set({
      name,
      ...(patch.unit !== undefined && row.type === "number"
        ? { unit: patch.unit?.trim().slice(0, 20) || null }
        : {}),
      ...(patch.multiple !== undefined && row.type === "choice"
        ? { multiple: patch.multiple }
        : {}),
      ...(patch.ordered !== undefined && row.type === "choice" ? { ordered: patch.ordered } : {}),
      ...(patch.hint !== undefined ? { hint: patch.hint?.trim().slice(0, 120) || null } : {}),
      ...(patch.proposed === false ? { proposed: false } : {}),
      ...(patch.position !== undefined ? { position: patch.position } : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.spaceCategory.id, row.id));
  if (patch.proposed === false && row.tableId && row.columnId) {
    await syncColumnCategory({ ...row, proposed: false });
  }
  if (name !== row.name || patch.unit !== undefined) {
    await reindexHolders(row.id);
  }
}

export async function deleteCategory(categoryId: string) {
  const row = await categoryRow(categoryId);
  await requireWritableProject(row.projectId);
  await reindexHolders(row.id);
  await db.delete(schema.spaceCategory).where(eq(schema.spaceCategory.id, row.id));
}

async function valueRow(valueId: string) {
  const value = await db.query.spaceCategoryValue.findFirst({
    where: eq(schema.spaceCategoryValue.id, valueId),
  });
  if (!value) {
    throw notFound();
  }
  const category = await categoryRow(value.categoryId);
  return { value, category };
}

export async function categoryValue(valueId: string) {
  return valueRow(valueId);
}

export async function addCategoryValue(categoryId: string, value: string) {
  const category = await categoryRow(categoryId);
  await requireWritableProject(category.projectId);
  if (category.type !== "choice") {
    throw new ServiceError("invalid", note("onlyChoiceCategoriesValues"));
  }
  const ids = await addValues(category.id, [value]);
  return { id: [...ids.values()].at(-1) as string };
}

export async function renameCategoryValue(valueId: string, value: string) {
  const { value: row, category } = await valueRow(valueId);
  await requireWritableProject(category.projectId);
  const next = value.replace(/\s+/g, " ").trim().slice(0, 200);
  if (!next || next === row.value) {
    return;
  }
  const clash = await db.query.spaceCategoryValue.findFirst({
    where: and(
      eq(schema.spaceCategoryValue.categoryId, category.id),
      eq(schema.spaceCategoryValue.value, next),
    ),
  });
  if (clash) {
    await mergeCategoryValues(row.id, clash.id);
    return;
  }
  await db
    .update(schema.spaceCategoryValue)
    .set({ value: next })
    .where(eq(schema.spaceCategoryValue.id, row.id));
  await reindexHolders(category.id);
}

/** Puts the items of one value under another and drops the first: two spellings become one. */
export async function mergeCategoryValues(fromId: string, intoId: string) {
  const from = await valueRow(fromId);
  const into = await valueRow(intoId);
  if (from.category.id !== into.category.id || fromId === intoId) {
    throw new ServiceError("invalid", note("onlyValuesOneCategory"));
  }
  await requireWritableProject(from.category.projectId);
  const t = schema.spaceItemCategory;
  const moving = await db.query.spaceItemCategory.findMany({ where: eq(t.valueId, fromId) });
  const having = new Set(
    (await db.query.spaceItemCategory.findMany({ where: eq(t.valueId, intoId) })).map(keyOfRow),
  );
  for (const row of moving) {
    if (having.has(keyOfRow(row))) {
      await db.delete(t).where(eq(t.id, row.id));
    } else {
      await db.update(t).set({ valueId: intoId }).where(eq(t.id, row.id));
    }
  }
  await db.delete(schema.spaceCategoryValue).where(eq(schema.spaceCategoryValue.id, fromId));
  // The summary of the value that grew is no longer all of it.
  await db
    .update(schema.spaceCategoryValue)
    .set({ summaryAt: null })
    .where(eq(schema.spaceCategoryValue.id, intoId));
  await reindexHolders(from.category.id);
}

export async function deleteCategoryValue(valueId: string) {
  const { value, category } = await valueRow(valueId);
  await requireWritableProject(category.projectId);
  await reindexHolders(category.id);
  await db.delete(schema.spaceCategoryValue).where(eq(schema.spaceCategoryValue.id, value.id));
}

export async function orderCategoryValues(categoryId: string, ids: string[]) {
  const category = await categoryRow(categoryId);
  await requireWritableProject(category.projectId);
  for (const [position, id] of ids.entries()) {
    await db
      .update(schema.spaceCategoryValue)
      .set({ position })
      .where(
        and(
          eq(schema.spaceCategoryValue.id, id),
          eq(schema.spaceCategoryValue.categoryId, category.id),
        ),
      );
  }
}

// --- on items ---------------------------------------------------------------------

/**
 * Sets categories on an item, by their names. A value null takes the category off. What a
 * person set stays when an origin or a model writes again. Names the space has no taken
 * category for are skipped and returned. True in `changed` when anything changed.
 */
export async function setItemCategories(
  projectId: string,
  ref: ItemRef,
  input: CategoryInput,
  by: "person" | "origin" | "model",
): Promise<{ changed: boolean; unknown: string[] }> {
  const rows = (await categoryRows(projectId)).filter((c) => !c.proposed);
  const t = schema.spaceItemCategory;
  const current = await db.query.spaceItemCategory.findMany({ where: refWhere(ref) });
  const unknown: string[] = [];
  let changed = false;
  for (const [name, raw] of Object.entries(input)) {
    const category = byName(rows, name);
    if (!category) {
      unknown.push(name);
      continue;
    }
    const mine = current.filter((r) => r.categoryId === category.id);
    if (by !== "person" && mine.some((r) => r.by === "person")) {
      continue;
    }
    const list = (Array.isArray(raw) ? raw : [raw])
      .map((v) => typed(category, v))
      .filter((v): v is Typed => v !== null);
    const values = category.type === "choice" && category.multiple ? list : list.slice(0, 1);
    const ids =
      category.type === "choice"
        ? await addValues(
            category.id,
            values.map((v) => v.choice as string),
          )
        : null;
    const next = values.map((v) => ({
      valueId: v.choice !== undefined ? (ids?.get(v.choice) ?? null) : null,
      text: v.text ?? null,
      num: v.num ?? null,
      at: v.at ?? null,
      bool: v.bool ?? null,
    }));
    const same =
      mine.length === next.length &&
      next.every((n) =>
        mine.some(
          (m) =>
            m.valueId === n.valueId &&
            m.text === n.text &&
            m.num === n.num &&
            m.at === n.at &&
            m.bool === n.bool,
        ),
      );
    if (same && mine.every((m) => m.by === by)) {
      continue;
    }
    changed = true;
    if (mine.length) {
      await db.delete(t).where(
        inArray(
          t.id,
          mine.map((m) => m.id),
        ),
      );
    }
    if (next.length) {
      await db.insert(t).values(
        next.map((n) => ({
          projectId,
          categoryId: category.id,
          ...("pageId" in ref ? { pageId: ref.pageId } : {}),
          ...("rowId" in ref ? { rowId: ref.rowId } : {}),
          ...("tableId" in ref ? { tableId: ref.tableId } : {}),
          ...("fileId" in ref ? { fileId: ref.fileId } : {}),
          ...n,
          by,
        })),
      );
    }
  }
  return { changed, unknown };
}

/** Whether an item is of the space's own Knowledge. */
async function itemInProject(projectId: string, ref: ItemRef): Promise<boolean> {
  if ("pageId" in ref) {
    const page = await db.query.spacePage.findFirst({
      where: eq(schema.spacePage.id, ref.pageId),
      columns: { projectId: true, wizardId: true },
    });
    return page?.projectId === projectId && !page.wizardId;
  }
  if ("fileId" in ref) {
    const file = await db.query.projectFile.findFirst({
      where: eq(schema.projectFile.id, ref.fileId),
      columns: { projectId: true },
    });
    return file?.projectId === projectId;
  }
  const tableId =
    "tableId" in ref
      ? ref.tableId
      : (
          await db.query.spaceTableRow.findFirst({
            where: eq(schema.spaceTableRow.id, ref.rowId),
            columns: { tableId: true },
          })
        )?.tableId;
  const table = tableId
    ? await db.query.spaceTable.findFirst({
        where: eq(schema.spaceTable.id, tableId),
        columns: { projectId: true, wizardId: true },
      })
    : undefined;
  return table?.projectId === projectId && !table.wizardId;
}

/** What a person set from the studio: by the category's id, a list of values or none. */
export async function setItemCategory(
  projectId: string,
  ref: ItemRef,
  categoryId: string,
  values: CategoryCell[],
) {
  const category = await categoryRow(categoryId);
  if (category.projectId !== projectId || !(await itemInProject(projectId, ref))) {
    throw notFound();
  }
  const { changed } = await setItemCategories(
    projectId,
    ref,
    { [category.name]: values.length ? values : null },
    "person",
  );
  return changed;
}

/** The categories of items, by `itemKey`. */
export async function itemCategoriesOf(refs: ItemRef[]): Promise<Map<string, ItemCategory[]>> {
  const out = new Map<string, ItemCategory[]>();
  if (!refs.length) {
    return out;
  }
  const t = schema.spaceItemCategory;
  const ids = (k: "pageId" | "rowId" | "tableId" | "fileId") =>
    refs
      .filter((r): r is Extract<ItemRef, Record<typeof k, string>> => k in r)
      .map((r) => (r as any)[k] as string);
  const conditions: SQL[] = [];
  for (const [k, column] of [
    ["pageId", t.pageId],
    ["rowId", t.rowId],
    ["tableId", t.tableId],
    ["fileId", t.fileId],
  ] as const) {
    const list = ids(k);
    for (let i = 0; i < list.length; i += 500) {
      conditions.push(inArray(column, list.slice(i, i + 500)));
    }
  }
  const rows = await db.query.spaceItemCategory.findMany({ where: or(...conditions) });
  const valueIds = [...new Set(rows.map((r) => r.valueId).filter((v): v is string => Boolean(v)))];
  const values = new Map<string, string>();
  for (let i = 0; i < valueIds.length; i += 500) {
    for (const v of await db.query.spaceCategoryValue.findMany({
      where: inArray(schema.spaceCategoryValue.id, valueIds.slice(i, i + 500)),
      columns: { id: true, value: true },
    })) {
      values.set(v.id, v.value);
    }
  }
  for (const row of rows) {
    const key = keyOfRow(row);
    const list = out.get(key) ?? [];
    const cell = cellOf(row, values);
    if (cell === null) {
      continue;
    }
    const known = list.find((c) => c.categoryId === row.categoryId);
    if (known) {
      known.values.push(cell);
    } else {
      list.push({ categoryId: row.categoryId, values: [cell], by: row.by });
    }
    out.set(key, list);
  }
  return out;
}

/** `Name: Wert` for each category an item has, in the order of the space's categories. */
export function categoryLines(
  categories: Pick<CategoryRow, "id" | "name" | "unit">[],
  has: ItemCategory[] | undefined,
): string[] {
  if (!has?.length) {
    return [];
  }
  return categories.flatMap((c) => {
    const mine = has.find((h) => h.categoryId === c.id);
    if (!mine) {
      return [];
    }
    const shown = mine.values
      .map((v) =>
        typeof v === "boolean"
          ? v
            ? "ja"
            : "nein"
          : `${v}${c.unit && typeof v === "number" ? ` ${c.unit}` : ""}`,
      )
      .join(", ");
    return [`${c.name}: ${shown}`];
  });
}

// --- a column as a category --------------------------------------------------------------

/** Writes the category of a column onto the table's rows: their cells are its values. */
export async function syncColumnCategory(category: CategoryRow, rowIds?: string[]) {
  if (!(category.tableId && category.columnId) || category.proposed) {
    return;
  }
  const rows = await db.query.spaceTableRow.findMany({
    where: rowIds
      ? and(
          eq(schema.spaceTableRow.tableId, category.tableId),
          inArray(schema.spaceTableRow.id, rowIds),
        )
      : eq(schema.spaceTableRow.tableId, category.tableId),
    columns: { id: true, cells: true },
  });
  for (const row of rows) {
    await setItemCategories(
      category.projectId,
      { rowId: row.id },
      {
        [category.name]: (row.cells[category.columnId] as CategoryCell | null | undefined) ?? null,
      },
      "origin",
    );
  }
}

/** After rows of a table changed: the categories its columns are. */
export async function syncTableRowCategories(tableId: string, rowIds?: string[]) {
  const categories = await db.query.spaceCategory.findMany({
    where: and(eq(schema.spaceCategory.tableId, tableId), isNotNull(schema.spaceCategory.columnId)),
  });
  for (const category of categories) {
    await syncColumnCategory(category, rowIds);
  }
}

// --- filters ------------------------------------------------------------------------

/** The items a filter leaves, by their kind. Sub-pages go with their page, rows with their table. */
export interface Filtered {
  pages: Set<string>;
  rows: Set<string>;
  tables: Set<string>;
  files: Set<string>;
  /** How many items that is. */
  size: number;
}

function condition(category: CategoryRow, w: WhereValue, valueIds: Map<string, string>): SQL {
  const t = schema.spaceItemCategory;
  const list = Array.isArray(w) ? w : null;
  const bad = () =>
    new ServiceError(
      "invalid",
      `“${category.name}” is a ${category.type}: ${
        {
          choice: "give a value, a list of values or { atLeast }",
          text: "give a text, a list or { contains }",
          number: "give a number, a list or { gte, lte }",
          date: 'give a day ("YYYY-MM-DD"), a list or { after, before }',
          boolean: "give true or false",
        }[category.type]
      }.`,
    );
  switch (category.type) {
    case "choice": {
      if (typeof w === "object" && w !== null && !Array.isArray(w)) {
        const floor = w.atLeast ? valueIds.get(w.atLeast.toLowerCase()) : undefined;
        if (!(floor && category.ordered)) {
          throw bad();
        }
        return sql`${t.valueId} IN (SELECT id FROM space_category_value WHERE category_id = ${category.id}
          AND position >= (SELECT position FROM space_category_value WHERE id = ${floor}))`;
      }
      const wanted = (list ?? [w]).map((v) => valueIds.get(String(v).toLowerCase()) ?? "-");
      return inArray(t.valueId, wanted);
    }
    case "text": {
      if (typeof w === "object" && w !== null && !Array.isArray(w)) {
        if (!w.contains) {
          throw bad();
        }
        return sql`lower(${t.text}) LIKE ${`%${w.contains.toLowerCase()}%`}`;
      }
      return inArray(
        sql`lower(${t.text})`,
        (list ?? [w]).map((v) => String(v).toLowerCase()),
      );
    }
    case "number": {
      if (typeof w === "object" && w !== null && !Array.isArray(w)) {
        if (w.gte === undefined && w.lte === undefined) {
          throw bad();
        }
        return and(
          w.gte !== undefined ? sql`${t.num} >= ${w.gte}` : undefined,
          w.lte !== undefined ? sql`${t.num} <= ${w.lte}` : undefined,
        ) as SQL;
      }
      const nums = (list ?? [w]).map(numberOf).filter((n): n is number => n !== null);
      if (!nums.length) {
        throw bad();
      }
      return inArray(t.num, nums);
    }
    case "date": {
      const DAY = 86_400_000;
      if (typeof w === "object" && w !== null && !Array.isArray(w)) {
        const after = w.after ? dateOf(w.after) : null;
        const before = w.before ? dateOf(w.before) : null;
        if (after === null && before === null) {
          throw bad();
        }
        return and(
          after !== null ? sql`${t.at} >= ${after}` : undefined,
          before !== null ? sql`${t.at} < ${before + DAY}` : undefined,
        ) as SQL;
      }
      const days = (list ?? [w]).map(dateOf).filter((n): n is number => n !== null);
      if (!days.length) {
        throw bad();
      }
      return or(...days.map((d) => sql`(${t.at} >= ${d} AND ${t.at} < ${d + DAY})`)) as SQL;
    }
    case "boolean": {
      const b = boolOf(list ? list[0] : w);
      if (b === null) {
        throw bad();
      }
      return eq(t.bool, b);
    }
    default:
      throw bad();
  }
}

/** Every page under the given ones, the given ones included. */
async function withSubPages(pageIds: string[]): Promise<string[]> {
  if (!pageIds.length) {
    return [];
  }
  const rows = await db.all<{ id: string }>(sql`
    WITH RECURSIVE tree(id) AS (
      SELECT id FROM space_page WHERE id IN (${sql.join(
        pageIds.map((id) => sql`${id}`),
        sql`, `,
      )})
      UNION SELECT p.id FROM space_page p JOIN tree ON p.parent_id = tree.id
    ) SELECT id FROM tree`);
  return rows.map((r) => r.id);
}

/**
 * The items of the space a filter leaves: an item matches when it, or the page or table it
 * belongs to, has every category as asked. Null for no filter. A name the space has no
 * category for is an error that lists the names there are.
 */
export async function filterItems(
  projectId: string,
  where: Where | undefined,
): Promise<Filtered | null> {
  const entries = Object.entries(where ?? {});
  if (!entries.length) {
    return null;
  }
  const rows = (await categoryRows(projectId)).filter((c) => !c.proposed);
  let result = null as Set<string> | null;
  for (const [name, w] of entries) {
    const category = byName(rows, name);
    if (!category) {
      throw new ServiceError(
        "invalid",
        `No category “${name}”. There are: ${rows.map((c) => `${c.name} (${c.type})`).join(", ") || "none"}.`,
      );
    }
    const valueIds = new Map(
      (
        await db.query.spaceCategoryValue.findMany({
          where: eq(schema.spaceCategoryValue.categoryId, category.id),
          columns: { id: true, value: true },
        })
      ).map((v) => [v.value.toLowerCase(), v.id]),
    );
    const t = schema.spaceItemCategory;
    const matched = await db
      .select({ pageId: t.pageId, rowId: t.rowId, tableId: t.tableId, fileId: t.fileId })
      .from(t)
      .where(and(eq(t.categoryId, category.id), condition(category, w, valueIds)));
    const keys = new Set<string>();
    const pages = await withSubPages(matched.flatMap((m) => (m.pageId ? [m.pageId] : [])));
    for (const id of pages) {
      keys.add(`p:${id}`);
    }
    const tables = matched.flatMap((m) => (m.tableId ? [m.tableId] : []));
    for (const id of tables) {
      keys.add(`t:${id}`);
    }
    for (let i = 0; i < tables.length; i += 500) {
      for (const r of await db.query.spaceTableRow.findMany({
        where: inArray(schema.spaceTableRow.tableId, tables.slice(i, i + 500)),
        columns: { id: true },
      })) {
        keys.add(`r:${r.id}`);
      }
    }
    for (const m of matched) {
      if (m.rowId) {
        keys.add(`r:${m.rowId}`);
      }
      if (m.fileId) {
        keys.add(`f:${m.fileId}`);
      }
    }
    result = result ? new Set([...result].filter((k) => keys.has(k))) : keys;
  }
  const out: Filtered = {
    pages: new Set(),
    rows: new Set(),
    tables: new Set(),
    files: new Set(),
    size: 0,
  };
  for (const key of result ?? []) {
    const id = key.slice(2);
    ({ p: out.pages, r: out.rows, t: out.tables, f: out.files })[
      key[0] as "p" | "r" | "t" | "f"
    ].add(id);
  }
  // A table counts once, however many of its rows are left.
  out.size =
    out.pages.size + out.files.size + out.tables.size + (out.tables.size ? 0 : out.rows.size);
  return out;
}
