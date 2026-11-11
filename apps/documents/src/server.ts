import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  DOCUMENT_NAME_HEADER,
  type DocumentReader,
  type DocumentsErrorBody,
  readsOwn,
  UnsupportedType,
} from "../../runtime/src/documents/read.js";

/**
 * The documents service's API, for the runtime only (apps/runtime/src/documents/service.ts):
 *
 *   GET  /health                  no secret: { ok, reading, waiting }
 *   POST /read                    the body is the document, `content-type` its type,
 *                                 `x-document-name` its name (URI-encoded) → ParsedDocument
 *   POST /fetch  { url, name, mime }   the same for a document at `url`, which must be on one of
 *                                 `fetchOrigins` (the broker's signed links); off without any
 *
 * Every route but /health wants `Authorization: Bearer <DOCUMENTS_SECRET>`. It keeps nothing: a
 * document is read and forgotten; what was read is kept by whoever asked. At most `maxReads`
 * documents are read at once (OCR takes every core it gets); the others wait their turn.
 */
export interface DocumentsServerOptions {
  secret: string;
  reader: DocumentReader;
  /** The largest document it takes. */
  maxFileBytes: number;
  /** Documents read at once. */
  maxReads: number;
  /** Origins `/fetch` fetches from, `https://broker.example`; empty: `/fetch` is off. */
  fetchOrigins: readonly string[];
  log?: (line: string) => void;
}

const MAX_JSON_BYTES = 64 * 1024;
/** How long fetching one document may take. */
const FETCH_TIMEOUT_MS = 60_000;

class HttpError extends Error {
  readonly status: number;
  readonly code: DocumentsErrorBody["error"];
  constructor(status: number, code: DocumentsErrorBody["error"], message: string = code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const digest = (value: string) => createHash("sha256").update(value).digest();

/** A document's type as a header says it: without parameters, lower case. */
const typeOf = (value: string | null | undefined) =>
  (value ?? "").split(";")[0].trim().toLowerCase();

export function documentsServer(options: DocumentsServerOptions) {
  const log = options.log ?? ((line: string) => console.log(line));
  const secret = digest(options.secret);
  const origins = new Set(options.fetchOrigins.map((origin) => new URL(origin).origin));
  let reading = 0;
  const waiting: (() => void)[] = [];

  const authorized = (req: IncomingMessage) => {
    const header = req.headers.authorization ?? "";
    return header.startsWith("Bearer ") && timingSafeEqual(digest(header.slice(7)), secret);
  };

  /** Runs `work` once one of `maxReads` places is free. */
  async function inTurn<T>(work: () => Promise<T>): Promise<T> {
    if (reading >= options.maxReads) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    } else {
      reading++;
    }
    try {
      return await work();
    } finally {
      const next = waiting.shift();
      if (next) {
        next();
      } else {
        reading--;
      }
    }
  }

  async function body(chunks: AsyncIterable<Uint8Array>, declared: number, limit: number) {
    if (declared > limit) {
      throw new HttpError(413, "too-large", `More than ${limit} bytes.`);
    }
    const parts: Buffer[] = [];
    let size = 0;
    for await (const chunk of chunks) {
      size += chunk.length;
      if (size > limit) {
        throw new HttpError(413, "too-large", `More than ${limit} bytes.`);
      }
      parts.push(Buffer.from(chunk));
    }
    return new Uint8Array(Buffer.concat(parts));
  }

  async function json(req: IncomingMessage): Promise<Record<string, unknown>> {
    const raw = Buffer.from(
      await body(req, Number(req.headers["content-length"]), MAX_JSON_BYTES),
    ).toString("utf8");
    try {
      const value = raw ? JSON.parse(raw) : {};
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return value;
      }
    } catch {}
    throw new HttpError(400, "bad-request", "The body isn’t a JSON object.");
  }

