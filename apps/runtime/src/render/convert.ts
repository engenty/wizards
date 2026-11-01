import type { Format } from "@engenty/wizards-shared/definition";
import HTMLtoDOCX from "@turbodocx/html-to-docx";
import ExcelJS from "exceljs";
import { marked } from "marked";
import TurndownService from "turndown";
import { offlineContext } from "./chromium.js";

/** Elements that turndown writes as blocks of their own, with blank lines around them. */
const BLOCKS = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "DIV",
  "DL",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "HR",
  "LI",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "TABLE",
  "UL",
]);

const holdsBlock = (node: Node): boolean =>
  [...node.childNodes].some((child) => BLOCKS.has(child.nodeName) || holdsBlock(child));

/**
 * A link around blocks (a teaser: a `<div>` with a picture and a heading in one `<a>`) would come
 * out with blank lines inside its brackets, which no Markdown reads as a link. Its content goes
 * on one line instead: `[![Bild](…) Titel](…)`.
 */
function linkBlocks(service: TurndownService): TurndownService {
  return service.addRule("blockLink", {
    filter: (node) =>
      node.nodeName === "A" && Boolean(node.getAttribute("href")) && holdsBlock(node),
    replacement: (text, node) => {
      const inner = text
        .replace(/\s*\n+\s*/g, " ")
        .replace(/(^|\s)#{1,6}\s+/g, "$1")
        .trim();
      if (!inner) {
        return "";
      }
      const el = node as HTMLElement;
      const href = (el.getAttribute("href") ?? "").replace(/([()])/g, "\\$1");
      const title = el.getAttribute("title");
      return `[${inner}](${href}${title ? ` "${title.replace(/"/g, '\\"')}"` : ""})`;
    },
  });
}

