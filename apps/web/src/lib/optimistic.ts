import type { QueryClient, QueryKey } from "@tanstack/react-query";

/**
 * The shape-agnostic half of a cache write that may lose to a newer one (the same lifecycle as
 * engenty-pro's `beginOptimisticUpdate`): cancel the query in flight, so an older answer can't
 * land on top, keep a snapshot, write. `rollback` restores the snapshot only while this write is
 * still what the cache holds; otherwise it keeps the newer value and fetches the key again.
 * A local save and a live patch both go through it, so neither overwrites the other.
 */
export type OptimisticRollbackResult = "invalidated" | "restored" | "unchanged";

export interface OptimisticUpdateTransaction {
  /** Marks the exact query stale and fetches it again when it is shown. */
  invalidate: () => Promise<void>;
  rollback: () => OptimisticRollbackResult;
  /** The query was fetching when the write began; it was cancelled. */
  wasFetching: boolean;
}

export async function beginOptimisticUpdate<T>(
  qc: QueryClient,
  options: { queryKey: QueryKey; update: (current: T | undefined) => T | undefined },
): Promise<OptimisticUpdateTransaction> {
  const wasFetching = qc.isFetching({ queryKey: options.queryKey, exact: true }) > 0;
  await qc.cancelQueries({ queryKey: options.queryKey, exact: true });
  const snapshot = qc.getQueryData<T>(options.queryKey);
  const next = options.update(snapshot);
  if (next !== snapshot) {
    qc.setQueryData<T>(options.queryKey, next);
  }
  // The cache may share structure with what it was given: compare with what it holds.
  const applied = qc.getQueryData<T>(options.queryKey);
  const invalidate = () => qc.invalidateQueries({ queryKey: options.queryKey, exact: true });
  return {
    invalidate,
    wasFetching,
    rollback: () => {
      if (qc.getQueryData<T>(options.queryKey) !== applied) {
        void invalidate();
        return "invalidated";
      }
      if (snapshot === undefined) {
        if (applied === undefined) {
          return "unchanged";
        }
        qc.removeQueries({ queryKey: options.queryKey, exact: true });
      } else {
        qc.setQueryData<T>(options.queryKey, snapshot);
      }
      return "restored";
    },
  };
}

/** Each key once per `ms`, the last call winning (engenty-pro's `createDebouncedInvalidator`). */
export function createDebouncedInvalidator(qc: QueryClient, ms = 150) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  return (queryKey: QueryKey) => {
    const key = JSON.stringify(queryKey);
    const was = timers.get(key);
    if (was) {
      clearTimeout(was);
    }
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        void qc.invalidateQueries({ queryKey, refetchType: "active" });
      }, ms),
    );
  };
}
