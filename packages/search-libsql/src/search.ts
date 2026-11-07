import { createHash } from "node:crypto";
import type { DecisionModel } from "@engenty/decision-model";
import { embedImage, embedQueries, embedTexts, type SearchEmbedder } from "@engenty/search-index";
import type { Client, InStatement, Row } from "@libsql/client";
import { canSee, jpegOf, pdfPages } from "./media.js";
import {
  type DocumentReaders,
  type HitKind,
  indexable,
  namePassage,
  type Passage,
  passagesOf,
} from "./passages.js";
import { judgeRelevance, MIN_RELEVANCE } from "./relevance.js";
import { migrate } from "./schema.js";
import { extOf, nameWords, snippet, termsOf } from "./text.js";

// The search over a folder of files, for a search box and for an assistant.
// Each file is cut into passages (chunks.ts); images and PDF pages are
// passages too. Every passage is in a full-text index (SQLite FTS5) and, where
// an embedder is given, has a vector; images and pages are embedded as
// pictures where the embedder sees them (`embedImage`). A search takes the
// best of both (reciprocal rank fusion), and a decision model checks the first
// ones and ranks them by how well they answer. Without an embedder the search
// finds words; without a decision model the fused order stays.
//
// The index is brought up to date by `sync`: when the source's head moves (or,
// without a head, any file's version). Only files whose version changed are
// read again, and only passages without a vector of the current model are
// embedded, in the background.

/** How many candidates each half of the search gives, and how many the decision model checks. */
const POOL = 50;
const JUDGED = 20;
/** Clef-flash on a laptop reads slowly: fewer candidates, and less of each. */
const JUDGED_LOCAL = 10;
const JUDGE_MS = 6000;
const JUDGE_LOCAL_MS = 30_000;
const JUDGE_CHARS = 1200;
const JUDGE_LOCAL_CHARS = 500;
/** How far the nearest passage has to stand out from the median one to count (cosine). */
export const MIN_LEAD = 0.08;
/** Reciprocal rank fusion's constant, as is usual. */
export const RRF_K = 60;
/** Passages embedded in one call. */
const BATCH = 32;
/** Files the embedding run takes from the database at once. */
const PAGE = 200;
/** How long a question's vector may take. */
const QUERY_EMBED_MS = 8000;
/** A run that failed is tried again after this long, if nothing else starts one sooner. */
const RETRY_MS = 30_000;
/** After this many files in a row fail to embed, the embedder is left alone a while. */
const FAILURES_IN_ROW = 3;
const PAUSE_MS = 5 * 60_000;
const DEFAULT_LIMIT = 20;
const SUGGESTION_MIN = 8;
const SUGGESTION_MAX = 60;

export type { HitKind } from "./passages.js";

export interface SearchHit {
  heading: string | null;
  kind: HitKind;
  /** The line the hit is on, 1-based (0 for images and PDF pages). */
  line: number;
  /** A PDF's page, 1-based. */
  page: number | null;
  /** The passage, for an assistant. */
  passage: string;
  path: string;
  /** P(relevant) from the decision model; null where it did not judge. */
  relevance: number | null;
  /** The line or sentence that matched, cut to fit. */
  text: string;
  /** A picture of the hit, as `thumbUrl` names it: an image file, or a PDF page's thumbnail. */
  thumb: string | null;
}

export interface SearchResult {
  /** Whether a decision model is there: a search without `rerank` can ask again with it. */
  canRank: boolean;
  hits: SearchHit[];
  /** Whether vectors took part; false: words only. */
  meaning: boolean;
  /** Whether a decision model ranked the hits. */
  ranked: boolean;
}

export interface SearchOptions {
  /** Leave out what the decision model finds irrelevant (for an assistant). */
  drop?: boolean;
  limit?: number;
  /** Hits per file; 1 for a list of files, more for an assistant. */
  perFile?: number;
  /** Let the decision model rank the first hits. */
  rerank?: boolean;
  signal?: AbortSignal;
}

export interface SearchSourceFile {
  path: string;
  /** Bytes; where given, files too large to index are left out. */
  size?: number;
  /** Changes whenever the file's content does (a blob SHA, an mtime). */
  version: string;
}

