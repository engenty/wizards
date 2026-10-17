// SPDX-License-Identifier: FSL-1.1-MIT OR MIT
import { coerceRowValues, mergeRowValues, type TableColumn } from "./engenty/data-tables/index.js";
import { readNumber } from "./numbers.js";

/**
 * What a wizard keeps between runs for one person: lists (tabular data), files and connected
 * accounts. The wizard definition says which lists and connections exist; the content belongs
 * to the person who ran it.
 */

/** A list is an engenty data table: typed columns, rows of cells keyed by column id. */
export interface ListDef {
  id: string;
  title: string;
  description?: string;
  columns: TableColumn[];
  /** Column whose value identifies a row: saving a row with a known key updates it. */
  key?: string;
  /**
   * The rows are gone through one by one in a review: `file` holds the path of a kept file
   * shown beside the row, `status` is a select whose options are the answers (first = open).
   */
  check?: { file?: string; status?: string };
  /** Every run reads and writes the same rows; kept as a table of the space, not per person. */
  shared?: boolean;
}

export interface ListRow {
  id: string;
  cells: Record<string, unknown>;
  updatedAt: string;
}

export interface StoreFile {
  path: string;
  mime: string;
  size: number;
  /** Where the file came from, in words: "E-Mail von billing@notion.so, 3.9.2026". */
  source: string | null;
  updatedAt: string;
}

export const STORE_LIMITS = {
  fileBytes: 15_000_000,
  totalBytes: 200_000_000,
  files: 2000,
  rowsPerList: 5000,
};

/** Kinds of accounts a wizard can ask the person to connect. */
export const CONNECTION_KINDS = ["mail"] as const;
export type ConnectionKind = (typeof CONNECTION_KINDS)[number];

/** An account the person connects: a built-in kind, or one of the project's imported connectors. */
export interface ConnectionDef {
  id: string;
  kind?: ConnectionKind;
  /** Id of an imported connector of the project. */
  connector?: string;
  /** Imported connectors: the actions steps may call. Default: every action that only reads. */
  actions?: string[];
  /**
   * Imported connectors: per action, run it without asking ("allow") or ask the person first
   * ("ask"). Default: reading is allowed, changing asks; deleting always asks.
   */
  policy?: Record<string, "allow" | "ask">;
  title?: string;
  description?: string;
}

/** A connector the person can pick for a connection: an OAuth sign-in or a credentials form. */
export interface ConnectorOption {
  id: string;
  name: string;
  auth: "oauth2" | "api_key";
  /** `api_key` connectors: the form, in order. */
  fields?: {
    key: string;
    label: string;
    secret?: boolean;
    placeholder?: string;
    required?: boolean;
  }[];
  /** Shown under the form: where to get the values. */
  hint?: string;
}

export interface ConnectionView {
  id: string;
  kind: ConnectionKind | null;
  /** The imported connector behind the connection, if it is one. */
  connector: string | null;
  title: string | null;
  description: string | null;
  /** Set when the person has connected an account. */
  account: { connector: string; label: string; connectedAt: string } | null;
  connectors: ConnectorOption[];
}

/** One list as a Markdown table of raw cell values — what a model reads. */
export function listAsMarkdown(def: ListDef, rows: ListRow[], limit = 200): string {
  if (!rows.length) {
    return "(empty)";
  }
  const cols = def.columns;
  const cell = (v: unknown) =>
    v === null || v === undefined
      ? ""
      : (Array.isArray(v) ? v.join(", ") : String(v)).replace(/\|/g, "\\|").replace(/\s+/g, " ");
  const head = `| ${cols.map((c) => c.id).join(" | ")} |\n|${cols.map(() => " --- ").join("|")}|`;
  const body = rows
    .slice(0, limit)
    .map((r) => `| ${cols.map((c) => cell(r.cells[c.id])).join(" | ")} |`);
  const more = rows.length > limit ? [`… ${rows.length - limit} more rows`] : [];
  return [head, ...body, ...more].join("\n");
}

/**
 * When the first row saved now is stamped, in milliseconds: after every row the list already
 * holds, so a list reads in the order its rows came — also when two saves fall in one
 * millisecond. The rows of one save follow it a millisecond apart.
 */
export function firstRowAt(existing: { createdAt: Date }[]): number {
  return existing.reduce((at, row) => Math.max(at, row.createdAt.getTime() + 1), Date.now());
}

/** The key a row is matched on: trimmed and lower-cased, so "Notion " and "notion" are one row. */
export function rowKey(def: ListDef, cells: Record<string, unknown>): string | null {
  if (!def.key) {
    return null;
  }
  const raw = cells[def.key];
  const key = raw === null || raw === undefined ? "" : String(raw).trim().toLowerCase();
  return key || null;
}

/** A new row's cells, typed by the list's columns. Throws `TableColumnValueError` on a bad value. */
export function newCells(def: ListDef, input: Record<string, unknown>): Record<string, unknown> {
  return coerceRowValues(def.columns, input);
}

/** An existing row's cells with some columns changed; cells of columns the list no longer has are dropped. */
export function patchCells(
  def: ListDef,
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const known = new Set(def.columns.map((c) => c.id));
  const kept = Object.fromEntries(Object.entries(current).filter(([id]) => known.has(id)));
  return mergeRowValues(def.columns, kept, patch);
}

/**
 * What a person typed into a cell, as the value sent for its column; the runtime still checks it
 * against the column. Blank is null; a number or a duration (in the column's input unit) is read
 * as people write it ("12,5"); a date and time from the browser's picker, in local time, becomes
 * ISO. What cannot be read goes as typed, for the runtime to refuse and name.
 */
export function cellValue(column: TableColumn, text: string): unknown {
  if (text.trim() === "") {
    return null;
  }
  switch (column.type) {
    case "number":
    case "duration":
      return readNumber(text) ?? text;
    case "boolean":
      return text === "true";
    case "date": {
      if (column.format.kind !== "datetime") {
        return text;
      }
      const at = new Date(text);
      return Number.isNaN(at.getTime()) ? text : at.toISOString();
    }
    default:
      return text;
  }
}
