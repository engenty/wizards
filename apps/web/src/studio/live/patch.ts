import type { LiveChange, LiveKind } from "@engenty/wizards-shared/live";
import { notifyManager, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { beginOptimisticUpdate, createDebouncedInvalidator } from "../../lib/optimistic";

/**
 * Live changes into the studio's cache (docs/plans/live-changes.md, 5). Each area declares a
 * `LiveBinding` beside its queries: the kinds it shows, how a change goes into its cached
 * queries, and what to fetch again where it can't. Here are the shared steps: newer wins, a GET
 * in flight can't bring an older state back, a patcher that fails falls back to fetching.
 */

export interface LivePatch {
  qc: QueryClient;
  /** Fetches a key again, once per short while, only where it is shown. */
  invalidate: (key: QueryKey) => void;
  /** Marks an item as changed elsewhere, for a moment (`useLiveFlash`). */
  flash: (id: string) => void;
}

export interface LiveBinding {
  id: string;
  kinds: readonly LiveKind[];
  /** Writes the change into the cache; may also invalidate computed lists. */
  patch: (change: LiveChange, live: LivePatch) => void | Promise<void>;
  /** What to fetch again when the change came without a view, or the patch failed. */
  fallback: (change: LiveChange) => QueryKey[];
}

const bindings: LiveBinding[] = [];

/** Adds an area's bindings; the feed reads them all (`useLiveFeed`). */
export function registerLiveBindings(list: LiveBinding[]) {
  for (const b of list) {
    if (!bindings.some((x) => x.id === b.id)) {
      bindings.push(b);
    }
  }
}

export const liveBindings = (): readonly LiveBinding[] => bindings;

// --- open editors take their item's changes themselves (6) ------------------------------------

type EditorPatch = (change: LiveChange) => void;
const editors = new Map<string, EditorPatch>();

/** An open editor of an item: its changes go to it instead of into the cache. */
export function registerLiveEditor(kind: LiveKind, id: string, onPatch: EditorPatch) {
  const key = `${kind}|${id}`;
  editors.set(key, onPatch);
  return () => {
    if (editors.get(key) === onPatch) {
      editors.delete(key);
    }
  };
}

export const liveEditor = (kind: LiveKind, id: string) => editors.get(`${kind}|${id}`);

// --- the shared steps --------------------------------------------------------------------------

interface Versioned {
  updatedAt?: string | null;
  revision?: number | null;
}

/** Whether `next` is newer than what is cached; equal counts as not (an own save's echo). */
export function isNewer(cached: Versioned | undefined | null, next: Versioned): boolean {
  if (!cached) {
    return true;
  }
  if (typeof next.revision === "number" && typeof cached.revision === "number") {
    return next.revision > cached.revision;
  }
  if (next.updatedAt && cached.updatedAt) {
    return Date.parse(next.updatedAt) > Date.parse(cached.updatedAt);
  }
  return true;
}

/**
 * Puts a view into a detail query when it is newer. A GET that was running is cancelled first
 * and started again, so its answer, older or not, can't land after the patch.
 */
export async function putDetail<T>(
  qc: QueryClient,
  key: QueryKey,
  next: (cached: T | undefined) => T | undefined,
): Promise<boolean> {
  if (!qc.getQueryCache().find({ queryKey: key, exact: true })) {
    return false;
  }
  let changed = false;
  const tx = await beginOptimisticUpdate<T>(qc, {
    queryKey: key,
    update: (cached) => {
      const value = next(cached);
      if (value === undefined || value === cached) {
        return cached;
      }
      changed = true;
      return value;
    },
  });
  if (tx.wasFetching) {
    void tx.invalidate();
  }
  return changed;
}

/** Every cached query under `prefix` that holds a list of items with ids. */
export function patchLists<T extends { id: string }>(
  qc: QueryClient,
  prefix: QueryKey,
  change: (list: T[]) => T[] | undefined,
) {
  qc.setQueriesData<T[]>({ queryKey: prefix }, (list) => {
    if (!Array.isArray(list)) {
      return list;
    }
    return change(list) ?? list;
  });
}

/** Replaces the item with the same id when it is newer; `add` places one that isn't there. */
export function upsert<T extends { id: string } & Versioned>(
  list: T[],
  item: T,
  add: "first" | "last" | "none",
): T[] | undefined {
  const at = list.findIndex((x) => x.id === item.id);
  if (at < 0) {
    if (add === "none") {
      return undefined;
    }
    return add === "first" ? [item, ...list] : [...list, item];
  }
  if (!isNewer(list[at], item)) {
    return undefined;
  }
  const next = list.slice();
  next[at] = item;
  return next;
}

export const without = <T extends { id: string }>(list: T[], id: string): T[] | undefined =>
  list.some((x) => x.id === id) ? list.filter((x) => x.id !== id) : undefined;

// --- the flash of what changed elsewhere ------------------------------------------------------

const FLASH_MS = 1500;
/** When each item last changed elsewhere, and how often: the parity picks the animation. */
const flashed = new Map<string, { at: number; n: number }>();
const watchers = new Map<string, Set<() => void>>();
const tell = (id: string) => {
  for (const w of watchers.get(id) ?? []) {
    w();
  }
};

export function flashItem(id: string) {
  flashed.set(id, { at: Date.now(), n: (flashed.get(id)?.n ?? 0) + 1 });
  tell(id);
  setTimeout(() => {
    const f = flashed.get(id);
    if (f && Date.now() - f.at >= FLASH_MS) {
      flashed.delete(id);
      tell(id);
    }
  }, FLASH_MS + 50);
}

/** The class an item shows while it flashes, or "". */
export function flashClass(id: string): string {
  const f = flashed.get(id);
  if (!f || Date.now() - f.at >= FLASH_MS) {
    return "";
  }
  return f.n % 2 ? "live-flash-a" : "live-flash-b";
}

export function watchFlash(id: string, fn: () => void) {
  const set = watchers.get(id) ?? new Set();
  set.add(fn);
  watchers.set(id, set);
  return () => {
    set.delete(fn);
    if (!set.size) {
      watchers.delete(id);
    }
  };
}

// --- applying a batch -------------------------------------------------------------------------

/** Applies changes in one go; an error in one binding fetches its keys and leaves the rest. */
export function createPatcher(qc: QueryClient) {
  const invalidate = createDebouncedInvalidator(qc, 150);
  const live: LivePatch = { qc, invalidate, flash: flashItem };
  return async function apply(changes: LiveChange[]) {
    const work: Promise<void>[] = [];
    notifyManager.batch(() => {
      for (const change of changes) {
        for (const b of bindings) {
          if (!b.kinds.includes(change.kind)) {
            continue;
          }
          const fallBack = () => {
            for (const key of b.fallback(change)) {
              invalidate(key);
            }
          };
          if (change.op === "put" && change.view === undefined) {
            fallBack();
            continue;
          }
          try {
            const done = b.patch(change, live);
            if (done) {
              work.push(
                done.catch((err) => {
                  console.warn(`[live] ${b.id} could not patch ${change.kind}:`, err);
                  fallBack();
                }),
              );
            }
          } catch (err) {
            console.warn(`[live] ${b.id} could not patch ${change.kind}:`, err);
            fallBack();
          }
        }
      }
    });
    await Promise.all(work);
  };
}

/** For a reset: every query on screen is fetched again. */
export function refetchShown(qc: QueryClient) {
  void qc.invalidateQueries({ refetchType: "active" });
}