/** What the index reads: the host's files, read only. */
export interface SearchSource {
  read(path: string): Promise<{ text: string } | null>;
  readBytes(path: string): Promise<Uint8Array | null>;
  /** The files, and the head they are at (a commit); null head: by the files' versions. */
  tree(): Promise<{ head: string | null; files: SearchSourceFile[] }>;
}

type Maybe<T> = T | null | undefined;
/** A value, or a function the search asks before each use (settings may change it). */
export type Current<T> = Maybe<T> | (() => Maybe<T> | Promise<Maybe<T>>);

export interface SearchStatus {
  /** Files with vectors of the current embedder. */
  embedded: number;
  files: number;
  images: number;
  /** The last file that failed to embed, and why. */
  lastError: string | null;
  pages: number;
  passages: number;
  /** Whether embedding runs now. */
  running: boolean;
}

export type SearchLog = Pick<Console, "error" | "log" | "warn">;

export interface LibsqlSearchOptions {
  /** The host's libSQL client; the index keeps its tables (`search_*`) there. */
  db: Client;
  /** Text out of documents the package does not read itself (workbooks), by extension. */
  documents?: DocumentReaders;
  /** Who turns passages, images and questions into vectors; none: words only. */
  embedder?: Current<SearchEmbedder>;
  /** The decision model that ranks what the index found; none: the fused order stays. */
  judge?: Current<DecisionModel>;
  log?: SearchLog;
  source: SearchSource;
  /** The URL of a hit's picture: an image file (`passage` null) or a passage's thumbnail. */
  thumbUrl?: (t: { path: string; passage: number | null }) => string | null;
}

/** A SearchEmbedder is a function too: it is told from a getter by its `modelId`. */
async function currentEmbedder(e: Current<SearchEmbedder>): Promise<SearchEmbedder | null> {
  if (typeof e === "function" && !("modelId" in e)) {
    return (await (e as () => Maybe<SearchEmbedder>)()) ?? null;
  }
  return (e as Maybe<SearchEmbedder>) ?? null;
}

async function currentJudge(j: Current<DecisionModel>): Promise<DecisionModel | null> {
  return (typeof j === "function" ? await j() : j) ?? null;
}

const toBlob = (v: Float32Array) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength);

/** A BLOB as bytes. */
const fromBytes = (b: unknown): Uint8Array | null => {
  if (b instanceof ArrayBuffer) {
    return new Uint8Array(b);
  }
  return ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : null;
};

/** A vector from its BLOB; a copy, as the database's buffer need not be aligned for floats. */
const fromBlob = (b: unknown): Float32Array | null => {
  const bytes = fromBytes(b);
  return bytes ? new Float32Array(bytes.slice().buffer) : null;
};

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A file's passages out of the index, by its path. */
const removeFile = (path: string): InStatement[] => [
  {
    args: [path],
    sql: `DELETE FROM search_text WHERE rowid IN (
            SELECT c.id FROM search_chunk c JOIN search_file f ON f.id = c.file_id WHERE f.path = ?)`,
  },
  {
    args: [path],
    sql: "DELETE FROM search_chunk WHERE file_id = (SELECT id FROM search_file WHERE path = ?)",
  },
];

/** A file and all its passages, as one transaction's statements. */
const writeFile = (f: { path: string; version: string }, passages: Passage[]): InStatement[] => [
  {
    args: [f.path, f.version],
    sql: `INSERT INTO search_file (path, version, embedded) VALUES (?, ?, NULL)
          ON CONFLICT (path) DO UPDATE SET version = excluded.version, embedded = NULL`,
  },
  ...removeFile(f.path),
  ...passages.flatMap((p): InStatement[] => [
    {
      args: [f.path, p.kind, p.heading, p.line, p.page, p.text, p.thumb],
      sql: `INSERT INTO search_chunk (file_id, kind, heading, line, page, text, thumb)
            VALUES ((SELECT id FROM search_file WHERE path = ?), ?, ?, ?, ?, ?, ?)`,
    },
    {
      args: [f.path, p.heading ?? "", p.text],
      sql: "INSERT INTO search_text (rowid, path, heading, body) VALUES (last_insert_rowid(), ?, ?, ?)",
    },
  ]),
];

