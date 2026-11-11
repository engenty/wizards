import { readXlsxWorkbook } from "../engenty/csv-import/xlsx-workbook.js";
import {
  joinPagesWithBreaks,
  splitMarkdownByPageBreaks,
} from "../engenty/doc-converter/page-break.js";
import { LocalProvider } from "../engenty/doc-converter/providers/local/index.js";
import { onDemand } from "../on-demand.js";
import { OCR_TYPES, OcrProvider } from "./ocr.js";

/**
 * Reading a document without a model: a PDF's own text page by page and its scanned pages by OCR,
 * a picture by OCR, Word and old Word files, Excel workbooks as tables. The libraries it takes
 * (PDF.js, PDFium and Tesseract, mammoth, exceljs) are the heavy part of reading; what a model
 * does with a file (documents/parse.ts) stays out of here.
 *
 * The runtime runs it in its own process, with its on-demand libraries, or the documents service
 * does (apps/documents), which runs this very file: documents/service.ts picks. So nothing here
 * reads the runtime's settings or touches a database, and everything it imports does the same.
 */

/** A document as text a model can read. */
export interface ParsedDocument {
  markdown: string;
  pages: number | null;
  /** How it was read: its own text, OCR or a vision model (scan, photo), a table, or a mail. */
  via: "text" | "ocr" | "vision" | "table" | "mail";
}

export const PDF = "application/pdf";
export const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const WORD97 = "application/msword";
export const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const local = new LocalProvider();

/** The pictures OCR reads. */
export const OCR_IMAGES = OCR_TYPES.filter((type) => type.startsWith("image/"));

/** The types read here; the rest (text, tables as CSV, web pages, mails) the runtime reads itself. */
export const readsOwn = (mime: string) =>
  mime === PDF || mime === DOCX || mime === WORD97 || mime === XLSX || OCR_IMAGES.includes(mime);

/** A page with fewer letters than this is a scan, and so is a picture. */
export const SCAN_LETTERS = 60;
export const letters = (markdown: string) =>
  markdown.replace(/<page-break[^>]*><\/page-break>|\s/g, "").length;

export class UnsupportedType extends Error {}

export interface DocumentInput {
  data: Uint8Array;
  name: string;
  /** As documentMime (documents/parse.ts) made it: never "octet-stream" for a type read here. */
  mime: string;
}

/** What reads a document's own text: in this process, or the documents service over HTTP. */
export interface DocumentReader {
  /**
   * A document of `readsOwn` as text. A picture whose OCR found nothing comes back empty, with
   * `via: "ocr"`: whether a vision model looks at it is the caller's call.
   */
  read(input: DocumentInput, opts?: { signal?: AbortSignal }): Promise<ParsedDocument>;
}

/** Reads in this process. `tessdata`: where Tesseract's models are kept and downloaded to. */
export function ownReader(tessdata: string): DocumentReader {
  const ocr = new OcrProvider(tessdata);
  /** OCR that doesn't work (no models without the internet, a broken file) reads nothing. */
  const ocrPages = (data: Uint8Array, name: string, pages?: number[]) =>
    ocr.pages(data, pages).catch((err) => {
      console.error("[ocr]", name, err);
      return new Map<number, string>();
    });

  return {
    async read({ data, name, mime }) {
      if (OCR_IMAGES.includes(mime)) {
        const text = [...(await ocrPages(data, name)).values()].join("\n\n");
        return { markdown: text, pages: 1, via: "ocr" };
      }
      if (mime === PDF) {
        const own = await local.convert(data, name, mime);
        const total = own.metadata.page_count ?? 0;
        const byPage = new Map(
          splitMarkdownByPageBreaks(own.markdown).map((page) => [page.number, page.markdown]),
        );
        // Pages with hardly any text of their own are scans: OCR reads them.
        const scanned = Array.from({ length: total }, (_, i) => i + 1).filter(
          (n) => letters(byPage.get(n) ?? "") < SCAN_LETTERS,
        );
        let via: ParsedDocument["via"] = "text";
        for (const [n, text] of scanned.length ? await ocrPages(data, name, scanned) : []) {
          if (letters(text) > letters(byPage.get(n) ?? "")) {
            byPage.set(n, text);
            via = "ocr";
          }
        }
        const markdown =
          via === "ocr"
            ? joinPagesWithBreaks(
                [...byPage]
                  .sort(([a], [b]) => a - b)
                  .map(([number, text]) => ({ number, markdown: text })),
                total,
              )
            : own.markdown;
        return { markdown, pages: total || null, via };
      }
      if (mime === WORD97) {
        return { markdown: await readWord97(data), pages: null, via: "text" };
      }
      if (mime === DOCX) {
        return {
          markdown: (await local.convert(data, name, mime)).markdown,
          pages: null,
          via: "text",
        };
      }
      if (mime === XLSX) {
        const workbook = await readXlsxWorkbook(data);
        const sheets = workbook.sheets
          .filter((s) => s.matrix.rows.length)
          .map((s) => `## ${s.name}\n\n${tableMarkdown(s.matrix.columns, s.matrix.rows)}`);
        return { markdown: sheets.join("\n\n"), pages: null, via: "table" };
      }
      throw new UnsupportedType(`${mime || "This type"} isn’t read here.`);
    },
  };
}

/** Old Word files (Word 97–2003): their body, headers and footnotes. */
async function readWord97(data: Uint8Array): Promise<string> {
  const { default: WordExtractor } = await onDemand<{ default: typeof import("word-extractor") }>(
    "word-extractor",
  );
  const doc = await new WordExtractor().extract(Buffer.from(data));
  return [
    doc.getHeaders({ includeFooters: false }),
    doc.getBody(),
    doc.getFootnotes(),
    doc.getFooters(),
  ]
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");
}

export function tableMarkdown(columns: string[], rows: string[][], limit = 400): string {
  const cell = (v: string) => v.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
  const head = `| ${columns.map(cell).join(" | ")} |\n|${columns.map(() => " --- ").join("|")}|`;
  const body = rows.slice(0, limit).map((r) => `| ${r.map(cell).join(" | ")} |`);
  const more = rows.length > limit ? [`\n… ${rows.length - limit} more rows`] : [];
  return [head, ...body, ...more].join("\n");
}

// --- the documents service's wire (apps/documents/src/server.ts, documents/service.ts) --------

/**
 * `POST /read`: the body is the document, `content-type` its type, this header its name
 * (URI-encoded). `POST /fetch` with `{ url, name, mime }`: the service fetches the document
 * itself, from an address it was set up to trust (a signed link). Both answer a ParsedDocument.
 */
export const DOCUMENT_NAME_HEADER = "x-document-name";

/** What the service answers when it can't: `{ error, message }`. */
export interface DocumentsErrorBody {
  error:
    | "unauthorized"
    | "forbidden"
    | "not-found"
    | "too-large"
    | "unsupported"
    | "unreadable"
    | "bad-request"
    | "failed";
  message?: string;
}
