import { type Chunk, chunksOf, MAX_CHARS } from "./chunks.js";
import { canReadPdf, canReadWord, canSee, pdfPages, thumbOf, wordText } from "./media.js";
import { extOf, nameOf, nameWords } from "./text.js";

// Which files the index reads, and the passages each one gives: text files cut
// by chunks.ts, an image as one passage named by its file, a PDF page by page,
// and documents by their text.

export type HitKind = "text" | "image" | "page";

/** Files the index reads as text: what people write, not code or data dumps. */
export const TEXT = new Set(["md", "txt", "csv", "tsv", "html", "htm", "yml", "yaml"]);
/** Images it embeds as pictures. */
export const IMAGES = new Set(["png", "jpg", "jpeg", "webp", "gif"]);
/** Documents it takes the text (and for PDFs, the pages) out of itself. */
export const DOCUMENTS = new Set(["pdf", "docx"]);
const MAX_TEXT = 1024 * 1024;
const MAX_BYTES = 25 * 1024 * 1024;

/**
 * Text out of a document the package does not read itself, as markdown, by
 * the file's extension: a host passes `{ xlsx: workbookText }` to find
 * workbooks by their cells.
 */
export type DocumentReaders = Record<string, (bytes: Uint8Array) => Promise<string>>;

/** A passage as the index keeps it. */
export interface Passage extends Chunk {
  kind: HitKind;
  page: number | null;
  thumb: Uint8Array | null;
}

/** Whether the index reads a file: by its extension and, where known, its size. */
export function indexable(f: { path: string; size?: number }, documents: DocumentReaders): boolean {
  const ext = extOf(f.path);
  if (nameOf(f.path).startsWith(".")) {
    return false;
  }
  const size = f.size ?? 0;
  if (TEXT.has(ext)) {
    return size <= MAX_TEXT;
  }
  return (
    (IMAGES.has(ext) || DOCUMENTS.has(ext) || Object.hasOwn(documents, ext)) && size <= MAX_BYTES
  );
}

export const textPassages = (chunks: Chunk[], page: number | null = null): Passage[] =>
  chunks.map((c) => ({ ...c, kind: "text", page, thumb: null }));

/** A file found by its name only: a PDF without pdf-parse, a broken workbook. */
export const namePassage = (path: string): Passage[] =>
  textPassages([{ heading: null, line: 0, text: nameWords(path) }]);

async function pdfPassages(path: string, bytes: Uint8Array) {
  if (!(await canReadPdf())) {
    return namePassage(path);
  }
  const out: Passage[] = [];
  for (const p of await pdfPages(bytes, await canSee())) {
    const text = p.text.trim();
    // The page itself carries its first passage; the rest of a long page
    // follows as text.
    out.push({
      heading: null,
      kind: "page",
      line: 0,
      page: p.page,
      text: text.slice(0, MAX_CHARS) || `${nameWords(path)}, page ${p.page}`,
      thumb: p.jpeg ? await thumbOf(p.jpeg) : null,
    });
    if (text.length > MAX_CHARS) {
      out.push(...textPassages(chunksOf("txt", text.slice(MAX_CHARS)), p.page));
    }
  }
  return out;
}

export interface PassageSource {
  read(path: string): Promise<{ text: string } | null>;
  readBytes(path: string): Promise<Uint8Array | null>;
}

/** The passages of one file; empty when it can't be read. */
export async function passagesOf(
  source: PassageSource,
  path: string,
  documents: DocumentReaders,
): Promise<Passage[]> {
  const ext = extOf(path);
  if (TEXT.has(ext)) {
    const file = await source.read(path);
    return file ? textPassages(chunksOf(ext, file.text)) : [];
  }
  if (IMAGES.has(ext)) {
    return [
      {
        heading: null,
        kind: "image",
        line: 0,
        page: null,
        text: nameWords(path),
        thumb: null,
      },
    ];
  }
  const bytes = await source.readBytes(path);
  if (!bytes) {
    return [];
  }
  if (ext === "pdf") {
    return pdfPassages(path, bytes);
  }
  if (ext === "docx") {
    return (await canReadWord())
      ? textPassages(chunksOf("txt", await wordText(bytes)))
      : namePassage(path);
  }
  const reader = Object.hasOwn(documents, ext) ? documents[ext] : undefined;
  return reader ? textPassages(chunksOf("md", await reader(bytes))) : namePassage(path);
}
