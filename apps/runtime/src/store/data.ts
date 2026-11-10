import { rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { DataScope, WizardDefinition } from "@engenty/wizards-shared/definition";
import {
  DATA_MIGRATIONS,
  isReadSql,
  splitSql,
  sqlRefusal,
} from "@engenty/wizards-shared/wizard-data";
import type { WorkspaceFile } from "@engenty/wizards-shared/workspace";
import { type Client, createClient, type InValue } from "@libsql/client";
import { and, eq, inArray } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { db, schema } from "../db/client.js";
import { env } from "../env.js";
import { getBlob } from "../files/blobs.js";
import { currentTenant } from "../tenants/tenant.js";
import {
  closeWorkers,
  inWorker,
  type WorkerReply,
  type WorkerResult,
  type WorkerStep,
  WorkerTimeout,
} from "./data-worker.js";
import { StoreError } from "./errors.js";
import { type StoreScope, touchStore } from "./index.js";

/**
 * A wizard's own database (docs/plans/wizard-data.md): libSQL the runtime keeps, never a file the
 * wizard brings. One per person who runs it, and where the wizard says `shared`, one more for
 * every run of its space. It is made the first time a statement writes to it: the wizard's
 * `data.schema`, then its `data/migrations/*.sql` in the order of their names; a migration added
 * later runs before the next statement. A read before anything was written reads the schema alone.
 *
 * Where it lives: a file in the tenant's data folder (`tenants/<tenant>/data/<id>.db`), or, where
 * tenant databases are on a database server (`TENANT_DB_URL_TEMPLATE`), a database beside the
 * tenant's, its name `<tenant>-<id>`.
 *
 * This module runs statements and knows nothing of who asks. Every caller goes through
 * `runData` in store/data-access.ts, which the broker stands in front of.
 */

/** A database's name: lower case, as a database server takes it. */
const newId = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 16);

/** The holder of the database every run of a space shares. */
const sharedHolder = (spaceId: string) => `shared:${spaceId}`;

export type DataRow = typeof schema.storeDatabase.$inferSelect;

/** What a statement gave back. */
export interface DataResult {
  columns: string[];
  rows: Record<string, unknown>[];
  /** More rows were there than a read hands back. */
  truncated: boolean;
  /** Rows a write changed. */
  changes: number;
  /** The rowid of the last row a write inserted. */
  lastId: number | null;
}

/** One statement: its SQL and its bound parameters, never spliced into it. */
export interface DataStatement {
  sql: string;
  params?: Record<string, unknown>;
  /** `read` runs with writing switched off. */
  mode: "read" | "write";
}

/** Which scopes this runtime offers (`WIZARD_DATA`). */
export const dataScopes = (): readonly DataScope[] => env.wizardData.scopes;

/** Why this runtime can't give a wizard the database it requires, or null. */
export function dataRequirement(def: Pick<WizardDefinition, "data" | "requires">): string | null {
  const wanted = def.requires?.data ?? def.data?.scope;
  if (!wanted || dataScopes().includes(wanted)) {
    return null;
  }
  return wanted === "shared"
    ? "This runtime keeps no database shared by every run."
    : "This runtime keeps no database for a wizard.";
}

/** The holder whose database a store reaches for a scope: the person's, or the space's shared one. */
export async function dataHolder(store: StoreScope, scope: DataScope): Promise<string> {
  if (scope === "person") {
    return store.holder;
  }
  if (store.clientSpaceId) {
    return sharedHolder(store.clientSpaceId);
  }
  const wizard = await db.query.wizard.findFirst({
    where: eq(schema.wizard.id, store.wizardId),
    columns: { spaceId: true },
  });
  if (!wizard) {
    throw new StoreError("The wizard is gone.");
  }
  return sharedHolder(wizard.spaceId);
}

// --- where -------------------------------------------------------------------------------------

const remote = () => Boolean(env.tenantDbUrlTemplate);

function filePath(id: string): string {
  return join(env.dataDir, "tenants", currentTenant(), "data", `${id}.db`);
}

function remoteUrl(id: string): string {
  return env.tenantDbUrlTemplate.replaceAll("{tenant}", `${currentTenant().toLowerCase()}-${id}`);
}

