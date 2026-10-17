import { z } from "zod";

/**
 * Knowledge: what a space holds for its wizards' steps to look up. Pages (Markdown, with sub-pages),
 * tables (typed columns; FAQ is a format of one) and files that could not be read into either.
 * Categories run across all of them: typed properties a step filters on before it searches.
 */

export const CATEGORY_TYPES = ["choice", "date", "number", "text", "boolean"] as const;
export type CategoryType = (typeof CATEGORY_TYPES)[number];

/** A value of a choice, how many items have it, and whether it has a summary. */
export interface CategoryValueInfo {
  id: string;
  value: string;
  count: number;
  summary: boolean;
}

export interface SpaceCategory {
  id: string;
  name: string;
  type: CategoryType;
  /** A number's unit: `h`, `€`, `kg`. */
  unit: string | null;
  /** A choice: several values per item. */
  multiple: boolean;
  /** A choice whose values are ranked: their order is the rank. */
  ordered: boolean;
  /** Where its values come from, in a few words. */
  hint: string | null;
  /** The plugin that brought it. */
  origin: string | null;
  /** Proposed, not taken yet: never filled until a person takes it. */
  proposed: boolean;
  /** A column of a table whose cells are its values. */
  tableId: string | null;
  columnId: string | null;
  /** How many items have it. */
  count: number;
  /** A choice's values, in their order. */
  values: CategoryValueInfo[];
  /** A date's or a number's lowest and highest value (a date as `YYYY-MM-DD`). */
  range: { min: string | number; max: string | number } | null;
  /** Pairs of values that look like one written two ways ("Graz-Süd", "Graz Süd"), by id. */
  alike: [string, string][];
}

/** A value as an item has it: a choice's value, a date as `YYYY-MM-DD`, a number, a text, yes/no. */
export type CategoryCell = string | number | boolean;

/** What an item has of one category. */
export interface ItemCategory {
  categoryId: string;
  /** A choice with several values has several. */
  values: CategoryCell[];
  by: "person" | "origin" | "model";
}

/** What a writer sets: by the category's name; a list for a choice with several values. */
export type CategoryInput = Record<string, CategoryCell | CategoryCell[] | null>;

export type KnowledgeKind = "page" | "table" | "file";

/** An item of Knowledge, as lists show it. Sub-pages stand under their page, not in the list. */
export interface KnowledgeItem {
  /** `p:<id>`, `t:<id>`, `f:<id>`. */
  key: string;
  kind: KnowledgeKind;
  id: string;
  title: string;
  /** How a step names it: `pages/handbuch/montage`, `tables/kettenprogramm`, `files/plan.dwg`. */
  path: string;
  /** A page's sub-pages. */
  children: number;
  /** A table's rows. */
  rows: number | null;
  format: "faq" | null;
  /** What wrote it: a plugin's id and what it calls the source; null when a person did. */
  origin: string | null;
  originLabel: string | null;
  /** A person changed what its origin wrote: the origin no longer writes it. */
  kept: boolean;
  /** Why a person should look at it; null when nothing is in doubt. */
  review: string | null;
  /** The file it was read from. */
  fileId: string | null;
  /** A file still being read, or that could not be read. */
  status: "pending" | "ready" | "failed";
  categories: ItemCategory[];
  updatedAt: string;
}

export interface Knowledge {
  items: KnowledgeItem[];
  categories: SpaceCategory[];
  /** The index finds by meaning too, not by keywords alone. */
  embeddings: boolean;
  /** A classifier checks what a search found. */
  checked: boolean;
}

/** A value of a choice, opened: its summary and its table of contents, the items that have it. */
export interface KnowledgeValue {
  id: string;
  value: string;
  category: { id: string; name: string };
  summary: string | null;
  summaryAt: string | null;
  /** Pages (sub-pages too), tables and files that have the value. */
  items: KnowledgeItem[];
  /** Rows of tables that have it, by table. */
  rows: { tableId: string; title: string; count: number }[];
}

