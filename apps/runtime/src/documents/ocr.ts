import { join } from "node:path";
import type { LiteParse } from "@llamaindex/liteparse";
import type {
  ConversionOptions,
  ConversionResult,
  DocConverterProvider,
} from "../engenty/doc-converter/interface.js";
import { markdownFromPagedParseResult } from "../engenty/doc-converter/page-break.js";
import { env } from "../env.js";

/**
 * Reads scans and photos on this computer, as an engenty doc-converter provider: LlamaIndex's
 * LiteParse, with PDFium and Tesseract built in (docs/plans/document-reading.md). Tesseract's
 * models are downloaded the first time a scan is read, into DATA_DIR/tessdata.
 */

/** Tesseract's languages, by their model names. */
const LANGUAGES = "deu+eng";
/** Pages of one document read by OCR at most: a long scanned book costs minutes. */
export const MAX_OCR_PAGES = 100;
export const TESSDATA_DIR = join(env.dataDir, "tessdata");

let loaded: Promise<typeof import("@llamaindex/liteparse")> | null = null;

/** A parser for one read: which pages it reads is part of its config. */
async function liteparse(targetPages?: string): Promise<LiteParse> {
  loaded ??= import("@llamaindex/liteparse").catch((err) => {
    // A platform LiteParse has no build for: no OCR.
    console.error("[ocr] LiteParse is not available:", err);
    throw err;
  });
  const { LiteParse } = await loaded;
  return new LiteParse({
    outputFormat: "markdown",
    imageMode: "off",
    ocrLanguage: LANGUAGES,
    tessdataPath: TESSDATA_DIR,
    maxPages: MAX_OCR_PAGES,
    quiet: true,
    ...(targetPages ? { targetPages } : {}),
  });
}

export class OcrProvider implements DocConverterProvider {
  readonly id = "liteparse";
  readonly name = "LiteParse OCR";
  readonly supportedTypes = [
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "image/tiff",
    "image/bmp",
  ];

  canConvert(mimeType: string): boolean {
    return this.supportedTypes.includes(mimeType);
  }

  async convert(
    data: Uint8Array,
    filename: string,
    mimeType: string,
    _options?: ConversionOptions,
  ): Promise<ConversionResult> {
    const pages = await this.pages(data);
    // A picture is one page: no page markers.
    const markdown =
      mimeType === "application/pdf"
        ? markdownFromPagedParseResult({
            pages: [...pages].map(([number, text]) => ({ number, markdown: text })),
            total: pages.size,
          })
        : [...pages.values()].join("\n\n");
    return {
      markdown,
      metadata: {
        page_count: pages.size,
        word_count: markdown.split(/\s+/).filter(Boolean).length,
      },
      source: { filename, mime_type: mimeType, size_bytes: data.byteLength },
    };
  }

  /** The text of each page by its number: of `only` where given, else of the first pages. */
  async pages(data: Uint8Array, only?: number[]): Promise<Map<number, string>> {
    const lp = await liteparse(only?.slice(0, MAX_OCR_PAGES).join(","));
    const result = await lp.parse(data);
    return new Map(result.pages.map((page) => [page.pageNum, (page.markdown ?? page.text).trim()]));
  }
}