const clients = new Map<string, Client>();

function remoteClient(id: string): Client {
  const url = remoteUrl(id);
  let client = clients.get(url);
  if (!client) {
    client = createClient({ url, authToken: env.tenantDbAuthToken || undefined });
    clients.set(url, client);
  }
  return client;
}

const limits = () => ({
  maxRows: env.wizardData.maxRows,
  maxChanges: env.wizardData.maxChanges,
  maxBytes: env.wizardData.maxMb * 1024 * 1024,
});

/** The refusal of a worker's answer, worded for the step or the model. */
function refusal(reply: Extract<WorkerReply, { ok: false }>): StoreError {
  if (reply.code === "full") {
    return new StoreError(
      `The wizard's database is full (${env.wizardData.maxMb} MB). Nothing was written.`,
    );
  }
  return new StoreError(reply.message);
}

/** Runs the steps on a database file, or in memory (`null`), in a worker within the time limit. */
async function onFile(id: string | null, steps: WorkerStep[]): Promise<WorkerResult[]> {
  const path = id ? filePath(id) : ":memory:";
  if (id) {
    await mkdir(join(path, ".."), { recursive: true });
  }
  let reply: WorkerReply;
  try {
    reply = await inWorker({ path, steps, ...limits() }, env.wizardData.timeoutMs);
  } catch (err) {
    if (err instanceof WorkerTimeout) {
      throw new StoreError(`${err.message} Nothing was written.`);
    }
    throw err;
  }
  if (!reply.ok) {
    throw refusal(reply);
  }
  return reply.results;
}

const timed = <T>(work: Promise<T>): Promise<T> =>
  Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new StoreError(`The statement took longer than ${env.wizardData.timeoutMs / 1000} s.`),
          ),
        env.wizardData.timeoutMs,
      ).unref(),
    ),
  ]);

/** The same on a database server: its own limits stop a statement there, the time limit here. */
async function onServer(id: string, steps: WorkerStep[]): Promise<WorkerResult[]> {
  const client = remoteClient(id);
  const { maxRows, maxChanges, maxBytes } = limits();
  const out: WorkerResult[] = [];
  for (const step of steps) {
    const empty: WorkerResult = {
      columns: [],
      rows: [],
      truncated: false,
      changes: 0,
      lastId: null,
    };
    if (step.mode === "schema") {
      await timed(client.executeMultiple(step.sql));
      out.push(empty);
      continue;
    }
    if (step.mode === "write") {
      const size = await client.execute(
        "SELECT (SELECT page_count FROM pragma_page_count) * (SELECT page_size FROM pragma_page_size) AS n",
      );
      if (Number(size.rows[0]?.n ?? 0) >= maxBytes) {
        throw refusal({ ok: false, code: "full", message: "" });
      }
    }
    const tx = await client.transaction(step.mode === "read" ? "read" : "write");
    try {
      const rs = await timed(tx.execute({ sql: step.sql, args: (step.args ?? {}) as never }));
      if (rs.rowsAffected > maxChanges) {
        throw new StoreError(
          `The statement changes ${rs.rowsAffected} rows; at most ${maxChanges} at once.`,
        );
      }
      await tx.commit();
      out.push({
        columns: rs.columns,
        rows: rs.rows
          .slice(0, maxRows)
          .map((r) => Object.fromEntries(rs.columns.map((c, i) => [c, cell(r[i])]))),
        truncated: rs.rows.length > maxRows,
        changes: rs.rowsAffected,
        lastId: rs.lastInsertRowid === undefined ? null : Number(rs.lastInsertRowid),
      });
    } catch (err) {
      tx.close();
      throw err instanceof StoreError ? err : new StoreError(String((err as Error).message));
    }
  }
  return out;
}

const cell = (v: unknown) =>
  typeof v === "bigint" ? Number(v) : v instanceof ArrayBuffer ? `<${v.byteLength} bytes>` : v;

const run = (id: string | null, steps: WorkerStep[]) =>
  id && remote() ? onServer(id, steps) : onFile(id, steps);

