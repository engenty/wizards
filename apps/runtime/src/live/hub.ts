import type { LiveChange, LiveItem } from "@engenty/wizards-shared/live";
import { withTenant } from "../db/client.js";
import { changesAfter, newestSeq, oldestSeq, pruneLive } from "./feed.js";

/**
 * The live hub (docs/plans/live-changes.md, 2): one per process. While a tenant has a stream
 * open, it reads the tenant's feed every second or three, and right away after a write in this
 * process (`nudge`). Writes of other processes (the runner, the doors, another replica) arrive
 * with the next tick. One read serves every stream of the tenant.
 */

export type LiveEvent =
  | { event: "hello"; seq: number }
  | { event: "changes"; seq: number; items: LiveChange[] }
  | { event: "reset"; seq: number }
  | { event: "sync" };

/** More changes than this in one go and the browser reloads what is open instead. */
export const BURST = 1000;
const FAST_MS = 1000;
const SLOW_MS = 3000;
/** Ticks stay fast this long after the last change. */
const BUSY_MS = 60_000;
const PRUNE_EVERY_MS = 5 * 60_000;
/** Views a batch carries at most, in characters of JSON; the items after it go without. */
export const BATCH_VIEWS_MAX = 512 * 1024;
/** Above this a view isn't sent: the browser fetches that item. */
export const VIEW_MAX = 64 * 1024;

/**
 * How a stream's reader sees items (live/views.ts, with the reader's role). Readers with the
 * same `key` see the same views, so one read serves them all.
 */
export interface Views {
  key: string;
  read: (x: LiveItem) => Promise<unknown>;
}

interface Subscriber {
  since: number;
  send: (e: LiveEvent) => void;
  views?: Views;
}

interface TenantFeed {
  id: string;
  subs: Set<Subscriber>;
  timer: NodeJS.Timeout | null;
  ticking: boolean;
  again: boolean;
  changedAt: number;
  prunedAt: number;
}

const feeds = new Map<string, TenantFeed>();

/**
 * Starts sending the tenant's changes after `since` (null: from now on). Answers `hello`, or
 * `reset` when the changes after `since` are no longer kept or `since` is of another database.
 */
export async function subscribe(
  tenantId: string,
  since: number | null,
  send: (e: LiveEvent) => void,
  views?: Views,
): Promise<() => void> {
  const { newest, gap } = await withTenant(tenantId, async () => {
    const newest = await newestSeq();
    if (since === null || since === newest) {
      return { newest, gap: false };
    }
    if (since > newest) {
      return { newest, gap: true };
    }
    const oldest = await oldestSeq();
    return { newest, gap: oldest === null || oldest > since + 1 };
  });
  const sub: Subscriber = { since: since === null || gap ? newest : since, send, views };
  send(gap ? { event: "reset", seq: newest } : { event: "hello", seq: newest });
  let feed = feeds.get(tenantId);
  if (!feed) {
    feed = {
      id: tenantId,
      subs: new Set(),
      timer: null,
      ticking: false,
      again: false,
      changedAt: 0,
      prunedAt: 0,
    };
    feeds.set(tenantId, feed);
  }
  feed.subs.add(sub);
  // A catch-up is the next tick's work.
  schedule(feed, sub.since < newest ? 0 : FAST_MS);
  return () => {
    const f = feeds.get(tenantId);
    if (!f) {
      return;
    }
    f.subs.delete(sub);
    if (!f.subs.size) {
      if (f.timer) {
        clearTimeout(f.timer);
      }
      feeds.delete(tenantId);
    }
  };
}

/** A write in this process: read the tenant's feed now, if anyone listens. */
export function nudge(tenantId: string | null | undefined) {
  const feed = tenantId ? feeds.get(tenantId) : undefined;
  if (feed) {
    schedule(feed, 0);
  }
}

/** Something only this process knows changed, such as the two-way sync's state. */
export function signal(tenantId: string | null | undefined, event: "sync") {
  const feed = tenantId ? feeds.get(tenantId) : undefined;
  for (const sub of feed?.subs ?? []) {
    sub.send({ event });
  }
}

/** Streams open in this process, for limits and tests. */
export function openStreams(tenantId: string): number {
  return feeds.get(tenantId)?.subs.size ?? 0;
}

function schedule(feed: TenantFeed, ms: number) {
  if (feed.ticking) {
    feed.again = true;
    return;
  }
  if (feed.timer) {
    clearTimeout(feed.timer);
  }
  feed.timer = setTimeout(() => void tick(feed), ms);
  feed.timer.unref?.();
}

async function tick(feed: TenantFeed) {
  feed.timer = null;
  if (feeds.get(feed.id) !== feed) {
    return;
  }
  feed.ticking = true;
  feed.again = false;
  try {
    await withTenant(feed.id, () => read(feed));
  } catch (err) {
    console.error(`[live ${feed.id}]`, err);
  } finally {
    feed.ticking = false;
  }
  if (feeds.get(feed.id) === feed) {
    const quiet = Date.now() - feed.changedAt > BUSY_MS;
    schedule(feed, feed.again ? 0 : quiet ? SLOW_MS : FAST_MS);
  }
}

async function read(feed: TenantFeed) {
  const subs = [...feed.subs];
  if (!subs.length) {
    return;
  }
  const from = Math.min(...subs.map((s) => s.since));
  const rows = await changesAfter(from, BURST + 1);
  if (rows.length) {
    feed.changedAt = Date.now();
  }
  if (rows.length > BURST) {
    const seq = await newestSeq();
    for (const sub of subs) {
      sub.since = seq;
      sub.send({ event: "reset", seq });
    }
  } else if (rows.length) {
    const read = new Map<string, Promise<unknown>>();
    for (const sub of subs) {
      const mine = rows.filter((r) => r.seq > sub.since);
      if (!mine.length) {
        continue;
      }
      const seq = mine[mine.length - 1].seq;
      sub.since = seq;
      sub.send({ event: "changes", seq, items: await withViews(dedupe(mine), sub.views, read) });
    }
  }
  if (Date.now() - feed.prunedAt > PRUNE_EVERY_MS) {
    feed.prunedAt = Date.now();
    await pruneLive();
  }
}

/**
 * The views of a batch's `put` items, read once per item and kind of reader. A put whose item
 * is gone by now goes as a `del`; a view too big, or over the batch's budget, is left out.
 */
async function withViews(
  items: LiveItem[],
  views: Views | undefined,
  read: Map<string, Promise<unknown>>,
): Promise<LiveChange[]> {
  if (!views) {
    return items;
  }
  let budget = BATCH_VIEWS_MAX;
  const out: LiveChange[] = [];
  for (const x of items) {
    if (x.op === "del") {
      out.push(x);
      continue;
    }
    const key = `${views.key}|${x.kind}|${x.item}`;
    let view = read.get(key);
    if (!view) {
      view = views.read(x).catch(() => undefined);
      read.set(key, view);
    }
    const v = await view;
    if (v === null) {
      out.push({ ...x, op: "del" });
      continue;
    }
    const size = v === undefined ? 0 : JSON.stringify(v).length;
    if (v === undefined || size > VIEW_MAX || size > budget) {
      out.push(x);
      continue;
    }
    budget -= size;
    out.push({ ...x, view: v });
  }
  return out;
}

/** One entry per item, in the order of its last change, with its last op. */
export function dedupe(rows: (LiveItem & { seq?: number })[]): LiveItem[] {
  const last = new Map<string, LiveItem>();
  for (const { seq: _, ...item } of rows) {
    const key = `${item.kind}|${item.item}`;
    last.delete(key);
    last.set(key, item);
  }
  return [...last.values()];
}
