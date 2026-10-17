import { createHash } from "node:crypto";
import type { WizardDefinition } from "@engenty-wizards/shared/definition";
import { tableColumnsSchema } from "@engenty-wizards/shared/engenty/data-tables";
import { CATEGORY_TYPES } from "@engenty-wizards/shared/knowledge";
import { PROJECT_LIMITS } from "@engenty-wizards/shared/projects";
import { note } from "@engenty-wizards/shared/run";
import { SPACE_DATA_LIMITS } from "@engenty-wizards/shared/space-data";
import { WORKSPACE_LIMITS } from "@engenty-wizards/shared/workspace";
import { and, count, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db, inTransaction, schema } from "../db/client.js";
import { missingModels, unavoidableSteps } from "../engine/requirements.js";
import { env } from "../env.js";
import { spaceChanged } from "../plugins/events.js";
import { sandboxEngine } from "../sandbox/index.js";
import { codeOf, putLink } from "../tenants/control.js";
import { currentTenant } from "../tenants/tenant.js";
import { asSync, mayBuild } from "./access.js";
import { emitDraftChanged } from "./draft-events.js";
import { notFound, ServiceError } from "./errors.js";
import { keepFiles, replaceFiles } from "./files.js";
import { addProjectFile, projectFiles, removeProjectFile } from "./project-files.js";
import { reindexSpace } from "./project-index.js";
import {
  brandColorSchema,
  type ProjectRow,
  projectFactSchema,
  projectLimit,
  removeProject,
} from "./projects.js";
import { deleteWizard, draftIssues, parseDraft, rotateShareLink, shareUrl } from "./wizards.js";

/**
 * A local install's project on this runtime (docs/manage-contract.md, "Spaces of a local
 * install"). The install sends a wizard when it publishes it: the published version and its
 * workspace, under the ids they have there. Here the project is shown and its wizards run; it
 * is changed only by the next sync. The share link is this runtime's own.
 */

/** Ids as the local install makes them (nanoid); nothing else is taken as a key. */
const syncedId = z.string().regex(/^[A-Za-z0-9_-]{8,40}$/);

const spaceSchema = z.object({
  name: z.string().min(1).max(80),
  brand: z
    .object({
      name: z.string().max(120).optional(),
      about: z.string().max(8000).optional(),
      colors: z.array(brandColorSchema).max(PROJECT_LIMITS.colors).optional(),
    })
    .default({}),
  facts: z.array(projectFactSchema).max(PROJECT_LIMITS.facts).default([]),
  /** The logo end users see; null for none. */
  logo: z
    .object({
      name: z.string().min(1).max(120),
      mime: z.string().max(100),
      description: z.string().max(600).default(""),
      data: z.string(),
    })
    .nullable()
    .default(null),
});
export type SpaceInput = z.infer<typeof spaceSchema>;

export const syncWizardSchema = z.object({
  space: spaceSchema,
  /** The version the install published, as it counts them. */
  version: z.number().int().min(1).max(1_000_000),
  definition: z.unknown(),
  files: z
    .array(
      z.object({
        path: z.string().max(300),
        mime: z.string().max(100).optional(),
        data: z.string(),
      }),
    )
    .max(WORKSPACE_LIMITS.files)
    .default([]),
  shareEnabled: z.boolean().default(true),
  dailyRunLimit: z.number().int().min(1).max(10_000).optional(),
});
export type SyncWizardInput = z.infer<typeof syncWizardSchema>;

export const syncSettingsSchema = z.object({
  shareEnabled: z.boolean().optional(),
  translate: z.boolean().optional(),
  dailyRunLimit: z.number().int().min(1).max(10_000).optional(),
});

export const checkSchema = z.object({
  definition: z.unknown(),
  /** Paths of the wizard's workspace files. */
  files: z.array(z.string().max(300)).max(WORKSPACE_LIMITS.files).default([]),
});

/**
 * What keeps a synced wizard from running here as it does at home. `blocking`: no run can
 * finish, so the version is kept but not published. The words are the studio's to choose.
 */
