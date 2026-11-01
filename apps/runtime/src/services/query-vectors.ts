import { setTimeout as sleep } from "node:timers/promises";
import { embedMany } from "ai";
import { embeddingModel } from "../models.js";

/**
 * The vector of a search's query. The embedding model is the index's too: in an Ollama that is
 * embedding a folder, a query's call waits behind every passage sent before it (36 s measured).
 * So a query is embedded once (the palette asks twice, a client space's search once per space),
 * the indexers send nothing new while one is on its way (`searchesFirst`), and a search waits
 * only as long as it is given.
 */

/** How many queries' vectors are kept. */
const KEPT = 64;
/** An embedding model that has not answered in this time is not going to. */
const GIVE_UP_MS = 120_000;

const vectors = new Map<string, Promise<{ vector: number[]; model: string } | null>>();
let pending = 0;
let waiting: (() => void)[] = [];

/**
 * The query's vector and the model it comes from. Null without an embedding model or when it
 * failed; undefined when it did not come within `waitMs` (it is kept for the next ask).
 */
export async function queryVector(
  query: string,
  waitMs: number,
): Promise<{ vector: number[]; model: string } | null | undefined> {
  const resolved = await embeddingModel().catch(() => null);
  if (!resolved) {
    return null;
  }
  const key = `${resolved.ref}\n${query}`;
  let found = vectors.get(key);
  if (!found) {
    pending++;
    found = embedMany({
      model: resolved.model,
      values: [query],
      abortSignal: AbortSignal.timeout(GIVE_UP_MS),
    })
      .then((r) => ({ vector: Array.from(r.embeddings[0]), model: resolved.ref }))
      .catch(() => {
        vectors.delete(key);
        return null;
      })
      .finally(() => {
        pending--;
        if (!pending) {
          for (const go of waiting) {
            go();
          }
          waiting = [];
        }
      });
    vectors.set(key, found);
    if (vectors.size > KEPT) {
      vectors.delete(vectors.keys().next().value as string);
    }
  }
  return Promise.race([found, sleep(waitMs, undefined, { ref: false })]);
}

/** Resolves once no query's vector is on its way: an indexer calls it before it sends a batch. */
export function searchesFirst(): Promise<void> {
  return pending ? new Promise((resolve) => waiting.push(resolve)) : Promise.resolve();
}