/** A page with what Knowledge knows about it, as the studio opens it. */
export interface KnowledgePage {
  id: string;
  path: string;
  /** Its ancestors, outermost first. */
  parents: { id: string; title: string }[];
  children: { id: string; title: string; path: string }[];
  categories: ItemCategory[];
  origin: string | null;
  originLabel: string | null;
  kept: boolean;
  review: string | null;
  file: { id: string; name: string; mime: string } | null;
}

// --- filters --------------------------------------------------------------------

/**
 * A filter on one category: a value (a choice is it, a text equals it, yes/no), one of several,
 * or a range — numbers by `gte`/`lte`, dates by `after`/`before` (`YYYY-MM-DD`, both ends
 * included), a text by `contains`, an ordered choice by `atLeast`.
 */
export const whereValueSchema = z.union([
  z.string().max(200),
  z.number(),
  z.boolean(),
  z.array(z.union([z.string().max(200), z.number()])).max(50),
  z
    .object({
      gte: z.number().optional(),
      lte: z.number().optional(),
      after: z.string().max(40).optional(),
      before: z.string().max(40).optional(),
      contains: z.string().max(200).optional(),
      atLeast: z.string().max(200).optional(),
    })
    .strict(),
]);
export type WhereValue = z.infer<typeof whereValueSchema>;

/** Filters by the category's name; an item matches all of them. */
export const whereSchema = z.record(z.string().max(120), whereValueSchema);
export type Where = z.infer<typeof whereSchema>;

// --- search ---------------------------------------------------------------------

export interface KnowledgeHit {
  /** `p:<id>`, `t:<id>` (a row of it), `f:<id>`, `v:<id>` (a value's summary), `d:<id>` (a
   * document read before Knowledge had pages), `x:<plugin>:<key>` (a plugin's text). */
  key: string;
  kind: KnowledgeKind | "summary" | "document" | "plugin";
  /** What the studio opens for it: `p:`, `t:` (a row's table), `f:`, `v:`; null for a plugin's text. */
  open: string | null;
  path: string;
  title: string;
  /** The categories as `name: value`. */
  categories: string[];
  /** The best section's headings, outermost first, joined by " › ". */
  heading: string | null;
  /** The page of the original it stands on. */
  sheet: number | null;
  /** A row of a table: its id. */
  rowId: string | null;
  text: string;
  /** P(relevant) the classifier gave; null when nothing checked it. */
  relevance: number | null;
  /** Where the studio shows a plugin's text. */
  link: string | null;
  plugin: string | null;
}

export interface KnowledgeSearch {
  hits: KnowledgeHit[];
  /** How many units the keywords and the vectors found together, before the classifier. */
  candidates: number;
  /** A classifier judged the candidates; false: they keep the order the index gave them. */
  checked: boolean;
  /** Items the filter left, when there was one. */
  filtered: number | null;
}

/** A day as `YYYY-MM-DD` from what a person or a source wrote: ISO, `14.03.2026`, a timestamp. */
export function dayOf(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  if (typeof value !== "string") {
    return null;
  }
  const s = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) {
    return `${iso[1]}-${iso[2]}-${iso[3]}`;
  }
  const de = /^(\d{1,2})\.(\d{1,2})\.(\d{2,4})/.exec(s);
  if (de) {
    const year = de[3].length === 2 ? `20${de[3]}` : de[3];
    return `${year}-${de[2].padStart(2, "0")}-${de[1].padStart(2, "0")}`;
  }
  return null;
}

/** A slug for a path: lower case, `-` between words, umlauts spelled out. */
export function slugOf(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/ä/g, "ae")
      .replace(/ö/g, "oe")
      .replace(/ü/g, "ue")
      .replace(/ß/g, "ss")
      .replace(/§/g, "p")
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/, "") || "page"
  );
}
