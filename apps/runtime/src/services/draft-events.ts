import { AsyncResource } from "node:async_hooks";
import { EventEmitter } from "node:events";
import type { WizardDefinition } from "@engenty/wizards-shared/definition";
import { and, asc, eq, gt, lt, max } from "drizzle-orm";
import { db } from "../db/client.js";
import * as schema from "../db/schema.js";

/** A change to a wizard's draft or workspace, for every studio tab that has it open. */
export interface DraftChange {
  wizardId: string;
  kind: "draft" | "files";
  revision: number;
  /** "mcp": the admin's own client, named in `client`. */
  source: "studio" | "mcp";
  client: string | null;
  note: string | null;
  /** Step ids added or changed (draft), or file paths (files). */
  touched: string[];
}

/** How often a subscriber looks for what another process wrote. */
const LOOK_MS = 2000;
/** A subscriber reads a change within seconds; a reconnect catches up on the revision. */
const KEEP_MS = 3600_000;

/** Wakes this process's subscribers at once; those of another process find the row on their look. */
const wake = new EventEmitter();
wake.setMaxListeners(0);

/**
 * In the tenant's database, so the studio hears what the process answering MCP wrote
 * (RUNTIME_ROLE). A notice lost is a notice lost: the write it tells of stands.
 */
export async function emitDraftChanged(change: DraftChange): Promise<void> {
  try {
    await db.insert(schema.draftChange).values({ wizardId: change.wizardId, change });
    wake.emit(change.wizardId);
  } catch (err) {
    console.error("[draft-events]", (err as Error).message);
  }
}

/** Hears the changes to a wizard from now on, in the current tenant's context. */
export function subscribeDraft(
  wizardId: string,
  listener: (change: DraftChange) => void,
): () => void {
  const t = schema.draftChange;
  let stopped = false;
  let reading = false;
  let again = false;
  let seen: number | null = null;
  // The tenant's context stays with the reader, whoever wakes it: ids are unique per tenant only.
  const read = AsyncResource.bind(async () => {
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    try {
      if (seen === null) {
        const [newest] = await db.select({ id: max(t.id) }).from(t);
        seen = newest?.id ?? 0;
      }
      do {
        again = false;
        const after: number = seen ?? 0;
        const rows = await db
          .select()
          .from(t)
          .where(and(eq(t.wizardId, wizardId), gt(t.id, after)))
          .orderBy(asc(t.id));
        for (const row of rows) {
          seen = row.id;
          if (!stopped) {
            listener(row.change);
          }
        }
      } while (again && !stopped);
    } catch (err) {
      console.error("[draft-events]", (err as Error).message);
    } finally {
      reading = false;
    }
  });
  const timer = setInterval(() => void read(), LOOK_MS);
  timer.unref();
  wake.on(wizardId, read);
  void read();
  return () => {
    stopped = true;
    clearInterval(timer);
    wake.off(wizardId, read);
  };
}

/** Deletes notices nobody needs any more, in the current tenant's context. */
export async function pruneDraftChanges(now = Date.now()) {
  await db
    .delete(schema.draftChange)
    .where(lt(schema.draftChange.createdAt, new Date(now - KEEP_MS)));
}

/** Steps that are new or differ in `after`. */
export function changedSteps(before: WizardDefinition, after: WizardDefinition): string[] {
  const old = new Map(before.steps.map((s) => [s.id, JSON.stringify(s)]));
  return after.steps.filter((s) => old.get(s.id) !== JSON.stringify(s)).map((s) => s.id);
}

/** A workspace file was written or removed. Files carry no revision; the draft's is passed along. */
export function filesChanged(w: { id: string; revision: number }, path: string): DraftChange {
  return {
    wizardId: w.id,
    kind: "files",
    revision: w.revision,
    source: "studio",
    client: null,
    note: null,
    touched: [path],
  };
}