  function nameOf(value: unknown): string {
    if (typeof value !== "string") {
      return "";
    }
    try {
      return decodeURIComponent(value);
    } catch {
      throw new HttpError(400, "bad-request", `${DOCUMENT_NAME_HEADER} isn’t URI-encoded.`);
    }
  }

  /** The document at `url`, from an origin it was set up to fetch from. */
  async function fetched(url: unknown): Promise<Uint8Array> {
    let at: URL;
    try {
      at = new URL(String(url));
    } catch {
      throw new HttpError(400, "bad-request", "`url` isn’t an address.");
    }
    if (!origins.has(at.origin)) {
      throw new HttpError(403, "forbidden", `Not fetched from ${at.origin}.`);
    }
    const res = await fetch(at, {
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    }).catch((err) => {
      throw new HttpError(502, "failed", `${at.origin} doesn’t answer: ${(err as Error).message}`);
    });
    if (!res.ok || !res.body) {
      throw new HttpError(502, "failed", `${at.origin} answered ${res.status}.`);
    }
    return body(
      res.body as AsyncIterable<Uint8Array>,
      Number(res.headers.get("content-length")),
      options.maxFileBytes,
    );
  }

  /** Reads a document of `readsOwn` and answers what it says. */
  async function read(res: ServerResponse, data: Uint8Array, name: string, mime: string) {
    const started = Date.now();
    const doc = await inTurn(() => options.reader.read({ data, name, mime })).catch((err) => {
      if (err instanceof UnsupportedType) {
        throw new HttpError(415, "unsupported", err.message);
      }
      // What the libraries throw is about the file: a broken PDF, a Word file that isn't one.
      log(`read ${mime}, ${data.byteLength} bytes: ${err instanceof Error ? err.message : err}`);
      throw new HttpError(422, "unreadable", err instanceof Error ? err.message : String(err));
    });
    log(`read ${mime}, ${data.byteLength} bytes, via ${doc.via}: ${Date.now() - started} ms`);
    send(res, 200, doc);
  }

  const send = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
  };

  async function route(req: IncomingMessage, res: ServerResponse) {
    const path = new URL(req.url ?? "/", "http://documents").pathname;
    const method = req.method ?? "GET";
    if (path === "/health" && method === "GET") {
      send(res, 200, { ok: true, reading, waiting: waiting.length });
      return;
    }
    if (!authorized(req)) {
      throw new HttpError(401, "unauthorized");
    }
    if (method !== "POST" || (path !== "/read" && path !== "/fetch")) {
      throw new HttpError(404, "not-found", "Not found.");
    }
    if (path === "/read") {
      const mime = typeOf(req.headers["content-type"]);
      const name = nameOf(req.headers[DOCUMENT_NAME_HEADER]);
      if (!readsOwn(mime)) {
        throw new HttpError(415, "unsupported", `${mime || "No type"} isn’t read here.`);
      }
      const data = await body(req, Number(req.headers["content-length"]), options.maxFileBytes);
      await read(res, data, name, mime);
      return;
    }
    if (!origins.size) {
      throw new HttpError(404, "not-found", "Fetching is off: DOCUMENTS_FETCH_ORIGINS.");
    }
    const input = await json(req);
    const mime = typeOf(typeof input.mime === "string" ? input.mime : "");
    if (!readsOwn(mime)) {
      throw new HttpError(415, "unsupported", `${mime || "No type"} isn’t read here.`);
    }
    const data = await fetched(input.url);
    await read(res, data, typeof input.name === "string" ? input.name : "", mime);
  }

  const server: Server = createServer((req, res) => {
    route(req, res).catch((err) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof HttpError) {
        send(res, err.status, { error: err.code, message: err.message });
        return;
      }
      log(`${req.method} ${req.url}: ${err instanceof Error ? err.stack : err}`);
      send(res, 500, {
        error: "failed",
        message: err instanceof Error ? err.message : String(err),
      });
    });
  });

  return {
    server,
    /** Stops taking requests; reads under way end first. */
    async close() {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      await closed;
    },
  };
}
