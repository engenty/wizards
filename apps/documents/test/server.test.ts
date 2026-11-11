import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type DocumentReader,
  ownReader,
  type ParsedDocument,
} from "../../runtime/src/documents/read.js";
import { documentsServer } from "../src/server.js";

// The documents service's API with the runtime's own reading behind it: a PDF, an old Word file
// and a picture by OCR, as the runtime sends them (apps/runtime/src/documents/service.ts).

const SECRET = "d".repeat(40);
const FIXTURES = join(import.meta.dirname, "../../runtime/test/fixtures/documents");
const PDF = "application/pdf";
// Tesseract's models (24 MB), downloaded once and shared with the runtime's tests on this machine.
const TESSDATA = join(homedir(), ".cache", "wizards-tessdata");

const closing: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(closing.splice(0).map((close) => close()));
});

async function listen(server: import("node:http").Server) {
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function start(
  overrides: { reader?: DocumentReader; maxReads?: number; fetchOrigins?: string[] } = {},
) {
  const api = documentsServer({
    secret: SECRET,
    reader: overrides.reader ?? ownReader(TESSDATA),
    maxFileBytes: 64 * 1024,
    maxReads: overrides.maxReads ?? 2,
    fetchOrigins: overrides.fetchOrigins ?? [],
    log: () => undefined,
  });
  const base = await listen(api.server);
  closing.push(api.close);
  const read = (
    data: Uint8Array | string,
    mime: string,
    name = "file",
    secret: string | null = SECRET,
  ) =>
    fetch(`${base}/read`, {
      method: "POST",
      headers: {
        ...(secret === null ? {} : { authorization: `Bearer ${secret}` }),
        "content-type": mime,
        "x-document-name": encodeURIComponent(name),
      },
      body: data as BodyInit,
    });
  const fetchDoc = (input: { url: string; name: string; mime: string }) =>
    fetch(`${base}/fetch`, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  return { base, read, fetchDoc };
}

describe("the secret", () => {
  it("is wanted on every route but /health", async () => {
    const { base, read } = await start();
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, reading: 0, waiting: 0 });
    const pdf = readFileSync(join(FIXTURES, "rechnung.pdf"));
    expect((await read(pdf, PDF, "r.pdf", null)).status).toBe(401);
    expect((await read(pdf, PDF, "r.pdf", "wrong")).status).toBe(401);
    expect((await read(pdf, PDF, "r.pdf", `${SECRET}x`)).status).toBe(401);
  });
});

describe("reading", () => {
  it("reads a PDF's own text", async () => {
    const { read } = await start();
    const res = await read(readFileSync(join(FIXTURES, "rechnung.pdf")), PDF, "rechnung.pdf");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as ParsedDocument;
    expect(doc.via).toBe("text");
    expect(doc.pages).toBe(1);
    expect(doc.markdown).toContain("Gartenbau Huber GmbH");
  });

  it("reads an old Word file", async () => {
    const { read } = await start();
    const res = await read(
      readFileSync(join(FIXTURES, "angebot.doc")),
      "application/msword",
      "angebot.doc",
    );
    const doc = (await res.json()) as ParsedDocument;
    expect(doc.via).toBe("text");
    expect(doc.markdown).toContain("Gartenmauer berechnen wir 1.240,00 Euro");
  });

  it("reads a picture of text by OCR", { timeout: 180_000 }, async () => {
    const { createCanvas } = await import("@napi-rs/canvas");
    const canvas = createCanvas(1240, 1754);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#000";
    ctx.font = "40px sans-serif";
    ["Bäckerei Moser, Kirchengasse 12, Wien", "Summe: EUR 18,40 inklusive Steuer"].forEach(
      (line, i) => ctx.fillText(line, 120, 200 + i * 70),
    );
    const { read } = await start();
    const res = await read(await canvas.encode("png"), "image/png", "quittung.png");
    const doc = (await res.json()) as ParsedDocument;
    expect(doc).toMatchObject({ via: "ocr", pages: 1 });
    expect(doc.markdown).toMatch(/18,40/);
  });

  it("says what it doesn't read, what is too large and what is broken", async () => {
    const { read } = await start();
    const text = await read("Hallo", "text/plain");
    expect(text.status).toBe(415);
    expect(await text.json()).toMatchObject({ error: "unsupported" });
    const large = await read(new Uint8Array(65 * 1024), PDF, "large.pdf");
    expect(large.status).toBe(413);
    const broken = await read("%PDF-1.4 nothing else", PDF, "broken.pdf");
    expect(broken.status).toBe(422);
    expect(await broken.json()).toMatchObject({ error: "unreadable" });
  });

  it("reads at most maxReads documents at once; the others wait", async () => {
    let now = 0;
    let most = 0;
    const reader: DocumentReader = {
      async read({ name }) {
        most = Math.max(most, ++now);
        await new Promise((resolve) => setTimeout(resolve, 30));
        now--;
        return { markdown: name, pages: null, via: "text" };
      },
    };
    const { read } = await start({ reader, maxReads: 2 });
    const answers = await Promise.all(
      ["a", "b", "c", "d", "e"].map(async (name) => (await read("x", PDF, name)).json()),
    );
    expect(answers.map((doc) => (doc as ParsedDocument).markdown)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
    expect(most).toBe(2);
  });
});

describe("fetching", () => {
  it("fetches a document from an origin it trusts, and only from there", async () => {
    const pdf = readFileSync(join(FIXTURES, "rechnung.pdf"));
    const files = createServer((req, res) => {
      if (req.url === "/signed/rechnung.pdf?sig=abc") {
        res.writeHead(200, { "content-type": PDF }).end(pdf);
        return;
      }
      res.writeHead(404).end();
    });
    const origin = await listen(files);
    closing.push(() => new Promise((resolve) => files.close(() => resolve())));

    const off = await start();
    expect(
      (await off.fetchDoc({ url: `${origin}/signed/rechnung.pdf?sig=abc`, name: "r", mime: PDF }))
        .status,
    ).toBe(404);

    const { fetchDoc } = await start({ fetchOrigins: [origin] });
    const res = await fetchDoc({
      url: `${origin}/signed/rechnung.pdf?sig=abc`,
      name: "rechnung.pdf",
      mime: PDF,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as ParsedDocument).markdown).toContain("Gartenbau Huber");

    const elsewhere = await fetchDoc({ url: "http://127.0.0.2:9/x.pdf", name: "x", mime: PDF });
    expect(elsewhere.status).toBe(403);
    const missing = await fetchDoc({ url: `${origin}/signed/none.pdf`, name: "x", mime: PDF });
    expect(missing.status).toBe(502);
  });
});