export interface ServerProblem {
  code: "invalid" | "model" | "sandbox" | "mcp" | "connector";
  blocking: boolean;
  steps: { id: string; title: string }[];
  /** The validator's sentence, the class and why it is missing, or the name of what is missing. */
  detail: string;
}

export interface SyncResult {
  wizardId: string;
  /** The link of the copy here; it stays over later syncs. */
  shareUrl: string;
  /** The copy's ID for the mobile app, for the install to show beside the link. */
  code: string;
  shareEnabled: boolean;
  /** The version runs start on here; null when none could be published yet. */
  publishedVersion: number | null;
  /** The sent version is the one that runs. */
  runnable: boolean;
  problems: ServerProblem[];
}

const stepsWith = (
  def: WizardDefinition,
  has: (step: WizardDefinition["steps"][number]) => boolean,
) => def.steps.filter(has).map((s) => ({ id: s.id, title: s.title }));

/**
 * What of a wizard does not work on this runtime: what its validator says here (a connector
 * the project lacks, a plugin's tool), model classes nothing is bound to, the sandbox where
 * there is none, MCP servers the project does not know.
 */
export async function serverProblems(
  def: WizardDefinition,
  issues: { stepId?: string; message: string }[],
  mcpServers: string[],
): Promise<ServerProblem[]> {
  const problems: ServerProblem[] = issues.map((issue) => ({
    code: /connector/i.test(issue.message) ? "connector" : "invalid",
    blocking: true,
    steps: stepsWith(def, (s) => s.id === issue.stepId),
    detail: issue.message,
  }));
  for (const missing of await missingModels(def)) {
    problems.push({
      code: "model",
      blocking: missing.blocking,
      steps: missing.steps,
      detail: `${missing.cls}: ${missing.problem}`,
    });
  }
  if (!sandboxEngine()) {
    const steps = stepsWith(def, (s) => s.type === "agent" && s.tools.includes("sandbox"));
    if (steps.length) {
      problems.push({ code: "sandbox", blocking: false, steps, detail: "" });
    }
  }
  const unknown = new Set<string>();
  const steps = stepsWith(def, (s) => {
    const lacking =
      s.type === "agent" ? (s.mcp ?? []).filter((id) => !mcpServers.includes(id)) : [];
    for (const id of lacking) {
      unknown.add(id);
    }
    return lacking.length > 0;
  });
  if (steps.length) {
    const unavoidable = unavoidableSteps(def);
    problems.push({
      code: "mcp",
      blocking: steps.some((s) => unavoidable.has(s.id)),
      steps,
      detail: [...unknown].join(", "),
    });
  }
  return problems;
}

/** What a wizard would lack here, asked before it is sent: no project is touched. */
export async function checkOnServer(input: z.infer<typeof checkSchema>): Promise<ServerProblem[]> {
  const { draft, issues } = parseDraft(input.definition, input.files);
  // Connectors are a project's; a project that is not here yet has none.
  const connectors = (draft.connections ?? [])
    .filter((c) => c.connector)
    .map((c) => ({
      message: `Connection "${c.id}" uses connector "${c.connector}", which this project has not imported.`,
    }));
  return serverProblems(draft, [...issues, ...connectors], []);
}

async function syncedProject(spaceId: string): Promise<ProjectRow | null> {
  const p = await db.query.project.findFirst({
    where: and(eq(schema.project.id, spaceId), eq(schema.project.tenantId, currentTenant())),
  });
  return p ?? null;
}

/** Refuses a project beyond the tenant's number; a synced one counts like one made here. */
async function requireRoom(spaceId: string): Promise<void> {
  const mine = eq(schema.project.tenantId, currentTenant());
  // What a tenant that builds nothing here once made here is not shown, so it takes no place.
  const counted = (await mayBuild()) ? mine : and(mine, eq(schema.project.origin, "local"));
  const others = await db
    .select({ id: schema.project.id, name: schema.project.name, origin: schema.project.origin })
    .from(schema.project)
    .where(and(counted, sql`${schema.project.id} <> ${spaceId}`));
  const limit = await projectLimit();
  if (others.length >= limit) {
    throw new ServiceError(
      "refused",
      limit === 1 ? note("accountAlreadySpace") : note("accountAlreadySpaces", { count: limit }),
      {
        reason: "space_limit",
        limit,
        spaces: others.filter((p) => p.origin === "local").map((p) => ({ id: p.id, name: p.name })),
      },
    );
  }
}