// --- the wizard's SQL ------------------------------------------------------------------------------

/** The text of one of the wizard's files, from the files the run started with. */
async function fileText(files: WorkspaceFile[], path: string): Promise<string> {
  const file = files.find((f) => f.path === path);
  if (!file) {
    throw new StoreError(`The wizard's file ${path} is missing.`);
  }
  return (await getBlob(file.hash)).toString("utf8");
}

/** A file's statements, each checked: one the runtime refuses stops the whole file. */
async function sqlFile(files: WorkspaceFile[], path: string): Promise<WorkerStep> {
  const text = await fileText(files, path);
  for (const statement of splitSql(text)) {
    const why = sqlRefusal(statement);
    if (why) {
      throw new StoreError(`${path}: ${why}`);
    }
  }
  return { sql: text, mode: "schema" };
}

const migrationsOf = (files: WorkspaceFile[]) =>
  files
    .map((f) => f.path)
    .filter((p) => DATA_MIGRATIONS.test(p))
    .sort();

/** The schema and the migrations a database that has run `done` still needs. */
async function pending(
  def: WizardDefinition,
  files: WorkspaceFile[],
  done: string[] | null,
): Promise<{ steps: WorkerStep[]; paths: string[] }> {
  if (!def.data) {
    throw new StoreError("The wizard keeps no database.");
  }
  const paths = migrationsOf(files).filter((p) => !done?.includes(p));
  const steps = await Promise.all([
    ...(done === null ? [sqlFile(files, def.data.schema)] : []),
    ...paths.map((p) => sqlFile(files, p)),
  ]);
  return { steps, paths };
}

// --- the databases ---------------------------------------------------------------------------------

const rowOf = (wizardId: string, holder: string) =>
  db.query.storeDatabase.findFirst({
    where: and(
      eq(schema.storeDatabase.wizardId, wizardId),
      eq(schema.storeDatabase.holder, holder),
    ),
  });

/** Databases being made right now, by tenant, wizard and holder: each once. */
const making = new Map<string, Promise<DataRow>>();

/**
 * The database of a holder, made where it isn't there yet, with every migration of the wizard's
 * files run.
 */
async function databaseOf(
  def: WizardDefinition,
  files: WorkspaceFile[],
  wizardId: string,
  holder: string,
): Promise<DataRow> {
  const found = await rowOf(wizardId, holder);
  if (found) {
    const todo = await pending(def, files, found.migrations);
    if (!todo.steps.length) {
      return found;
    }
    await run(found.id, todo.steps);
    const migrations = [...found.migrations, ...todo.paths];
    await db
      .update(schema.storeDatabase)
      .set({ migrations })
      .where(eq(schema.storeDatabase.id, found.id));
    return { ...found, migrations };
  }
  const key = `${currentTenant()}/${wizardId}/${holder}`;
  let made = making.get(key);
  if (!made) {
    made = (async () => {
      const todo = await pending(def, files, null);
      const id = newId();
      await run(id, todo.steps);
      await db
        .insert(schema.storeDatabase)
        .values({ id, wizardId, holder, migrations: todo.paths })
        .onConflictDoNothing();
      const row = await rowOf(wizardId, holder);
      if (!row) {
        throw new StoreError("The wizard's database could not be made.");
      }
      if (row.id !== id) {
        // Another process made it at the same moment: theirs is kept.
        await dropFiles([id]);
      }
      return row;
    })().finally(() => making.delete(key));
    making.set(key, made);
  }
  return made;
}

/**
 * Runs one statement on the database of a store's scope. A read where no database is there yet
 * reads the schema alone, in memory; a write makes the database. No broker here: callers go
 * through `runData` (store/data-access.ts).
 */
