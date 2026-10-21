import { note } from "@engenty/wizards-shared/run";
import type {
  PullAnswer,
  PushAnswer,
  PushInput,
  PushItem,
  PushResult,
  SyncChange,
  SyncOverview,
} from "@engenty/wizards-shared/sync";
import { count, eq } from "drizzle-orm";
import { db, schema, tenantSchemaVersion } from "../db/client.js";
import { getBlob, hasBlob, putBlobOf } from "../files/blobs.js";
import { managed, tenantInfo } from "../manage.js";
import { currentRole, isAdminRole, MEMBERS_EDIT_ONLY, mayBuild } from "../services/access.js";
import { ServiceError } from "../services/errors.js";
import { projectLimit } from "../services/projects.js";
import { publishWizard, rotateShareLink, shareUrl } from "../services/wizards.js";
import { codeOf } from "../tenants/control.js";
import { currentTenant } from "../tenants/tenant.js";
import { type ApplyItem, applyItems } from "./apply.js";
import { changedSince, compactLog, lastSeqs, seqKey, spaceSeq } from "./log.js";
import { canonical, KIND_ORDER, KINDS } from "./records.js";

/**
 * The cloud's half of the two-way sync (docs/manage-contract.md, "Two-way sync of a space"): it
 * takes what an install changed when it was made on the cloud's latest version of the item, and
 * hands out what changed after a number. It writes through the same records as the install, as
 * the person behind the token, in their role.
 */

const PAGE = 300;

/** The tenant schema of both sides must be the same; refused otherwise, with ours named. */
function requireSchema(theirs: string) {
  if (theirs !== tenantSchemaVersion) {
    const order = (tag: string) => Number.parseInt(tag, 10) || 0;
    throw new ServiceError(
      "refused",
      order(theirs) < order(tenantSchemaVersion) ? note("syncUpdateHere") : note("syncUpdateCloud"),
      { reason: "schema_mismatch", schema: tenantSchemaVersion },
    );
  }
}

/** The organization as an install meets it: its schema, its number of spaces, its spaces. */
export async function syncOverview(): Promise<SyncOverview> {
  const spaces = await db.query.project.findMany({
    where: eq(schema.project.tenantId, currentTenant()),
    columns: { id: true, name: true, origin: true },
    orderBy: [schema.project.createdAt],
  });
  const info = managed ? await tenantInfo(currentTenant()).catch(() => null) : null;
  const limit = await projectLimit();
  return {
    tenantId: currentTenant(),
    schema: tenantSchemaVersion,
    role: currentRole(),
    limits: {
      projects: info?.limits.projects === null || !Number.isFinite(limit) ? null : limit,
    },
    spaces: await Promise.all(
      spaces.map(async (s) => ({ id: s.id, name: s.name, seq: await spaceSeq(s.id) })),
    ),
  };
}

/**
 * What changed in a space after `since`. From 0 it is every item of the space, a page at a
 * time (`cursor`); `next` then is the number the log stood at when the listing began.
 */
export async function pullChanges(
  projectId: string,
  since: number,
  cursor?: string,
): Promise<PullAnswer & { cursor?: string }> {
  if (since > 0) {
    const logged = await changedSince(projectId, since, PAGE);
    const changes: SyncChange[] = [];
    for (const x of logged) {
      const def = KINDS[x.kind];
      if (!def) {
        continue;
      }
      const read = await def.read(x.item);
      if (read === "skip") {
        continue;
      }
      changes.push({ kind: x.kind, item: x.item, seq: x.seq, record: read?.record ?? null });
    }
    return {
      changes,
      next: logged.at(-1)?.seq ?? since,
      more: logged.length === PAGE,
    };
  }
  const [offsetText, topText] = (cursor ?? "").split(".");
  const offset = Number.parseInt(offsetText ?? "", 10) || 0;
  const top = cursor ? Number.parseInt(topText ?? "", 10) || 0 : await spaceSeq(projectId);
  const project = await db.query.project.findFirst({
    where: eq(schema.project.id, projectId),
    columns: { tenantId: true },
  });
  if (!project || project.tenantId !== currentTenant()) {
    throw new ServiceError("not_found", note("syncSpaceNotInCloud"));
  }
  const all: { kind: (typeof KIND_ORDER)[number]; item: string }[] = [];
  for (const kind of KIND_ORDER) {
    for (const item of await KINDS[kind].list(projectId)) {
      all.push({ kind, item });
    }
  }
  const page = all.slice(offset, offset + PAGE);
  const seqs = await lastSeqs(page);
  const changes: SyncChange[] = [];
  for (const x of page) {
    const read = await KINDS[x.kind].read(x.item);
    if (read && read !== "skip") {
      changes.push({ ...x, seq: seqs.get(seqKey(x.kind, x.item)) ?? 0, record: read.record });
    }
  }
  const more = offset + PAGE < all.length;
  return {
    changes,
    next: more ? 0 : top,
    more,
    ...(more ? { cursor: `${offset + PAGE}.${top}` } : {}),
  };
}

