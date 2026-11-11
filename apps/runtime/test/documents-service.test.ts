import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { documentsServer } from "../../documents/src/server.js";
import { type DocumentReader, ownReader } from "../src/documents/read.js";

// The runtime with DOCUMENTS_URL set: what takes a document library is read by the documents
// service (apps/documents), the rest by the runtime itself, and a service that fails is a
// failure, never read here instead. Without DOCUMENTS_URL, document-reading.test.ts.

const SECRET = "d".repeat(40);
const dir = mkdtempSync(join(tmpdir(), "wizards-documents-service-"));
process.env.DATA_DIR = join(dir, "data");
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
mkdirSync(process.env.DATA_DIR, { recursive: true });

const FIXTURES = join(import.meta.dirname, "fixtures/documents");
/** What the service was asked to read, by name. */
const asked: string[] = [];
let close: () => Promise<void>;
let parse: typeof import("../src/documents/parse");

beforeAll(async () => {
  const own = ownReader(join(homedir(), ".cache", "wizards-tessdata"));
  const reader: DocumentReader = {
    read: (input, opts) => {
      asked.push(input.name);
      return own.read(input, opts);
    },
  };
  const api = documentsServer({
    secret: SECRET,
    reader,
    maxFileBytes: 1024 * 1024,
    maxReads: 2,
    fetchOrigins: [],
    log: () => undefined,
  });
  api.server.listen(0, "127.0.0.1");
  await new Promise((resolve) => api.server.once("listening", resolve));
  close = api.close;
  process.env.DOCUMENTS_URL = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}/`;
  process.env.DOCUMENTS_SECRET = SECRET;
  parse = await import("../src/documents/parse");
});

afterAll(async () => {
  await close?.();
  rmSync(dir, { recursive: true, force: true });
});

describe("reading through the documents service", () => {
  it("reads a PDF there, and keeps what was read here", async () => {
    const data = readFileSync(join(FIXTURES, "rechnung.pdf"));
    const doc = await parse.parseDocument({ data, name: "rechnung.pdf", mime: "" });
    expect(doc).toMatchObject({ via: "text", pages: 1 });
    expect(doc.markdown).toContain("Gartenbau Huber GmbH");
    expect(asked).toEqual(["rechnung.pdf"]);
    // Kept by content: the same bytes are not sent again.
    await parse.parseDocument({ data, name: "again.pdf", mime: "application/pdf" });
    expect(asked).toEqual(["rechnung.pdf"]);
  });

  it("reads an old Word file there, a name with spaces and umlauts included", async () => {
    const data = readFileSync(join(FIXTURES, "angebot.doc"));
    const doc = await parse.ownText({ data, name: "Angebot Mauer für Huber.doc", mime: "" });
    expect(doc?.via).toBe("text");
    expect(doc?.markdown).toContain("Gartenmauer berechnen wir 1.240,00 Euro");
    expect(asked).toContain("Angebot Mauer für Huber.doc");
  });

  it("reads text, tables and mails here", async () => {
    const before = asked.length;
    const csv = await parse.localText({
      data: new TextEncoder().encode("Name;Betrag\nHuber;1240\n"),
      name: "betraege.csv",
      mime: "text/csv",
    });
    expect(csv.via).toBe("table");
    const text = await parse.ownText({
      data: new TextEncoder().encode("Hallo"),
      name: "notiz.txt",
      mime: "text/plain",
    });
    expect(text?.markdown).toBe("Hallo");
    expect(asked.length).toBe(before);
  });

  it("fails when the service does, and doesn't read the file here instead", async () => {
    const broken = new TextEncoder().encode("%PDF-1.4 nothing else");
    await expect(
      parse.ownText({ data: broken, name: "broken.pdf", mime: "application/pdf" }),
    ).rejects.toMatchObject({ status: 422, code: "unreadable" });

    const { remoteReader } = await import("../src/documents/service");
    const gone = remoteReader({ url: "http://127.0.0.1:9", secret: SECRET });
    await expect(
      gone.read({ data: broken, name: "x.pdf", mime: "application/pdf" }),
    ).rejects.toThrow(/documents service doesn’t answer/);
    const wrong = remoteReader({ url: process.env.DOCUMENTS_URL ?? "", secret: "x".repeat(40) });
    await expect(
      wrong.read({ data: broken, name: "x.pdf", mime: "application/pdf" }),
    ).rejects.toMatchObject({ status: 401 });
  });
});
