import type {
  SpaceDatabaseInfo,
  WizardDatabase,
  WizardDatabaseRows,
} from "@engenty/wizards-shared/space-data";
import { and, count, eq, inArray, notLike } from "drizzle-orm";
import { assertRwx, readable, type Subject } from "../broker/rwx.js";
import { db, schema } from "../db/client.js";
import { env } from "../env.js";
import { readDatabase } from "../store/data.js";
import { currentTenant } from "../tenants/tenant.js";
import { notFound, ServiceError } from "./errors.js";
import { ownedSpace } from "./spaces.js";

/**
 * Space → Data for a wizard's own database (docs/plans/wizard-data.md, step 3): the database every
 * run of the space shares, read-only, a table at a time, and as CSV. A person's own database is
 * theirs: the studio counts them and shows none.
 */

/** Rows a page of a table shows: no more than a read hands back. */
const perPage = () => Math.min(200, env.wizardData.maxRows);

/** Rows a CSV export holds at most. */
const CSV_MAX_ROWS = 100_000;

const sharedOf = (spaceId: string) => `shared:${spaceId}`;

/** A table's name as SQL quotes it. */
const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** The shared databases of a space's wizards that `who` may read, with how many people keep their own. */
export async function spaceDatabases(
  spaceId: string,
  who: Subject[],
): Promise<SpaceDatabaseInfo[]> {
  const wizards = await db.query.wizard.findMany({
    where: and(eq(schema.wizard.spaceId, spaceId), eq(schema.wizard.tenantId, currentTenant())),
    columns: { id: true },
  });
  const ids = wizards.map((w) => w.id);
  if (!ids.length) {
    return [];
  }
  const [shared, people] = await Promise.all([
    db.query.storeDatabase.findMany({
      where: and(
        inArray(schema.storeDatabase.wizardId, ids),
        eq(schema.storeDatabase.holder, sharedOf(spaceId)),
      ),
    }),
    db
      .select({ wizardId: schema.storeDatabase.wizardId, n: count() })
      .from(schema.storeDatabase)
      .where(
        and(
          inArray(schema.storeDatabase.wizardId, ids),
          notLike(schema.storeDatabase.holder, "shared:%"),
        ),
      )
      .groupBy(schema.storeDatabase.wizardId),
  ]);
  const ok = await readable(
    spaceId,
    who,
    shared.map((d) => ({ kind: "data" as const, id: d.wizardId })),
  );
  return shared
    .filter((d) => ok.has(d.wizardId))
    .map((d) => {
      return {
        id: d.id,
        wizardId: d.wizardId,
        people: people.find((p) => p.wizardId === d.wizardId)?.n ?? 0,
        updatedAt: d.usedAt.toISOString(),
      };
    });
}

/** A shared database of a space, once `who` may read the wizard's data. */
async function readableDatabase(userId: string, id: string, who: Subject[]) {
  const row = await db.query.storeDatabase.findFirst({ where: eq(schema.storeDatabase.id, id) });
  if (!row?.holder.startsWith("shared:")) {
    throw notFound();
  }
  const wizard = await db.query.wizard.findFirst({
    where: and(eq(schema.wizard.id, row.wizardId), eq(schema.wizard.tenantId, currentTenant())),
    columns: { id: true, spaceId: true, title: true },
  });
  if (!wizard) {
    throw notFound();
  }
  const space = await ownedSpace(userId, wizard.spaceId);
  await assertRwx(space.id, who, { kind: "data", id: wizard.id }, "r");
  return { row, wizard };
}

async function tablesOf(id: string): Promise<{ name: string; rows: number }[]> {
  const names = await readDatabase(
    id,
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const out: { name: string; rows: number }[] = [];
  for (const { name } of names.rows as { name: string }[]) {
    const n = await readDatabase(id, `SELECT count(*) AS n FROM ${quoted(name)}`);
    out.push({ name, rows: Number(n.rows[0]?.n ?? 0) });
  }
  return out;
}

/** The database's tables and how many rows each holds. */
export async function wizardDatabase(
  userId: string,
  id: string,
  who: Subject[],
): Promise<WizardDatabase> {
  const { row, wizard } = await readableDatabase(userId, id, who);
  return {
    id: row.id,
    wizardId: wizard.id,
    title: wizard.title,
    tables: await tablesOf(row.id),
    updatedAt: row.usedAt.toISOString(),
  };
}

async function tableNamed(id: string, table: string): Promise<string> {
  const tables = await tablesOf(id);
  if (!tables.some((t) => t.name === table)) {
    throw new ServiceError("not_found", `No table "${table}".`);
  }
  return table;
}

/** A page of a table's rows, in the order they were written. */
export async function wizardDatabaseRows(
  userId: string,
  id: string,
  table: string,
  offset: number,
  who: Subject[],
): Promise<WizardDatabaseRows> {
  const { row } = await readableDatabase(userId, id, who);
  const name = await tableNamed(row.id, table);
  const total = await readDatabase(row.id, `SELECT count(*) AS n FROM ${quoted(name)}`);
  const page = await readDatabase(
    row.id,
    `SELECT * FROM ${quoted(name)} LIMIT ${perPage()} OFFSET ${Math.max(0, Math.floor(offset))}`,
  );
  return {
    table: name,
    columns: page.columns,
    rows: page.rows,
    offset,
    total: Number(total.rows[0]?.n ?? 0),
  };
}

const csvCell = (v: unknown) => {
  const text = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

/** A table as CSV: a header line, then every row, at most a hundred thousand. */
export async function wizardDatabaseCsv(
  userId: string,
  id: string,
  table: string,
  who: Subject[],
): Promise<{ name: string; csv: string }> {
  const { row, wizard } = await readableDatabase(userId, id, who);
  const name = await tableNamed(row.id, table);
  const lines: string[] = [];
  let columns: string[] | null = null;
  for (let offset = 0; offset < CSV_MAX_ROWS; ) {
    const page = await readDatabase(
      row.id,
      `SELECT * FROM ${quoted(name)} LIMIT ${perPage()} OFFSET ${offset}`,
    );
    columns ??= page.columns;
    for (const r of page.rows) {
      lines.push(page.columns.map((c) => csvCell(r[c])).join(","));
    }
    if (page.rows.length < perPage()) {
      break;
    }
    offset += page.rows.length;
  }
  const header = (columns ?? []).map(csvCell).join(",");
  const file = `${wizard.title}-${name}`.replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 80);
  return { name: `${file}.csv`, csv: `${[header, ...lines].join("\r\n")}\r\n` };
}
