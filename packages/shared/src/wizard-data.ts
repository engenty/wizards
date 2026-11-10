// SPDX-License-Identifier: FSL-1.1-MIT OR MIT
import type { WizardDefinition } from "./definition.js";

/**
 * A wizard's own database (docs/plans/wizard-data.md): libSQL the runtime keeps per person, or
 * shared by every run. The wizard brings SQL (its schema, its migrations, the fixed statements of
 * its steps), never a database. What is read here is the SQL as text: split into statements, and
 * refused where it would reach past the database (ATTACH, extensions, a PRAGMA that changes the
 * file, a transaction of its own).
 */

/** Where a migration of a wizard's database lies in its files, run in the order of its name. */
export const DATA_MIGRATIONS = /^data\/migrations\/[^/]+\.sql$/;

/** What the runtime allows per database and per statement, unless its env says otherwise. */
export const DATA_LIMITS = {
  /** Megabytes one database may grow to (`WIZARD_DATA_MAX_MB`). */
  maxMb: 50,
  /** Rows a read hands back (`WIZARD_DATA_MAX_ROWS`); more are cut off and said so. */
  maxRows: 500,
  /** Rows one write may change (`WIZARD_DATA_MAX_CHANGES`); more and nothing is written. */
  maxChanges: 1000,
  /** Milliseconds one statement may take (`WIZARD_DATA_TIMEOUT_MS`). */
  timeoutMs: 5000,
  /** Characters of one statement. */
  sqlChars: 20_000,
  /** Statements a schema or migration file may hold. */
  fileStatements: 200,
};

/** A statement read word by word: its words, upper case, outside strings and comments. */
interface Scanned {
  /** The statements, as written, without the semicolon between them. */
  statements: string[];
  /** Per statement: its keywords and names, upper case, in order. */
  words: string[][];
  /** Per statement: the parameters it names (`:email`, `@email`, `$email`), without the sign. */
  params: string[][];
  /** Text left open at the end: a string, a quoted name or a comment. */
  open: string | null;
}

const WORD = /[A-Za-z_][A-Za-z0-9_$]*/y;
const PARAM = /[:@$]([A-Za-z_][A-Za-z0-9_]*)/y;

/**
 * Splits SQL into its statements, the way SQLite reads it: a semicolon in a string, a quoted name,
 * a comment or the body of a trigger (`BEGIN … END`) ends nothing.
 */
function scan(text: string): Scanned {
  const statements: string[] = [];
  const words: string[][] = [];
  const params: string[][] = [];
  let start = 0;
  let current: string[] = [];
  let named: string[] = [];
  // In a trigger's body: `END` closes it, unless a `CASE` is open.
  let body = false;
  let cases = 0;
  const end = (at: number) => {
    const sql = text.slice(start, at).trim();
    if (sql) {
      statements.push(sql);
      words.push(current);
      params.push([...new Set(named)]);
    }
    current = [];
    named = [];
    body = false;
    cases = 0;
    start = at + 1;
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "-" && next === "-") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl + 1;
      continue;
    }
    if (c === "/" && next === "*") {
      const close = text.indexOf("*/", i + 2);
      if (close < 0) {
        return { statements, words, params, open: "a comment" };
      }
      i = close + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      const closer = c === "[" ? "]" : c;
      let j = i + 1;
      for (;;) {
        const k = text.indexOf(closer, j);
        if (k < 0) {
          return { statements, words, params, open: c === "'" ? "a string" : "a quoted name" };
        }
        // A doubled quote is the quote itself.
        if (closer !== "]" && text[k + 1] === closer) {
          j = k + 2;
          continue;
        }
        j = k + 1;
        break;
      }
      if (c !== "'") {
        current.push(text.slice(i + 1, j - 1).toUpperCase());
      }
      i = j;
      continue;
    }
    if (c === ":" || c === "@" || c === "$") {
      PARAM.lastIndex = i;
      const m = PARAM.exec(text);
      if (m) {
        named.push(m[1]);
        i += m[0].length;
        continue;
      }
    }
    WORD.lastIndex = i;
    const w = WORD.exec(text);
    if (w) {
      const word = w[0].toUpperCase();
      current.push(word);
      const trigger = current[0] === "CREATE" && current.slice(1, 4).includes("TRIGGER");
      if (trigger && word === "BEGIN") {
        body = true;
      } else if (body && word === "CASE") {
        cases++;
      } else if (body && word === "END") {
        if (cases) {
          cases--;
        } else {
          body = false;
        }
      }
      i += w[0].length;
      continue;
    }
    if (c === ";" && !body) {
      end(i);
    }
    i++;
  }
  end(text.length);
  return { statements, words, params, open: body ? "a trigger's BEGIN without its END" : null };
}

/** The statements of a SQL text, each without its semicolon; throws where the text is left open. */
export function splitSql(text: string): string[] {
  const scanned = scan(text);
  if (scanned.open) {
    throw new Error(`The SQL ends inside ${scanned.open}.`);
  }
  return scanned.statements;
}

/** The parameters a statement names, `:email` as `email`. */
export function sqlParams(statement: string): string[] {
  return scan(statement).params.flat();
}