/** Whether the person may make or change this; members edit, owners and admins make and delete. */
function mayChange(x: PushItem, exists: boolean): boolean {
  if (!managed || isAdminRole(currentRole())) {
    return true;
  }
  if (x.kind === "space" || x.kind === "connector") {
    return false;
  }
  if (x.kind === "wizard") {
    return exists && x.record !== null;
  }
  return true;
}

async function requireRoomForSpace() {
  const [{ n }] = await db
    .select({ n: count() })
    .from(schema.project)
    .where(eq(schema.project.tenantId, currentTenant()));
  const limit = await projectLimit();
  if (n >= limit) {
    throw new ServiceError(
      "refused",
      limit === 1 ? note("onlyOneSpaceAllowed") : note("mostSpaces", { count: limit }),
      { reason: "space_limit", limit },
    );
  }
}

const refused = (x: PushItem, reason: string, message: string): PushResult => ({
  kind: x.kind,
  item: x.item,
  status: "refused",
  reason,
  message,
});

/**
 * Takes what an install changed in one space. Each item is taken when the cloud's version has
 * not changed after the one the install changed (`base`); else the answer is the cloud's
 * version, to merge with. What is taken is written in one transaction, and gets its number.
 */
export async function pushChanges(projectId: string, input: PushInput): Promise<PushAnswer> {
  requireSchema(input.schema);
  if (!(await mayBuild())) {
    throw new ServiceError("read_only", note("wizardsRunOncePublished"), { reason: "read_only" });
  }
  const project = await db.query.project.findFirst({
    where: eq(schema.project.id, projectId),
    columns: { tenantId: true },
  });
  if (project && project.tenantId !== currentTenant()) {
    throw new ServiceError("refused", note("spaceIdAlreadyExists"), { reason: "id_taken" });
  }
  const makesSpace = input.items.some(
    (x) => x.kind === "space" && x.item === projectId && x.record !== null,
  );
  if (!project && !makesSpace) {
    throw new ServiceError("not_found", note("syncSpaceNotInCloud"), { reason: "not_found" });
  }
  const seqs = await lastSeqs(input.items);
  const results: PushResult[] = [];
  const taking: { x: PushItem; apply: ApplyItem }[] = [];
  // Refusals carry a `reason` the install says in its own words; `message` is for the log.
  for (const x of input.items) {
    const def = KINDS[x.kind];
    const current = await def.read(x.item);
    if (current === "skip") {
      results.push(refused(x, "not_synced", "This item does not sync."));
      continue;
    }
    if (current && current.projectId !== projectId) {
      results.push(refused(x, "id_taken", "In the cloud this belongs to another space."));
      continue;
    }
    if (x.record && x.kind !== "space" && x.record.projectId !== projectId) {
      results.push(refused(x, "invalid", "The item names another space."));
      continue;
    }
    if (!mayChange(x, current !== null)) {
      results.push(
        refused(x, "forbidden", "Only the organization's owners and admins make and delete this."),
      );
      continue;
    }
    const seq = seqs.get(seqKey(x.kind, x.item)) ?? 0;
    if (seq > x.base) {
      results.push({
        kind: x.kind,
        item: x.item,
        status: "conflict",
        seq,
        record: current?.record ?? null,
      });
      continue;
    }
    if (canonical(current?.record ?? null) === canonical(x.record)) {
      results.push({ kind: x.kind, item: x.item, status: "taken", seq });
      continue;
    }
    if (x.record) {
      const missing: string[] = [];
      for (const hash of def.blobs?.(x.record) ?? []) {
        if (!(await hasBlob(hash))) {
          missing.push(hash);
        }
      }
      if (missing.length) {
        results.push(refused(x, "blob_missing", "A file of this change has not arrived yet."));
        continue;
      }
    }
    if (x.kind === "space" && !current && x.record) {
      try {
        await requireRoomForSpace();
      } catch (err) {
        results.push(
          refused(x, "space_limit", (err as Error).message || "No room for another space."),
        );
        continue;
      }
    }
    taking.push({ x, apply: { kind: x.kind, item: x.item, projectId, record: x.record } });
  }
  const taken = await applyEach(taking.map((t) => t.apply));
  const after = await lastSeqs(taking.map((t) => t.x));
  for (const { x } of taking) {
    const failed = taken.get(seqKey(x.kind, x.item));
    results.push(
      failed
        ? refused(x, "invalid", failed)
        : {
            kind: x.kind,
            item: x.item,
            status: "taken",
            seq: after.get(seqKey(x.kind, x.item)) ?? 0,
          },
    );
  }
  await compactLog(projectId);
  return { results, seq: await spaceSeq(projectId) };
}

