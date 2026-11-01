import { validateWizard } from "@engenty/wizards-shared/definition";
import { tableColumnsSchema } from "@engenty/wizards-shared/engenty/data-tables";
import {
  SKILL_MODES,
  SKILL_SOURCES,
  type SkillBlobFile,
  type SkillFile,
} from "@engenty/wizards-shared/skills";
import type { SyncKind, SyncRecord } from "@engenty/wizards-shared/sync";
import { themeSchema } from "@engenty/wizards-shared/theme";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db, schema } from "../db/client.js";
import { blobThumb, hasBlob, releaseBlob } from "../files/blobs.js";
import { spaceChanged } from "../plugins/events.js";
import { asSync } from "../services/access.js";
import { emitDraftChanged } from "../services/draft-events.js";
import { forgetWizardLinks } from "../services/links.js";
import { pushPages } from "../services/pages.js";
import { removeSpaceFile } from "../services/space-files.js";
import { dropIndex, queueIndex } from "../services/space-index.js";
import { removeSpace } from "../services/spaces.js";
import { parseDraft } from "../services/wizards.js";
import { putLink } from "../tenants/control.js";
import { currentTenant } from "../tenants/tenant.js";

/**
 * What syncs of a space, item by item (docs/plans/tenant-sync.md): how each kind is read into
 * the record that travels, written back from one, removed, listed and checked. The same code
 * runs in the cloud and on an install, so a record means the same on both sides. A record holds
 * an item's own fields, never the tenant's id, the revision or a time a write sets by itself;
 * files go by the hash of their bytes (files/blobs.ts).
 */

/** What reading found: the item and its space; `null`: it is gone; `skip`: it is there but does not sync now. */
export type ReadResult = { spaceId: string; record: SyncRecord } | null | "skip";

/** After a write: what follows outside the transaction (links, events, the index). */
type After = () => Promise<void> | void;

interface KindDef {
  read(item: string): Promise<ReadResult>;
  /** Writes the record under `item` in `spaceId`; returns what follows after the commit. */
  write(spaceId: string, item: string, record: SyncRecord): Promise<After | undefined>;
  remove(spaceId: string, item: string): Promise<After | undefined>;
  /** Every item of this kind in the space, for a full pull or a first push. */
  list(spaceId: string): Promise<string[]>;
  title(record: SyncRecord | null, item: string): string;
  /** Hashes of the bytes the record points to. */
  blobs?(record: SyncRecord): string[];
  /** What a merge broke that neither side had broken: empty when it is sound. */
  check?(merged: SyncRecord, local: SyncRecord | null, remote: SyncRecord | null): string[];
}

const ms = (d: Date | null | undefined) => (d ? d.getTime() : null);
const str = (v: unknown) => (typeof v === "string" ? v : null);
const num = (v: unknown) => (typeof v === "number" ? v : null);
const bool = (v: unknown, fallback = false) => (typeof v === "boolean" ? v : fallback);
const arr = <T = unknown>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

// --- categories set on an item ---------------------------------------------------------

type ItemColumn = "pageId" | "rowId" | "tableId" | "fileId";

/** The categories set on a page, a row, a table or a file, keyed so a merge goes value by value. */
async function categoriesOf(column: ItemColumn, id: string) {
  const rows = await db.query.spaceItemCategory.findMany({
    where: eq(schema.spaceItemCategory[column], id),
    orderBy: [asc(schema.spaceItemCategory.id)],
  });
  return rows.map((r) => ({
    id: `${r.categoryId}/${r.valueId ?? "-"}`,
    categoryId: r.categoryId,
    valueId: r.valueId,
    text: r.text,
    num: r.num,
    at: r.at,
    bool: r.bool,
    by: r.by,
  }));
}

async function writeCategories(spaceId: string, column: ItemColumn, id: string, list: unknown) {
  await db.delete(schema.spaceItemCategory).where(eq(schema.spaceItemCategory[column], id));
  const rows = arr<Record<string, unknown>>(list).filter((a) => str(a.categoryId));
  if (!rows.length) {
    return;
  }
  await db.insert(schema.spaceItemCategory).values(
    rows.map((a) => ({
      spaceId,
      categoryId: a.categoryId as string,
      pageId: column === "pageId" ? id : null,
      rowId: column === "rowId" ? id : null,
      tableId: column === "tableId" ? id : null,
      fileId: column === "fileId" ? id : null,
      valueId: str(a.valueId),
      text: str(a.text),
      num: num(a.num),
      at: num(a.at),
      bool: typeof a.bool === "boolean" ? a.bool : null,
      by: (["person", "origin", "model"].includes(a.by as string) ? a.by : "person") as
        | "person"
        | "origin"
        | "model",
    })),
  );
}