/** Reciprocal rank fusion: a passage high in either list, or fairly high in both, comes first. */
export function fuse(lists: number[][]): Map<number, number> {
  const fused = new Map<number, number>();
  for (const list of lists) {
    list.forEach((id, rank) => {
      fused.set(id, (fused.get(id) ?? 0) + 1 / (RRF_K + rank + 1));
    });
  }
  return fused;
}

/**
 * The passages nearest to the question, by cosine. The nearest are near even
 * for a question the files know nothing of: what counts is how far the best
 * stand out from the middle. Too little, and meaning adds nothing.
 */
export function nearest(q: ArrayLike<number>, rows: { id: number; v: Float32Array }[]): number[] {
  const scored = rows.map((r) => {
    let dot = 0;
    for (let i = 0; i < q.length; i++) {
      dot += (q[i] ?? 0) * (r.v[i] ?? 0);
    }
    return { dot, id: r.id };
  });
  scored.sort((a, b) => b.dot - a.dot);
  const top = scored[0]?.dot ?? 0;
  const median = scored[Math.floor(scored.length / 2)]?.dot ?? 0;
  if (top - median < MIN_LEAD) {
    return [];
  }
  const floor = median + (top - median) / 2;
  return scored
    .slice(0, POOL)
    .filter((s) => s.dot >= floor)
    .map((s) => s.id);
}

