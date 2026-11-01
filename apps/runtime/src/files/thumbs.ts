import { spawn } from "node:child_process";
import { inTurn } from "./upload-check.js";

/**
 * A 320 px JPEG of a picture, or of a PDF's first page, for lists and search. Drawn in a process
 * of its own, as an upload is checked (upload-check.ts): a broken file can crash the libraries.
 */

/** The longest side of a thumbnail. */
export const THUMB_SIDE = 320;

const PICTURES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/svg+xml",
]);

/** Whether a file of this type gets a thumbnail. */
export function hasThumb(mime: string): boolean {
  return PICTURES.has(mime) || mime === "application/pdf";
}

/**
 * Reads the file on stdin, writes the JPEG on stdout, ends with 3 when it doesn't decode. A PDF's
 * first page is drawn at twice the size first, so its text stays sharp when it is scaled down. A
 * picture with transparency stands on white.
 */
const THUMB = `
const [canvasUrl, pdfUrl, mime, side] = process.argv.slice(1);
const { createCanvas, loadImage } = await import(canvasUrl);
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
let data = Buffer.concat(chunks);
let image;
try {
  if (mime === "application/pdf") {
    const { PDFParse } = await import(pdfUrl);
    const parser = new PDFParse({ data: new Uint8Array(data) });
    const shot = await parser.getScreenshot({ partial: [1], desiredWidth: Number(side) * 2, imageBuffer: true, imageDataUrl: false });
    await parser.destroy();
    data = Buffer.from(shot.pages[0].data);
  }
  image = await loadImage(data);
} catch { process.exit(3); }
if (!image.width || !image.height) process.exit(3);
const scale = Math.min(1, Number(side) / Math.max(image.width, image.height));
const w = Math.max(1, Math.round(image.width * scale));
const h = Math.max(1, Math.round(image.height * scale));
const canvas = createCanvas(w, h);
const ctx = canvas.getContext("2d");
ctx.fillStyle = "#fff";
ctx.fillRect(0, 0, w, h);
ctx.drawImage(image, 0, 0, w, h);
process.stdout.write(await canvas.encode("jpeg", 80), () => process.exit(0));
`;

const THUMB_TIMEOUT_MS = 60_000;

/** The thumbnail of a file, or null when it has none or doesn't decode. */
export function makeThumb(data: Uint8Array, mime: string): Promise<Buffer | null> {
  if (!hasThumb(mime)) {
    return Promise.resolve(null);
  }
  return inTurn(
    () =>
      new Promise((resolve) => {
        const child = spawn(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            THUMB,
            import.meta.resolve("@napi-rs/canvas"),
            import.meta.resolve("pdf-parse"),
            mime,
            String(THUMB_SIDE),
          ],
          { env: {}, stdio: ["pipe", "pipe", "ignore"], timeout: THUMB_TIMEOUT_MS },
        );
        const out: Buffer[] = [];
        child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
        child.on("error", () => resolve(null));
        child.on("close", (code) => resolve(code === 0 && out.length ? Buffer.concat(out) : null));
        child.stdin.on("error", () => undefined);
        child.stdin.end(Buffer.from(data));
      }),
  );
}
