// Search over a catalogue held in memory: tools, skills, connectors, templates.
//
// Words and meaning together: the words find a name that is spelled out, the meaning finds what
// the person asks for in another language or other words. Words alone miss half of it (a German
// request over English entries); a decision model, where there is one, judges what both found.

import { type CatalogFieldWeights, scoreCatalogEntry } from "./catalog-lexical.js";
import { cosineSimilarity } from "./catalog-rank.js";
import { embedQueries, embedTexts, type SearchEmbedder } from "./embedder.js";

export interface CatalogEntry {
  id: string;
  // The name in words: "schedule set".
  title: string;
  // What it is and when to use it. English, like the code.
  description: string;
  // More words it is found by, less important: the inputs of a tool.
  details?: string;
}

export interface CatalogHit<T extends CatalogEntry = CatalogEntry> {
  entry: T;
  // How well it fits among this search's entries, 0 to 1.
  score: number;
  // P(it helps), where a decision model judged it.
  relevance: number | null;
}

export interface CatalogResult<T extends CatalogEntry = CatalogEntry> {
  hits: CatalogHit<T>[];
  // What found them: the words alone where no embedder answered in time.
  by: "meaning" | "words";
  // A decision model judged them: one that fits badly is not among them, and none may be.
  judged: boolean;
}

// Vectors of texts, kept by the vector space and the text's key.
export interface VectorStore {
  get(space: string, keys: string[]): Promise<Map<string, number[]>> | Map<string, number[]>;
  put(space: string, vectors: Map<string, number[]>): Promise<void> | void;
}

// Whether each candidate helps with the query, in their order: 0 to 1, null where it is open; null
// for all when there was no answer in time.
export type CatalogJudge = (
  query: string,
  candidates: CatalogEntry[],
  signal?: AbortSignal,
) => Promise<(number | null)[] | null>;

export interface CatalogSearchOptions {
  // The embedder to use now, or none. Asked at each search: the settings may change.
  embedder?: () => Promise<SearchEmbedder | null> | SearchEmbedder | null;
  // Only a fast decision model: a local one takes longer than a search may.
  judge?: CatalogJudge;
  store?: VectorStore;
  // How long a search waits for vectors and for the judge. Vectors that come later are kept.
  waitMs?: number;
  // Below this a judged candidate is left out.
  minRelevance?: number;
  log?: Pick<Console, "warn">;
}

export interface CatalogQuery {
  limit?: number;
  signal?: AbortSignal;
}

const WEIGHTS: CatalogFieldWeights = [
  ["title", 10],
  ["description", 6],
  ["details", 2],
];
// How much the meaning counts against the words, once both run from 0 to 1 over the entries.
const MEANING = 0.8;
const LIMIT = 6;
// What the judge reads: more than are given, so that it can bring one up.
const JUDGED = 12;
const WAIT_MS = 3000;
const MIN_RELEVANCE = 0.5;

// What an entry is embedded as: its purpose in one line, and all of it. The line is near a short
// request, the whole near a detailed one.
const lineOf = (entry: CatalogEntry): string =>
  `${entry.title}: ${entry.description.split(/(?<=[.!?])\s/)[0] ?? ""}`;
const textsOf = (entry: CatalogEntry): [string, string] => [
  lineOf(entry),
  `${entry.title}: ${entry.description}`,
];

const spread = (scores: number[]): number[] => {
  const max = Math.max(...scores);
  const min = Math.min(...scores);
  return scores.map((score) => (max > min ? (score - min) / (max - min) : 0));
};

export function memoryVectors(): VectorStore {
  const spaces = new Map<string, Map<string, number[]>>();
  return {
    get: (space, keys) => {
      const held = spaces.get(space);
      return new Map(
        keys.flatMap((key) => {
          const vector = held?.get(key);
          return vector ? [[key, vector] as const] : [];
        }),
      );
    },
    put: (space, vectors) => {
      const held = spaces.get(space) ?? new Map<string, number[]>();
      for (const [key, vector] of vectors) {
        held.set(key, vector);
      }
      spaces.set(space, held);
    },
  };
}

const late = Symbol("late");

async function within<T>(work: Promise<T>, ms: number, signal?: AbortSignal) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const end = new Promise<typeof late>((resolve) => {
    timer = setTimeout(() => resolve(late), ms);
    signal?.addEventListener("abort", () => resolve(late), { once: true });
  });
  try {
    return await Promise.race([work, end]);
  } finally {
    clearTimeout(timer);
  }
}