/** An item a plugin wrote under a key: another one under the same key here gives way to it. */
async function clearOrigin(
  table: typeof schema.spacePage | typeof schema.spaceTable | typeof schema.spaceFile,
  spaceId: string,
  id: string,
  record: SyncRecord,
) {
  const origin = str(record.origin);
  const key = str(record.originKey);
  if (!origin || !key) {
    return;
  }
  await db
    .delete(table)
    .where(
      and(
        eq(table.spaceId, spaceId),
        eq(table.origin, origin),
        eq(table.originKey, key),
        ne(table.id, id),
      ),
    );
}

// --- the kinds ----------------------------------------------------------------------------

const space: KindDef = {
  async read(id) {
    const p = await db.query.space.findFirst({
      where: and(eq(schema.space.id, id), eq(schema.space.tenantId, currentTenant())),
    });
    if (!p) {
      return null;
    }
    return {
      spaceId: p.id,
      record: {
        name: p.name,
        brand: p.brand,
        facts: p.facts,
        themes: p.themes,
        page: p.page ?? null,
      },
    };
  },
  async write(id, _item, r) {
    const before = await db.query.space.findFirst({ where: eq(schema.space.id, id) });
    const values = {
      name: str(r.name) ?? before?.name ?? "Space",
      brand: obj(r.brand),
      facts: arr(r.facts) as never,
      themes: arr(r.themes) as never,
      page: (r.page ?? null) as never,
    };
    if (before) {
      await db
        .update(schema.space)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(schema.space.id, id));
    } else {
      await db.insert(schema.space).values({ id, tenantId: currentTenant(), ...values });
    }
    return () => {
      spaceChanged(before ? "space.updated" : "space.created", id);
      pushPages();
    };
  },
  async remove(id) {
    await asSync(() => removeSpace(id));
    return undefined;
  },
  list: async (spaceId) => [spaceId],
  title: (r, item) => str(r?.name) ?? item,
  check(merged) {
    const issues: string[] = [];
    if (!z.array(themeSchema).safeParse(merged.themes ?? []).success) {
      issues.push("themes");
    }
    return issues;
  },
};

const wizard: KindDef = {
  async read(id) {
    const w = await db.query.wizard.findFirst({
      where: and(eq(schema.wizard.id, id), eq(schema.wizard.tenantId, currentTenant())),
    });
    if (!w) {
      return null;
    }
    const files = await db.query.wizardFile.findMany({
      where: eq(schema.wizardFile.wizardId, id),
      orderBy: [asc(schema.wizardFile.path)],
    });
    return {
      spaceId: w.spaceId,
      record: {
        spaceId: w.spaceId,
        // The title is the draft's: it travels once, in the draft.
        draft: w.draft,
        shareEnabled: w.shareEnabled,
        dailyRunLimit: w.dailyRunLimit,
        starter: w.starter,
        starterRevision: w.starterRevision,
        runners: w.runners,
        translate: w.translate,
        // Keyed by path, so a merge goes file by file.
        files: files.map((f) => ({
          id: f.path,
          path: f.path,
          hash: f.hash,
          mime: f.mime,
          size: f.size,
        })),
      },
    };
  },
  async write(spaceId, id, r) {
    const files = arr<Record<string, unknown>>(r.files).filter((f) => str(f.path) && str(f.hash));
    const { draft } = parseDraft(
      r.draft,
      files.map((f) => f.path as string),
    );
    const before = await db.query.wizard.findFirst({ where: eq(schema.wizard.id, id) });
    const values = {
      spaceId,
      title: draft.title,
      draft,
      shareEnabled: bool(r.shareEnabled, true),
      ...(num(r.dailyRunLimit) ? { dailyRunLimit: num(r.dailyRunLimit) as number } : {}),
      starter: str(r.starter),
      starterRevision: num(r.starterRevision),
      runners: (r.runners ?? null) as never,
      translate: bool(r.translate, true),
    };
    let shareToken = before?.shareToken;
    if (before) {
      await db
        .update(schema.wizard)
        .set({ ...values, revision: sql`${schema.wizard.revision} + 1`, updatedAt: new Date() })
        .where(eq(schema.wizard.id, id));
    } else {
      // The link is each side's own: a token from elsewhere could be one another tenant holds.
      shareToken = nanoid(14);
      await db
        .insert(schema.wizard)
        .values({ id, tenantId: currentTenant(), shareToken, ...values });
    }
    await db.delete(schema.wizardFile).where(eq(schema.wizardFile.wizardId, id));
    if (files.length) {
      await db.insert(schema.wizardFile).values(
        files.map((f) => ({
          wizardId: id,
          path: f.path as string,
          hash: f.hash as string,
          mime: str(f.mime) ?? "application/octet-stream",
          size: num(f.size) ?? 0,
        })),
      );
    }
    return async () => {
      if (!before && shareToken) {
        await putLink(shareToken, "wizard", id);
      }
      const row = await db.query.wizard.findFirst({
        where: eq(schema.wizard.id, id),
        columns: { revision: true },
      });
      emitDraftChanged({
        wizardId: id,
        kind: "draft",
        revision: row?.revision ?? 0,
        source: "mcp",
        client: "sync",
        note: null,
        touched: [],
      });
    };
  },
  async remove(_spaceId, id) {
    await forgetWizardLinks(id);
    await db
      .delete(schema.wizard)
      .where(and(eq(schema.wizard.id, id), eq(schema.wizard.tenantId, currentTenant())));
    return () => pushPages();
  },
  async list(spaceId) {
    const rows = await db
      .select({ id: schema.wizard.id })
      .from(schema.wizard)
      .where(eq(schema.wizard.spaceId, spaceId));
    return rows.map((r) => r.id);
  },
  title: (r, item) => str(obj(r?.draft).title) ?? item,
  blobs: (r) => arr<Record<string, unknown>>(r.files).map((f) => String(f.hash)),
  check(merged, local, remote) {
    const paths = (r: SyncRecord | null) =>
      arr<Record<string, unknown>>(r?.files).map((f) => String(f.path));
    let issues: string[];
    try {
      issues = parseDraft(merged.draft, paths(merged)).issues.map((i) => i.message);
    } catch {
      return ["draft"];
    }
    // Only what the merge broke: a draft may be unfinished on either side already.
    const had = new Set(
      [local, remote].flatMap((r) => {
        try {
          return r ? validateWizard(r.draft as never, paths(r)).map((i) => i.message) : [];
        } catch {
          return [];
        }
      }),
    );
    return issues.filter((m) => !had.has(m));
  },
};