/** PRAGMAs that only read: a statement may ask them, never set them. */
const READING_PRAGMAS = new Set([
  "TABLE_INFO",
  "TABLE_XINFO",
  "TABLE_LIST",
  "INDEX_LIST",
  "INDEX_INFO",
  "INDEX_XINFO",
  "FOREIGN_KEY_LIST",
  "FOREIGN_KEY_CHECK",
  "INTEGRITY_CHECK",
  "QUICK_CHECK",
  "PAGE_COUNT",
  "PAGE_SIZE",
  "FREELIST_COUNT",
]);

/** The words that end what a statement may be. */
const REFUSED_FIRST: Record<string, string> = {
  ATTACH: "ATTACH reaches another database.",
  DETACH: "DETACH reaches another database.",
  VACUUM: "VACUUM rewrites the file.",
  BEGIN: "The runtime runs each statement in a transaction of its own.",
  COMMIT: "The runtime runs each statement in a transaction of its own.",
  END: "The runtime runs each statement in a transaction of its own.",
  ROLLBACK: "The runtime runs each statement in a transaction of its own.",
  SAVEPOINT: "The runtime runs each statement in a transaction of its own.",
  RELEASE: "The runtime runs each statement in a transaction of its own.",
  REINDEX: "REINDEX rewrites the file.",
};

/**
 * Why a statement is refused, or null: it reaches past its own database, loads an extension, sets
 * a PRAGMA, or starts a transaction of its own. A trigger's body counts like its statements.
 */
export function sqlRefusal(statement: string): string | null {
  const scanned = scan(statement);
  if (scanned.open) {
    return `The SQL ends inside ${scanned.open}.`;
  }
  if (scanned.statements.length !== 1) {
    return scanned.statements.length ? "One statement at a time." : "There is no statement.";
  }
  if (statement.length > DATA_LIMITS.sqlChars) {
    return `A statement has at most ${DATA_LIMITS.sqlChars} characters.`;
  }
  const words = scanned.words[0];
  const first = words[0] ?? "";
  if (REFUSED_FIRST[first]) {
    return REFUSED_FIRST[first];
  }
  if (first === "PRAGMA") {
    const name = (words[1] === "MAIN" ? words[2] : words[1]) ?? "";
    if (!READING_PRAGMAS.has(name) || /=/.test(statement)) {
      return "A PRAGMA may only read: table_info, index_list and the like.";
    }
  }
  if (words.includes("LOAD_EXTENSION")) {
    return "Extensions are not loaded.";
  }
  if (words.includes("ATTACH")) {
    return "ATTACH reaches another database.";
  }
  if (words.some((w) => w === "SQLITE_MASTER" || w === "SQLITE_SCHEMA") && !isReadSql(statement)) {
    return "The schema table is the database's own.";
  }
  return null;
}

/** Whether a statement only reads: SELECT, VALUES, a WITH that selects, EXPLAIN, a reading PRAGMA. */
export function isReadSql(statement: string): boolean {
  const words = scan(statement).words[0] ?? [];
  const first = words[0];
  if (first === "SELECT" || first === "VALUES" || first === "EXPLAIN" || first === "PRAGMA") {
    return true;
  }
  if (first === "WITH") {
    return !words.some(
      (w) => w === "INSERT" || w === "UPDATE" || w === "DELETE" || w === "REPLACE",
    );
  }
  return false;
}

/** A problem with a wizard's data files, worded for the validator. */
export interface DataFileIssue {
  path: string;
  message: string;
}

/**
 * The SQL files of a wizard's data, read from its files: the schema, then the migrations in the
 * order of their names. `read` gives a file's text, or null where it is missing.
 */
export function dataFiles(
  def: Pick<WizardDefinition, "data">,
  paths: string[],
): { schema: string; migrations: string[] } | null {
  if (!def.data) {
    return null;
  }
  return {
    schema: def.data.schema,
    migrations: paths.filter((p) => DATA_MIGRATIONS.test(p)).sort(),
  };
}

/** Whether every statement of a SQL file can run: it splits, and none is refused. */
export function dataFileIssues(path: string, text: string): DataFileIssue[] {
  let statements: string[];
  try {
    statements = splitSql(text);
  } catch (err) {
    return [{ path, message: `${path}: ${(err as Error).message}` }];
  }
  if (!statements.length) {
    return [{ path, message: `${path} holds no SQL statement.` }];
  }
  if (statements.length > DATA_LIMITS.fileStatements) {
    return [
      {
        path,
        message: `${path} holds ${statements.length} statements; at most ${DATA_LIMITS.fileStatements}.`,
      },
    ];
  }
  const issues: DataFileIssue[] = [];
  statements.forEach((statement, i) => {
    const why = sqlRefusal(statement);
    if (why) {
      issues.push({ path, message: `${path}, statement ${i + 1}: ${why}` });
    }
  });
  return issues;
}

/**
 * Every SQL file of a wizard's data checked: the schema is in its files and each file splits into
 * statements the runtime runs. `read` gives a file's text, or null where it is not there.
 */
export function wizardDataIssues(
  def: Pick<WizardDefinition, "data">,
  paths: string[],
  read: (path: string) => string | null,
): DataFileIssue[] {
  const files = dataFiles(def, paths);
  if (!files) {
    return [];
  }
  const issues: DataFileIssue[] = [];
  for (const path of [files.schema, ...files.migrations]) {
    const text = read(path);
    if (text !== null) {
      issues.push(...dataFileIssues(path, text));
    }
  }
  return issues;
}
