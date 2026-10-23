import { z } from "zod";
import type { MergeConflict } from "./sync-merge.js";

/**
 * The two-way sync of a space between a local install and its organization in the cloud
 * (docs/plans/tenant-sync.md, docs/manage-contract.md "Two-way sync of a space"). The cloud is
 * the hub: it numbers every change (`seq`); an install pushes what it changed on top of the
 * version it last had of each item, and pulls what changed after the last number it saw.
 */

/**
 * What syncs, one row each: the space's details, a wizard (its draft and workspace together),
 * a translation, a message of a wizard's build chat, a page, a table, a row, a category (with
 * its values), a file, an imported connector. Runs, chats, the store and the index do not.
 */
export const SYNC_KINDS = [
  "space",
  "wizard",
  "translation",
  "message",
  "page",
  "table",
  "row",
  "category",
  "file",
  "connector",
] as const;
export type SyncKind = (typeof SYNC_KINDS)[number];

/** One item as it travels: its fields, never the tenant's id; `null` = deleted. */
export type SyncRecord = Record<string, unknown>;

/** An item that changed in the cloud, as a pull hands it out. */
export interface SyncChange {
  kind: SyncKind;
  item: string;
  /** The cloud's number of its last change. */
  seq: number;
  record: SyncRecord | null;
}

/** Items carry ids as installs make them (nanoid), or `<id>:<part>` for a wizard's translations and a space's connectors. */
export const syncItemId = z.string().regex(/^[A-Za-z0-9_-]{1,64}(:[A-Za-z0-9_.-]{1,64})?$/);

export const pushItemSchema = z.object({
  kind: z.enum(SYNC_KINDS),
  item: syncItemId,
  /** The cloud's number of the version this change was made on; 0 for an item new to the cloud. */
  base: z.number().int().min(0),
  record: z.record(z.string(), z.unknown()).nullable(),
});
export type PushItem = z.infer<typeof pushItemSchema>;

export const pushSchema = z.object({
  /** The tenant schema the install writes, the last migration's tag: both sides must have the same. */
  schema: z.string().min(1).max(100),
  items: z.array(pushItemSchema).max(500),
});
export type PushInput = z.infer<typeof pushSchema>;

export type PushResult =
  | { kind: SyncKind; item: string; status: "taken"; seq: number }
  /** The cloud's version changed after `base`: here it is, to merge with. */
  | { kind: SyncKind; item: string; status: "conflict"; seq: number; record: SyncRecord | null }
  /** Not taken, for a reason only the person can mend (a role, a limit, an id another item has). */
  | { kind: SyncKind; item: string; status: "refused"; reason: string; message: string };

export interface PushAnswer {
  results: PushResult[];
  /** The cloud's last number after the push. */
  seq: number;
}

export interface PullAnswer {
  changes: SyncChange[];
  /** Ask again from here. */
  next: number;
  /** More changes wait after `next`. */
  more: boolean;
}

/** The organization as the sync sees it: its schema, how many spaces it may have, its spaces. */
export interface SyncOverview {
  tenantId: string;
  schema: string;
  role: string;
  limits: { projects: number | null };
  spaces: { id: string; name: string; seq: number }[];
}

export const blobHash = z.string().regex(/^[a-f0-9]{64}$/);
export const missingBlobsSchema = z.object({ hashes: z.array(blobHash).max(2000) });

// --- what the studio shows ---------------------------------------------------------------

/** Where a space stands with the cloud, for the studio. */
export interface SpaceSyncState {
  spaceId: string;
  /** This space syncs both ways. */
  on: boolean;
  /** When the last push or pull arrived. */
  syncedAt: string | null;
  /** Changes made here that have not arrived in the cloud yet. */
  waiting: number;
  conflicts: number;
  /** Merges made by themselves since they were last seen. */
  merges: number;
  /** Why the last try did not arrive; null when it did. */
  error: { message: string; reason?: string; at: string } | null;
  /**
   * The organization the space syncs with, when the account is signed in to another one now:
   * the space stays here and syncs again after a switch back.
   */
  organization?: string | null;
}

/** An item where both sides changed the same thing: what each has, and where they differ. */
export interface SyncConflictView {
  id: string;
  spaceId: string;
  kind: SyncKind;
  item: string;
  /** The item's name: a wizard's title, a page's title, a row's first cell. */
  title: string;
  /** Deleted on one side. */
  deleted: "local" | "remote" | null;
  conflicts: (MergeConflict & { label: string })[];
  at: string;
}

/** A merge the sync made by itself, for the notice on the item. */
export interface SyncMergeView {
  id: string;
  spaceId: string;
  kind: SyncKind;
  item: string;
  title: string;
  /** What each side changed, as labels of the places. */
  local: string[];
  remote: string[];
  at: string;
  /** The versions before the merge are kept, so it can be undone. */
  undoable: boolean;
}
