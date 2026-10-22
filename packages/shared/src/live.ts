import { SYNC_KINDS } from "./sync.js";

/**
 * Live changes (docs/plans/live-changes.md): every write to an item a studio shows is numbered
 * in the tenant's `live_change` feed, and an open studio hears of it. The kinds start equal to
 * the two-way sync's; they are their own list so a kind can be live without syncing.
 */
export const LIVE_KINDS = SYNC_KINDS;
export type LiveKind = (typeof LIVE_KINDS)[number];

/** `put`: the item was added or changed. `del`: the item itself was deleted. */
export type LiveOp = "put" | "del";

/** One changed item, as the feed and the stream carry it. */
export interface LiveItem {
  kind: LiveKind;
  op: LiveOp;
  /** The changed item's id, as the two-way sync names it. */
  item: string;
  projectId: string | null;
  /** Where the item shows when its id alone doesn't say: a row's table, a translation's wizard. */
  parent: string | null;
  /** The feed's number of the item's last change in this batch. */
  seq?: number;
}

/**
 * A change as the studio's stream sends it: a `put` carries the item's view when it has one, the
 * JSON its GET route answers, so the studio can show it without asking again.
 */
export interface LiveChange extends LiveItem {
  view?: unknown;
}
