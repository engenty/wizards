import type { Format } from "@engenty-wizards/shared/definition";
import HTMLtoDOCX from "@turbodocx/html-to-docx";
import ExcelJS from "exceljs";
import { marked } from "marked";
import TurndownService from "turndown";
import { offlineContext } from "./chromium.js";

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

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