/** A synced project holds so many wizards: each brings up to 25 MB of files to keep. */
async function requireWizardRoom(spaceId: string): Promise<void> {
  const [row] = await db
    .select({ n: count() })
    .from(schema.wizard)
    .where(eq(schema.wizard.projectId, spaceId));
  if ((row?.n ?? 0) >= env.limits.syncedWizards) {
    throw new ServiceError(
      "refused",
      note("roomMostPublishedWizards", { count: env.limits.syncedWizards }),
      { reason: "wizard_limit", limit: env.limits.syncedWizards },
    );
  }
}

const hashOf = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

/**
 * The project's logo follows the install's: kept when it is the same picture, else replaced —
 * the new one is stored before the old one goes, so a store that fails leaves the old one.
 */
async function syncLogo(projectId: string, logo: SpaceInput["logo"]): Promise<void> {
  const here = await projectFiles(projectId, "logo");
  const data = logo ? Buffer.from(logo.data, "base64") : null;
  const mark = data ? `sync:${hashOf(data)}` : null;
  if (mark && here.length === 1 && here[0].source === mark) {
    return;
  }
  if (logo && data && mark) {
    await addProjectFile(projectId, {
      kind: "logo",
      name: logo.name,
      mime: logo.mime,
      data,
      // With words of its own no model is asked to describe it.
      description: logo.description || logo.name,
      source: mark,
    });
  }
  for (const old of here) {
    await removeProjectFile(projectId, old.id);
  }
}

/** Makes or updates the synced project: its name and what it says about itself (the logo: syncLogo). */
async function syncSpace(spaceId: string, space: SpaceInput): Promise<ProjectRow> {
  const existing = await syncedProject(spaceId);
  if (existing && existing.origin !== "local") {
    throw new ServiceError("refused", note("spaceIdAlreadyExists"), {
      reason: "id_taken",
    });
  }
  if (!existing) {
    await requireRoom(spaceId);
  }
  const now = new Date();
  const values = { name: space.name, brand: space.brand, facts: space.facts, syncedAt: now };
  if (existing) {
    await db
      .update(schema.project)
      .set({ ...values, updatedAt: now })
      .where(eq(schema.project.id, spaceId));
  } else {
    await db.insert(schema.project).values({
      id: spaceId,
      tenantId: currentTenant(),
      origin: "local",
      mcpServers: [],
      ...values,
    });
  }
  spaceChanged(existing ? "space.updated" : "space.created", spaceId);
  const project = await syncedProject(spaceId);
  if (!project) {
    throw notFound();
  }
  return project;
}

/**
 * Takes a wizard a local install published: the project it is in, the wizard under its id, its
 * workspace, and the version — published here when a run of it can finish. Sending the same
 * wizard again updates the copy; its link stays. The files' bytes are kept first; then the
 * project, the wizard, its workspace and the version are written in one transaction, so an
 * install whose sending broke off finds nothing half done and sends again.
 */
