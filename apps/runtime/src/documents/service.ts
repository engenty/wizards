import { join } from "node:path";
import { z } from "zod";
import { env } from "../env.js";
import {
  DOCUMENT_NAME_HEADER,
  type DocumentReader,
  type DocumentsErrorBody,
  ownReader,
  type ParsedDocument,
} from "./read.js";

/** OCR of a long scan takes minutes (MAX_OCR_PAGES); beyond this the service is gone. */
const READ_TIMEOUT_MS = 10 * 60_000;

const PARSED = z.object({
  markdown: z.string(),
  pages: z.number().int().nonnegative().nullable(),
  via: z.enum(["text", "ocr", "vision", "table", "mail"]),
}) satisfies z.ZodType<ParsedDocument>;

/** The documents service said no: its status and `error` (DocumentsErrorBody). */
export class DocumentsServiceError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Where the documents service answers, and the secret both sides share. */
export interface DocumentsServiceAddress {
  url: string;
  secret: string;
}

/**
 * The documents service (apps/documents, its Dockerfile) over HTTP: the document
 * goes in the request, its text comes back. It keeps nothing; what was read is kept here
 * (documents/parse.ts, `kept`).
 */
export function remoteReader(service: DocumentsServiceAddress): DocumentReader {
  return {
    async read({ data, name, mime }, opts = {}) {
      if (!service.url || !service.secret) {
        throw new Error(
          "The documents service isn’t set up on this server: DOCUMENTS_URL and DOCUMENTS_SECRET.",
        );
      }
      const timeout = AbortSignal.timeout(READ_TIMEOUT_MS);
      const res = await fetch(`${service.url}/read`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${service.secret}`,
          "content-type": mime,
          [DOCUMENT_NAME_HEADER]: encodeURIComponent(name),
        },
        body: data as BodyInit,
        signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
      }).catch((err) => {
        if (opts.signal?.aborted) {
          throw err;
        }
        throw new Error(`The documents service doesn’t answer: ${(err as Error).message}`);
      });
      if (!res.ok) {
        const answer = (await res.json().catch(() => ({}))) as Partial<DocumentsErrorBody>;
        throw new DocumentsServiceError(
          res.status,
          answer.error ?? "failed",
          answer.message ?? `The documents service answered ${res.status}.`,
        );
      }
      return PARSED.parse(await res.json());
    },
  };
}

let own: DocumentReader | null = null;

/**
 * What reads a document's own text (documents/read.ts): the documents service at `DOCUMENTS_URL`
 * where one is set (env.ts), else this process. A failed call to the service is a failure; this
 * process never reads in its place.
 */
export function documentsService(): DocumentReader {
  if (env.documentsUrl) {
    return remoteReader({ url: env.documentsUrl, secret: env.documentsSecret });
  }
  own ??= ownReader(join(env.dataDir, "tessdata"));
  return own;
}
