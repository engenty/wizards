import { formatTableCell, type TableColumn } from "@engenty-wizards/shared/engenty/data-tables";
import {
  type Knowledge,
  type KnowledgeItem,
  type KnowledgePage,
  type KnowledgeValue,
  slugOf,
  type Where,
  type WhereValue,
} from "@engenty-wizards/shared/knowledge";
import { and, asc, count, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { embeddingModel, systemOneAccess } from "../models.js";
import { notFound, ServiceError } from "./errors.js";
import { ownedProject } from "./projects.js";
import {
  categoryLines,
  categoryRows,
  dateOf,
  filterItems,
  itemCategoriesOf,
  listCategories,
  numberOf,
} from "./space-categories.js";

/**
 * Knowledge: the space's own pages (with their sub-pages), tables and files, as the studio lists
 * them and as a step names them. A step names an item by its path — `pages/handbuch/montage`,
 * `tables/kettenprogramm`, `files/plan.dwg` — and reads it whole.
 */

type PageRow = typeof schema.spacePage.$inferSelect;

export interface PageNode {
  id: string;
  parentId: string | null;
  title: string;
  slug: string;
  position: number;
  path: string;
  /** The titles from the outermost page down to this one. */
  titles: string[];
}

/** Gives each item without a slug one, unique among its siblings, and keeps it. */
async function slugsFor<T extends { id: string; slug: string | null; title: string }>(
  rows: T[],
  siblingsOf: (row: T) => string,
  save: (id: string, slug: string) => Promise<unknown>,
): Promise<Map<string, string>> {
  const taken = new Map<string, Set<string>>();
  const out = new Map<string, string>();
  for (const row of rows) {
    if (row.slug) {
      const set = taken.get(siblingsOf(row)) ?? new Set();
      set.add(row.slug);
      taken.set(siblingsOf(row), set);
      out.set(row.id, row.slug);
    }
  }
  for (const row of rows) {
    if (row.slug) {
      continue;
    }
    const set = taken.get(siblingsOf(row)) ?? new Set();
    const base = slugOf(row.title);
    let slug = base;
    for (let i = 2; set.has(slug); i++) {
      slug = `${base}-${i}`;
    }
    set.add(slug);
    taken.set(siblingsOf(row), set);
    out.set(row.id, slug);
    await save(row.id, slug);
  }
  return out;
}

/** A slug for a new page among its siblings, or a new table among the space's tables. */
export async function freeSlug(
  projectId: string,
  title: string,
  of: { parentId: string | null } | "table",
  except?: string,
): Promise<string> {
  const rows =
    of === "table"
      ? await db.query.spaceTable.findMany({
          where: and(
            eq(schema.spaceTable.projectId, projectId),
            isNull(schema.spaceTable.wizardId),
          ),
          columns: { id: true, slug: true },
        })
      : await db.query.spacePage.findMany({
          where: and(
            eq(schema.spacePage.projectId, projectId),
            isNull(schema.spacePage.wizardId),
            of.parentId
              ? eq(schema.spacePage.parentId, of.parentId)
              : isNull(schema.spacePage.parentId),
          ),
          columns: { id: true, slug: true },
        });
  const taken = new Set(rows.filter((r) => r.id !== except).map((r) => r.slug));
  const base = slugOf(title);
  let slug = base;
  for (let i = 2; taken.has(slug); i++) {
    slug = `${base}-${i}`;
  }
  return slug;
}

/** The space's own pages with their paths, by id. */
export async function pageTree(projectId: string): Promise<Map<string, PageNode>> {
  const rows = await db.query.spacePage.findMany({
    where: and(eq(schema.spacePage.projectId, projectId), isNull(schema.spacePage.wizardId)),
    columns: { id: true, parentId: true, title: true, slug: true, position: true },
    orderBy: [asc(schema.spacePage.position), asc(schema.spacePage.title)],
  });
  const slugs = await slugsFor(
    rows,
    (r) => r.parentId ?? "",
    (id, slug) => db.update(schema.spacePage).set({ slug }).where(eq(schema.spacePage.id, id)),
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = new Map<string, PageNode>();
  const walk = (id: string, seen: Set<string>): PageNode | undefined => {
    const known = out.get(id);
    if (known) {
      return known;
    }
    const row = byId.get(id);
    if (!row || seen.has(id)) {
      return undefined;
    }
    seen.add(id);
    const parent = row.parentId ? walk(row.parentId, seen) : undefined;
    const slug = slugs.get(id) as string;
    const node: PageNode = {
      id,
      parentId: parent ? row.parentId : null,
      title: row.title,
      slug,
      position: row.position,
      path: parent ? `${parent.path}/${slug}` : `pages/${slug}`,
      titles: [...(parent?.titles ?? []), row.title],
    };
    out.set(id, node);
    return node;
  };
  for (const row of rows) {
    walk(row.id, new Set());
  }
  return out;
}

/** The space's own tables with their paths, by id. */
export async function tablePaths(projectId: string): Promise<Map<string, string>> {
  const rows = await db.query.spaceTable.findMany({
    where: and(eq(schema.spaceTable.projectId, projectId), isNull(schema.spaceTable.wizardId)),
    columns: { id: true, slug: true, title: true },
    orderBy: [asc(schema.spaceTable.createdAt)],
  });
  const slugs = await slugsFor(
    rows,
    () => "",
    (id, slug) => db.update(schema.spaceTable).set({ slug }).where(eq(schema.spaceTable.id, id)),
  );
  return new Map(rows.map((r) => [r.id, `tables/${slugs.get(r.id)}`]));
}

/** The space's documents with their paths, by id: their names, made unique. */
export async function filePaths(projectId: string): Promise<Map<string, string>> {
  const rows = await db.query.projectFile.findMany({
    where: and(
      eq(schema.projectFile.projectId, projectId),
      eq(schema.projectFile.kind, "document"),
    ),
    columns: { id: true, name: true },
    orderBy: [asc(schema.projectFile.createdAt)],
  });
  const taken = new Set<string>();
  const out = new Map<string, string>();
  for (const row of rows) {
    const base = row.name.replace(/[/\\]/g, "-");
    let name = base;
    for (let i = 2; taken.has(name.toLowerCase()); i++) {
      const dot = base.lastIndexOf(".");
      name = dot > 0 ? `${base.slice(0, dot)}-${i}${base.slice(dot)}` : `${base}-${i}`;
    }
    taken.add(name.toLowerCase());
    out.set(row.id, `files/${name}`);
  }
  return out;
}

const cleanPath = (path: string) =>
  path
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.(md|csv)$/i, "")
    .toLowerCase();

/** What a path names; null when nothing in the space has it. */
export async function resolvePath(
  projectId: string,
  path: string,
): Promise<{ kind: "page" | "table" | "file"; id: string; path: string } | null> {
  const want = cleanPath(path);
  if (want.startsWith("pages/")) {
    for (const node of (await pageTree(projectId)).values()) {
      if (node.path === want) {
        return { kind: "page", id: node.id, path: node.path };
      }
    }
  } else if (want.startsWith("tables/")) {
    for (const [id, p] of await tablePaths(projectId)) {
      if (p === want) {
        return { kind: "table", id, path: p };
      }
    }
  } else if (want.startsWith("files/")) {
    for (const [id, p] of await filePaths(projectId)) {
      if (p.toLowerCase() === want) {
        return { kind: "file", id, path: p };
      }
    }
  }
  return null;
}

// --- what the studio lists ---------------------------------------------------------

/** Files a page or a table was read from: they stand behind it, not on their own. */
async function convertedFiles(projectId: string): Promise<Set<string>> {
  const [pages, tables] = await Promise.all([
    db
      .selectDistinct({ id: schema.spacePage.fileId })
      .from(schema.spacePage)
      .where(and(eq(schema.spacePage.projectId, projectId), isNotNull(schema.spacePage.fileId))),
    db
      .selectDistinct({ id: schema.spaceTable.fileId })
      .from(schema.spaceTable)
      .where(and(eq(schema.spaceTable.projectId, projectId), isNotNull(schema.spaceTable.fileId))),
  ]);
  return new Set([...pages, ...tables].map((r) => r.id as string));
}

/** Everything Knowledge holds: pages (sub-pages counted under them), tables, files, categories. */
export async function listKnowledge(userId: string, projectId: string): Promise<Knowledge> {
  const project = await ownedProject(userId, projectId);
  const [tree, tables, rowCounts, files, converted, categories, embeddings, checker] =
    await Promise.all([
      pageTree(project.id),
      db.query.spaceTable.findMany({
        where: and(eq(schema.spaceTable.projectId, project.id), isNull(schema.spaceTable.wizardId)),
      }),
      db
        .select({ tableId: schema.spaceTableRow.tableId, n: count() })
        .from(schema.spaceTableRow)
        .innerJoin(schema.spaceTable, eq(schema.spaceTable.id, schema.spaceTableRow.tableId))
        .where(and(eq(schema.spaceTable.projectId, project.id), isNull(schema.spaceTable.wizardId)))
        .groupBy(schema.spaceTableRow.tableId),
      db.query.projectFile.findMany({
        where: and(
          eq(schema.projectFile.projectId, project.id),
          eq(schema.projectFile.kind, "document"),
        ),
      }),
      convertedFiles(project.id),
      listCategories(project.id),
      embeddingModel()
        .then(Boolean)
        .catch(() => false),
      systemOneAccess()
        .then(Boolean)
        .catch(() => false),
    ]);
  const tPaths = await tablePaths(project.id);
  const fPaths = await filePaths(project.id);
  const pages = await db.query.spacePage.findMany({
    where: and(
      eq(schema.spacePage.projectId, project.id),
      isNull(schema.spacePage.wizardId),
      isNull(schema.spacePage.parentId),
    ),
    columns: { markdown: false },
  });
  const children = new Map<string, number>();
  for (const node of tree.values()) {
    if (node.parentId) {
      children.set(node.parentId, (children.get(node.parentId) ?? 0) + 1);
    }
  }
  const loose = files.filter((f) => !converted.has(f.id));
  const cats = await itemCategoriesOf([
    ...pages.map((p) => ({ pageId: p.id })),
    ...tables.map((t) => ({ tableId: t.id })),
    ...loose.map((f) => ({ fileId: f.id })),
  ]);
  const items: KnowledgeItem[] = [
    ...pages.map(
      (p): KnowledgeItem => ({
        key: `p:${p.id}`,
        kind: "page",
        id: p.id,
        title: p.title,
        path: tree.get(p.id)?.path ?? "",
        children: children.get(p.id) ?? 0,
        rows: null,
        format: null,
        origin: p.origin,
        originLabel: p.originLabel,
        kept: p.kept,
        review: p.review,
        fileId: p.fileId,
        status: "ready",
        categories: cats.get(`p:${p.id}`) ?? [],
        updatedAt: p.updatedAt.toISOString(),
      }),
    ),
    ...tables.map(
      (t): KnowledgeItem => ({
        key: `t:${t.id}`,
        kind: "table",
        id: t.id,
        title: t.title,
        path: tPaths.get(t.id) ?? "",
        children: 0,
        rows: rowCounts.find((r) => r.tableId === t.id)?.n ?? 0,
        format: t.format,
        origin: t.origin,
        originLabel: t.originLabel,
        kept: t.kept,
        review: t.review,
        fileId: t.fileId,
        status: "ready",
        categories: cats.get(`t:${t.id}`) ?? [],
        updatedAt: t.updatedAt.toISOString(),
      }),
    ),
    ...loose.map(
      (f): KnowledgeItem => ({
        key: `f:${f.id}`,
        kind: "file",
        id: f.id,
        title: f.name,
        path: fPaths.get(f.id) ?? "",
        children: 0,
        rows: null,
        format: null,
        origin: f.origin,
        originLabel: f.originLabel,
        kept: false,
        review: null,
        fileId: f.id,
        status:
          f.status === "pending" && Date.now() - f.updatedAt.getTime() > 15 * 60_000
            ? "failed"
            : f.status,
        categories: cats.get(`f:${f.id}`) ?? [],
        updatedAt: f.updatedAt.toISOString(),
      }),
    ),
  ];
  items.sort((a, b) => a.title.localeCompare(b.title, "de"));
  return { items, categories, embeddings, checked: checker };
}

/** A value opened in the studio: its summary, and the items and rows that have it. */
export async function valueContents(userId: string, valueId: string): Promise<KnowledgeValue> {
  const value = await db.query.spaceCategoryValue.findFirst({
    where: eq(schema.spaceCategoryValue.id, valueId),
  });
  const category = value
    ? await db.query.spaceCategory.findFirst({
        where: eq(schema.spaceCategory.id, value.categoryId),
      })
    : undefined;
  if (!(value && category)) {
    throw notFound();
  }
  const project = await ownedProject(userId, category.projectId);
  const having = await db.query.spaceItemCategory.findMany({
    where: eq(schema.spaceItemCategory.valueId, value.id),
  });
  return {
    id: value.id,
    value: value.value,
    category: { id: category.id, name: category.name },
    summary: value.summary,
    summaryAt: value.summaryAt?.toISOString() ?? null,
    ...(await itemsHaving(userId, project.id, having)),
  };
}

/** Everything that has a category, whatever its value: what the category's page lists. */
export async function categoryContents(userId: string, categoryId: string) {
  const category = await db.query.spaceCategory.findFirst({
    where: eq(schema.spaceCategory.id, categoryId),
  });
  if (!category) {
    throw notFound();
  }
  const project = await ownedProject(userId, category.projectId);
  const having = await db.query.spaceItemCategory.findMany({
    where: eq(schema.spaceItemCategory.categoryId, category.id),
  });
  return itemsHaving(userId, project.id, having);
}

/** The items rows of `space_item_category` name, as the studio lists them, and rows by table. */
async function itemsHaving(
  userId: string,
  projectId: string,
  having: (typeof schema.spaceItemCategory.$inferSelect)[],
): Promise<Pick<KnowledgeValue, "items" | "rows">> {
  const project = { id: projectId };
  const pageIds = having.flatMap((h) => (h.pageId ? [h.pageId] : []));
  const tableIds = having.flatMap((h) => (h.tableId ? [h.tableId] : []));
  const fileIds = having.flatMap((h) => (h.fileId ? [h.fileId] : []));
  const rowIds = having.flatMap((h) => (h.rowId ? [h.rowId] : []));
  const all = await listKnowledge(userId, project.id);
  const tree = await pageTree(project.id);
  const subPages = pageIds.filter((id) => !all.items.some((i) => i.key === `p:${id}`));
  const subItems: KnowledgeItem[] = [];
  if (subPages.length) {
    const cats = await itemCategoriesOf(subPages.map((pageId) => ({ pageId })));
    for (const page of await db.query.spacePage.findMany({
      where: inArray(schema.spacePage.id, subPages),
      columns: { markdown: false },
    })) {
      subItems.push({
        key: `p:${page.id}`,
        kind: "page",
        id: page.id,
        title: tree.get(page.id)?.titles.join(" › ") ?? page.title,
        path: tree.get(page.id)?.path ?? "",
        children: [...tree.values()].filter((n) => n.parentId === page.id).length,
        rows: null,
        format: null,
        origin: page.origin,
        originLabel: page.originLabel,
        kept: page.kept,
        review: page.review,
        fileId: page.fileId,
        status: "ready",
        categories: cats.get(`p:${page.id}`) ?? [],
        updatedAt: page.updatedAt.toISOString(),
      });
    }
  }
  const rowTables = new Map<string, number>();
  for (let i = 0; i < rowIds.length; i += 500) {
    for (const r of await db.query.spaceTableRow.findMany({
      where: inArray(schema.spaceTableRow.id, rowIds.slice(i, i + 500)),
      columns: { tableId: true },
    })) {
      rowTables.set(r.tableId, (rowTables.get(r.tableId) ?? 0) + 1);
    }
  }
  return {
    items: [
      ...all.items.filter(
        (i) =>
          (i.kind === "page" && pageIds.includes(i.id)) ||
          (i.kind === "table" && tableIds.includes(i.id)) ||
          (i.kind === "file" && fileIds.includes(i.id)),
      ),
      ...subItems,
    ],
    rows: [...rowTables].map(([tableId, n]) => ({
      tableId,
      title: all.items.find((i) => i.key === `t:${tableId}`)?.title ?? "",
      count: n,
    })),
  };
}

/** What the studio shows around a page of Knowledge: where it stands, its sub-pages, its origin. */
export async function knowledgePage(page: PageRow): Promise<KnowledgePage> {
  const tree = await pageTree(page.projectId);
  const node = tree.get(page.id);
  const parents: { id: string; title: string }[] = [];
  for (let at = node?.parentId ? tree.get(node.parentId) : undefined; at; ) {
    parents.unshift({ id: at.id, title: at.title });
    at = at.parentId ? tree.get(at.parentId) : undefined;
  }
  const children = [...tree.values()]
    .filter((n) => n.parentId === page.id)
    .sort((a, b) => a.position - b.position || a.title.localeCompare(b.title, "de"))
    .map((n) => ({ id: n.id, title: n.title, path: n.path }));
  const file = page.fileId
    ? await db.query.projectFile.findFirst({
        where: eq(schema.projectFile.id, page.fileId),
        columns: { id: true, name: true, mime: true },
      })
    : undefined;
  return {
    id: page.id,
    path: node?.path ?? "",
    parents,
    children,
    categories: (await itemCategoriesOf([{ pageId: page.id }])).get(`p:${page.id}`) ?? [],
    origin: page.origin,
    originLabel: page.originLabel,
    kept: page.kept,
    review: page.review,
    file: file ?? null,
  };
}

// --- what a step reads ---------------------------------------------------------------

const PART = 20_000;

function yamlValue(v: string | number | boolean): string {
  return typeof v === "string" && /[:#\n"']|^\s|\s$/.test(v) ? JSON.stringify(v) : String(v);
}

/** The headings of a page, outermost first, for a step that wants one section. */
function sectionOf(markdown: string, wanted: string): string | null {
  const lines = markdown.split("\n");
  const want = wanted
    .replace(/^#+\s*/, "")
    .trim()
    .toLowerCase();
  let start = -1;
  let level = 0;
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) {
      fence = !fence;
    }
    const h = fence ? null : /^(#{1,6})\s+(.*)$/.exec(lines[i]);
    if (!h) {
      continue;
    }
    if (start >= 0 && h[1].length <= level) {
      return lines.slice(start, i).join("\n").trim();
    }
    if (start < 0 && h[2].trim().toLowerCase().includes(want)) {
      start = i;
      level = h[1].length;
    }
  }
  return start >= 0 ? lines.slice(start).join("\n").trim() : null;
}

/**
 * A page as a step reads it: front matter (title, path, categories, where it came from, its
 * original, its parent and sub-pages) and its Markdown, or one section of it. Long pages come in
 * parts: `from` continues where the last part ended.
 */
export async function readPage(
  projectId: string,
  path: string,
  opts: { section?: string; from?: number } = {},
) {
  const found = await resolvePath(projectId, path);
  if (found?.kind !== "page") {
    throw new ServiceError(
      "not_found",
      `No page "${path}". project_list or project_search name the pages there are.`,
    );
  }
  const page = await db.query.spacePage.findFirst({ where: eq(schema.spacePage.id, found.id) });
  if (!page) {
    throw notFound();
  }
  const tree = await pageTree(projectId);
  const node = tree.get(page.id);
  const categories = await categoryRows(projectId);
  const lines = categoryLines(
    categories,
    (await itemCategoriesOf([{ pageId: page.id }])).get(`p:${page.id}`),
  );
  const children = [...tree.values()]
    .filter((n) => n.parentId === page.id)
    .sort((a, b) => a.position - b.position)
    .map((n) => n.path);
  const original = page.fileId ? (await filePaths(projectId)).get(page.fileId) : undefined;
  const front = [
    "---",
    `title: ${yamlValue(page.title)}`,
    `path: ${found.path}`,
    ...(node?.parentId ? [`parent: ${tree.get(node.parentId)?.path}`] : []),
    ...(lines.length
      ? [
          "categories:",
          ...lines.map(
            (l) =>
              `  ${l.replace(/^([^:]+): (.*)$/, (_m, k, v) => `${yamlValue(k)}: ${yamlValue(v)}`)}`,
          ),
        ]
      : []),
    ...(page.originLabel ? [`source: ${yamlValue(page.originLabel)}`] : []),
    ...(original ? [`original: ${original}`] : []),
    ...(children.length ? ["sub-pages:", ...children.slice(0, 200).map((c) => `  - ${c}`)] : []),
    ...(children.length > 200 ? [`  # … ${children.length - 200} more, see project_list`] : []),
    "---",
  ].join("\n");
  let text = page.markdown;
  if (opts.section) {
    const section = sectionOf(text, opts.section);
    if (section === null) {
      throw new ServiceError("not_found", `No section "${opts.section}" on ${found.path}.`);
    }
    text = section;
  }
  const start = Math.min(Math.max(0, opts.from ?? 0), text.length);
  const part = text.slice(start, start + PART);
  return {
    path: found.path,
    page: `${front}\n\n${part}`,
    next: start + part.length < text.length ? start + part.length : null,
    length: text.length,
  };
}

/** A cell as a table's filter compares it. */
function matchesCell(column: TableColumn, cell: unknown, w: WhereValue): boolean {
  const shown = formatTableCell(column, cell, "de").toLowerCase();
  if (Array.isArray(w)) {
    return w.some((v) => matchesCell(column, cell, v));
  }
  if (typeof w === "object" && w !== null) {
    if (w.contains !== undefined) {
      return shown.includes(w.contains.toLowerCase());
    }
    if (w.gte !== undefined || w.lte !== undefined) {
      const n = typeof cell === "number" ? cell : numberOf(String(cell ?? ""));
      return (
        n !== null && (w.gte === undefined || n >= w.gte) && (w.lte === undefined || n <= w.lte)
      );
    }
    if (w.after !== undefined || w.before !== undefined) {
      const at = dateOf(cell);
      const after = w.after ? dateOf(w.after) : null;
      const before = w.before ? dateOf(w.before) : null;
      return (
        at !== null &&
        (after === null || at >= after) &&
        (before === null || at < before + 86_400_000)
      );
    }
    return false;
  }
  if (typeof w === "number") {
    return (typeof cell === "number" ? cell : numberOf(String(cell ?? ""))) === w;
  }
  if (typeof w === "boolean") {
    return cell === w;
  }
  return (
    shown === String(w).toLowerCase() ||
    String(cell ?? "").toLowerCase() === String(w).toLowerCase()
  );
}

const csvCell = (value: string) =>
  /[",\n;]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

/**
 * A table as a step reads it: its rows as CSV, filtered by its columns (by their names), a few
 * hundred at a time.
 */
export async function readTable(
  projectId: string,
  path: string,
  opts: { where?: Where; columns?: string[]; limit?: number; offset?: number } = {},
) {
  const found = await resolvePath(projectId, path);
  if (found?.kind !== "table") {
    throw new ServiceError(
      "not_found",
      `No table "${path}". project_list or project_search name the tables there are.`,
    );
  }
  const table = await db.query.spaceTable.findFirst({ where: eq(schema.spaceTable.id, found.id) });
  if (!table) {
    throw notFound();
  }
  const byName = (name: string) =>
    table.columns.find(
      (c) => c.name.toLowerCase() === name.trim().toLowerCase() || c.id === name.trim(),
    );
  const filters = Object.entries(opts.where ?? {}).map(([name, w]) => {
    const column = byName(name);
    if (!column) {
      throw new ServiceError(
        "invalid",
        `No column "${name}" in ${found.path}. It has: ${table.columns.map((c) => c.name).join(", ")}.`,
      );
    }
    return { column, w };
  });
  const shown = opts.columns?.length
    ? opts.columns.map((name) => {
        const column = byName(name);
        if (!column) {
          throw new ServiceError("invalid", `No column "${name}" in ${found.path}.`);
        }
        return column;
      })
    : table.columns;
  const rows = (
    await db.query.spaceTableRow.findMany({
      where: eq(schema.spaceTableRow.tableId, table.id),
      orderBy: [asc(schema.spaceTableRow.createdAt), asc(schema.spaceTableRow.id)],
    })
  ).filter((row) => filters.every((f) => matchesCell(f.column, row.cells[f.column.id], f.w)));
  const limit = Math.min(Math.max(1, opts.limit ?? 200), 1000);
  const offset = Math.max(0, opts.offset ?? 0);
  const part = rows.slice(offset, offset + limit);
  const csv = [
    shown.map((c) => csvCell(c.name)).join(","),
    ...part.map((row) =>
      shown.map((c) => csvCell(formatTableCell(c, row.cells[c.id], "de"))).join(","),
    ),
  ].join("\n");
  return {
    path: found.path,
    title: table.title,
    format: table.format,
    columns: table.columns.map((c) => `${c.name} (${c.type})`),
    rows: rows.length,
    shown: part.length,
    next: offset + part.length < rows.length ? offset + part.length : null,
    csv,
  };
}

/**
 * For project_list: without a filter, the categories with their values and how many items each
 * has; with one, the items it leaves, with their paths and categories.
 */
export async function listForStep(projectId: string, where: Where | undefined) {
  const categories = await listCategories(projectId);
  const taken = categories.filter((c) => !c.proposed);
  if (!Object.keys(where ?? {}).length) {
    return {
      categories: taken.map((c) => ({
        name: c.name,
        type: c.type,
        ...(c.unit ? { unit: c.unit } : {}),
        items: c.count,
        ...(c.type === "choice"
          ? { values: c.values.slice(0, 60).map((v) => `${v.value} (${v.count})`) }
          : {}),
        ...(c.range ? { range: `${c.range.min} … ${c.range.max}` } : {}),
      })),
      hint: 'Pass `where` to list the items of values, e.g. { "Baustelle": "Graz Süd" }.',
    };
  }
  const filtered = await filterItems(projectId, where);
  const [tree, tPaths, fPaths] = await Promise.all([
    pageTree(projectId),
    tablePaths(projectId),
    filePaths(projectId),
  ]);
  const refs = [
    ...[...(filtered?.pages ?? [])].map((pageId) => ({ pageId })),
    ...[...(filtered?.tables ?? [])].map((tableId) => ({ tableId })),
    ...[...(filtered?.files ?? [])].map((fileId) => ({ fileId })),
  ];
  const cats = await itemCategoriesOf(refs);
  // Rows whose table is not left as a whole: by their table, with how many.
  const rowTables = new Map<string, number>();
  const looseRows = [...(filtered?.rows ?? [])];
  for (let i = 0; i < looseRows.length; i += 500) {
    for (const r of await db.query.spaceTableRow.findMany({
      where: inArray(schema.spaceTableRow.id, looseRows.slice(i, i + 500)),
      columns: { tableId: true },
    })) {
      if (!filtered?.tables.has(r.tableId)) {
        rowTables.set(r.tableId, (rowTables.get(r.tableId) ?? 0) + 1);
      }
    }
  }
  const items = [
    ...[...(filtered?.pages ?? [])]
      .map((id) => tree.get(id))
      .filter((n): n is PageNode => Boolean(n))
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((n) => ({
        path: n.path,
        title: n.title,
        categories: categoryLines(taken, cats.get(`p:${n.id}`)),
      })),
    ...[...(filtered?.tables ?? [])].map((id) => ({
      path: tPaths.get(id) ?? "",
      title: "",
      categories: categoryLines(taken, cats.get(`t:${id}`)),
    })),
    ...[...rowTables].map(([id, n]) => ({
      path: tPaths.get(id) ?? "",
      title: `${n} rows match: read them with table_read and the same values as its columns`,
      categories: [],
    })),
    ...[...(filtered?.files ?? [])].map((id) => ({
      path: fPaths.get(id) ?? "",
      title: "",
      categories: categoryLines(taken, cats.get(`f:${id}`)),
    })),
  ];
  return { items: items.slice(0, 200), total: items.length };
}

/** How much Knowledge a space holds: what the block of the steps' instructions says. */
export async function knowledgeCounts(projectId: string) {
  const [pages, tables, files] = await Promise.all([
    db
      .select({ n: count() })
      .from(schema.spacePage)
      .where(and(eq(schema.spacePage.projectId, projectId), isNull(schema.spacePage.wizardId))),
    db
      .select({ n: count() })
      .from(schema.spaceTable)
      .where(and(eq(schema.spaceTable.projectId, projectId), isNull(schema.spaceTable.wizardId))),
    db
      .select({ n: count() })
      .from(schema.projectFile)
      .where(
        and(eq(schema.projectFile.projectId, projectId), eq(schema.projectFile.kind, "document")),
      ),
  ]);
  return { pages: pages[0].n, tables: tables[0].n, files: files[0].n };
}

/**
 * What every step of the space is told about Knowledge: how much there is, the categories to filter
 * by, the tools to find and read. Empty when Knowledge is.
 */
export async function knowledgeBlock(projectId: string): Promise<string> {
  const counts = await knowledgeCounts(projectId);
  if (!(counts.pages || counts.tables || counts.files)) {
    return "";
  }
  const categories = (await listCategories(projectId)).filter((c) => !c.proposed && c.count);
  const what = [
    counts.pages ? `${counts.pages} pages` : "",
    counts.tables ? `${counts.tables} tables` : "",
    counts.files ? `${counts.files} files` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const lines = categories.slice(0, 30).map((c) => {
    const type = `${c.type}${c.unit ? `, ${c.unit}` : ""}`;
    const values =
      c.type === "choice"
        ? `: ${c.values
            .slice(0, 12)
            .map((v) => v.value)
            .join(", ")}${c.values.length > 12 ? ` … (${c.values.length} values)` : ""}`
        : c.range
          ? `: ${c.range.min} … ${c.range.max}`
          : "";
    return `- ${c.name} (${type})${values}`;
  });
  return [
    "# KNOWLEDGE — WHAT THE SPACE KNOWS",
    `Ground truth the space's owner keeps for all wizards: ${what}. Use it when the task touches what it covers, and prefer it to what you remember.`,
    ...(lines.length
      ? [
          "Categories, to filter with `where` in project_search and project_list before searching:",
          ...lines,
        ]
      : []),
    "Find with project_search (a question; `where` on categories). List with project_list. Read whole with page_read and table_read by path. A page marks the pages of its original as <!-- S. n -->: quote them when the source matters.",
  ].join("\n");
}