export async function syncWizard(
  rawSpaceId: string,
  rawWizardId: string,
  input: SyncWizardInput,
): Promise<SyncResult> {
  const spaceId = syncedId.parse(rawSpaceId);
  const wizardId = syncedId.parse(rawWizardId);
  // The shape is checked before anything is written; a wrong one leaves nothing behind.
  const { draft } = parseDraft(
    input.definition,
    input.files.map((f) => f.path),
  );
  return asSync(async () => {
    const files = await keepFiles(
      input.files.map((f) => ({ path: f.path, mime: f.mime, data: Buffer.from(f.data, "base64") })),
    );
    const taken = await inTransaction(async () => {
      const project = await syncSpace(spaceId, input.space);
      const existing = await db.query.wizard.findFirst({
        where: and(eq(schema.wizard.id, wizardId), eq(schema.wizard.tenantId, currentTenant())),
      });
      if (existing && existing.projectId !== spaceId) {
        throw new ServiceError("refused", note("wizardIdAlreadyBelongs"), {
          reason: "id_taken",
        });
      }
      const settings = {
        title: draft.title,
        draft,
        shareEnabled: input.shareEnabled,
        ...(input.dailyRunLimit ? { dailyRunLimit: input.dailyRunLimit } : {}),
      };
      if (!existing) {
        await requireWizardRoom(spaceId);
      }
      if (existing) {
        await db
          .update(schema.wizard)
          .set({ ...settings, revision: sql`${schema.wizard.revision} + 1`, updatedAt: new Date() })
          .where(eq(schema.wizard.id, wizardId));
      } else {
        await db.insert(schema.wizard).values({
          id: wizardId,
          projectId: spaceId,
          tenantId: currentTenant(),
          // The link is made here: a token an install brought could be one another tenant holds.
          shareToken: nanoid(14),
          dailyRunLimit: env.limits.defaultDailyRuns,
          ...settings,
        });
      }
      // The workspace becomes what was sent: files that are gone there go here.
      await replaceFiles(wizardId, files);
      const row = await db.query.wizard.findFirst({ where: eq(schema.wizard.id, wizardId) });
      if (!row) {
        throw notFound();
      }
      const problems = await serverProblems(
        draft,
        await draftIssues(row),
        project.mcpServers.map((s) => s.id),
      );
      const runnable = !problems.some((p) => p.blocking);
      let publishedVersion = row.publishedVersion;
      if (runnable) {
        await db
          .insert(schema.wizardVersion)
          .values({ id: nanoid(12), wizardId, version: input.version, definition: draft, files })
          .onConflictDoUpdate({
            target: [schema.wizardVersion.wizardId, schema.wizardVersion.version],
            set: { definition: draft, files },
          });
        await db
          .update(schema.wizard)
          .set({ publishedVersion: input.version })
          .where(eq(schema.wizard.id, wizardId));
        publishedVersion = input.version;
      }
      // Last, since it reaches the object store: a store that fails takes everything back.
      await syncLogo(spaceId, input.space.logo);
      return { row, problems, runnable, publishedVersion };
    });
    const { row, problems, runnable, publishedVersion } = taken;
    // The public link lives in the control database, outside the transaction: set on every
    // sync, so one that failed to get there once is there after the next.
    await putLink(row.shareToken, "wizard", wizardId);
    emitDraftChanged({
      wizardId,
      kind: "draft",
      revision: row.revision,
      source: "mcp",
      client: "sync",
      note: null,
      touched: [],
    });
    return {
      wizardId,
      shareUrl: shareUrl(row.shareToken),
      code: await codeOf(row.shareToken),
      shareEnabled: row.shareEnabled,
      publishedVersion,
      runnable,
      problems,
    };
  });
}

async function syncedWizard(rawSpaceId: string, rawWizardId: string) {
  const spaceId = syncedId.parse(rawSpaceId);
  const wizardId = syncedId.parse(rawWizardId);
  const project = await syncedProject(spaceId);
  const w =
    project?.origin === "local"
      ? await db.query.wizard.findFirst({
          where: and(eq(schema.wizard.id, wizardId), eq(schema.wizard.projectId, spaceId)),
        })
      : null;
  if (!w) {
    throw notFound();
  }
  return w;
}

/** The install changed how a synced wizard is shared: its link on or off, its runs a day. */
export async function patchSyncedWizard(
  spaceId: string,
  wizardId: string,
  patch: z.infer<typeof syncSettingsSchema>,
) {
  const w = await syncedWizard(spaceId, wizardId);
  await db
    .update(schema.wizard)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(schema.wizard.id, w.id));
  return { ok: true };
}

/** The install made a new link for a wizard: its copy here gets one too, the old one stops. */
export async function rotateSyncedLink(userId: string, spaceId: string, wizardId: string) {
  const w = await syncedWizard(spaceId, wizardId);
  const { shareToken } = await asSync(() => rotateShareLink(userId, w.id));
  return { shareUrl: shareUrl(shareToken), code: await codeOf(shareToken) };
}

