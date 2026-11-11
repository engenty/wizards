// Pictures for the embedding model: an image as a JPEG it looks at, a PDF as pictures of its
// pages. @napi-rs/canvas comes with pdf-parse and has prebuilt binaries, so nothing is compiled.

/** The side EmbeddingGemma sees a picture at; larger only costs time. */
export const EMBED_SIDE = 768;
/** A PDF's pages beyond this are found by their text only. */
export const MAX_PAGE_PICTURES = 40;

/** An image as a JPEG no larger than `side` on its longer side. */
export async function jpegOf(bytes: Buffer | Uint8Array, side = EMBED_SIDE): Promise<Buffer> {
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const image = await loadImage(Buffer.from(bytes));
  const scale = Math.min(1, side / Math.max(image.width, image.height));
  const w = Math.max(1, Math.round(image.width * scale));
  const h = Math.max(1, Math.round(image.height * scale));
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  // Transparent PNGs on white, as people see them.
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(image, 0, 0, w, h);
  return canvas.encode("jpeg", 82);
}

/** Pictures of a PDF's first `MAX_PAGE_PICTURES` pages, EMBED_SIDE wide, by their 1-based number. */
export async function pdfPages(
  bytes: Buffer | Uint8Array,
): Promise<{ page: number; jpeg: Buffer }[]> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(bytes) });
  try {
    const shots = await parser.getScreenshot({
      desiredWidth: EMBED_SIDE,
      first: MAX_PAGE_PICTURES,
      imageDataUrl: false,
    });
    const pages: { page: number; jpeg: Buffer }[] = [];
    for (const s of shots.pages) {
      pages.push({ page: s.pageNumber, jpeg: await jpegOf(s.data) });
    }
    return pages;
  } finally {
    await parser.destroy();
  }
}
