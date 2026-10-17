import {
  firstRowAt,
  type ListDef,
  type ListRow,
  newCells,
  patchCells,
  rowKey,
  STORE_LIMITS,
} from "@engenty-wizards/shared/store";
import { and, asc, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema } from "../db/client.js";
import { StoreError } from "./errors.js";

/**
 * A wizard's shared lists: one table of the space per list, owned by the wizard, that every run
 * reads and writes, wherever it runs — a run on the server writes the server's table, one on a
 * local install the install's. The list in the wizard's definition decides the table's title,
 * columns and key; the studio shows it under Space → Data.
 */

type TableRow = typeof schema.spaceTable.$inferSelect;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The table a shared list is kept in: made the first time, following the list as it changes. */
export async function sharedTable(wizardId: string, def: ListDef): Promise<TableRow> {
  const where = and(eq(schema.spaceTable.wizardId, wizardId), eq(schema.spaceTable.list, def.id));
  const found = await db.query.spaceTable.findFirst({ where });
  const shape = { title: def.title, columns: def.columns, keyColumn: def.key ?? null };
  if (found) {
    if (
      found.title !== shape.title ||
      found.keyColumn !== shape.keyColumn ||
      !same(found.columns, shape.columns)
    ) {
      await db
        .update(schema.spaceTable)
        .set({ ...shape, updatedAt: new Date() })
        .where(eq(schema.spaceTable.id, found.id));
      return { ...found, ...shape };
    }
    return found;
  }
  const wizard = await db.query.wizard.findFirst({
    where: eq(schema.wizard.id, wizardId),
    columns: { projectId: true, tenantId: true },
  });
  if (!wizard) {
    throw new StoreError("The wizard is gone.");
  }
  // Two runs that start at once make it once.
  await db
    .insert(schema.spaceTable)
    .values({ id: nanoid(12), ...wizard, wizardId, list: def.id, ...shape })
    .onConflictDoNothing();
  const made = await db.query.spaceTable.findFirst({ where });
  if (!made) {
    throw new StoreError(`List "${def.id}" could not be made.`);
  }
  return made;
}

async function touch(tableId: string) {
  await db
    .update(schema.spaceTable)
    .set({ updatedAt: new Date() })
    .where(eq(schema.spaceTable.id, tableId));
}

function toRow(r: typeof schema.spaceTableRow.$inferSelect): ListRow {
  return { id: r.id, cells: r.cells, updatedAt: r.updatedAt.toISOString() };
}

export async function sharedRows(wizardId: string, def: ListDef): Promise<ListRow[]> {
  const table = await sharedTable(wizardId, def);
  const rows = await db.query.spaceTableRow.findMany({
    where: eq(schema.spaceTableRow.tableId, table.id),
    orderBy: [asc(schema.spaceTableRow.createdAt), asc(schema.spaceTableRow.id)],
  });
  return rows.map(toRow);
}

/** As `saveRows` does for one person's list: a row with a known key updates that row. */
export async function saveSharedRows(
  wizardId: string,
  def: ListDef,
  input: Record<string, unknown>[],
): Promise<{ added: number; updated: number }> {
  const table = await sharedTable(wizardId, def);
  const existing = await db.query.spaceTableRow.findMany({
    where: eq(schema.spaceTableRow.tableId, table.id),
  });
  const byKey = new Map(existing.filter((r) => r.key).map((r) => [r.key as string, r]));
  let count = existing.length;
  const at = firstRowAt(existing);
  let added = 0;
  let updated = 0;
  for (const raw of input) {
    const key = rowKey(def, raw);
    const hit = key ? byKey.get(key) : undefined;
    if (hit) {
      const cells = patchCells(def, hit.cells, raw);
      await db
        .update(schema.spaceTableRow)
        .set({ cells, updatedAt: new Date() })
        .where(eq(schema.spaceTableRow.id, hit.id));
      hit.cells = cells;
      updated++;
      continue;
    }
    const cells = newCells(def, raw);
    if (Object.values(cells).every((v) => v === null)) {
      continue;
    }
    if (count >= STORE_LIMITS.rowsPerList) {
      throw new StoreError(`List "${def.id}" is full (${STORE_LIMITS.rowsPerList} rows).`);
    }
    const row = { id: nanoid(14), tableId: table.id, key, cells, createdAt: new Date(at + added) };
    await db.insert(schema.spaceTableRow).values(row);
    if (key) {
      byKey.set(key, { ...row, updatedAt: new Date() });
    }
    count++;
    added++;
  }
  if (added || updated) {
    await touch(table.id);
  }
  return { added, updated };
}

/** Deletes rows by id, or by the value of the key column. */
export async function deleteSharedRows(wizardId: string, def: ListDef, idsOrKeys: string[]) {
  if (!idsOrKeys.length) {
    return 0;
  }
  const table = await sharedTable(wizardId, def);
  const keys = idsOrKeys.map((k) => k.trim().toLowerCase());
  const inTable = eq(schema.spaceTableRow.tableId, table.id);
  const byId = await db
    .delete(schema.spaceTableRow)
    .where(and(inTable, inArray(schema.spaceTableRow.id, idsOrKeys)))
    .returning({ id: schema.spaceTableRow.id });
  const byKey = await db
    .delete(schema.spaceTableRow)
    .where(and(inTable, inArray(schema.spaceTableRow.key, keys)))
    .returning({ id: schema.spaceTableRow.id });
  if (byId.length + byKey.length) {
    await touch(table.id);
  }
  return byId.length + byKey.length;
}