/** The install deleted a wizard: its copy here goes, with its link and its runs. */
export async function removeSyncedWizard(userId: string, spaceId: string, wizardId: string) {
  const w = await syncedWizard(spaceId, wizardId);
  await asSync(() => deleteWizard(userId, w.id));
  return { ok: true };
}

/** The projects local installs synced, with their wizards: what an install compares itself to. */
export async function listSyncedSpaces() {
  const projects = await db.query.project.findMany({
    where: and(eq(schema.project.tenantId, currentTenant()), eq(schema.project.origin, "local")),
    orderBy: [schema.project.createdAt],
  });
  const wizards = projects.length
    ? await db
        .select({
          id: schema.wizard.id,
          projectId: schema.wizard.projectId,
          title: schema.wizard.title,
          publishedVersion: schema.wizard.publishedVersion,
          shareToken: schema.wizard.shareToken,
          shareEnabled: schema.wizard.shareEnabled,
        })
        .from(schema.wizard)
        .where(
          inArray(
            schema.wizard.projectId,
            projects.map((p) => p.id),
          ),
        )
    : [];
  return projects.map((p) => ({
    id: p.id,
    name: p.name,
    syncedAt: p.syncedAt?.toISOString() ?? null,
    wizards: wizards
      .filter((w) => w.projectId === p.id)
      .map((w) => ({
        id: w.id,
        title: w.title,
        publishedVersion: w.publishedVersion,
        shareUrl: shareUrl(w.shareToken),
        shareEnabled: w.shareEnabled,
      })),
  }));
}

/** Takes a synced project away from this runtime: its wizards, their links and runs, its files. */
export async function removeSyncedSpace(rawSpaceId: string) {
  const spaceId = syncedId.parse(rawSpaceId);
  const project = await syncedProject(spaceId);
  if (project?.origin !== "local") {
    throw notFound();
  }
  await asSync(() => removeProject(spaceId));
  return { ok: true };
}

// --- the space's own tables and pages --------------------------------------------
// What the admin made under Space → Data on the install, not what a wizard keeps: those stay
// where their runs write them. Sent as a whole, it replaces what came before.

// Since Knowledge: sub-pages, where an item came from, categories and what has them. An install of
// before sends none of it.
export const syncDataSchema = z.object({
  tables: z
    .array(
      z.object({
        id: syncedId,
        title: z.string().min(1).max(120),
        format: z.enum(["faq"]).nullish(),
        originLabel: z.string().max(120).nullish(),
        columns: tableColumnsSchema,
        rows: z
          .array(z.object({ id: syncedId, cells: z.record(z.string(), z.unknown()) }))
          .max(SPACE_DATA_LIMITS.rowsPerTable),
      }),
    )
    .max(SPACE_DATA_LIMITS.tables),
  pages: z
    .array(
      z.object({
        id: syncedId,
        title: z.string().min(1).max(200),
        markdown: z.string().max(SPACE_DATA_LIMITS.pageChars),
        parentId: syncedId.nullish(),
        position: z.number().int().min(0).optional(),
        originLabel: z.string().max(120).nullish(),
      }),
    )
    .max(SPACE_DATA_LIMITS.pages),
  categories: z
    .array(
      z.object({
        id: syncedId,
        name: z.string().min(1).max(80),
        type: z.enum(CATEGORY_TYPES),
        unit: z.string().max(20).nullish(),
        multiple: z.boolean(),
        ordered: z.boolean(),
        hint: z.string().max(120).nullish(),
        tableId: syncedId.nullish(),
        columnId: z.string().max(64).nullish(),
        position: z.number().int().min(0),
        values: z
          .array(
            z.object({
              id: syncedId,
              value: z.string().min(1).max(200),
              position: z.number().int().min(0),
              summary: z.string().max(20_000).nullish(),
            }),
          )
          .max(2000),
      }),
    )
    .max(60)
    .optional(),
  /** `p:<page>`, `t:<table>`, `r:<row>`: files stay with the install. */
  assignments: z
    .array(
      z.object({
        categoryId: syncedId,
        item: z.string().regex(/^[ptr]:[A-Za-z0-9_-]{8,40}$/),
        valueId: syncedId.nullish(),
        text: z.string().max(300).nullish(),
        num: z.number().nullish(),
        at: z.number().int().nullish(),
        bool: z.boolean().nullish(),
        by: z.enum(["person", "origin", "model"]),
      }),
    )
    .max(200_000)
    .optional(),
});
export type SyncDataInput = z.infer<typeof syncDataSchema>;

