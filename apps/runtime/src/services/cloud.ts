import { createHash } from "node:crypto";
import { note } from "@engenty-wizards/shared/run";
import { and, asc, eq, inArray, isNotNull, isNull, like } from "drizzle-orm";
import { accountToken, linkedAccount } from "../auth/account.js";
import { control, controlDb, db, schema } from "../db/client.js";
import { env } from "../env.js";
import { getBlob } from "../files/blobs.js";
import { managed } from "../manage.js";
import { deleteSetting, readSetting, writeSetting } from "../settings.js";
import { currentTenant } from "../tenants/tenant.js";
import { mainLogoId } from "./brand.js";
import { ServiceError } from "./errors.js";
import { projectFileContent, projectFiles } from "./project-files.js";
import { ownedProject } from "./projects.js";
import type { ServerProblem, SpaceInput, SyncDataInput, SyncResult } from "./spaces.js";
import { ownedWizard, publishedVersion, publishWizard } from "./wizards.js";

/**
 * A runtime that runs alone, linked to an account: what it publishes also goes to the account's
 * cloud runtime, which runs it for everyone (docs/manage-contract.md, "Spaces of a local
 * install"). Only the published version is sent, when it is published; drafts, runs and
 * connected accounts stay here. The cloud makes the link of its copy.
 */

export interface CloudCopy {
  /** The link of the copy in the cloud. */
  shareUrl: string;
  /** The wizard's ID for the mobile app; a cloud before it knew IDs sends none. */
  code?: string;
  /** The version last sent from here. */
  version: number;
  /** The version runs start on in the cloud; null when none could be published there. */
  publishedVersion: number | null;
  runnable: boolean;
  problems: ServerProblem[];
  syncedAt: string;
}

export interface CloudState {
  copy: CloudCopy | null;
  /** Why the last try did not arrive; the copy from before stays as it was. */
  error: {
    message: string;
    reason?: string;
    at: string;
    /** How often it was tried since it last arrived. */
    tries: number;
    /**
     * When the runtime tries again by itself — after a cloud that was out of reach or answered
     * with an error of its own. Null where only the person can help (signed out, no room).
     */
    again: string | null;
  } | null;
}

/** What the cloud lacks for a wizard, and what stays here: said before it is sent. */
export interface CloudCheck {
  problems: ServerProblem[];
  /** The project has documents; they are not sent, so steps there work without them. */
  documents: boolean;
}

const key = (wizardId: string) => `cloud:${wizardId}`;
const EMPTY: CloudState = { copy: null, error: null };

/** Whether this runtime sends what it publishes: it runs alone and an account is linked. */
export async function cloudLinked(): Promise<boolean> {
  return !managed && Boolean(await linkedAccount());
}

/** Where a local wizard stands in the cloud. */
export async function cloudState(wizardId: string): Promise<CloudState> {
  return (await readSetting<CloudState>(key(wizardId))) ?? EMPTY;
}

interface CloudAnswer<T> {
  ok: boolean;
  status: number;
  body: T & { error?: string; reason?: string };
}

