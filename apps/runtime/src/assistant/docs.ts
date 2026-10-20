import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The user guide and the plugin guide (docs/content), as the studio assistant reads them: bundled
 * with each release (the build copies them to dist/docs), so an answer matches the installed
 * version. Links point to engenty.ai/docs.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SITE = "https://engenty.ai/docs";

/** Built: dist/docs. From source: the repo's docs/content. */
function contentDir(): string | null {
  for (const dir of [
    join(here, "..", "docs"),
    join(here, "..", "..", "..", "..", "docs", "content"),
  ]) {
    if (existsSync(join(dir, "user-guide"))) {
      return dir;
    }
  }
  return null;
}

export interface DocPage {
  /** Its path below docs/content without the extension: `user-guide/steps`, `dev/plugins/tools`. */
  id: string;
  title: string;
  description: string;
  url: string;
  text: string;
  sections: { heading: string; text: string }[];
}

let pages: DocPage[] | null = null;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(join(dir, entry.name))
      : /\.mdx?$/.test(entry.name)
        ? [join(dir, entry.name)]
        : [],
  );
}

function parse(root: string, file: string): DocPage {
  const raw = readFileSync(file, "utf8");
  const front = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  const meta = Object.fromEntries(
    (front?.[1] ?? "")
      .split("\n")
      .map((line) => line.match(/^(\w+):\s*(.*)$/))
      .filter((m): m is RegExpMatchArray => Boolean(m))
      .map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]),
  );
  const text = raw
    .slice(front?.[0].length ?? 0)
    // Pictures say nothing to the assistant; their alt text stays.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "($1)")
    .trim();
  const id = relative(root, file)
    .replace(/\\/g, "/")
    .replace(/\.mdx?$/, "");
  const sections: DocPage["sections"] = [];
  let heading = meta.title ?? id;
  let lines: string[] = [];
  for (const line of text.split("\n")) {
    const h = line.match(/^#{2,3}\s+(.*)$/);
    if (h) {
      if (lines.join("").trim()) {
        sections.push({ heading, text: lines.join("\n").trim() });
      }
      heading = h[1].trim();
      lines = [];
    } else {
      lines.push(line);
    }
  }
  if (lines.join("").trim()) {
    sections.push({ heading, text: lines.join("\n").trim() });
  }
  return {
    id,
    title: meta.title ?? id,
    description: meta.description ?? "",
    url: `${SITE}/${id.replace(/\/index$/, "")}`,
    text,
    sections,
  };
}

/** Every page of the guides; read once. */
export function docPages(): DocPage[] {
  if (!pages) {
    const root = contentDir();
    pages = root ? walk(root).map((file) => parse(root, file)) : [];
  }
  return pages;
}

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");

function termsOf(query: string): string[] {
  return [
    ...new Set(
      fold(query)
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length >= 3),
    ),
  ];
}

function count(hay: string, term: string): number {
  let n = 0;
  for (let at = hay.indexOf(term); at >= 0; at = hay.indexOf(term, at + term.length)) {
    n++;
  }
  return n;
}

/** The sections of the guides that speak most of the query's words, best first. */
export function searchDocs(query: string, limit = 6) {
  const terms = termsOf(query);
  if (!terms.length) {
    return [];
  }
  const hits: { page: DocPage; heading: string; text: string; score: number }[] = [];
  for (const page of docPages()) {
    const title = fold(`${page.title} ${page.description}`);
    for (const section of page.sections) {
      const heading = fold(section.heading);
      const body = fold(section.text);
      let score = 0;
      let matched = 0;
      for (const term of terms) {
        const found = count(title, term) * 3 + count(heading, term) * 4 + count(body, term);
        if (found) {
          matched++;
          score += Math.log(1 + found);
        }
      }
      if (matched) {
        hits.push({ page, heading: section.heading, text: section.text, score: score * matched });
      }
    }
  }
  return hits
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((h) => ({
      page: h.page.id,
      title: h.page.title,
      section: h.heading,
      url: h.page.url,
      excerpt: h.text.slice(0, 700),
    }));
}

/** One page of the guides, from character `from` on. */
export function readDoc(id: string, from = 0, size = 14_000) {
  const wanted = id
    .replace(/^https?:\/\/[^/]+\/docs\//, "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.mdx?$/, "");
  const page =
    docPages().find((p) => p.id === wanted) ??
    docPages().find((p) => p.id === `${wanted}/index`) ??
    docPages().find((p) => p.id.endsWith(`/${wanted}`));
  if (!page) {
    return {
      error: `No page "${id}".`,
      pages: docPages().map((p) => `${p.id}: ${p.title}`),
    };
  }
  const start = Math.max(0, Math.min(from, page.text.length));
  return {
    page: page.id,
    title: page.title,
    url: page.url,
    text: page.text.slice(start, start + size),
    next: start + size < page.text.length ? start + size : null,
  };
}
