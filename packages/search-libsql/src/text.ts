// Words and snippets: how a query is cut into terms, and how a passage is cut
// down to the lines a result shows.

/** About three lines of the search's results. */
const SNIPPET = 360;
/** How many words of a query count. */
const MAX_TERMS = 8;
/** How much of the line before the first word found a cut snippet keeps. */
const LEAD = 60;

/** Lower case without accents, as the tokenizer sees it: "Österreich" finds "osterreich". */
export const fold = (s: string): string => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** A query's words as the full-text index sees them. */
export const termsOf = (query: string): string[] =>
  (fold(query).match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, MAX_TERMS);

export const nameOf = (path: string): string => path.split("/").pop() ?? path;

/** A file's name as words: "aWATTar-onboarding_2.jpg" → "aWATTar onboarding 2". */
export const nameWords = (path: string): string =>
  nameOf(path)
    .replace(/\.[^.]+$/, "")
    .replace(/[-_.]+/g, " ")
    .trim();

/** A file's extension, lower case, without the dot. */
export const extOf = (path: string): string => {
  const name = nameOf(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

/**
 * A line as plain text for a snippet: no markdown marks, links and images as
 * their text, a table row's cells with dots between them.
 */
export const plain = (line: string): string =>
  line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(?:[-*+]|\d+[.)]|#{1,6}|>)\s+/, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .replace(/\s*\|\s*/g, " · ")
    .replace(/\s+/g, " ")
    .trim();

/** The line of a passage a snippet starts at: every word, else any, else the first line. */
function lineOf(lines: string[], terms: string[]): number {
  const has = (line: string, every: boolean) => {
    const f = fold(line);
    return every ? terms.every((t) => f.includes(t)) : terms.some((t) => f.includes(t));
  };
  if (terms.length) {
    const all = lines.findIndex((l) => has(l, true));
    if (all >= 0) {
      return all;
    }
    const any = lines.findIndex((l) => has(l, false));
    if (any >= 0) {
      return any;
    }
  }
  // Found by meaning: the passage's start.
  return Math.max(
    0,
    lines.findIndex((l) => l.trim()),
  );
}

/** The best place in a passage for the query, cut around the first word found. */
export function snippet(text: string, terms: string[]): { at: number; text: string } {
  const lines = text.split("\n");
  const at = lineOf(lines, terms);
  // The line found, and what follows it in the passage, up to a snippet's length.
  let line = plain(lines[at] ?? "");
  for (let i = at + 1; i < lines.length && line.length < SNIPPET; i++) {
    const next = plain(lines[i] ?? "");
    if (next) {
      line = `${line} ${next}`;
    }
  }
  if (line.length <= SNIPPET) {
    return { at, text: line };
  }
  // Longer, it is cut around the first word found, at spaces, so it starts
  // and ends with whole words.
  const found = terms.map((t) => fold(line).indexOf(t)).filter((i) => i >= 0);
  const first = found.length ? Math.min(...found) : 0;
  let from = Math.max(0, first - LEAD);
  from = from > 0 ? line.lastIndexOf(" ", from) + 1 : 0;
  let to = Math.min(line.length, from + SNIPPET);
  if (to < line.length) {
    to = Math.max(line.lastIndexOf(" ", to), first + 1);
  }
  const head = from > 0 ? "…" : "";
  const tail = to < line.length ? "…" : "";
  return { at, text: `${head}${line.slice(from, to).trim()}${tail}` };
}
