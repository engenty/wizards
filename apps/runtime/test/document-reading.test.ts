import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Reading documents on this computer (docs/plans/document-reading.md): a PDF's own text page by
// page, its scanned pages by OCR, a picture by OCR before any vision model, an old Word file by
// its text. No model is configured: everything here is read without one.

const dir = mkdtempSync(join(tmpdir(), "wizards-documents-"));
process.env.DATA_DIR = join(dir, "data");
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";

// Tesseract's models (24 MB) are downloaded once and shared by the runs on this machine.
const models = join(homedir(), ".cache", "wizards-tessdata");
mkdirSync(models, { recursive: true });
mkdirSync(process.env.DATA_DIR, { recursive: true });
symlinkSync(models, join(process.env.DATA_DIR, "tessdata"));

let parse: typeof import("../src/documents/parse");

/** A picture of printed text, as a scanner would make it. */
async function scan(lines: string[], format: "png" | "jpeg") {
  const { createCanvas } = await import("@napi-rs/canvas");
  const canvas = createCanvas(1240, 1754);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#000";
  ctx.font = "40px sans-serif";
  lines.forEach((line, i) => {
    ctx.fillText(line, 120, 200 + i * 70);
  });
  return format === "png" ? canvas.encode("png") : canvas.encode("jpeg", 90);
}

/** A PDF of two pages: one with text of its own, one that is only a scanned picture. */
function pdf(text: string[], picture: { jpeg: Uint8Array; width: number; height: number }) {
  const content = `BT /F1 12 Tf 50 780 Td 16 TL ${text.map((l) => `(${l}) '`).join(" ")} ET`;
  const draw = "q 595 0 0 842 0 0 cm /Im1 Do Q";
  const objects: (string | Buffer)[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im1 7 0 R >> >> /Contents 8 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${picture.width} /Height ${picture.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${picture.jpeg.length} >>\nstream\n`,
      ),
      Buffer.from(picture.jpeg),
      Buffer.from("\nendstream"),
    ]),
    `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`,
  ];
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n")];
  const offsets: number[] = [];
  let at = parts[0].length;
  objects.forEach((body, i) => {
    const part = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`),
      Buffer.isBuffer(body) ? body : Buffer.from(body),
      Buffer.from("\nendobj\n"),
    ]);
    offsets.push(at);
    parts.push(part);
    at += part.length;
  });
  const xref = [
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`,
    ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`,
  ].join("");
  parts.push(Buffer.from(xref));
  return new Uint8Array(Buffer.concat(parts));
}

beforeAll(async () => {
  parse = await import("../src/documents/parse");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("reading documents", () => {
  it("reads a PDF's own text, and its scanned page by OCR", { timeout: 180_000 }, async () => {
    const jpeg = await scan(
      ["Kaufvertrag", "Fahrzeug: Model S Long Range", "Kaufpreis: EUR 25.500"],
      "jpeg",
    );
    const data = pdf(
      [
        "Rechnung 2026-17 an die Gartenbau Huber GmbH in Linz.",
        "Leistungszeitraum Oktober, zahlbar binnen vierzehn Tagen.",
      ],
      { jpeg, width: 1240, height: 1754 },
    );
    const started = performance.now();
    const doc = await parse.ownText({ data, name: "vertrag.pdf", mime: "application/pdf" });
    console.log(`[ocr] two pages, one scanned: ${Math.round(performance.now() - started)} ms`);
    expect(doc?.via).toBe("ocr");
    expect(doc?.pages).toBe(2);
    expect(doc?.markdown).toContain("Gartenbau Huber");
    expect(doc?.markdown).toMatch(/Kaufpreis:?\s*EUR\s*25[.,]500/);
    expect(doc?.markdown).toContain('<page-break number="2" total="2">');
  });

  it("reads a picture of text by OCR, without a vision model", { timeout: 180_000 }, async () => {
    const png = await scan(
      [
        "Bäckerei Moser, Kirchengasse 12, Wien",
        "Quittung Nummer 4711 vom 3. Oktober",
        "Summe: EUR 18,40 inklusive Steuer",
      ],
      "png",
    );
    const doc = await parse.parseDocument({ data: png, name: "quittung.png", mime: "image/png" });
    expect(doc.via).toBe("ocr");
    expect(doc.markdown).toMatch(/18,40/);
  });

  it("reads an old Word file", async () => {
    const data = readFileSync(join(import.meta.dirname, "fixtures/documents/angebot.doc"));
    const doc = await parse.ownText({ data, name: "angebot.doc", mime: "" });
    expect(doc?.via).toBe("text");
    expect(doc?.markdown).toContain("Gartenmauer berechnen wir 1.240,00 Euro");
  });

  it("reads a mounted file again where what was kept of it had no text", async () => {
    const { cachedText } = await import("../src/mounts/cache");
    const read = { markdown: "Kaufpreis: EUR 25.500", pages: 1, via: "ocr" as const };
    expect(await cachedText("a1", async () => null)).toBeNull();
    expect(await cachedText("a1", async () => read)).toBeNull();
    expect(await cachedText("a1", async () => read, true)).toEqual(read);
    expect(await cachedText("a1", async () => null, true)).toEqual(read);
  });
});