const turndown = linkBlocks(new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" }));

export interface Converted {
  data: Uint8Array | string;
  mime: string;
  ext: string;
}

export const MIME: Record<Format, string> = {
  png: "image/png",
  mp4: "video/mp4",
  mp3: "audio/mpeg",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  html: "text/html",
  md: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  json: "application/json",
  zip: "application/zip",
};

/** A calm print stylesheet for documents written as Markdown. */
export function markdownToHtml(markdown: string, title = "Document"): string {
  const body = marked.parse(markdown, { async: false }) as string;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  @page { size: A4; margin: 22mm 20mm; }
  body { font-family: "Inter", "Helvetica Neue", Arial, sans-serif; color: #1d1a17; line-height: 1.55; font-size: 11pt; max-width: 760px; margin: 40px auto; padding: 0 24px; }
  h1 { font-size: 22pt; line-height: 1.2; margin: 0 0 12pt; }
  h2 { font-size: 14pt; margin: 22pt 0 6pt; }
  h3 { font-size: 12pt; margin: 16pt 0 4pt; }
  table { border-collapse: collapse; width: 100%; margin: 10pt 0; font-size: 10pt; }
  th, td { border-bottom: 1px solid #e6e1da; padding: 6pt 8pt; text-align: left; vertical-align: top; }
  th { font-weight: 600; background: #f7f4ef; }
  a { color: #b4532a; }
  blockquote { border-left: 3px solid #e6e1da; margin: 0; padding-left: 12pt; color: #5d564e; }
  code { background: #f4f1ec; padding: 1px 4px; border-radius: 3px; }
  @media print { body { margin: 0; padding: 0; max-width: none; } }
</style></head><body>${body}</body></html>`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function htmlToMarkdown(html: string): string {
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
  return turndown.turndown(
    body.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<script[\s\S]*?<\/script>/gi, ""),
  );
}

// --- a page's content, without what every page of the site has -----------------------------

/** Elements that are a site's frame, never a page's content. */
const FRAME_TAGS = new Set([
  "NAV",
  "FOOTER",
  "ASIDE",
  "FORM",
  "DIALOG",
  "BUTTON",
  "IFRAME",
  "NOSCRIPT",
  "TEMPLATE",
]);
const FRAME_ROLES =
  /^(navigation|banner|contentinfo|search|dialog|alertdialog|complementary|menu|menubar)$/i;
/** Classes and ids of skip links, cookie notices, breadcrumbs and share buttons. */
const FRAME_NAMES =
  /(^|[\s_-])(skip-link|screen-reader-text|cookies?|consent|gdpr|borlabs|breadcrumbs?|share|sharing|social)([\s_-]|$)/i;

const within = (node: Node, names: string[]) => {
  for (let at = node.parentNode; at; at = at.parentNode) {
    if (names.includes(at.nodeName)) {
      return true;
    }
  }
  return false;
};

/** An element of the site's frame: its menus, its header and footer, hidden parts, notices. */
function frame(node: HTMLElement): boolean {
  if (FRAME_TAGS.has(node.nodeName)) {
    return true;
  }
  // A header inside an article or the main part is the content's own heading.
  if (node.nodeName === "HEADER" && !within(node, ["ARTICLE", "MAIN"])) {
    return true;
  }
  const get = (name: string) => node.getAttribute?.(name) ?? "";
  return (
    get("aria-hidden") === "true" ||
    node.hasAttribute?.("hidden") ||
    FRAME_ROLES.test(get("role")) ||
    FRAME_NAMES.test(`${get("class")} ${get("id")}`)
  );
}

// A rule of its own, not `remove`: turndown asks `remove` only of elements no rule converts,
// and links, pictures and headings have rules.
const content = linkBlocks(
  new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" }).addRule("frame", {
    filter: (node) => frame(node),
    replacement: () => "",
  }),
);

/**
 * A web page's content as Markdown: its main part where it marks one (`<main>`,
 * `role="main"`), else its body, without the site's frame — navigation, the site's header and
 * footer, asides, forms, hidden menus, skip links, cookie notices, breadcrumbs.
 */
export function htmlToContent(html: string): string {
  const main =
    html.match(/<main\b[^>]*>([\s\S]*)<\/main>/i)?.[1] ??
    html.match(/<[a-z]+\b[^>]*\brole\s*=\s*["']main["'][^>]*>[\s\S]*/i)?.[0];
  const part = main ?? html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
  return (
    content
      .turndown(part.replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, ""))
      // A link that held only an icon, now gone, shows nothing.
      .replace(/(?<!!)\[\]\([^)\n]*\)/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

// --- a page's pictures ----------------------------------------------------------------------

/** A picture a web page's content shows. */
export interface WebPicture {
  url: string;
  alt: string;
}

/** The largest picture `srcset` offers up to this width; where all are wider, the smallest. */
const MAX_PICTURE_WIDTH = 2000;
/** Drawn smaller than this, a picture is an icon or a bullet, not content. */
const MIN_PICTURE_SIDE = 200;
/** What an address or a class says of an icon, a sprite, a spinner or a tracking pixel. */
const NO_PICTURE =
  /(^|[\s/_.-])(icons?|sprites?|emojis?|spinner|loader|spacer|pixel|tracking)([\s/_.-]|$)/i;

/** An attribute of a tag by its exact name: `src`, not the `src` of `data-src`. */
const attrOf = (tag: string, name: string) =>
  tag
    .match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"))
    ?.slice(2)
    .find((v) => v !== undefined) ?? "";

/** The candidate of a `srcset` to keep, with its width or its density where the set says one. */
function fromSrcset(srcset: string): { url: string; width: number | null; density: number } | null {
  const candidates = srcset
    .split(/,\s+/)
    .map((part) => part.trim().split(/\s+/))
    .filter(([url]) => url)
    .map(([url, d = "1x"]) => ({
      url: url.replace(/,$/, ""),
      w: d.endsWith("w") ? Number.parseInt(d, 10) : null,
      x: d.endsWith("x") ? Number.parseFloat(d) : null,
    }));
  const wide = candidates.filter((c) => c.w).sort((a, b) => (a.w ?? 0) - (b.w ?? 0));
  if (wide.length) {
    const pick = wide.filter((c) => (c.w ?? 0) <= MAX_PICTURE_WIDTH).pop() ?? wide[0];
    return { url: pick.url, width: pick.w, density: 1 };
  }
  const dense = candidates.sort((a, b) => (a.x ?? 1) - (b.x ?? 1)).pop();
  return dense ? { url: dense.url, width: null, density: dense.x ?? 1 } : null;
}

/**
 * A page's `<img>` tags, each pointed at one absolute address: the largest `srcset` entry up to
 * 2000 px, else `src`, or what a lazy loader keeps in `data-srcset`/`data-src`. Icons, sprites,
 * drawings (SVG) and pictures drawn under 200 px on their longer side go: what `htmlToMarkdown` and `htmlToContent`
 * then write as `![alt](url)` is a picture of the page.
 */
export function absolutePictures(html: string, base: string): string {
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    const lazy = (name: string) => attrOf(tag, `data-${name}`) || attrOf(tag, `data-lazy-${name}`);
    const set = fromSrcset(lazy("srcset") || attrOf(tag, "srcset"));
    const plain = lazy("src") || attrOf(tag, "data-original") || attrOf(tag, "src");
    const raw = set?.url || plain;
    let url: URL;
    try {
      url = new URL(raw.trim(), base);
    } catch {
      return "";
    }
    const side = (name: string) => Number.parseInt(attrOf(tag, name), 10);
    // The size it is drawn at, by its longer side, times the density `srcset` offers it in.
    const drawn = Math.max(side("width") || 0, side("height") || 0) * (set?.density ?? 1);
    const tiny = drawn > 0 && drawn < MIN_PICTURE_SIDE && !((set?.width ?? 0) >= MIN_PICTURE_SIDE);
    if (
      !/^https?:$/.test(url.protocol) ||
      /\.(svg|ico)$/i.test(url.pathname) ||
      NO_PICTURE.test(url.pathname) ||
      NO_PICTURE.test(attrOf(tag, "class")) ||
      tiny
    ) {
      return "";
    }
    // Markdown ends an address at `)`.
    const href = url.toString().replace(/\(/g, "%28").replace(/\)/g, "%29");
    return `<img src="${href}" alt="${attrOf(tag, "alt").replace(/"/g, "&quot;")}">`;
  });
}

/** The pictures Markdown shows, each once, in their order. */
export function picturesOf(markdown: string): WebPicture[] {
  const seen = new Map<string, WebPicture>();
  for (const m of markdown.matchAll(/!\[([^\]\n]*)\]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    if (!seen.has(m[2])) {
      seen.set(m[2], { url: m[2], alt: m[1].trim() });
    }
  }
  return [...seen.values()];
}

export async function htmlToPdf(html: string): Promise<Uint8Array> {
  const context = await offlineContext();
  try {
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: "networkidle", timeout: 30_000 });
    return await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true });
  } finally {
    await context.close();
  }
}