/** `<wizard id>:<language>`. */
const splitTwo = (item: string) => {
  const at = item.indexOf(":");
  return [item.slice(0, at), item.slice(at + 1)] as const;
};

const translation: KindDef = {
  async read(item) {
    const [wizardId, lang] = splitTwo(item);
    const row = await db.query.wizardTranslation.findFirst({
      where: and(
        eq(schema.wizardTranslation.wizardId, wizardId),
        eq(schema.wizardTranslation.lang, lang),
      ),
    });
    const w = row
      ? await db.query.wizard.findFirst({
          where: eq(schema.wizard.id, wizardId),
          columns: { spaceId: true },
        })
      : null;
    return row && w ? { spaceId: w.spaceId, record: { wizardId, lang, texts: row.texts } } : null;
  },
  async write(_spaceId, item, r) {
    const [wizardId, lang] = splitTwo(item);
    const texts = obj(r.texts) as never;
    await db
      .insert(schema.wizardTranslation)
      .values({ wizardId, lang, texts })
      .onConflictDoUpdate({
        target: [schema.wizardTranslation.wizardId, schema.wizardTranslation.lang],
        set: { texts, updatedAt: new Date() },
      });
    return undefined;
  },
  async remove(_spaceId, item) {
    const [wizardId, lang] = splitTwo(item);
    await db
      .delete(schema.wizardTranslation)
      .where(
        and(
          eq(schema.wizardTranslation.wizardId, wizardId),
          eq(schema.wizardTranslation.lang, lang),
        ),
      );
    return undefined;
  },
  async list(spaceId) {
    const rows = await db
      .select({ wizardId: schema.wizardTranslation.wizardId, lang: schema.wizardTranslation.lang })
      .from(schema.wizardTranslation)
      .innerJoin(schema.wizard, eq(schema.wizard.id, schema.wizardTranslation.wizardId))
      .where(eq(schema.wizard.spaceId, spaceId));
    return rows.map((r) => `${r.wizardId}:${r.lang}`);
  },
  title: (_r, item) => splitTwo(item)[1],
};

