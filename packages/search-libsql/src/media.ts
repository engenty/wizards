// What the search takes out of files that are not text: images as JPEGs the
// embedding model looks at, PDFs as pages (their text, a picture of each, a
// thumbnail for the results), and the text of Word files. Each needs an
// optional peer dependency (@napi-rs/canvas, pdf-parse, mammoth); without one,
// such files are found by their name, and text search works as before.

/** The side EmbeddingGemma sees an image at; larger only costs time. */
const EMBED_SIDE = 768;
const THUMB_SIDE = 320;
/** A PDF's pages beyond this are indexed by their text only. */
const MAX_PAGE_IMAGES = 40;
const JPEG_QUALITY = 82;

type Canvas = typeof import("@napi-rs/canvas");
type PdfParse = typeof import("pdf-parse");
type Mammoth = typeof import("mammoth");

const loaded = new Map<string, Promise<unknown>>();

/** An optional peer dependency, or null where the host has not installed it. */
function optional<T>(name: string, load: () => Promise<T>): Promise<T | null> {
  let found = loaded.get(name) as Promise<T | null> | undefined;
  if (!found) {
    found = load().catch(() => null);
    loaded.set(name, found);
  }
  return found;
}

const canvasModule = () => optional<Canvas>("@napi-rs/canvas", () => import("@napi-rs/canvas"));
const pdfModule = () => optional<PdfParse>("pdf-parse", () => import("pdf-parse"));
const mammothModule = () => optional<Mammoth>("mammoth", () => import("mammoth"));

/** Whether images can be drawn: with @napi-rs/canvas. */
export const canSee = async (): Promise<boolean> => Boolean(await canvasModule());

/** Whether PDFs can be read: with pdf-parse. */
export const canReadPdf = async (): Promise<boolean> => Boolean(await pdfModule());

/** Whether Word files can be read: with mammoth. */
export const canReadWord = async (): Promise<boolean> => Boolean(await mammothModule());

const asBuffer = (bytes: Uint8Array): Buffer =>
  Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** An image as a JPEG no larger than `side` on its longer side. */
export async function jpegOf(bytes: Uint8Array, side = EMBED_SIDE): Promise<Buffer> {
  const canvas = await canvasModule();
  if (!canvas) {
    throw new Error("@napi-rs/canvas is not installed");
  }
  const image = await canvas.loadImage(asBuffer(bytes));
  const scale = Math.min(1, side / Math.max(image.width, image.height));
  const w = Math.max(1, Math.round(image.width * scale));
  const h = Math.max(1, Math.round(image.height * scale));
  const out = canvas.createCanvas(w, h);
  const ctx = out.getContext("2d");
  // Transparent PNGs on white, as people see them.
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(image, 0, 0, w, h);
  return out.encode("jpeg", JPEG_QUALITY);
}

export interface PdfPage {
  /** A picture of the page at EMBED_SIDE wide; only for the first MAX_PAGE_IMAGES. */
  jpeg: Buffer | null;
  /** 1-based. */
  page: number;
  text: string;
}

/** A PDF's pages: their text, and a picture of each with `pictures`. */
export async function pdfPages(bytes: Uint8Array, pictures: boolean): Promise<PdfPage[]> {
  const pdf = await pdfModule();
  if (!pdf) {
    throw new Error("pdf-parse is not installed");
  }
  const parser = new pdf.PDFParse({ data: new Uint8Array(bytes) });
  try {
    const text = await parser.getText();
    const pages: PdfPage[] = text.pages.map((p) => ({
      jpeg: null,
      page: p.num,
      text: p.text,
    }));
    if (pictures && (await canSee())) {
      const shots = await parser.getScreenshot({
        desiredWidth: EMBED_SIDE,
        first: MAX_PAGE_IMAGES,
        imageDataUrl: false,
      });
      for (const s of shots.pages) {
        const page = pages.find((p) => p.page === s.pageNumber);
        if (page) {
          page.jpeg = await jpegOf(s.data);
        }
      }
    }
    return pages;
  } finally {
    await parser.destroy();
  }
}

/** A thumbnail for the results. */
export const thumbOf = (jpeg: Uint8Array): Promise<Buffer> => jpegOf(jpeg, THUMB_SIDE);

/** A Word file's text. */
export async function wordText(bytes: Uint8Array): Promise<string> {
  const mammoth = await mammothModule();
  if (!mammoth) {
    throw new Error("mammoth is not installed");
  }
  const extract = (mammoth as Mammoth & { default?: Mammoth }).default ?? mammoth;
  return (await extract.extractRawText({ buffer: asBuffer(bytes) })).value;
}