async function call<T>(
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 30_000,
): Promise<CloudAnswer<T>> {
  const token = await accountToken();
  if (!token) {
    throw new ServiceError("refused", note("accountSignedOut"), {
      reason: "signed_out",
    });
  }
  const res = await fetch(`${env.local.cloudUrl}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  }).catch(() => null);
  if (!res) {
    throw new ServiceError("refused", note("cloudNotReachedRight"), {
      reason: "unreachable",
    });
  }
  const parsed = (await res.json().catch(() => ({}))) as T & { error?: string; reason?: string };
  return { ok: res.ok, status: res.status, body: parsed };
}

function refusal(answer: CloudAnswer<unknown>, fallback: string): ServiceError {
  const { error, reason, ...rest } = answer.body as Record<string, unknown>;
  const message =
    answer.status === 401
      ? note("accountSignedOut")
      : typeof error === "string" && error
        ? error
        : fallback;
  return new ServiceError("refused", message, {
    reason: answer.status === 401 ? "signed_out" : typeof reason === "string" ? reason : "refused",
    status: answer.status,
    ...(Array.isArray(rest.spaces) ? { spaces: rest.spaces } : {}),
  });
}

/** A try is made again by itself when the cloud, not what was sent, was the trouble. */
function worthAnotherTry(err: unknown): boolean {
  if (!(err instanceof ServiceError)) {
    return true;
  }
  const status = typeof err.data.status === "number" ? err.data.status : 0;
  return err.data.reason === "unreachable" || status >= 500 || status === 429;
}

/** A minute, then twice as long each time, up to an hour. */
function nextTry(tries: number, from: Date): string {
  const minutes = Math.min(60, 2 ** (tries - 1));
  return new Date(from.getTime() + minutes * 60_000).toISOString();
}

/** The project as the cloud keeps it: its name, what it says about itself, its logo. */
async function spaceOf(userId: string, projectId: string): Promise<SpaceInput> {
  const project = await ownedProject(userId, projectId);
  const logoId = await mainLogoId(project.id);
  const logo = logoId ? await projectFileContent(project.id, logoId).catch(() => null) : null;
  return {
    name: project.name,
    brand: {
      name: project.brand.name,
      about: project.brand.about,
      colors: project.brand.colors,
    },
    facts: project.facts,
    logo: logo
      ? {
          name: logo.row.name,
          mime: logo.row.mime,
          description: logo.row.description,
          data: Buffer.from(logo.data).toString("base64"),
        }
      : null,
  };
}

/** The space's own tables and pages, as they are sent: not what a wizard's runs keep. */
async function spaceDataOf(projectId: string): Promise<SyncDataInput> {
  const own = (table: typeof schema.spaceTable | typeof schema.spacePage) =>
    and(eq(table.projectId, projectId), isNull(table.wizardId));
  const tables = await db.query.spaceTable.findMany({
    where: own(schema.spaceTable),
    orderBy: [asc(schema.spaceTable.id)],
  });
  const rows = tables.length
    ? await db.query.spaceTableRow.findMany({
        where: inArray(
          schema.spaceTableRow.tableId,
          tables.map((t) => t.id),
        ),
        orderBy: [asc(schema.spaceTableRow.createdAt), asc(schema.spaceTableRow.id)],
      })
    : [];
  const pages = await db.query.spacePage.findMany({
    where: own(schema.spacePage),
    orderBy: [asc(schema.spacePage.id)],
  });
  const categories = await db.query.spaceCategory.findMany({
    where: and(
      eq(schema.spaceCategory.projectId, projectId),
      eq(schema.spaceCategory.proposed, false),
    ),
    orderBy: [asc(schema.spaceCategory.position), asc(schema.spaceCategory.id)],
  });
  const values = categories.length
    ? await db.query.spaceCategoryValue.findMany({
        where: inArray(
          schema.spaceCategoryValue.categoryId,
          categories.map((c) => c.id),
        ),
        orderBy: [asc(schema.spaceCategoryValue.position), asc(schema.spaceCategoryValue.id)],
      })
    : [];
  const assignments = categories.length
    ? await db.query.spaceItemCategory.findMany({
        where: and(
          eq(schema.spaceItemCategory.projectId, projectId),
          isNull(schema.spaceItemCategory.fileId),
        ),
        orderBy: [asc(schema.spaceItemCategory.id)],
      })
    : [];
  const tableIds = new Set(tables.map((t) => t.id));
  const rowIds = new Set(rows.map((r) => r.id));
  const pageIds = new Set(pages.map((p) => p.id));
  return {
    tables: tables.map((t) => ({
      id: t.id,
      title: t.title,
      format: t.format,
      originLabel: t.originLabel,
      columns: t.columns,
      rows: rows.filter((r) => r.tableId === t.id).map((r) => ({ id: r.id, cells: r.cells })),
    })),
    pages: pages.map((p) => ({
      id: p.id,
      title: p.title,
      markdown: p.markdown,
      parentId: p.parentId,
      position: p.position,
      originLabel: p.originLabel,
    })),
    categories: categories.map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      unit: c.unit,
      multiple: c.multiple,
      ordered: c.ordered,
      hint: c.hint,
      tableId: c.tableId && tableIds.has(c.tableId) ? c.tableId : null,
      columnId: c.tableId && tableIds.has(c.tableId) ? c.columnId : null,
      position: c.position,
      values: values
        .filter((v) => v.categoryId === c.id)
        .map((v) => ({ id: v.id, value: v.value, position: v.position, summary: v.summary })),
    })),
    // Only what goes along: a page, a table or a row of it.
    assignments: assignments
      .filter(
        (a) =>
          (a.pageId && pageIds.has(a.pageId)) ||
          (a.tableId && tableIds.has(a.tableId)) ||
          (a.rowId && rowIds.has(a.rowId)),
      )
      .map((a) => ({
        categoryId: a.categoryId,
        item: a.pageId ? `p:${a.pageId}` : a.tableId ? `t:${a.tableId}` : `r:${a.rowId}`,
        valueId: a.valueId,
        text: a.text,
        num: a.num,
        at: a.at,
        bool: a.bool,
        by: a.by,
      })),
  };
}

/**
 * Sends the space's own tables and pages along with a wizard, when they changed since they last
 * arrived. A sending that fails is tried with the next wizard; the wizard is there either way.
 */
async function syncSpaceDataToCloud(projectId: string): Promise<void> {
  const data = await spaceDataOf(projectId);
  const hash = createHash("sha256").update(JSON.stringify(data)).digest("hex");
  const sent = `cloud-data:${projectId}`;
  if ((await readSetting<string>(sent)) === hash) {
    return;
  }
  try {
    const answer = await call("PUT", `/spaces/${projectId}/data`, data, 120_000);
    if (answer.ok) {
      await writeSetting(sent, hash);
    } else {
      console.error("[cloud] the space's data was not taken:", answer.status, answer.body);
    }
  } catch (err) {
    console.error("[cloud] sending the space's data failed:", err);
  }
}

/**
 * Sends a wizard's published version to the cloud: the same wizard again updates its copy
 * there, whose link stays. What came back is kept; a try that failed is kept as such beside
 * the copy from before. The space's own tables and pages follow it.
 */
export async function syncToCloud(userId: string, wizardId: string): Promise<CloudState> {
  const w = await ownedWizard(userId, wizardId);
  const version = await publishedVersion(w);
  if (!version) {
    throw new ServiceError("refused", note("publishWizardFirst"));
  }
  const before = await cloudState(w.id);
  try {
    const files = await Promise.all(
      version.files.map(async (f) => ({
        path: f.path,
        mime: f.mime,
        data: (await getBlob(f.hash)).toString("base64"),
      })),
    );
    const answer = await call<SyncResult>(
      "PUT",
      `/spaces/${w.projectId}/wizards/${w.id}`,
      {
        space: await spaceOf(userId, w.projectId),
        version: version.version,
        definition: version.definition,
        files,
        shareEnabled: w.shareEnabled,
        dailyRunLimit: w.dailyRunLimit,
      },
      120_000,
    );
    if (!answer.ok || !answer.body.shareUrl) {
      throw refusal(answer, "The cloud did not take the wizard.");
    }
    const state: CloudState = {
      copy: {
        shareUrl: answer.body.shareUrl,
        code: answer.body.code,
        version: version.version,
        publishedVersion: answer.body.publishedVersion,
        runnable: answer.body.runnable,
        problems: answer.body.problems ?? [],
        syncedAt: new Date().toISOString(),
      },
      error: null,
    };
    await writeSetting(key(w.id), state);
    await syncSpaceDataToCloud(w.projectId);
    return state;
  } catch (err) {
    const now = new Date();
    const tries = (before.error?.tries ?? 0) + 1;
    const failed: CloudState = {
      copy: before.copy,
      error: {
        message: err instanceof ServiceError ? err.message : "Sending did not work.",
        reason: err instanceof ServiceError ? (err.data.reason as string | undefined) : undefined,
        at: now.toISOString(),
        tries,
        again: worthAnotherTry(err) ? nextTry(tries, now) : null,
      },
    };
    await writeSetting(key(w.id), failed);
    if (!(err instanceof ServiceError)) {
      console.error("[cloud] sync failed:", err);
    }
    return failed;
  }
}

/**
 * Publishes here and, with an account linked, sends the version on. The cloud never holds the
 * publishing up or back: what it answered comes along as `cloud`.
 */
export async function publishAndSync(userId: string, wizardId: string) {
  const published = await publishWizard(userId, wizardId);
  const cloud = (await cloudLinked()) ? await syncToCloud(userId, wizardId) : null;
  return { ...published, cloud };
}

/** How a wizard is shared changed here: the copy in the cloud follows. */
export async function pushSharing(userId: string, wizardId: string): Promise<void> {
  if (!(await cloudLinked())) {
    return;
  }
  const state = await cloudState(wizardId);
  if (!state.copy) {
    return;
  }
  const w = await ownedWizard(userId, wizardId);
  await call("PATCH", `/spaces/${w.projectId}/wizards/${w.id}`, {
    shareEnabled: w.shareEnabled,
    dailyRunLimit: w.dailyRunLimit,
    translate: w.translate,
    ...(w.runners ? { runners: w.runners } : {}),
  }).catch((err) => console.error("[cloud] sharing not sent:", (err as Error).message));
}

/**
 * A new link was made here: the copy in the cloud gets a new one too, and its old one stops
 * answering. Null where no account is linked; the state as it was where the cloud has no copy.
 */
export async function rotateInCloud(userId: string, wizardId: string): Promise<CloudState | null> {
  if (!(await cloudLinked())) {
    return null;
  }
  const state = await cloudState(wizardId);
  if (!state.copy) {
    return state;
  }
  const w = await ownedWizard(userId, wizardId);
  const answer = await call<{ shareUrl: string; code?: string }>(
    "POST",
    `/spaces/${w.projectId}/wizards/${w.id}/rotate-link`,
  );
  if (!answer.ok || !answer.body.shareUrl) {
    throw refusal(answer, "The link in the cloud could not be renewed.");
  }
  const next: CloudState = {
    ...state,
    copy: { ...state.copy, shareUrl: answer.body.shareUrl, code: answer.body.code },
  };
  await writeSetting(key(w.id), next);
  return next;
}

/** A wizard is about to be deleted here: its copy in the cloud goes too. */
export async function removeFromCloud(userId: string, wizardId: string): Promise<void> {
  const state = await cloudState(wizardId);
  if (!state.copy && !state.error) {
    return;
  }
  const w = await ownedWizard(userId, wizardId).catch(() => null);
  await deleteSetting(key(wizardId));
  if (!w || !state.copy || !(await cloudLinked())) {
    return;
  }
  await call("DELETE", `/spaces/${w.projectId}/wizards/${w.id}`).catch((err) =>
    console.error("[cloud] copy not removed:", (err as Error).message),
  );
}

/**
 * Sends again what did not arrive and is due for another try. Called every minute by the
 * runtime that runs alone; a wizard that is gone meanwhile is forgotten.
 */
export async function retryFailedSends(userId: string): Promise<void> {
  if (!(await cloudLinked())) {
    return;
  }
  const now = new Date().toISOString();
  const rows = await controlDb
    .select({ key: control.setting.key, value: control.setting.value })
    .from(control.setting)
    .where(like(control.setting.key, "cloud:%"));
  for (const row of rows) {
    const state = row.value as CloudState;
    if (!state.error?.again || state.error.again > now) {
      continue;
    }
    const wizardId = row.key.slice("cloud:".length);
    const w = await ownedWizard(userId, wizardId).catch(() => null);
    if (!w?.publishedVersion) {
      await deleteSetting(row.key);
      continue;
    }
    const sent = await syncToCloud(userId, wizardId);
    // Something the person has to see to (signed out, no room) holds for every wizard.
    if (sent.error && !sent.error.again) {
      break;
    }
  }
}

/** The account was unlinked: what this runtime kept of its cloud belongs to no account now. */
export async function forgetCloud(): Promise<void> {
  await controlDb.delete(control.setting).where(like(control.setting.key, "cloud:%"));
  await forgetSentData();
}

/** The space's data counts as not sent: the next wizard takes it along again. */
async function forgetSentData() {
  await controlDb.delete(control.setting).where(like(control.setting.key, "cloud-data:%"));
}

/** Sends every published wizard: once after an account was linked. */
export async function syncAllToCloud(userId: string): Promise<{ sent: number; failed: number }> {
  // A cloud that was linked anew, or whose spaces were replaced, has none of it.
  await forgetSentData();
  const wizards = await db
    .select({ id: schema.wizard.id })
    .from(schema.wizard)
    .where(
      and(eq(schema.wizard.tenantId, currentTenant()), isNotNull(schema.wizard.publishedVersion)),
    );
  let sent = 0;
  let failed = 0;
  for (const [i, { id }] of wizards.entries()) {
    const state = await syncToCloud(userId, id);
    if (state.error) {
      failed++;
      // A refusal that holds for every wizard (no room, signed out) is not asked again; a cloud
      // out of reach neither, but the rest is then tried again later, with this one.
      if (state.error.reason && state.error.reason !== "refused") {
        for (const rest of wizards.slice(i + 1)) {
          failed++;
          await writeSetting(key(rest.id), {
            copy: (await cloudState(rest.id)).copy,
            error: state.error,
          } satisfies CloudState);
        }
        break;
      }
    } else {
      sent++;
    }
  }
  return { sent, failed };
}

/** What the cloud would lack for the draft, asked before it is published. */
export async function checkForCloud(userId: string, wizardId: string): Promise<CloudCheck> {
  const w = await ownedWizard(userId, wizardId);
  const files = await db
    .select({ path: schema.wizardFile.path })
    .from(schema.wizardFile)
    .where(eq(schema.wizardFile.wizardId, w.id));
  const answer = await call<{ problems: ServerProblem[] }>("POST", "/spaces/check", {
    definition: w.draft,
    files: files.map((f) => f.path),
  });
  if (!answer.ok) {
    throw refusal(answer, "The cloud did not answer.");
  }
  const documents = await projectFiles(w.projectId, "document");
  return {
    problems: answer.body.problems ?? [],
    documents: documents.length > 0 && w.draft.steps.some((s) => s.type === "agent"),
  };
}

export interface CloudSpace {
  id: string;
  name: string;
  syncedAt: string | null;
  wizards: { id: string; title: string; publishedVersion: number | null; shareUrl: string }[];
}

/** The projects the account's cloud holds of local installs: this one's, or another machine's. */
export async function cloudSpaces(): Promise<CloudSpace[]> {
  const answer = await call<{ spaces: CloudSpace[] }>("GET", "/spaces");
  if (!answer.ok) {
    throw refusal(answer, "The cloud did not answer.");
  }
  return answer.body.spaces ?? [];
}

/**
 * Makes room for this install's project: the projects of other installs go from the cloud, with
 * their links, then everything published here is sent. For the person who moved to a new
 * machine or installed anew.
 */
export async function replaceCloudSpaces(userId: string) {
  const mine = new Set(
    (
      await db
        .select({ id: schema.project.id })
        .from(schema.project)
        .where(eq(schema.project.tenantId, currentTenant()))
    ).map((p) => p.id),
  );
  for (const space of await cloudSpaces()) {
    if (!mine.has(space.id)) {
      const answer = await call("DELETE", `/spaces/${space.id}`);
      if (!answer.ok) {
        throw refusal(answer, "The space in the cloud could not be removed.");
      }
    }
  }
  return syncAllToCloud(userId);
}