/**
 * Takes the space's own tables and pages a local install sent: those it no longer has go, the
 * others are written under the ids they have there. The space must be here already: it comes
 * with the first wizard.
 */
export async function syncSpaceData(rawSpaceId: string, input: SyncDataInput) {
  const spaceId = syncedId.parse(rawSpaceId);
  const project = await syncedProject(spaceId);
  if (project?.origin !== "local") {
    throw notFound();
  }
  const own = (table: typeof schema.spaceTable | typeof schema.spacePage) =>
    and(eq(table.projectId, spaceId), isNull(table.wizardId));
  const tableIds = input.tables.map((t) => t.id);
  const pageIds = input.pages.map((p) => p.id);
  // An id this tenant uses for something else is not taken over.
  const [tablesHere, pagesHere] = await Promise.all([
    tableIds.length
      ? db.query.spaceTable.findMany({
          where: inArray(schema.spaceTable.id, tableIds),
          columns: { id: true, projectId: true, wizardId: true },
        })
      : [],
    pageIds.length
      ? db.query.spacePage.findMany({
          where: inArray(schema.spacePage.id, pageIds),
          columns: { id: true, projectId: true, wizardId: true },
        })
      : [],
  ]);
  if ([...tablesHere, ...pagesHere].some((x) => x.projectId !== spaceId || x.wizardId !== null)) {
    throw new ServiceError("refused", note("idAlreadyUse"), {
      reason: "id_taken",
    });
  }
  const now = new Date();
  await inTransaction(async () => {
    await db
      .delete(schema.spaceTable)
      .where(
        and(
          own(schema.spaceTable),
          tableIds.length ? notInArray(schema.spaceTable.id, tableIds) : undefined,
        ),
      );
    await db
      .delete(schema.spacePage)
      .where(
        and(
          own(schema.spacePage),
          pageIds.length ? notInArray(schema.spacePage.id, pageIds) : undefined,
        ),
      );
    for (const table of input.tables) {
      const values = { title: table.title, columns: table.columns, updatedAt: now };
      await db
        .insert(schema.spaceTable)
        .values({ id: table.id, tenantId: currentTenant(), projectId: spaceId, ...values })
        .onConflictDoUpdate({ target: schema.spaceTable.id, set: values });
      await db.delete(schema.spaceTableRow).where(eq(schema.spaceTableRow.tableId, table.id));
      for (let i = 0; i < table.rows.length; i += 200) {
        const batch = table.rows.slice(i, i + 200);
        // The order they stand in there: one millisecond apart.
        await db.insert(schema.spaceTableRow).values(
          batch.map((row, j) => ({
            id: row.id,
            tableId: table.id,
            cells: row.cells,
            createdAt: new Date(now.getTime() - table.rows.length + i + j),
          })),
        );
      }
    }
    for (const page of input.pages) {
      const values = {
        title: page.title,
        markdown: page.markdown,
        position: page.position ?? 0,
        originLabel: page.originLabel ?? null,
        // Its place comes after every page is there.
        parentId: null,
        slug: null,
        updatedAt: now,
      };
      await db
        .insert(schema.spacePage)
        .values({ id: page.id, tenantId: currentTenant(), projectId: spaceId, ...values })
        .onConflictDoUpdate({ target: schema.spacePage.id, set: values });
    }
    const pagesThere = new Set(pageIds);
    for (const page of input.pages) {
      if (page.parentId && pagesThere.has(page.parentId) && page.parentId !== page.id) {
        await db
          .update(schema.spacePage)
          .set({ parentId: page.parentId })
          .where(eq(schema.spacePage.id, page.id));
      }
    }
    for (const table of input.tables) {
      await db
        .update(schema.spaceTable)
        .set({ format: table.format ?? null, originLabel: table.originLabel ?? null, slug: null })
        .where(eq(schema.spaceTable.id, table.id));
    }
    if (input.categories) {
      await syncCategories(spaceId, input.categories, input.assignments ?? []);
    }
  });
  await reindexSpace(spaceId);
  return { tables: input.tables.length, pages: input.pages.length };
}

