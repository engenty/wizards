// SPDX-License-Identifier: FSL-1.1-MIT OR MIT
import { type Lang, localeOf } from "./definition.js";

/**
 * A line with a form for each plural category of its `{count}` (or `{n}`, `Intl.PluralRules`):
 * "one" and "other" in English and German, more in languages that need them.
 */
export interface Plural {
  zero?: string;
  one?: string;
  two?: string;
  few?: string;
  many?: string;
  other: string;
}

/** A line of a string table: plain, or with plural forms. */
export type Line = string | Plural;

/**
 * A string table: each language's lines by key. English has every line; another language may
 * lack some, and those are said in English. A new language needs only its own table.
 */
export type Texts<K extends string> = { en: Record<K, Line> } & {
  [L in Exclude<Lang, "en">]: Partial<Record<K, Line>>;
};

/** What fills a line's gaps: words, a number (written the language's way), or a list of them. */
export type Gap = string | number | readonly Gap[];

const plurals = new Map<string, Intl.PluralRules>();

/** The plural rules of a language: any language, by its code. */
export function pluralRules(lang: string): Intl.PluralRules {
  let rules = plurals.get(lang);
  if (!rules) {
    rules = new Intl.PluralRules(localeOf(lang));
    plurals.set(lang, rules);
  }
  return rules;
}

function form(line: Line, lang: string, count: unknown): string {
  if (typeof line === "string") {
    return line;
  }
  if (typeof count !== "number") {
    return line.other;
  }
  return line[pluralRules(lang).select(count)] ?? line.other;
}

/** A gap's words in a language: numbers as the language writes them, lists joined. */
export function gapText(value: Gap, lang: string): string {
  if (typeof value === "number") {
    return value.toLocaleString(localeOf(lang));
  }
  if (Array.isArray(value)) {
    return value.map((item) => gapText(item, lang)).join(", ");
  }
  return value as string;
}

/** Fills `{name}` gaps; a gap with nothing for it stays as it is. */
export function fillGaps(
  text: string,
  lang: string,
  params?: Record<string, Gap | undefined>,
): string {
  return text.replace(/\{(\w+)\}/g, (gap, key: string) => {
    const value = params?.[key];
    return value === undefined ? gap : gapText(value, lang);
  });
}

/**
 * A line of a table in a language, its gaps filled and its plural form picked by `{count}`
 * (or `{n}`);
 * the English line where the language lacks one.
 */
export function textOf<K extends string>(
  texts: Texts<K>,
  key: K,
  lang: Lang,
  params?: Record<string, Gap | undefined>,
): string {
  const line = (texts[lang] as Partial<Record<K, Line>>)[key] ?? texts.en[key];
  if (line === undefined) {
    return key;
  }
  return fillGaps(form(line, lang, params?.count ?? params?.n), lang, params);
}

/**
 * A string table of one language outside `LANGS`, translated on request: lines by key, a plural
 * line with the forms of that language's plural categories.
 */
export type TextTable = Record<string, Line>;

/** A line of a table, in a language: its gaps filled and its plural form picked. */
export function lineText(
  line: Line,
  lang: string,
  params?: Record<string, Gap | undefined>,
): string {
  return fillGaps(form(line, lang, params?.count ?? params?.n), lang, params);
}
