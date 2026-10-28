import { SYNC_KINDS } from "./sync.js";

/**
 * Live changes (docs/plans/live-changes.md): every write to an item a studio shows is numbered
 * in the tenant's `live_change` feed, and an open studio hears of it. The kinds start equal to
 * the two-way sync's; they are their own list so a kind can be live without syncing.
 */
export const LIVE_KINDS = [...SYNC_KINDS, "presence", "chat"] as const;
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

/** Who is in a wizard, page or table: a signal for people and AI, never a lock. */
export interface PresenceEntry {
  /** The person's id, or the client's for an agent. */
  who: string;
  /** One editor of that person: a tab. */
  tab: string;
  whoKind: "person" | "agent" | "assistant" | "run";
  name: string;
  /** The app an agent acts through; for the assistant, whom it acts for. */
  client: string | null;
  place: string | null;
  placeLabel: string | null;
  state: "viewing" | "editing";
  seenAt: string;
}

/** The kinds of item presence is kept for. */
export const PRESENCE_KINDS = ["wizard", "page", "table"] as const;
export type PresenceKind = (typeof PRESENCE_KINDS)[number];
