// Passages of a file for the search: what one hit points at and what an embedding stands for.
// Paragraphs are gathered up to MAX_CHARS, a markdown heading starts a new passage and names it,
// and a table repeats its header row in each passage. As engenty wizards' paragraph chunks
// (apps/runtime/src/engenty/search-index/chunks.ts), with the line each passage starts on, so a
// hit opens the file there.

export interface Chunk {
  /** The heading the passage stands under, if any. */
  heading: string | null;
  /** The line it starts on, 1-based (for HTML: of the page's text). */
  line: number;
  text: string;
}

export const MAX_CHARS = 1200;

/** An HTML page's text, a line per block, without its scripts and styles. */
export const htmlText = (html: string) =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/(p|div|h\d|li|tr|section|article|header|footer|br)\s*>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n");

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/** Prose: paragraphs up to MAX_CHARS, a new passage at each heading (markdown). */
function proseChunks(text: string, markdown: boolean): Chunk[] {
  const lines = text.split("\n");
  const out: Chunk[] = [];
  let heading: string | null = null;
  let buffer: string[] = [];
  let start = 1;
  let fence = false;
  const flush = () => {
    const body = buffer.join("\n").trim();
    if (body) {
      out.push({ heading, line: start, text: body });
    }
    buffer = [];
  };
  lines.forEach((line, i) => {
    if (markdown && /^(```|~~~)/.test(line.trim())) {
      fence = !fence;
    }
    const h = markdown && !fence ? HEADING.exec(line) : null;
    if (h) {
      flush();
      heading = (h[2] ?? "").replace(/[*_`]/g, "");
      start = i + 2;
      return;
    }
    const size = buffer.reduce((n, l) => n + l.length + 1, 0);
    // A paragraph ends at a blank line; a long run of lines (a list, a table) at MAX_CHARS.
    if (size + line.length > MAX_CHARS && buffer.length) {
      flush();
    }
    if (!buffer.length) {
      if (!line.trim()) {
        return;
      }
      start = i + 1;
    }
    if (!line.trim() && size > MAX_CHARS / 2) {
      flush();
      return;
    }
    // A single line longer than a passage (minified HTML, a long cell) is cut.
    for (let at = 0; at < Math.max(line.length, 1); at += MAX_CHARS) {
      if (at > 0) {
        flush();
        start = i + 1;
      }
      buffer.push(line.slice(at, at + MAX_CHARS));
    }
  });
  flush();
  return out;
}

/** A table: rows up to MAX_CHARS, each passage under the header row. */
function tableChunks(text: string): Chunk[] {
  const lines = text.split("\n");
  const header = lines[0] ?? "";
  const out: Chunk[] = [];
  let rows: string[] = [];
  let start = 2;
  const flush = () => {
    if (rows.length) {
      out.push({
        heading: null,
        line: start,
        text: [header, ...rows].join("\n"),
      });
    }
    rows = [];
  };
  lines.slice(1).forEach((row, i) => {
    if (!row.trim()) {
      return;
    }
    if (rows.reduce((n, r) => n + r.length + 1, header.length) + row.length > MAX_CHARS) {
      flush();
    }
    if (!rows.length) {
      start = i + 2;
    }
    rows.push(row.slice(0, MAX_CHARS));
  });
  flush();
  return out.length || !header.trim() ? out : [{ heading: null, line: 1, text: header }];
}

/** The passages of a text file, by its extension. */
export function chunksOf(ext: string, text: string): Chunk[] {
  if (ext === "csv" || ext === "tsv") {
    return tableChunks(text);
  }
  if (ext === "html" || ext === "htm") {
    return proseChunks(htmlText(text), false);
  }
  return proseChunks(text, ext === "md");
}