const message: KindDef = {
  async read(id) {
    const m = await db.query.wizardMessage.findFirst({ where: eq(schema.wizardMessage.id, id) });
    const w = m
      ? await db.query.wizard.findFirst({
          where: eq(schema.wizard.id, m.wizardId),
          columns: { spaceId: true },
        })
      : null;
    if (!m || !w) {
      return null;
    }
    return {
      spaceId: w.spaceId,
      record: {
        wizardId: m.wizardId,
        role: m.role,
        content: m.content,
        changed: m.changed,
        source: m.source,
        client: m.client,
        createdAt: ms(m.createdAt),
      },
    };
  },
  async write(_spaceId, id, r) {
    const values = {
      wizardId: String(r.wizardId),
      role: (r.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
      content: String(r.content ?? ""),
      changed: bool(r.changed),
      source: (r.source === "mcp" ? "mcp" : "studio") as "studio" | "mcp",
      client: str(r.client),
      createdAt: new Date(num(r.createdAt) ?? Date.now()),
    };
    await db
      .insert(schema.wizardMessage)
      .values({ id, ...values })
      .onConflictDoUpdate({ target: schema.wizardMessage.id, set: values });
    return undefined;
  },
  async remove(_spaceId, id) {
    await db.delete(schema.wizardMessage).where(eq(schema.wizardMessage.id, id));
    return undefined;
  },
  async list(spaceId) {
    const rows = await db
      .select({ id: schema.wizardMessage.id })
      .from(schema.wizardMessage)
      .innerJoin(schema.wizard, eq(schema.wizard.id, schema.wizardMessage.wizardId))
      .where(eq(schema.wizard.spaceId, spaceId));
    return rows.map((r) => r.id);
  },
  title: (r) => (str(r?.content) ?? "").slice(0, 60),
};

const page: KindDef = {
  async read(id) {
    const p = await db.query.spacePage.findFirst({
      where: and(eq(schema.spacePage.id, id), eq(schema.spacePage.tenantId, currentTenant())),
    });
    if (!p) {
      return null;
    }
    // A wizard's pages are what its runs keep: they stay where the runs write them.
    if (p.wizardId) {
      return "skip";
    }
    return {
      spaceId: p.spaceId,
      record: {
        spaceId: p.spaceId,
        title: p.title,
        slug: p.slug,
        markdown: p.markdown,
        parentId: p.parentId,
        position: p.position,
        origin: p.origin,
        originKey: p.originKey,
        originLabel: p.originLabel,
        kept: p.kept,
        review: p.review,
        fileId: p.fileId,
        categories: await categoriesOf("pageId", id),
      },
    };
  },
  async write(spaceId, id, r) {
    await clearOrigin(schema.spacePage, spaceId, id, r);
    const values = {
      spaceId,
      title: str(r.title) ?? "",
      slug: str(r.slug),
      markdown: str(r.markdown) ?? "",
      parentId: str(r.parentId),
      position: num(r.position) ?? 0,
      origin: str(r.origin),
      originKey: str(r.originKey),
      originLabel: str(r.originLabel),
      kept: bool(r.kept),
      review: str(r.review),
      fileId: str(r.fileId),
    };
    await db
      .insert(schema.spacePage)
      .values({ id, tenantId: currentTenant(), ...values })
      .onConflictDoUpdate({
        target: schema.spacePage.id,
        set: { ...values, updatedAt: new Date() },
      });
    await writeCategories(spaceId, "pageId", id, r.categories);
    return () => queueIndex(`P:${id}`);
  },
  async remove(_spaceId, id) {
    await db.delete(schema.spacePage).where(eq(schema.spacePage.id, id));
    return undefined;
  },
  async list(spaceId) {
    const rows = await db
      .select({ id: schema.spacePage.id })
      .from(schema.spacePage)
      .where(and(eq(schema.spacePage.spaceId, spaceId), isNull(schema.spacePage.wizardId)));
    return rows.map((r) => r.id);
  },
  title: (r, item) => str(r?.title) ?? item,
};

const table: KindDef = {
  async read(id) {
    const t = await db.query.spaceTable.findFirst({
      where: and(eq(schema.spaceTable.id, id), eq(schema.spaceTable.tenantId, currentTenant())),
    });
    if (!t) {
      return null;
    }
    if (t.wizardId) {
      return "skip";
    }
    return {
      spaceId: t.spaceId,
      record: {
        spaceId: t.spaceId,
        title: t.title,
        slug: t.slug,
        parentId: t.parentId,
        position: t.position,
        format: t.format,
        columns: t.columns,
        origin: t.origin,
        originKey: t.originKey,
        originLabel: t.originLabel,
        kept: t.kept,
        review: t.review,
        fileId: t.fileId,
        categories: await categoriesOf("tableId", id),
      },
    };
  },
  async write(spaceId, id, r) {
    await clearOrigin(schema.spaceTable, spaceId, id, r);
    const values = {
      spaceId,
      title: str(r.title) ?? "",
      slug: str(r.slug),
      parentId: str(r.parentId),
      position: num(r.position) ?? 0,
      format: (r.format === "faq" ? "faq" : null) as "faq" | null,
      columns: tableColumnsSchema.parse(r.columns ?? []),
      origin: str(r.origin),
      originKey: str(r.originKey),
      originLabel: str(r.originLabel),
      kept: bool(r.kept),
      review: str(r.review),
      fileId: str(r.fileId),
    };
    await db
      .insert(schema.spaceTable)
      .values({ id, tenantId: currentTenant(), ...values })
      .onConflictDoUpdate({
        target: schema.spaceTable.id,
        set: { ...values, updatedAt: new Date() },
      });
    await writeCategories(spaceId, "tableId", id, r.categories);
    return () => queueIndex(`t:${id}`);
  },
  async remove(_spaceId, id) {
    await db.delete(schema.spaceTable).where(eq(schema.spaceTable.id, id));
    return undefined;
  },
  async list(spaceId) {
    const rows = await db
      .select({ id: schema.spaceTable.id })
      .from(schema.spaceTable)
      .where(and(eq(schema.spaceTable.spaceId, spaceId), isNull(schema.spaceTable.wizardId)));
    return rows.map((r) => r.id);
  },
  title: (r, item) => str(r?.title) ?? item,
  check(merged) {
    return tableColumnsSchema.safeParse(merged.columns ?? []).success ? [] : ["columns"];
  },
};

const row: KindDef = {
  async read(id) {
    const r = await db.query.spaceTableRow.findFirst({ where: eq(schema.spaceTableRow.id, id) });
    const t = r
      ? await db.query.spaceTable.findFirst({
          where: and(
            eq(schema.spaceTable.id, r.tableId),
            eq(schema.spaceTable.tenantId, currentTenant()),
          ),
          columns: { spaceId: true, wizardId: true },
        })
      : null;
    if (!r || !t) {
      return null;
    }
    if (t.wizardId) {
      return "skip";
    }
    return {
      spaceId: t.spaceId,
      record: {
        spaceId: t.spaceId,
        tableId: r.tableId,
        key: r.key,
        cells: r.cells,
        createdAt: ms(r.createdAt),
        categories: await categoriesOf("rowId", id),
      },
    };
  },
  async write(spaceId, id, r) {
    const values = {
      tableId: String(r.tableId),
      key: str(r.key),
      cells: obj(r.cells),
      createdAt: new Date(num(r.createdAt) ?? Date.now()),
    };
    await db
      .insert(schema.spaceTableRow)
      .values({ id, ...values })
      .onConflictDoUpdate({
        target: schema.spaceTableRow.id,
        set: { ...values, updatedAt: new Date() },
      });
    await writeCategories(spaceId, "rowId", id, r.categories);
    return () => queueIndex(`r:${id}`);
  },
  async remove(_spaceId, id) {
    await db.delete(schema.spaceTableRow).where(eq(schema.spaceTableRow.id, id));
    return undefined;
  },
  async list(spaceId) {
    const rows = await db
      .select({ id: schema.spaceTableRow.id })
      .from(schema.spaceTableRow)
      .innerJoin(schema.spaceTable, eq(schema.spaceTable.id, schema.spaceTableRow.tableId))
      .where(and(eq(schema.spaceTable.spaceId, spaceId), isNull(schema.spaceTable.wizardId)));
    return rows.map((r) => r.id);
  },
  title(r, item) {
    const first = Object.values(obj(r?.cells)).find((v) => typeof v === "string" && v.trim());
    return typeof first === "string" ? first.slice(0, 80) : item;
  },
};

/**
 * Gives an existing row of a unique name the id that arrives for it, with what points to it:
 * two sides that made "Region" each under an id of their own end up with one category.
 */
async function rekeyCategory(from: string, to: string) {
  await db.update(schema.spaceCategory).set({ id: to }).where(eq(schema.spaceCategory.id, from));
  await db
    .update(schema.spaceCategoryValue)
    .set({ categoryId: to })
    .where(eq(schema.spaceCategoryValue.categoryId, from));
  await db
    .update(schema.spaceItemCategory)
    .set({ categoryId: to })
    .where(eq(schema.spaceItemCategory.categoryId, from));
}

async function rekeyValue(from: string, to: string) {
  await db
    .update(schema.spaceCategoryValue)
    .set({ id: to })
    .where(eq(schema.spaceCategoryValue.id, from));
  await db
    .update(schema.spaceItemCategory)
    .set({ valueId: to })
    .where(eq(schema.spaceItemCategory.valueId, from));
  await db
    .update(schema.spaceChunk)
    .set({ valueId: to })
    .where(eq(schema.spaceChunk.valueId, from));
}

const category: KindDef = {
  async read(id) {
    const c = await db.query.spaceCategory.findFirst({
      where: and(
        eq(schema.spaceCategory.id, id),
        eq(schema.spaceCategory.tenantId, currentTenant()),
      ),
    });
    if (!c) {
      return null;
    }
    const values = await db.query.spaceCategoryValue.findMany({
      where: eq(schema.spaceCategoryValue.categoryId, id),
      orderBy: [asc(schema.spaceCategoryValue.position), asc(schema.spaceCategoryValue.id)],
    });
    return {
      spaceId: c.spaceId,
      record: {
        spaceId: c.spaceId,
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
        position: c.position,
        values: values.map((v) => ({
          id: v.id,
          value: v.value,
          position: v.position,
          summary: v.summary,
        })),
      },
    };
  },
  async write(spaceId, id, r) {
    const name = str(r.name) ?? "";
    const same = await db.query.spaceCategory.findFirst({
      where: and(
        eq(schema.spaceCategory.spaceId, spaceId),
        eq(schema.spaceCategory.name, name),
        ne(schema.spaceCategory.id, id),
      ),
      columns: { id: true },
    });
    if (same) {
      await db.delete(schema.spaceCategory).where(eq(schema.spaceCategory.id, id));
      await rekeyCategory(same.id, id);
    }
    const type = (r.type as string) ?? "text";
    const values = {
      spaceId,
      name,
      type: (["choice", "date", "number", "text", "boolean"].includes(type) ? type : "text") as
        | "choice"
        | "date"
        | "number"
        | "text"
        | "boolean",
      unit: str(r.unit),
      multiple: bool(r.multiple),
      ordered: bool(r.ordered),
      hint: str(r.hint),
      origin: str(r.origin),
      proposed: bool(r.proposed),
      tableId: str(r.tableId),
      columnId: str(r.columnId),
      position: num(r.position) ?? 0,
    };
    await db
      .insert(schema.spaceCategory)
      .values({ id, tenantId: currentTenant(), ...values })
      .onConflictDoUpdate({
        target: schema.spaceCategory.id,
        set: { ...values, updatedAt: new Date() },
      });
    const list = arr<Record<string, unknown>>(r.values).filter((v) => str(v.id) && str(v.value));
    const keep = list.map((v) => v.id as string);
    for (const v of list) {
      const twin = await db.query.spaceCategoryValue.findFirst({
        where: and(
          eq(schema.spaceCategoryValue.categoryId, id),
          eq(schema.spaceCategoryValue.value, v.value as string),
          ne(schema.spaceCategoryValue.id, v.id as string),
        ),
        columns: { id: true },
      });
      if (twin && !keep.includes(twin.id)) {
        await db
          .delete(schema.spaceCategoryValue)
          .where(eq(schema.spaceCategoryValue.id, v.id as string));
        await rekeyValue(twin.id, v.id as string);
      }
    }
    const here = await db.query.spaceCategoryValue.findMany({
      where: eq(schema.spaceCategoryValue.categoryId, id),
      columns: { id: true },
    });
    const gone = here.map((v) => v.id).filter((v) => !keep.includes(v));
    if (gone.length) {
      await db.delete(schema.spaceCategoryValue).where(inArray(schema.spaceCategoryValue.id, gone));
    }
    const summarized: string[] = [];
    for (const v of list) {
      const set = {
        value: v.value as string,
        position: num(v.position) ?? 0,
        summary: str(v.summary),
        summaryAt: str(v.summary) ? new Date() : null,
      };
      await db
        .insert(schema.spaceCategoryValue)
        .values({ id: v.id as string, categoryId: id, ...set })
        .onConflictDoUpdate({ target: schema.spaceCategoryValue.id, set });
      if (set.summary) {
        summarized.push(v.id as string);
      }
    }
    return () => {
      for (const v of summarized) {
        queueIndex(`v:${v}`);
      }
    };
  },
  async remove(_spaceId, id) {
    await db.delete(schema.spaceCategory).where(eq(schema.spaceCategory.id, id));
    return undefined;
  },
  async list(spaceId) {
    const rows = await db
      .select({ id: schema.spaceCategory.id })
      .from(schema.spaceCategory)
      .where(eq(schema.spaceCategory.spaceId, spaceId));
    return rows.map((r) => r.id);
  },
  title: (r, item) => str(r?.name) ?? item,
};

const file: KindDef = {
  async read(id) {
    const f = await db.query.spaceFile.findFirst({ where: eq(schema.spaceFile.id, id) });
    const p = f
      ? await db.query.space.findFirst({
          where: and(eq(schema.space.id, f.spaceId), eq(schema.space.tenantId, currentTenant())),
          columns: { id: true },
        })
      : null;
    if (!f || !p) {
      return null;
    }
    // A file still being read and described goes when it is ready.
    if (f.status !== "ready") {
      return "skip";
    }
    if (!f.hash || !(await hasBlob(f.hash))) {
      return "skip";
    }
    return {
      spaceId: f.spaceId,
      record: {
        spaceId: f.spaceId,
        kind: f.kind,
        name: f.name,
        mime: f.mime,
        size: f.size,
        description: f.description,
        source: f.source,
        position: f.position,
        parentId: f.parentId,
        textHash: f.textHash,
        pages: f.pages,
        chars: f.chars,
        origin: f.origin,
        originKey: f.originKey,
        originLabel: f.originLabel,
        content: f.hash,
        categories: await categoriesOf("fileId", id),
      },
    };
  },
  async write(spaceId, id, r) {
    await clearOrigin(schema.spaceFile, spaceId, id, r);
    const mime = str(r.mime) ?? "application/octet-stream";
    const name = str(r.name) ?? "file";
    const kind = (
      ["logo", "asset", "document", "pattern"].includes(r.kind as string) ? r.kind : "asset"
    ) as "logo" | "asset" | "document" | "pattern";
    // The bytes came ahead of the record, by their hash (client.ts, hub.ts).
    const hash = String(r.content);
    if (!(await hasBlob(hash))) {
      throw new Error("blob missing");
    }
    const before = await db.query.spaceFile.findFirst({ where: eq(schema.spaceFile.id, id) });
    const values = {
      spaceId,
      kind,
      name,
      mime,
      size: num(r.size) ?? 0,
      hash,
      description: str(r.description) ?? "",
      source: str(r.source),
      position: num(r.position) ?? 0,
      parentId: str(r.parentId),
      status: "ready" as const,
      error: null,
      textHash: str(r.textHash),
      pages: num(r.pages),
      chars: num(r.chars),
      origin: str(r.origin),
      originKey: str(r.originKey),
      originLabel: str(r.originLabel),
    };
    await db
      .insert(schema.spaceFile)
      .values({ id, ...values })
      .onConflictDoUpdate({
        target: schema.spaceFile.id,
        set: { ...values, updatedAt: new Date() },
      });
    await writeCategories(spaceId, "fileId", id, r.categories);
    return async () => {
      if (before?.hash !== hash) {
        await releaseBlob(before?.hash);
        void blobThumb(hash, mime).catch(() => null);
      }
      if (kind === "logo") {
        await putLink(id, "logo", id);
      }
      if (mime.startsWith("font/")) {
        await putLink(id, "font", id);
      }
      if (kind === "document") {
        await dropIndex(id);
        queueIndex(`f:${id}`);
      }
    };
  },
  async remove(spaceId, id) {
    await asSync(() => removeSpaceFile(spaceId, id)).catch(() => undefined);
    return undefined;
  },
  async list(spaceId) {
    const rows = await db
      .select({ id: schema.spaceFile.id })
      .from(schema.spaceFile)
      .where(and(eq(schema.spaceFile.spaceId, spaceId), eq(schema.spaceFile.status, "ready")));
    return rows.map((r) => r.id);
  },
  title: (r, item) => str(r?.name) ?? item,
  blobs: (r) => [r.content, r.textHash].filter((h): h is string => typeof h === "string"),
};

const connector: KindDef = {
  async read(item) {
    const [spaceId, id] = splitTwo(item);
    const c = await db.query.spaceConnector.findFirst({
      where: and(eq(schema.spaceConnector.spaceId, spaceId), eq(schema.spaceConnector.id, id)),
    });
    const p = c
      ? await db.query.space.findFirst({
          where: and(eq(schema.space.id, spaceId), eq(schema.space.tenantId, currentTenant())),
          columns: { id: true },
        })
      : null;
    return c && p ? { spaceId, record: { spaceId, record: c.record } } : null;
  },
  async write(spaceId, item, r) {
    const [, id] = splitTwo(item);
    const record = obj(r.record) as never;
    await db
      .insert(schema.spaceConnector)
      .values({ spaceId, id, record })
      .onConflictDoUpdate({
        target: [schema.spaceConnector.spaceId, schema.spaceConnector.id],
        set: { record, updatedAt: new Date() },
      });
    return undefined;
  },
  async remove(spaceId, item) {
    const [, id] = splitTwo(item);
    await db
      .delete(schema.spaceConnector)
      .where(and(eq(schema.spaceConnector.spaceId, spaceId), eq(schema.spaceConnector.id, id)));
    return undefined;
  },
  async list(spaceId) {
    const rows = await db
      .select({ id: schema.spaceConnector.id })
      .from(schema.spaceConnector)
      .where(eq(schema.spaceConnector.spaceId, spaceId));
    return rows.map((r) => `${spaceId}:${r.id}`);
  },
  title: (r, item) => str(obj(r?.record).name) ?? splitTwo(item)[1],
};

const skill: KindDef = {
  async read(id) {
    const k = await db.query.spaceSkill.findFirst({
      where: and(eq(schema.spaceSkill.id, id), eq(schema.spaceSkill.tenantId, currentTenant())),
    });
    if (!k) {
      return null;
    }
    return {
      spaceId: k.spaceId,
      record: {
        spaceId: k.spaceId,
        name: k.name,
        description: k.description,
        body: k.body,
        meta: k.meta,
        files: k.files,
        blobFiles: k.blobFiles,
        mode: k.mode,
        runScripts: k.runScripts,
        source: k.source,
        origin: k.origin,
        originHash: k.originHash,
      },
    };
  },
  async write(spaceId, id, r) {
    const mode = SKILL_MODES.find((m) => m === r.mode) ?? "demand";
    const source = SKILL_SOURCES.find((m) => m === r.source) ?? "own";
    const values = {
      spaceId,
      name: str(r.name) ?? id.toLowerCase(),
      description: str(r.description) ?? "",
      body: str(r.body) ?? "",
      meta: obj(r.meta),
      files: arr<SkillFile>(r.files).filter(
        (f) => typeof f?.path === "string" && typeof f?.text === "string",
      ),
      blobFiles: arr<SkillBlobFile>(r.blobFiles).filter(
        (f) =>
          typeof f?.path === "string" &&
          /^[a-f0-9]{64}$/.test(String(f?.hash)) &&
          typeof f?.bytes === "number",
      ),
      mode,
      runScripts: r.runScripts === true,
      source,
      origin: str(r.origin),
      originHash: str(r.originHash),
    };
    // Two sides named a skill alike: the one arriving takes the name with its id behind it.
    const clash = await db.query.spaceSkill.findFirst({
      where: and(
        eq(schema.spaceSkill.spaceId, spaceId),
        eq(schema.spaceSkill.name, values.name),
        ne(schema.spaceSkill.id, id),
      ),
      columns: { id: true },
    });
    if (clash) {
      values.name =
        `${values.name.slice(0, 50)}-${id.toLowerCase().replace(/[^a-z0-9]/g, "")}`.slice(0, 64);
    }
    await db
      .insert(schema.spaceSkill)
      .values({ id, tenantId: currentTenant(), ...values })
      .onConflictDoUpdate({
        target: schema.spaceSkill.id,
        set: { ...values, updatedAt: new Date() },
      });
    return undefined;
  },
  async remove(_spaceId, id) {
    await db.delete(schema.spaceSkill).where(eq(schema.spaceSkill.id, id));
    return undefined;
  },
  async list(spaceId) {
    const rows = await db
      .select({ id: schema.spaceSkill.id })
      .from(schema.spaceSkill)
      .where(eq(schema.spaceSkill.spaceId, spaceId));
    return rows.map((r) => r.id);
  },
  title: (r, item) => str(r?.name) ?? item,
  blobs: (r) => arr<SkillBlobFile>(r.blobFiles).map((f) => String(f.hash)),
};

export const KINDS: Record<SyncKind, KindDef> = {
  space,
  wizard,
  translation,
  message,
  page,
  table,
  row,
  category,
  file,
  connector,
  skill,
};

/**
 * The order items are written in, so what one points to is there first: the space, its files,
 * tables and categories, then rows, pages, connectors, skills, wizards and what belongs to them.
 */
export const KIND_ORDER: SyncKind[] = [
  "space",
  "file",
  "table",
  "category",
  "row",
  "page",
  "connector",
  "skill",
  "wizard",
  "translation",
  "message",
];

/** A record as both sides compare it: keys in one order, so the same item reads the same. */
export function canonical(record: SyncRecord | null): string {
  return JSON.stringify(record, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

/**
 * What still points nowhere once a batch is written: a page's parent or file, a table's file,
 * a category's table, categories set with a value or category that is gone. Points are let go
 * rather than the write refused: the next change of the item sends it again.
 */
export async function letDanglingGo() {
  await db.run(
    sql`UPDATE space_page SET parent_id = NULL WHERE parent_id IS NOT NULL AND parent_id NOT IN (SELECT id FROM space_page)`,
  );
  await db.run(
    sql`UPDATE space_page SET file_id = NULL WHERE file_id IS NOT NULL AND file_id NOT IN (SELECT id FROM space_file)`,
  );
  await db.run(
    sql`UPDATE space_table SET file_id = NULL WHERE file_id IS NOT NULL AND file_id NOT IN (SELECT id FROM space_file)`,
  );
  await db.run(
    sql`UPDATE space_category SET table_id = NULL, column_id = NULL WHERE table_id IS NOT NULL AND table_id NOT IN (SELECT id FROM space_table)`,
  );
  await db.run(
    sql`DELETE FROM space_item_category WHERE category_id NOT IN (SELECT id FROM space_category) OR (value_id IS NOT NULL AND value_id NOT IN (SELECT id FROM space_category_value)) OR (page_id IS NOT NULL AND page_id NOT IN (SELECT id FROM space_page)) OR (row_id IS NOT NULL AND row_id NOT IN (SELECT id FROM space_table_row)) OR (table_id IS NOT NULL AND table_id NOT IN (SELECT id FROM space_table)) OR (file_id IS NOT NULL AND file_id NOT IN (SELECT id FROM space_file))`,
  );
  await db.run(sql`DELETE FROM space_table_row WHERE table_id NOT IN (SELECT id FROM space_table)`);
  await db.run(sql`DELETE FROM wizard_translation WHERE wizard_id NOT IN (SELECT id FROM wizard)`);
  await db.run(sql`DELETE FROM wizard_message WHERE wizard_id NOT IN (SELECT id FROM wizard)`);
}