export interface CatalogSearch {
  // Embeds the entries ahead, so that a search need not wait for it.
  prepare(entries: CatalogEntry[]): Promise<void>;
  search<T extends CatalogEntry>(
    entries: T[],
    query: string,
    options?: CatalogQuery,
  ): Promise<CatalogResult<T>>;
}

export function createCatalogSearch(options: CatalogSearchOptions = {}): CatalogSearch {
  const store = options.store ?? memoryVectors();
  const waitMs = options.waitMs ?? WAIT_MS;
  const log = options.log ?? console;
  // One run of embedding at a time, per vector space: what it makes is kept for the next search.
  const running = new Map<string, Promise<unknown>>();

  const spaceOf = (embedder: SearchEmbedder) => `${embedder.modelId}@${embedder.dimensions}`;

  async function vectorsOf(embedder: SearchEmbedder, entries: CatalogEntry[]) {
    const space = spaceOf(embedder);
    const texts = [...new Set(entries.flatMap(textsOf))];
    const embed = async () => {
      const held = await store.get(space, texts);
      const missing = texts.filter((text) => !held.has(text));
      if (missing.length) {
        const made = await embedTexts(embedder, missing);
        const fresh = new Map(missing.map((text, at) => [text, made[at] ?? []]));
        await store.put(space, fresh);
        for (const [text, vector] of fresh) {
          held.set(text, vector);
        }
      }
      return held;
    };
    const run = (running.get(space) ?? Promise.resolve()).then(embed, embed);
    running.set(space, run);
    return run;
  }

  async function meaningOf(embedder: SearchEmbedder, entries: CatalogEntry[], query: string) {
    const [held, [asked]] = await Promise.all([
      vectorsOf(embedder, entries),
      embedQueries(embedder, [query]),
    ]);
    if (!asked) {
      return null;
    }
    return entries.map((entry) => {
      const near = textsOf(entry).map((text) => cosineSimilarity(held.get(text) ?? [], asked));
      return near.reduce((sum, value) => sum + value, 0) / near.length;
    });
  }

  const current = async () => (await options.embedder?.()) ?? null;

  return {
    async prepare(entries) {
      const embedder = await current();
      if (embedder && entries.length) {
        await vectorsOf(embedder, entries);
      }
    },
    async search(entries, query, { limit = LIMIT, signal } = {}) {
      const text = query.trim();
      if (!(entries.length && text)) {
        return { hits: [], by: "words", judged: false };
      }
      const words = entries.map((entry) =>
        scoreCatalogEntry({ ...entry } as Record<string, unknown>, text, WEIGHTS),
      );
      const warn = (what: string) => (error: unknown) => {
        log.warn(`[catalog-search] ${what}:`, error instanceof Error ? error.message : error);
        return null;
      };
      const embedder = await current().catch(warn("no embedder"));
      const found = embedder
        ? await within(meaningOf(embedder, entries, text).catch(warn("no vectors")), waitMs, signal)
        : null;
      const meaning = found === late ? null : found;
      const near = meaning && spread(meaning);
      const spelled = spread(words);
      const ranked = entries
        .map((entry, at) => ({
          entry,
          score: near
            ? (near[at] ?? 0) * MEANING + (spelled[at] ?? 0) * (1 - MEANING)
            : (spelled[at] ?? 0),
          relevance: null as number | null,
        }))
        .filter((_hit, at) => near || (words[at] ?? 0) > 0)
        .sort((a, b) => b.score - a.score);
      const by = near ? "meaning" : "words";
      const pool = ranked.slice(0, Math.max(JUDGED, limit));
      if (options.judge && pool.length) {
        const judged = await within(
          options
            .judge(
              text,
              pool.map((hit) => hit.entry),
              signal,
            )
            .catch(warn("no decision")),
          waitMs,
          signal,
        );
        if (judged && judged !== late) {
          const min = options.minRelevance ?? MIN_RELEVANCE;
          const hits = pool
            .map((hit, at) => ({ ...hit, relevance: judged[at] ?? null }))
            // What the judge left open keeps its place by score.
            .filter((hit) => hit.relevance === null || hit.relevance >= min)
            .sort((a, b) => (b.relevance ?? min) - (a.relevance ?? min) || b.score - a.score)
            .slice(0, limit);
          return { hits, by, judged: true };
        }
      }
      return { hits: ranked.slice(0, limit), by, judged: false };
    },
  };
}