export async function execData(
  target: {
    def: WizardDefinition;
    files: WorkspaceFile[];
    store: StoreScope;
    scope: DataScope;
  },
  statement: DataStatement,
): Promise<DataResult> {
  const { def, files, store, scope } = target;
  if (!def.data) {
    throw new StoreError("The wizard keeps no database.");
  }
  if (scope === "shared" && def.data.scope !== "shared") {
    throw new StoreError("The wizard keeps its data per person, with no shared database.");
  }
  if (!dataScopes().includes(scope)) {
    throw new StoreError(dataRequirement({ data: { ...def.data, scope } }) ?? "");
  }
  const why = sqlRefusal(statement.sql);
  if (why) {
    throw new StoreError(why);
  }
  const step: WorkerStep = {
    sql: statement.sql,
    mode: statement.mode,
    ...(statement.params ? { args: bindable(statement.params) } : {}),
  };
  const holder = await dataHolder(store, scope);
  const found = await rowOf(store.wizardId, holder);
  if (!found && statement.mode === "read" && isReadSql(statement.sql)) {
    const { steps } = await pending(def, files, null);
    const results = await run(null, [...steps, step]);
    return results.at(-1)!;
  }
  const row = await databaseOf(def, files, store.wizardId, holder);
  const [result] = await run(row.id, [step]);
  await db
    .update(schema.storeDatabase)
    .set({ usedAt: new Date() })
    .where(eq(schema.storeDatabase.id, row.id));
  if (scope === "person") {
    // The person's store is in use: what nobody comes back to is deleted with it (purgeUnusedStores).
    await touchStore(store);
  }
  return result;
}

/** A parameter as SQLite binds it: text, a number, null; anything else as its JSON. */
function bindable(params: Record<string, unknown>): Record<string, InValue> {
  return Object.fromEntries(
    Object.entries(params).map(([k, v]) => [
      k,
      v === undefined || v === null
        ? null
        : typeof v === "string" || typeof v === "number"
          ? v
          : typeof v === "boolean"
            ? Number(v)
            : JSON.stringify(v),
    ]),
  );
}

// --- what a database holds, for the studio --------------------------------------------------------

/** The databases a wizard keeps: per person, and shared. */
export async function databasesOf(wizardIds: string[]): Promise<DataRow[]> {
  if (!wizardIds.length) {
    return [];
  }
  return db.query.storeDatabase.findMany({
    where: inArray(schema.storeDatabase.wizardId, wizardIds),
  });
}

/** Reads a statement on one database by its id, as the studio shows it. */
export async function readDatabase(id: string, sql: string): Promise<DataResult> {
  const why = sqlRefusal(sql) ?? (isReadSql(sql) ? null : "Only reads.");
  if (why) {
    throw new StoreError(why);
  }
  const [result] = await run(id, [{ sql, mode: "read" }]);
  return result;
}

// --- deleting ------------------------------------------------------------------------------------------

async function dropFiles(ids: string[]): Promise<void> {
  if (!ids.length) {
    return;
  }
  if (remote()) {
    // A database on a server is the server's to delete; its rows are emptied here.
    for (const id of ids) {
      const client = remoteClient(id);
      const tables = await client.execute(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      );
      for (const t of tables.rows) {
        await client.execute(`DROP TABLE IF EXISTS "${String(t.name).replaceAll('"', '""')}"`);
      }
    }
    return;
  }
  await closeWorkers();
  for (const id of ids) {
    const path = filePath(id);
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${path}${suffix}`, { force: true });
    }
  }
}

async function drop(rows: Pick<DataRow, "id">[]): Promise<number> {
  if (!rows.length) {
    return 0;
  }
  const ids = rows.map((r) => r.id);
  await db.delete(schema.storeDatabase).where(inArray(schema.storeDatabase.id, ids));
  await dropFiles(ids);
  return ids.length;
}

/** Deletes a person's database of a wizard, with the rest of what the wizard keeps for them. */
export async function dropHolderData(scope: StoreScope): Promise<number> {
  return drop(
    await db.query.storeDatabase.findMany({
      where: and(
        eq(schema.storeDatabase.wizardId, scope.wizardId),
        eq(schema.storeDatabase.holder, scope.holder),
      ),
      columns: { id: true },
    }),
  );
}

/** Deletes every database of a wizard, the shared ones too: the wizard is gone. */
export async function dropWizardData(wizardId: string): Promise<number> {
  return drop(
    await db.query.storeDatabase.findMany({
      where: eq(schema.storeDatabase.wizardId, wizardId),
      columns: { id: true },
    }),
  );
}
