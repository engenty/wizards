import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { note } from "@engenty-wizards/shared/run";
import { generateText, Output } from "ai";
import PostalMime from "postal-mime";
import { z } from "zod";
import { parseCsvMatrix } from "../engenty/csv-import/csv-matrix.js";
import { readXlsxWorkbook } from "../engenty/csv-import/xlsx-workbook.js";
import type {
  ConversionOptions,
  ConversionResult,
  DocConverterProvider,
} from "../engenty/doc-converter/interface.js";
import { splitMarkdownByPageBreaks } from "../engenty/doc-converter/page-break.js";
import { LocalProvider } from "../engenty/doc-converter/providers/local/index.js";
import { invoiceSchema, receiptSchema } from "../engenty/document-scanner/schemas/index.js";
import { env } from "../env.js";
import { NotedError } from "../model-errors.js";
import { type CallMeta, costOf, textModel } from "../models.js";
import { htmlToMarkdown } from "../render/convert.js";

/** A document as text a model can read. */
export interface ParsedDocument {
  markdown: string;
  pages: number | null;
  /** How it was read: its own text, a vision model (scan, photo), a table, or a mail. */
  via: "text" | "vision" | "table" | "mail";
}

export class UnreadableDocument extends NotedError {}

/** Model calls made while reading are charged to whoever asked. */
export type Charge = (usd: number) => Promise<void>;

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  docx: DOCX,
  doc: "application/msword",
  xlsx: XLSX,
  csv: "text/csv",
  tsv: "text/csv",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  eml: "message/rfc822",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  avif: "image/avif",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  otf: "font/otf",
  glb: "model/gltf-binary",
  gltf: "model/gltf+json",
};

/** The type to read a file as: mail servers and browsers often only say "octet-stream". */
export function documentMime(name: string, mime: string): string {
  const declared = mime.split(";")[0].trim().toLowerCase();
  if (declared && declared !== "application/octet-stream") {
    return declared;
  }
  return MIME_BY_EXT[name.split(".").pop()?.toLowerCase() ?? ""] ?? declared;
}

/**
 * Reads scans and photos with a vision model, as an engenty doc-converter provider. Pages are
 * marked with the converter's page-break sentinel so paged output looks like any other.
 */
class VisionProvider implements DocConverterProvider {
  readonly id = "vision";
  readonly name = "Vision model";
  readonly supportedTypes = [
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
  ];

  constructor(
    private readonly charge: Charge | undefined,
    private readonly signal: AbortSignal | undefined,
    private readonly call: CallMeta | undefined,
  ) {}

  canConvert(mimeType: string): boolean {
    return this.supportedTypes.includes(mimeType);
  }

  async convert(
    data: Uint8Array,
    filename: string,
    mimeType: string,
    _options?: ConversionOptions,
  ): Promise<ConversionResult> {
    // Reads scans and photos: the class it runs on must take PDFs and images.
    const reader = await textModel("standard", this.call);
    const result = await generateText({
      model: reader.model,
      abortSignal: this.signal,
      maxOutputTokens: 16_000,
      system: [
        "You transcribe documents into clean Markdown, faithfully and completely.",
        "Keep every number, date, name and amount exactly as printed. Tables become Markdown tables.",
        "Do not summarise, do not comment, do not wrap the result in a code fence.",
        'For a PDF with several pages, start each page with this line: <page-break number="N" total="T"></page-break>',
        "If a part is illegible, write [unleserlich] there.",
        "A photo that is no document (a room, an object, a damage): describe precisely what it shows instead — what is there, how many, materials, condition, visible defects — without guessing what cannot be seen.",
      ].join("\n"),
      messages: [
        {
          role: "user",
          content: [
            { type: "file", data, mediaType: mimeType, filename: filename || "document" },
            { type: "text", text: "Transcribe this document." },
          ],
        },
      ],
    });
    await this.charge?.(costOf(reader, result.usage));
    const markdown = result.text.trim();
    return {
      markdown,
      metadata: { word_count: markdown.split(/\s+/).filter(Boolean).length },
      source: { filename, mime_type: mimeType, size_bytes: data.byteLength },
    };
  }
}

const local = new LocalProvider();

function tableMarkdown(columns: string[], rows: string[][], limit = 400): string {
  const cell = (v: string) => v.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
  const head = `| ${columns.map(cell).join(" | ")} |\n|${columns.map(() => " --- ").join("|")}|`;
  const body = rows.slice(0, limit).map((r) => `| ${r.map(cell).join(" | ")} |`);
  const more = rows.length > limit ? [`\n… ${rows.length - limit} more rows`] : [];
  return [head, ...body, ...more].join("\n");
}

async function parseMail(data: Uint8Array): Promise<string> {
  const mail = await PostalMime.parse(data);
  const body = mail.text?.trim() || (mail.html ? htmlToMarkdown(mail.html) : "");
  return [
    `From: ${mail.from?.address ?? ""}`,
    `To: ${(mail.to ?? []).map((t) => t.address).join(", ")}`,
    `Date: ${mail.date ?? ""}`,
    `Subject: ${mail.subject ?? ""}`,
    mail.attachments.length
      ? `Attachments: ${mail.attachments.map((a) => a.filename ?? "unnamed").join(", ")}`
      : "",
    "",
    body,
  ]
    .filter((line, i) => line || i === 5)
    .join("\n");
}