/** A promise that rejects after `ms`, or when the signal fires. */
function deadline(ms: number, what: string, signal?: AbortSignal) {
  return new Promise<never>((_, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} took too long.`)), ms);
    t.unref?.();
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    });
  });
}

interface Candidate {
  heading: string | null;
  id: number;
  kind: HitKind;
  line: number;
  page: number | null;
  path: string;
  relevance: number | null;
  text: string;
  thumb: boolean;
}

const candidateOf = (id: number, r: Row): Candidate => ({
  heading: r.heading === null ? null : String(r.heading),
  id,
  kind: String(r.kind) as HitKind,
  line: Number(r.line),
  page: r.page === null ? null : Number(r.page),
  path: String(r.path),
  relevance: null,
  text: String(r.text),
  thumb: Boolean(r.thumb),
});

/** A search index on libSQL over the files a source gives. */
export function createLibsqlSearch(o: LibsqlSearchOptions) {
  const { db, source } = o;
  const log = o.log ?? console;
  const documents = o.documents ?? {};
  const thumbUrl = o.thumbUrl ?? (() => null);
  let ready: Promise<void> | null = null;
  let indexedAt: string | null = null;
  let running: Promise<void> | null = null;
  let again = false;
  let retry: ReturnType<typeof setTimeout> | null = null;

  /** The schema, once; tried again on the next run if it failed (a locked database). */
  const migrated = () => {
    ready ??= migrate(db).catch((err) => {
      ready = null;
      throw err;
    });
    return ready;
  };

  const update = async () => {
    await migrated();
    const tree = await source.tree();
    const files = tree.files.filter((f) => indexable(f, documents));
    const key =
      tree.head ??
      createHash("sha1")
        .update(files.map((f) => `${f.path}@${f.version}`).join("\n"))
        .digest("hex");
    if (key === indexedAt) {
      return;
    }
    const known = new Map(
      (await db.execute("SELECT id, path, version FROM search_file")).rows.map((r) => [
        String(r.path),
        String(r.version),
      ]),
    );
    const wanted = new Set(files.map((f) => f.path));
    const gone = [...known.keys()].filter((path) => !wanted.has(path));
    if (gone.length) {
      await db.batch(
        gone.flatMap((path) => [
          ...removeFile(path),
          { args: [path], sql: "DELETE FROM search_file WHERE path = ?" },
        ]),
        "write",
      );
    }
    let changed = 0;
    for (const f of files) {
      if (known.get(f.path) === f.version) {
        continue;
      }
      let passages: Passage[];
      try {
        passages = await passagesOf(source, f.path, documents);
      } catch (err) {
        // A broken PDF or workbook: indexed by its name, and read again when it changes.
        log.warn(`[search] can't read ${f.path}:`, message(err));
        passages = namePassage(f.path);
      }
      // The file and all its passages in one transaction: a run that fails
      // leaves the file as it was, to be read again on the next.
      await db.batch(writeFile(f, passages), "write");
      changed++;
    }
    if (changed || gone.length) {
      log.log(`[search] indexed ${changed} files, removed ${gone.length} (${key.slice(0, 7)})`);
      vectors = null;
    }
    indexedAt = key;
    embedAll().catch(() => undefined);
  };

  /**
   * Brings the index up to date. One run at a time: a call while one runs
   * shares it, and one more run follows it (the call may have come for a
   * change the running one missed). A run that fails is tried again later.
   */
  const sync = (): Promise<void> => {
    if (running) {
      again = true;
      return running;
    }
    if (retry) {
      clearTimeout(retry);
      retry = null;
    }
    running = update()
      .catch((err) => {
        log.error(`[search] indexing failed, again in ${RETRY_MS / 1000} s:`, err);
        retry ??= setTimeout(() => {
          retry = null;
          sync().catch(() => undefined);
        }, RETRY_MS);
        retry.unref?.();
      })
      .finally(() => {
        running = null;
        if (again) {
          again = false;
          sync().catch(() => undefined);
        }
      });
    return running;
  };

  // Embedding, in the background: passages without a vector of the current model.
  let embedding: Promise<void> | null = null;
  let embedAgain = false;
  /** After failures in a row the embedder is left alone a while. */
  let pausedUntil = 0;
  let lastError: string | null = null;
  /** Files that failed, by id and version: tried again when they change or after a pause. */
  const failed = new Set<string>();

  /** Vectors for the passages that are pictures: images, and PDF pages as pictured. */
  const pictureVectors = async (
    embedder: SearchEmbedder,
    file: { path: string },
    visual: Row[],
    title: string,
  ) => {
    const out = new Map<number, Float32Array>();
    const bytes = await source.readBytes(file.path);
    if (!bytes) {
      throw new Error("the file can't be read");
    }
    if (extOf(file.path) === "pdf") {
      const pages = await pdfPages(bytes, true);
      for (const r of visual) {
        const jpeg = pages.find((p) => p.page === Number(r.page))?.jpeg;
        // Pages past the pictured ones go by their text.
        const v = jpeg
          ? await embedImage(embedder, { data: jpeg, mimeType: "image/jpeg" })
          : (await embedTexts(embedder, [String(r.text)], { title }))[0];
        if (v) {
          out.set(Number(r.id), Float32Array.from(v));
        }
      }
      return out;
    }
    const v = Float32Array.from(
      await embedImage(embedder, {
        data: await jpegOf(bytes),
        mimeType: "image/jpeg",
      }),
    );
    for (const r of visual) {
      out.set(Number(r.id), v);
    }
    return out;
  };

  const embedFile = async (
    embedder: SearchEmbedder,
    file: { id: number; path: string; version: string },
  ) => {
    const rows = (
      await db.execute({
        args: [file.id],
        sql: "SELECT id, kind, heading, page, text FROM search_chunk WHERE file_id = ? ORDER BY id",
      })
    ).rows;
    const title = nameWords(file.path);
    const sees = Boolean(embedder.images && embedder.embedImage) && (await canSee());
    const visual = sees ? rows.filter((r) => r.kind !== "text") : [];
    const textual = rows.filter((r) => !visual.includes(r));
    const found = new Map<number, Float32Array>();
    for (let i = 0; i < textual.length; i += BATCH) {
      const batch = textual.slice(i, i + BATCH);
      const got = await embedTexts(
        embedder,
        batch.map((r) => (r.heading ? `${r.heading}\n${r.text}` : String(r.text))),
        { title },
      );
      batch.forEach((r, j) => {
        const v = got[j];
        if (v) {
          found.set(Number(r.id), Float32Array.from(v));
        }
      });
    }
    if (visual.length) {
      for (const [id, v] of await pictureVectors(embedder, file, visual, title)) {
        found.set(id, v);
      }
    }
    // Only if the file is still at the version embedded: a newer one has passages of its own.
    await db.batch(
      [
        ...[...found].map(([id, v]) => ({
          args: [toBlob(v), id],
          sql: "UPDATE search_chunk SET vector = ? WHERE id = ?",
        })),
        {
          args: [embedder.modelId, file.id, file.version],
          sql: "UPDATE search_file SET embedded = ? WHERE id = ? AND version = ?",
        },
      ],
      "write",
    );
  };

  /** The models the last run named in the log: said again only when they change. */
  let logged = "";

  const logModels = (embedder: SearchEmbedder | null, judge: DecisionModel | null) => {
    const vectorsBy = embedder
      ? `${embedder.modelId}${embedder.images ? " (with images)" : ""}`
      : "none, words only";
    const ranking = judge ? `${judge.way} ${judge.model}` : "none";
    const models = `embedding: ${vectorsBy}; ranking: ${ranking}`;
    if (models !== logged) {
      log.log(`[search] ${models}`);
      logged = models;
    }
  };

  /** The files that wait for vectors of this embedder, a page at a time. */
  const waiting = async (ref: string) =>
    (
      await db.execute({
        args: [ref, PAGE],
        sql: `SELECT id, path, version FROM search_file
              WHERE embedded IS NULL OR embedded != ? ORDER BY id LIMIT ?`,
      })
    ).rows
      .map((r) => ({
        id: Number(r.id),
        path: String(r.path),
        version: String(r.version),
      }))
      .filter((f) => !failed.has(`${f.id}@${f.version}`));

  const embedPending = async () => {
    if (Date.now() < pausedUntil) {
      return;
    }
    const [embedder, judge] = await Promise.all([
      currentEmbedder(o.embedder),
      currentJudge(o.judge),
    ]);
    logModels(embedder, judge);
    if (!embedder) {
      return;
    }
    let done = 0;
    let inRow = 0;
    const started = Date.now();
    let files = await waiting(embedder.modelId);
    while (files.length && inRow < FAILURES_IN_ROW) {
      for (const file of files) {
        try {
          await embedFile(embedder, file);
          done++;
          inRow = 0;
        } catch (err) {
          lastError = `${file.path}: ${message(err)}`;
          log.warn(`[search] can't embed ${lastError}`);
          failed.add(`${file.id}@${file.version}`);
          inRow++;
          if (inRow >= FAILURES_IN_ROW) {
            // The model is not there or not working: later, everything again.
            pausedUntil = Date.now() + PAUSE_MS;
            failed.clear();
            break;
          }
        }
      }
      vectors = null;
      if (inRow < FAILURES_IN_ROW) {
        files = await waiting(embedder.modelId);
      }
    }
    if (done) {
      lastError = inRow ? lastError : null;
      log.log(
        `[search] embedded ${done} files with ${embedder.modelId} in ${Math.round((Date.now() - started) / 1000)} s`,
      );
    }
  };

  /** Embeds what has no vector yet; a call while one runs makes one more follow. */
  const embedAll = (): Promise<void> => {
    if (embedding) {
      embedAgain = true;
      return embedding;
    }
    embedding = embedPending()
      .catch((err) => log.error("[search] embedding", err))
      .finally(() => {
        embedding = null;
        if (embedAgain) {
          embedAgain = false;
          embedAll().catch(() => undefined);
        }
      });
    return embedding;
  };

  /** Forgets failures and pauses (the embedder changed), then embeds what is missing. */
  const retryEmbedding = (): Promise<void> => {
    pausedUntil = 0;
    failed.clear();
    return embedAll();
  };

  /** The vectors of one model, in memory: a search compares the question with all of them. */
  let vectors: { ref: string; rows: { id: number; v: Float32Array }[] } | null = null;
  const vectorsOf = async (ref: string) => {
    if (vectors?.ref !== ref) {
      const rows = (
        await db.execute({
          args: [ref],
          sql: `SELECT c.id, c.vector FROM search_chunk c JOIN search_file f ON f.id = c.file_id
                WHERE f.embedded = ? AND c.vector IS NOT NULL`,
        })
      ).rows.flatMap((r) => {
        const v = fromBlob(r.vector);
        return v ? [{ id: Number(r.id), v }] : [];
      });
      vectors = { ref, rows };
    }
    return vectors.rows;
  };

  /** Passages by words: every word first, then any of them, best first (BM25). */
  const byWords = async (terms: string[]) => {
    const ids: number[] = [];
    for (const join of [" ", " OR "]) {
      if (!terms.length || ids.length >= POOL || (join === " OR " && terms.length === 1)) {
        break;
      }
      const rows = await db.execute({
        args: [terms.map((t) => `"${t}"*`).join(join), POOL],
        sql: `SELECT rowid FROM search_text WHERE search_text MATCH ?
              ORDER BY bm25(search_text, 4.0, 2.0, 1.0) LIMIT ?`,
      });
      for (const r of rows.rows) {
        const id = Number(r.rowid);
        if (!ids.includes(id) && ids.length < POOL) {
          ids.push(id);
        }
      }
    }
    return ids;
  };

  /** Passages by meaning: the question's vector against every passage's, nearest first. */
  const byMeaning = async (embedder: SearchEmbedder, query: string, signal?: AbortSignal) => {
    const rows = await vectorsOf(embedder.modelId);
    if (!rows.length) {
      return null;
    }
    const [q] = await Promise.race([
      embedQueries(embedder, [query]),
      deadline(QUERY_EMBED_MS, "The embedding model", signal),
    ]);
    return q ? nearest(q, rows) : null;
  };

  /** The fused candidates as rows, best first, at most `perFile` of each file. */
  const candidates = async (fused: Map<number, number>, perFile: number, count: number) => {
    const ids = [...fused.keys()];
    const rows = (
      await db.execute({
        args: ids,
        sql: `SELECT c.id, f.path, c.kind, c.heading, c.line, c.page, c.text, c.thumb IS NOT NULL AS thumb
              FROM search_chunk c JOIN search_file f ON f.id = c.file_id
              WHERE c.id IN (${ids.map(() => "?").join(",")})`,
      })
    ).rows;
    const byId = new Map(rows.map((r) => [Number(r.id), r]));
    const perPath = new Map<string, number>();
    return ids
      .sort((a, b) => (fused.get(b) ?? 0) - (fused.get(a) ?? 0))
      .flatMap((id) => {
        const r = byId.get(id);
        if (!r) {
          return [];
        }
        const c = candidateOf(id, r);
        const n = perPath.get(c.path) ?? 0;
        if (n >= perFile) {
          return [];
        }
        perPath.set(c.path, n + 1);
        return [c];
      })
      .slice(0, count);
  };

  /** The decision model reads the passages with text; an image keeps its place. */
  const rank = async (
    judge: DecisionModel,
    query: string,
    pool: Candidate[],
    options: SearchOptions,
  ): Promise<Candidate[] | null> => {
    const local = judge.way === "local";
    const judged = pool.slice(0, local ? JUDGED_LOCAL : JUDGED).filter((c) => c.kind !== "image");
    const scores = await judgeRelevance(judge, query, judged, {
      chars: local ? JUDGE_LOCAL_CHARS : JUDGE_CHARS,
      deadlineMs: local ? JUDGE_LOCAL_MS : JUDGE_MS,
      log,
      signal: options.signal,
    });
    if (!scores) {
      return null;
    }
    judged.forEach((c, i) => {
      c.relevance = scores[i] ?? null;
    });
    const order = [...judged].sort((a, b) => (b.relevance ?? -1) - (a.relevance ?? -1));
    let next = 0;
    const list = pool.map((c) => (judged.includes(c) ? (order[next++] ?? c) : c));
    // Only what the model read and found to answer (or left open); images keep their place.
    return options.drop
      ? list.filter(
          (c) =>
            c.kind === "image" ||
            (judged.includes(c) && (c.relevance === null || c.relevance >= MIN_RELEVANCE)),
        )
      : list;
  };

  const hitOf =
    (terms: string[]) =>
    (c: Candidate): SearchHit => {
      const s = c.kind === "image" ? { at: 0, text: "" } : snippet(c.text, terms);
      let thumb: string | null = null;
      if (c.kind === "image") {
        thumb = thumbUrl({ passage: null, path: c.path });
      } else if (c.thumb) {
        thumb = thumbUrl({ passage: c.id, path: c.path });
      }
      return {
        heading: c.heading,
        kind: c.kind,
        line: c.kind === "text" && c.line > 0 ? c.line + s.at : 0,
        page: c.page,
        passage: c.text,
        path: c.path,
        relevance: c.relevance,
        text: s.text,
        thumb,
      };
    };

  /** A search: by words and, with an embedder, by meaning; ranked on `rerank`. */
  const query = async (text: string, options: SearchOptions = {}): Promise<SearchResult> => {
    const limit = options.limit ?? DEFAULT_LIMIT;
    const terms = termsOf(text);
    const [embedder, judge] = await Promise.all([
      currentEmbedder(o.embedder),
      currentJudge(o.judge),
    ]);
    const empty = {
      canRank: Boolean(judge),
      hits: [],
      meaning: false,
      ranked: false,
    };
    if (!(text.trim() && (terms.length || embedder))) {
      return empty;
    }
    await sync();
    const [words, meaning] = await Promise.all([
      byWords(terms),
      embedder
        ? byMeaning(embedder, text.trim(), options.signal).catch((err) => {
            log.warn("[search] by words only:", message(err));
            return null;
          })
        : null,
    ]);
    const fused = fuse([words, meaning ?? []]);
    if (!fused.size) {
      return { ...empty, meaning: Boolean(meaning) };
    }
    const pool = await candidates(fused, options.perFile ?? 1, Math.max(limit, JUDGED));
    const ranked = options.rerank && judge ? await rank(judge, text, pool, options) : null;
    return {
      canRank: Boolean(judge),
      hits: (ranked ?? pool).slice(0, limit).map(hitOf(terms)),
      meaning: Boolean(meaning),
      ranked: Boolean(ranked),
    };
  };

  /** The index's state, for a settings page. */
  const status = async (): Promise<SearchStatus> => {
    await migrated();
    const embedder = await currentEmbedder(o.embedder);
    const files = await db.execute({
      args: [embedder?.modelId ?? ""],
      sql: "SELECT COUNT(*) AS files, COALESCE(SUM(embedded = ?), 0) AS embedded FROM search_file",
    });
    const kinds = await db.execute("SELECT kind, COUNT(*) AS n FROM search_chunk GROUP BY kind");
    const n = (kind: string) => Number(kinds.rows.find((r) => r.kind === kind)?.n ?? 0);
    return {
      embedded: Number(files.rows[0]?.embedded ?? 0),
      files: Number(files.rows[0]?.files ?? 0),
      images: n("image"),
      lastError,
      pages: n("page"),
      passages: n("text"),
      running: Boolean(embedding),
    };
  };

  /** A passage's thumbnail (a PDF page's), as JPEG bytes. */
  const thumb = async (passage: number): Promise<Uint8Array | null> => {
    await migrated();
    const row = (
      await db.execute({
        args: [passage],
        sql: "SELECT thumb FROM search_chunk WHERE id = ? AND thumb IS NOT NULL",
      })
    ).rows[0];
    return row ? fromBytes(row.thumb) : null;
  };

  /**
   * Searches to try, before anything is typed: a heading of each of the files
   * given (the ones changed last), in their order.
   */
  const suggestions = async (paths: string[], max = 4): Promise<string[]> => {
    await migrated();
    if (!paths.length) {
      return [];
    }
    const headings = (
      await db.execute({
        args: paths,
        sql: `SELECT f.path, c.heading FROM search_chunk c JOIN search_file f ON f.id = c.file_id
              WHERE c.heading IS NOT NULL AND f.path IN (${paths.map(() => "?").join(",")})
              ORDER BY c.id`,
      })
    ).rows.map((h) => ({
      heading: String(h.heading).trim(),
      path: String(h.path),
    }));
    const out: string[] = [];
    for (const path of paths) {
      const found = headings.find(
        (h) =>
          h.path === path &&
          h.heading.length >= SUGGESTION_MIN &&
          h.heading.length <= SUGGESTION_MAX &&
          // A heading that is a file's name ("3. appstore-03.jpg") is no question.
          !/\.\w{2,4}$/.test(h.heading) &&
          !out.includes(h.heading),
      );
      if (found && out.length < max) {
        out.push(found.heading);
      }
    }
    return out;
  };

  return {
    embedAll,
    query,
    retryEmbedding,
    status,
    suggestions,
    sync,
    thumb,
  };
}

export type LibsqlSearch = ReturnType<typeof createLibsqlSearch>;
