import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";

/**
 * Where a statement on a wizard's database file runs (store/data.ts): a worker thread, so one
 * that takes too long is stopped by ending the thread. SQLite runs a statement without letting go
 * of its thread; on the runtime's own thread a recursive query would hold every run.
 *
 * The worker is a script of its own, given as text: it is the same in the sources, the tests and
 * the build, with no file to copy. It reads the database with `libsql`, the engine
 * `@libsql/client` opens files with.
 */

/** One part of a request, run in order on one connection. */
export interface WorkerStep {
  sql: string;
  args?: Record<string, unknown>;
  /**
   * `schema`: the statements of a schema or migration file, all in one transaction. `read`: one
   * statement with `query_only` on. `write`: one statement in a transaction, rolled back where it
   * changes more rows than allowed.
   */
  mode: "schema" | "read" | "write";
}

export interface WorkerRequest {
  /** A file path, or `:memory:`. */
  path: string;
  steps: WorkerStep[];
  maxRows: number;
  maxChanges: number;
  maxBytes: number;
}

export interface WorkerResult {
  columns: string[];
  rows: Record<string, unknown>[];
  truncated: boolean;
  changes: number;
  lastId: number | null;
}

export type WorkerReply =
  | { ok: true; results: WorkerResult[] }
  | { ok: false; code: "full" | "changes" | "sql"; message: string };

const SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const Database = require(workerData.libsql);
const open = new Map();

function connect(path, maxBytes) {
  let db = path === ":memory:" ? null : open.get(path);
  if (!db) {
    db = new Database(path);
    if (path === ":memory:") return limit(db, maxBytes);
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA journal_mode = WAL");
    open.set(path, db);
    if (open.size > 16) {
      const [first, oldest] = open.entries().next().value;
      oldest.close();
      open.delete(first);
    }
  }
  return limit(db, maxBytes);
}

function limit(db, maxBytes) {
  const pageSize = db.prepare("PRAGMA page_size").get().page_size;
  db.exec("PRAGMA max_page_count = " + Math.max(1, Math.floor(maxBytes / pageSize)));
  return db;
}

function value(v) {
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Uint8Array) return "<" + v.byteLength + " bytes>";
  return v;
}

function rowsOf(stmt, args, maxRows) {
  const columns = stmt.columns().map((c) => c.name);
  const rows = [];
  let truncated = false;
  for (const row of args ? stmt.iterate(args) : stmt.iterate()) {
    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }
    const out = {};
    for (const key of Object.keys(row)) out[key] = value(row[key]);
    rows.push(out);
  }
  return { columns, rows, truncated };
}

class Refused extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function step(db, s, req) {
  const empty = { columns: [], rows: [], truncated: false, changes: 0, lastId: null };
  if (s.mode === "schema") {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(s.sql);
      db.exec("COMMIT");
    } catch (err) {
      if (db.inTransaction) db.exec("ROLLBACK");
      throw err;
    }
    return empty;
  }
  if (s.mode === "read") {
    db.exec("PRAGMA query_only = 1");
    try {
      const stmt = db.prepare(s.sql);
      if (!stmt.reader) {
        // A write here fails: query_only is on.
        if (s.args) stmt.run(s.args); else stmt.run();
        return empty;
      }
      return { ...empty, ...rowsOf(stmt, s.args, req.maxRows) };
    } finally {
      db.exec("PRAGMA query_only = 0");
    }
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const stmt = db.prepare(s.sql);
    let out = empty;
    if (stmt.reader) {
      out = { ...empty, ...rowsOf(stmt, s.args, req.maxRows) };
      out.changes = db.prepare("SELECT changes() AS n").get().n;
    } else {
      const ran = s.args ? stmt.run(s.args) : stmt.run();
      out = { ...empty, changes: Number(ran.changes), lastId: ran.lastInsertRowid == null ? null : Number(ran.lastInsertRowid) };
    }
    if (out.changes > req.maxChanges) {
      throw new Refused("changes", "The statement changes " + out.changes + " rows; at most " + req.maxChanges + " at once.");
    }
    db.exec("COMMIT");
    return out;
  } catch (err) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw err;
  }
}

parentPort.on("message", (req) => {
  try {
    const db = connect(req.path, req.maxBytes);
    try {
      const results = req.steps.map((s) => step(db, s, req));
      parentPort.postMessage({ ok: true, results });
    } finally {
      if (req.path === ":memory:") db.close();
    }
  } catch (err) {
    const text = String((err && err.message) || err);
    const code = err instanceof Refused ? err.code : /SQLITE_FULL|database or disk is full/i.test(text + " " + (err && err.code)) ? "full" : "sql";
    parentPort.postMessage({ ok: false, code, message: text.slice(0, 500) });
  }
});
`;

/** `libsql` as `@libsql/client` finds it: the engine the runtime opens its own files with. */
let libsqlPath: string | null = null;
function libsql(): string {
  if (!libsqlPath) {
    const here = createRequire(import.meta.url);
    libsqlPath = createRequire(here.resolve("@libsql/client")).resolve("libsql");
  }
  return libsqlPath;
}

/** Threads at most: more requests wait for one to be free. */
const MAX_WORKERS = 4;

const idle: Worker[] = [];
let running = 0;
const waiting: (() => void)[] = [];

async function take(): Promise<Worker> {
  for (;;) {
    const free = idle.pop();
    if (free) {
      return free;
    }
    if (running < MAX_WORKERS) {
      running++;
      const worker = new Worker(SOURCE, { eval: true, workerData: { libsql: libsql() } });
      worker.unref();
      worker.on("error", () => {});
      return worker;
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
}

function give(worker: Worker) {
  idle.push(worker);
  waiting.shift()?.();
}

function end(worker: Worker) {
  running--;
  void worker.terminate();
  waiting.shift()?.();
}

/** A statement that ran past its time; its thread was ended with it. */
export class WorkerTimeout extends Error {}

/** Runs the steps on one connection of a worker, within `timeoutMs` or not at all. */
export async function inWorker(request: WorkerRequest, timeoutMs: number): Promise<WorkerReply> {
  const worker = await take();
  return new Promise<WorkerReply>((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.off("message", answer);
      worker.off("exit", gone);
      end(worker);
      reject(new WorkerTimeout(`The statement took longer than ${timeoutMs / 1000} s.`));
    }, timeoutMs);
    const answer = (reply: WorkerReply) => {
      clearTimeout(timer);
      worker.off("exit", gone);
      give(worker);
      resolve(reply);
    };
    const gone = () => {
      clearTimeout(timer);
      worker.off("message", answer);
      running--;
      waiting.shift()?.();
      reject(new Error("The database's worker ended."));
    };
    worker.once("message", answer);
    worker.once("exit", gone);
    worker.postMessage(request);
  });
}

/** Ends every worker, closing the files they hold open (before a database file is deleted). */
export async function closeWorkers(): Promise<void> {
  const all = idle.splice(0);
  running -= all.length;
  await Promise.all(all.map((w) => w.terminate()));
}