const CACHE_DIR = join(env.dataDir, "parsed");
mkdirSync(CACHE_DIR, { recursive: true });

/**
 * Turns a file into Markdown: PDFs and Word files by their own text, scans and photos by a
 * vision model, spreadsheets and CSV as tables, saved mails with their headers. The result is
 * kept by content, so a file is read (and paid for) once.
 */
export async function parseDocument(
  input: { data: Uint8Array; name: string; mime: string },
  opts: { charge?: Charge; signal?: AbortSignal; call?: CallMeta } = {},
): Promise<ParsedDocument> {
  const mime = documentMime(input.name, input.mime);
  return kept(input.data, mime, () => read({ ...input, mime }, opts));
}

/** What was made of a file, kept by its content: the same bytes are never worked through twice. */
async function kept<T>(data: Uint8Array, variant: string, make: () => Promise<T>): Promise<T> {
  const file = join(
    CACHE_DIR,
    `${createHash("sha256").update(data).update(variant).digest("hex")}.json`,
  );
  if (existsSync(file)) {
    return JSON.parse(await readFile(file, "utf8")) as T;
  }
  const made = await make();
  await writeFile(file, JSON.stringify(made));
  return made;
}

async function read(
  input: { data: Uint8Array; name: string; mime: string },
  opts: { charge?: Charge; signal?: AbortSignal; call?: CallMeta },
): Promise<ParsedDocument> {
  const { data, name, mime } = input;
  const vision = new VisionProvider(opts.charge, opts.signal, opts.call);
  if (mime.startsWith("image/")) {
    if (!vision.canConvert(mime)) {
      throw new UnreadableDocument(note("imageTypeNotReadable", { mime }));
    }
    const result = await vision.convert(data, name, mime);
    return { markdown: result.markdown, pages: 1, via: "vision" };
  }
  if (mime === "application/pdf") {
    const result = await local.convert(data, name, mime);
    const pages = result.metadata.page_count ?? null;
    const letters = result.markdown.replace(/<page-break[^>]*><\/page-break>|\s/g, "").length;
    // Hardly any text per page: the PDF is a scan.
    if (letters < 60 * Math.max(1, pages ?? 1)) {
      const seen = await vision.convert(data, name, mime);
      return {
        markdown: seen.markdown,
        pages: pages ?? (splitMarkdownByPageBreaks(seen.markdown).length || null),
        via: "vision",
      };
    }
    return { markdown: result.markdown, pages, via: "text" };
  }
  if (local.canConvert(mime)) {
    return { markdown: (await local.convert(data, name, mime)).markdown, pages: null, via: "text" };
  }
  if (mime === XLSX) {
    const workbook = await readXlsxWorkbook(data);
    const sheets = workbook.sheets
      .filter((s) => s.matrix.rows.length)
      .map((s) => `## ${s.name}\n\n${tableMarkdown(s.matrix.columns, s.matrix.rows)}`);
    return { markdown: sheets.join("\n\n"), pages: null, via: "table" };
  }
  const text = () => Buffer.from(data).toString("utf8");
  if (mime === "text/csv") {
    const matrix = parseCsvMatrix(text());
    return { markdown: tableMarkdown(matrix.columns, matrix.rows), pages: null, via: "table" };
  }
  if (mime === "text/html") {
    return { markdown: htmlToMarkdown(text()), pages: null, via: "text" };
  }
  if (mime === "message/rfc822") {
    return { markdown: await parseMail(data), pages: null, via: "mail" };
  }
  if (mime === "application/json" || mime.startsWith("text/")) {
    return { markdown: text(), pages: null, via: "text" };
  }
  throw new UnreadableDocument(note("fileNotReadable", { name, mime }));
}

// --- structured extraction -----------------------------------------------------

/** The scanner's schemas say nothing about the currency; SaaS invoices come in several. */
const currency = z
  .string()
  .nullable()
  .describe("ISO 4217 code of the currency the amounts are printed in (EUR, USD, …)");
const SCHEMAS = {
  invoice: invoiceSchema.extend({ currency }),
  receipt: receiptSchema.extend({ currency }),
};
export type ScanKind = keyof typeof SCHEMAS;
export type ScanResult = z.infer<(typeof SCHEMAS)[ScanKind]>;

/**
 * Pulls the fields of an invoice or receipt out of a document, with engenty's document-scanner
 * schemas (their field descriptions are the extraction instructions).
 */
export async function scanDocument(
  input: { data: Uint8Array; name: string; mime: string },
  kind: ScanKind,
  opts: { charge?: Charge; signal?: AbortSignal; call?: CallMeta } = {},
): Promise<ScanResult> {
  const doc = await parseDocument(input, opts);
  return kept(input.data, `scan:${kind}`, async () => {
    const extractor = await textModel("classifier", opts.call);
    const result = await generateText({
      model: extractor.model,
      abortSignal: opts.signal,
      output: Output.object({ schema: SCHEMAS[kind] as z.ZodType<ScanResult> }),
      prompt: `Extract the ${kind} from this document. Amounts are numbers in the document's own currency, exactly as printed; never convert or compute them.\n\nFile: ${input.name}\n\n${doc.markdown.slice(0, 30_000)}`,
    });
    await opts.charge?.(costOf(extractor, result.usage));
    return result.output;
  });
}