export async function htmlToPng(
  html: string,
  width = 1200,
  opts: { height?: number; fullPage?: boolean; scale?: number } = {},
): Promise<Uint8Array> {
  const context = await offlineContext({
    viewport: { width, height: opts.height ?? 900 },
    deviceScaleFactor: opts.scale ?? 2,
  });
  try {
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: "networkidle", timeout: 30_000 });
    return await page.screenshot({ fullPage: opts.fullPage ?? true, type: "png" });
  } finally {
    await context.close();
  }
}

export async function htmlToDocx(html: string): Promise<Uint8Array> {
  const cleaned = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  const out = await HTMLtoDOCX(cleaned, null, {
    table: { row: { cantSplit: true } },
    font: "Arial",
  });
  if (out instanceof ArrayBuffer) {
    return new Uint8Array(out);
  }
  if (typeof Blob !== "undefined" && out instanceof Blob) {
    return new Uint8Array(await out.arrayBuffer());
  }
  return new Uint8Array(out as Buffer);
}

/** The first array of objects inside a JSON value — the table a step produced. */
export function firstTable(value: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(value) && value.every((r) => r && typeof r === "object" && !Array.isArray(r))) {
    return value as Record<string, unknown>[];
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) {
      const t = firstTable(v);
      if (t) {
        return t;
      }
    }
  }
  return null;
}

function tableColumns(rows: Record<string, unknown>[]): string[] {
  return [...new Set(rows.flatMap((r) => Object.keys(r)))];
}

function cell(v: unknown): string {
  return v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
}

export function tableToCsv(rows: Record<string, unknown>[]): string {
  const cols = tableColumns(rows);
  const esc = (s: string) => (/[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return [
    cols.map(esc).join(","),
    ...rows.map((r) => cols.map((c) => esc(cell(r[c]))).join(",")),
  ].join("\n");
}

/** Every table of a step's JSON result, by its key; a bare array is the one table "Data". */
export function allTables(value: unknown): { name: string; rows: Record<string, unknown>[] }[] {
  const isTable = (v: unknown): v is Record<string, unknown>[] =>
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((r) => r && typeof r === "object" && !Array.isArray(r));
  if (isTable(value)) {
    return [{ name: "Data", rows: value }];
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  return Object.entries(value).flatMap(([name, v]) =>
    isTable(v)
      ? [{ name, rows: v }]
      : Array.isArray(v) && v.length && v.every((x) => typeof x !== "object")
        ? [{ name, rows: v.map((x) => ({ [name]: x })) }]
        : [],
  );
}

/** A workbook with one sheet per table. `headers` renames columns (column id → label). */
export async function tablesToXlsx(
  tables: { name: string; rows: Record<string, unknown>[]; headers?: Record<string, string> }[],
): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  for (const [index, table] of tables.entries()) {
    const ws = wb.addWorksheet(
      table.name.replace(/[\\/*?:[\]]/g, " ").slice(0, 31) || `Sheet${index + 1}`,
    );
    const cols = table.headers ? Object.keys(table.headers) : tableColumns(table.rows);
    ws.columns = cols.map((c) => {
      const header = table.headers?.[c] ?? c;
      return { header, key: c, width: Math.min(40, Math.max(12, header.length + 4)) };
    });
    for (const r of table.rows) {
      ws.addRow(
        Object.fromEntries(cols.map((c) => [c, typeof r[c] === "number" ? r[c] : cell(r[c])])),
      );
    }
    ws.getRow(1).font = { bold: true };
  }
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

export function jsonToMarkdown(value: unknown): string {
  const rows = firstTable(value);
  if (rows?.length) {
    const cols = tableColumns(rows);
    const head = `| ${cols.join(" | ")} |\n| ${cols.map(() => "---").join(" | ")} |`;
    const body = rows.map(
      (r) => `| ${cols.map((c) => cell(r[c]).replace(/\|/g, "\\|")).join(" | ")} |`,
    );
    return [head, ...body].join("\n");
  }
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}