/** The categories a local install sent, their values, and what has them: they replace these here. */
async function syncCategories(
  spaceId: string,
  categories: NonNullable<SyncDataInput["categories"]>,
  assignments: NonNullable<SyncDataInput["assignments"]>,
) {
  const ids = categories.map((c) => c.id);
  const taken = ids.length
    ? await db.query.spaceCategory.findMany({
        where: inArray(schema.spaceCategory.id, ids),
        columns: { id: true, projectId: true },
      })
    : [];
  if (taken.some((c) => c.projectId !== spaceId)) {
    throw new ServiceError("refused", note("idAlreadyUse"), {
      reason: "id_taken",
    });
  }
  await db
    .delete(schema.spaceCategory)
    .where(
      and(
        eq(schema.spaceCategory.projectId, spaceId),
        ids.length ? notInArray(schema.spaceCategory.id, ids) : undefined,
      ),
    );
  await db.delete(schema.spaceItemCategory).where(eq(schema.spaceItemCategory.projectId, spaceId));
  const tables = new Set(
    (
      await db.query.spaceTable.findMany({
        where: eq(schema.spaceTable.projectId, spaceId),
        columns: { id: true },
      })
    ).map((t) => t.id),
  );
  const values = new Set<string>();
  for (const c of categories) {
    const row = {
      name: c.name,
      type: c.type,
      unit: c.unit ?? null,
      multiple: c.multiple,
      ordered: c.ordered,
      hint: c.hint ?? null,
      proposed: false,
      tableId: c.tableId && tables.has(c.tableId) ? c.tableId : null,
      columnId: c.tableId && tables.has(c.tableId) ? (c.columnId ?? null) : null,
      position: c.position,
      updatedAt: new Date(),
    };
    await db
      .insert(schema.spaceCategory)
      .values({ id: c.id, tenantId: currentTenant(), projectId: spaceId, ...row })
      .onConflictDoUpdate({ target: schema.spaceCategory.id, set: row });
    const valueIds = c.values.map((v) => v.id);
    await db
      .delete(schema.spaceCategoryValue)
      .where(
        and(
          eq(schema.spaceCategoryValue.categoryId, c.id),
          valueIds.length ? notInArray(schema.spaceCategoryValue.id, valueIds) : undefined,
        ),
      );
    for (const v of c.values) {
      const set = {
        value: v.value,
        position: v.position,
        summary: v.summary ?? null,
        summaryAt: v.summary ? new Date() : null,
      };
      await db
        .insert(schema.spaceCategoryValue)
        .values({ id: v.id, categoryId: c.id, ...set })
        .onConflictDoUpdate({ target: schema.spaceCategoryValue.id, set });
      values.add(v.id);
    }
  }
  const known = new Set(ids);
  const rows = assignments.filter(
    (a) => known.has(a.categoryId) && (!a.valueId || values.has(a.valueId)),
  );
  for (let i = 0; i < rows.length; i += 200) {
    await db.insert(schema.spaceItemCategory).values(
      rows.slice(i, i + 200).map((a) => {
        const id = a.item.slice(2);
        return {
          projectId: spaceId,
          categoryId: a.categoryId,
          pageId: a.item[0] === "p" ? id : null,
          tableId: a.item[0] === "t" ? id : null,
          rowId: a.item[0] === "r" ? id : null,
          valueId: a.valueId ?? null,
          text: a.text ?? null,
          num: a.num ?? null,
          at: a.at ?? null,
          bool: a.bool ?? null,
          by: a.by,
        };
      }),
    );
  }
}