/**
 * Writes the batch in one transaction; when it fails, item by item, so one bad item does not
 * hold back the others. Answers the items that could not be written, with why.
 */
async function applyEach(items: ApplyItem[]): Promise<Map<string, string>> {
  const failed = new Map<string, string>();
  try {
    await applyItems(items, { quiet: false });
    return failed;
  } catch {
    for (const item of items) {
      try {
        await applyItems([item], { quiet: false });
      } catch (err) {
        failed.set(seqKey(item.kind, item.item), (err as Error).message || "invalid");
      }
    }
  }
  return failed;
}

// --- bytes ---------------------------------------------------------------------------------

export async function missingBlobs(hashes: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const hash of hashes) {
    if (!(await hasBlob(hash))) {
      out.push(hash);
    }
  }
  return out;
}

export const takeBlob = putBlobOf;
export const blobBytes = getBlob;

// --- publishing and links ------------------------------------------------------------------

async function wizardInSpace(projectId: string, wizardId: string) {
  const w = await db.query.wizard.findFirst({
    where: eq(schema.wizard.id, wizardId),
    columns: { projectId: true, tenantId: true },
  });
  if (!w || w.projectId !== projectId || w.tenantId !== currentTenant()) {
    throw new ServiceError("not_found", note("syncSpaceNotInCloud"));
  }
}

/** Publishes the cloud's draft of a wizard, which the install pushed before it asked. */
export async function publishSynced(userId: string, projectId: string, wizardId: string) {
  await wizardInSpace(projectId, wizardId);
  const published = await publishWizard(userId, wizardId);
  const w = await db.query.wizard.findFirst({ where: eq(schema.wizard.id, wizardId) });
  if (!w) {
    throw new ServiceError("not_found", note("syncSpaceNotInCloud"));
  }
  return {
    wizardId,
    shareUrl: shareUrl(w.shareToken),
    code: await codeOf(w.shareToken),
    shareEnabled: w.shareEnabled,
    publishedVersion: published.version,
    runnable: true,
    problems: [],
  };
}

/** A new link for the cloud's copy of a wizard; the old one stops answering. */
export async function rotateSynced(userId: string, projectId: string, wizardId: string) {
  await wizardInSpace(projectId, wizardId);
  const { shareToken } = await rotateShareLink(userId, wizardId);
  return { shareUrl: shareUrl(shareToken), code: await codeOf(shareToken) };
}

/**
 * A space a local install synced one way (`origin = "local"`) becomes a space of the cloud's
 * own, which the studio here edits: from now on it syncs both ways.
 */
export async function adoptSpace(projectId: string) {
  if (managed && !isAdminRole(currentRole())) {
    throw new ServiceError("forbidden", MEMBERS_EDIT_ONLY);
  }
  const project = await db.query.project.findFirst({
    where: eq(schema.project.id, projectId),
    columns: { tenantId: true, origin: true },
  });
  if (!project || project.tenantId !== currentTenant()) {
    return { adopted: false };
  }
  if (project.origin === "local") {
    await db
      .update(schema.project)
      .set({ origin: null, syncedAt: new Date() })
      .where(eq(schema.project.id, projectId));
  }
  return { adopted: true };
}
