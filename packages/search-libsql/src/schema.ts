import type { Client } from "@libsql/client";

// The index's tables, all under the `search_` prefix: a row per file, a row per
// passage (with its vector and, for a PDF page, a thumbnail), and the full-text
// index over the passages, whose rowid is the passage's id.

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS search_file (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    version TEXT NOT NULL,
    embedded TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS search_chunk (
    id INTEGER PRIMARY KEY,
    file_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    heading TEXT,
    line INTEGER NOT NULL,
    page INTEGER,
    text TEXT NOT NULL,
    vector BLOB,
    thumb BLOB
  )`,
  "CREATE INDEX IF NOT EXISTS search_chunk_file ON search_chunk (file_id)",
  // The path is indexed too, so a folder's name finds its files; it weighs
  // most, then headings.
  `CREATE VIRTUAL TABLE IF NOT EXISTS search_text USING fts5(
    path, heading, body, tokenize = 'unicode61 remove_diacritics 2'
  )`,
];

/** Creates the index's tables where they are missing; safe to run on every start. */
export async function migrate(db: Client): Promise<void> {
  for (const sql of SCHEMA) {
    await db.execute(sql);
  }
}
