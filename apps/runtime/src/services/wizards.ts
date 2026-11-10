import { versionChanges } from "@engenty/wizards-shared/changes";
import type { StepWarning } from "@engenty/wizards-shared/connectors";
import {
  DEFINITION_VERSION,
  type Lang,
  pluginToolOf,
  shapeIssues,
  type ToolStep,
  type ValidationIssue,
  validateWizard,
  type WizardDefinition,
  wizardSchema,
} from "@engenty/wizards-shared/definition";
import { withRequires } from "@engenty/wizards-shared/requires";
import { note } from "@engenty/wizards-shared/run";
import type { RunnerSettings } from "@engenty/wizards-shared/runners";
import { DATA_MIGRATIONS, wizardDataIssues } from "@engenty/wizards-shared/wizard-data";
import type { WorkspaceFile } from "@engenty/wizards-shared/workspace";
import { and, desc, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { applyOps, OpError, type WizardOp } from "../authoring/ops.js";
import { decide, kindOf } from "../broker/index.js";
import { listConnectors, resolveConnector } from "../connectors/external.js";
import { listSpaceConnections } from "../connectors/space-connections.js";
import { db, schema } from "../db/client.js";
import type { ConnectorDefinition } from "../engenty/connections-sdk/types.js";
import { answeringNarrowed, whoOf } from "../engine/answerers.js";
import { env } from "../env.js";
import { getBlob } from "../files/blobs.js";
import { managed, tenantMembers } from "../manage.js";
import { saidOf } from "../model-errors.js";
import { pluginToolsOf } from "../plugins/registry.js";
import { dropWizardData } from "../store/data.js";
import { dropLinks, putLink } from "../tenants/control.js";
import { currentTenant } from "../tenants/tenant.js";
import { serverText } from "../texts.js";
import { requireAdmin, requireBuild, requireWritable, requireWritableSpace } from "./access.js";
import { changedSteps, emitDraftChanged } from "./draft-events.js";
import { notFound, ServiceError } from "./errors.js";
import { copyFiles, draftFiles, sameFiles, seedFiles } from "./files.js";
import { forgetWizardLinks } from "./links.js";
import { pushWizards } from "./manage-reports.js";
import { asLang, countInstall, marketplaceWizard } from "./marketplace.js";
import { requireMaker } from "./members-studio.js";
import { pushPages } from "./pages.js";
import { checkRunnerSettings } from "./runners.js";
import { defaultSpace, ownedSpace } from "./spaces.js";
import { saveTheme } from "./themes.js";
import { workspaceSkillIssues } from "./wizard-skills.js";

export type WizardRow = typeof schema.wizard.$inferSelect;

/** Who wrote: the studio, or an admin's own MCP client (named after its API key). */
export type Writer = { source: "studio" } | { source: "mcp"; client: string };

/** The wizard a new one starts as, in the language of whoever makes it. */
function blankWizard(lang: Lang): WizardDefinition {
  return {
    version: DEFINITION_VERSION,
    title: serverText(lang, "newWizard"),
    description: "",
    avatar: "round",
    lang,
    steps: [
      {
        id: "start",
        type: "form",
        title: serverText(lang, "newWizardStart"),
        fields: [
          {
            id: "input",
            label: serverText(lang, "newWizardAsk"),
            kind: "textarea",
            required: true,
          },
        ],
      },
      { id: "done", type: "result", title: serverText(lang, "newWizardDone"), deliverables: [] },
    ],
  };
}

export const studioUrl = (wizardId: string) => `${env.appUrl}/studio/edit/${wizardId}`;
export const shareUrl = (token: string) => `${env.publicUrl}/w/${token}`;
const newShareToken = () => nanoid(14);

export async function ownedWizard(_userId: string, wizardId: string): Promise<WizardRow> {
  const w = await db.query.wizard.findFirst({
    where: and(eq(schema.wizard.id, wizardId), eq(schema.wizard.tenantId, currentTenant())),
  });
  if (!w) {
    throw notFound();
  }
  return w;
}

/** The wizard, for a change: refused where its space is a local install's or nothing is built here. */
export async function writableWizard(userId: string, wizardId: string): Promise<WizardRow> {
  const w = await ownedWizard(userId, wizardId);
  await requireWritableSpace(w.spaceId);
  return w;
}

export function wizardSummary(w: WizardRow) {
  return {
    id: w.id,
    spaceId: w.spaceId,
    title: w.title,
    description: w.draft.description,
    avatar: w.draft.avatar,
    costume: w.draft.costume,
    revision: w.revision,
    published: w.publishedVersion !== null,
    publishedVersion: w.publishedVersion,
    shareToken: w.shareToken,
    shareEnabled: w.shareEnabled,
    /** Who answers its steps with `who: "team"`. */
    answerers: w.answerers,
    dailyRunLimit: w.dailyRunLimit,
    /** How many emails guests' runs send per day, from any address. */
    dailyMailLimit: w.dailyMailLimit,
    /** How it is offered; null: the link opens the page, the chat is on beside it. */
    runners: w.runners,
    /** Its page offers it in the viewer's language, translated on request. */
    translate: w.translate,
    /** What begins a run without a person. */
    starts: w.starts,
    stepCount: w.draft.steps.length,
    updatedAt: w.updatedAt.toISOString(),
  };
}

export async function listWizards(_userId: string, spaceId?: string) {
  const rows = await db.query.wizard.findMany({
    where: and(
      eq(schema.wizard.tenantId, currentTenant()),
      spaceId ? eq(schema.wizard.spaceId, spaceId) : undefined,
    ),
    orderBy: [desc(schema.wizard.updatedAt)],
  });
  return rows.map(wizardSummary);
}

/** The organization has made a wizard: the studio offers itself as an app from then on. */
export async function hasWizards(): Promise<boolean> {
  const row = await db.query.wizard.findFirst({
    columns: { id: true },
    where: eq(schema.wizard.tenantId, currentTenant()),
  });
  return Boolean(row);
}

export async function publishedVersion(w: WizardRow) {
  if (w.publishedVersion === null) {
    return null;
  }
  const v = await db.query.wizardVersion.findFirst({
    where: and(
      eq(schema.wizardVersion.wizardId, w.id),
      eq(schema.wizardVersion.version, w.publishedVersion),
    ),
  });
  return v ?? null;
}

/** Connections must name connectors the space has imported, and actions those connectors have. */
async function connectorIssues(spaceId: string, draft: WizardDefinition) {
  const wanted = (draft.connections ?? []).filter((c) => c.connector);
  if (!wanted.length) {
    return [];
  }
  const issues: ValidationIssue[] = [];
  const connectors = await listConnectors(spaceId);
  for (const connection of wanted) {
    const connector = connectors.find((c) => c.id === connection.connector);
    if (!connector) {
      issues.push({
        message: `Connection "${connection.id}" uses connector "${connection.connector}", which this space has not imported.`,
      });
      continue;
    }
    const unknown = (connection.actions ?? []).filter(
      (a) => !connector.actions.some((x) => x.id === a),
    );
    if (unknown.length && !connector.toolsPending) {
      issues.push({
        message: `Connection "${connection.id}": ${connector.name} has no action ${unknown.map((a) => `"${a}"`).join(", ")}.`,
      });
    }
  }
  return issues;
}

/** Tools of plugins the draft's steps list that this tenant does not have. */
async function pluginIssues(draft: WizardDefinition) {
  const issues: ValidationIssue[] = [];
  let known: Set<string> | null = null;
  for (const step of draft.steps) {
    const tools =
      step.type === "agent"
        ? step.tools
        : step.type === "tool" && step.call && "tool" in step.call
          ? [step.call.tool]
          : [];
    for (const id of tools) {
      const named = pluginToolOf(id);
      if (!named) {
        continue;
      }
      known ??= new Set((await pluginToolsOf(currentTenant())).map((tool) => tool.id));
      if (!known.has(id)) {
        issues.push({
          stepId: step.id,
          message: `Step “${step.id}”: the tool “${id}” isn’t available here – the plugin “${named.plugin}” isn’t installed or has no such tool.`,
        });
      }
    }
  }
  return issues;
}

/**
 * A draft's connections of the space (A4 of docs/plans/capabilities.md): the connection must exist;
 * on one that signs in as the space an AI step only reads, so a write action it lists is refused;
 * a fixed `call` step names an action the connector has and the connection is for.
 */
async function spaceConnectionIssues(spaceId: string, draft: WizardDefinition) {
  const connections = draft.connections ?? [];
  const fixed = draft.steps.filter(
    (s) => s.type === "tool" && s.call && "connection" in s.call,
  ) as (ToolStep & { call: { connection: string; action: string } })[];
  if (!connections.some((c) => c.spaceConnection) && !fixed.length) {
    return [];
  }
  const issues: ValidationIssue[] = [];
  const rows = await listSpaceConnections(spaceId);
  const connectors = new Map<string, ConnectorDefinition | null>();
  const connectorOf = async (id: string) => {
    if (!connectors.has(id)) {
      connectors.set(id, (await resolveConnector(spaceId, id))?.connector ?? null);
    }
    return connectors.get(id) ?? null;
  };
  for (const connection of connections) {
    const row = connection.spaceConnection
      ? rows.find((r) => r.id === connection.spaceConnection)
      : null;
    if (connection.spaceConnection && !row) {
      issues.push({
        message: `Connection "${connection.id}" names the space's connection "${connection.spaceConnection}", which this space does not have.`,
      });
      continue;
    }
    const connector = await connectorOf(row?.connectorId ?? connection.connector ?? "");
    if (!connector) {
      continue;
    }
    const name = connection.title ?? connector.name;
    if (row?.signIn === "space") {
      const writes = (connection.actions ?? []).filter((id) => {
        const action = connector.actions.find((a) => a.id === id);
        return action && action.group !== "read";
      });
      for (const step of draft.steps) {
        if (step.type !== "agent" || !step.connections?.includes(connection.id)) {
          continue;
        }
        for (const id of writes) {
          issues.push({
            stepId: step.id,
            message: `Step "${step.id}": "${id}" writes in ${name}, which signs in as the space. An AI step only reads there; put the write in a tool step.`,
          });
        }
      }
    }
    for (const step of fixed.filter((s) => s.call.connection === connection.id)) {
      const action = connector.actions.find((a) => a.id === step.call.action);
      if (!action) {
        issues.push({
          stepId: step.id,
          message: `Step "${step.id}": ${name} has no action "${step.call.action}".`,
        });
      } else if (row?.actions.length && !row.actions.includes(action.id)) {
        issues.push({
          stepId: step.id,
          message: `Step "${step.id}": the connection ${name} is not for "${action.id}".`,
        });
      }
    }
  }
  return issues;
}

/**
 * The fixed steps of a draft that fail in a run as the space's rules are now
 * (docs/plans/capabilities-next.md, 2b): a `call` on a connection of the space whose rule for
 * that kind of action is „Mit Freigabe“ asks the space's admins, and nothing in a run waits for
 * them. The broker's own decision says so, read from the rule as it is: the warning is gone once
 * the rule says „Erlaubt“, and a wizard's own connection or a read never has one. No issue: the
 * wizard saves and publishes.
 */
export async function stepWarnings(
  spaceId: string,
  draft: WizardDefinition,
): Promise<StepWarning[]> {
  const fixed = draft.steps.filter(
    (s) => s.type === "tool" && s.call && "connection" in s.call,
  ) as (ToolStep & { call: { connection: string; action: string } })[];
  const ofSpace = new Map(
    (draft.connections ?? []).flatMap((c) =>
      c.spaceConnection ? [[c.id, c.spaceConnection]] : [],
    ),
  );
  if (!fixed.some((step) => ofSpace.has(step.call.connection))) {
    return [];
  }
  const rows = await listSpaceConnections(spaceId);
  const warnings: StepWarning[] = [];
  for (const step of fixed) {
    const row = rows.find((r) => r.id === ofSpace.get(step.call.connection));
    const connector = row ? (await resolveConnector(spaceId, row.connectorId))?.connector : null;
    const action = connector?.actions.find((a) => a.id === step.call.action);
    if (!(row && connector && action)) {
      continue;
    }
    const kind = kindOf(action.group);
    // As the step of an admin's run: in every audience, so only the rule speaks.
    const decision = decide({
      who: { kind: "step", for: { kind: "admin" } },
      where: {},
      connection: { kind: "space_connection", row, connector },
      actionId: action.id,
      kind,
    });
    if (decision.outcome === "ask" && decision.admins) {
      warnings.push({
        stepId: step.id,
        kind: "needs_approval",
        connection: { id: row.id, name: row.name },
        action: { id: action.id, kind },
      });
    }
  }
  return warnings;
}

/** The SQL files of a draft's own database, read: each splits into statements the runtime runs. */
async function draftDataIssues(draft: WizardDefinition, files: WorkspaceFile[]) {
  if (!draft.data) {
    return [];
  }
  const paths = files.map((f) => f.path);
  const wanted = [draft.data.schema, ...paths.filter((p) => DATA_MIGRATIONS.test(p))];
  const texts = new Map<string, string>();
  for (const f of files.filter((f) => wanted.includes(f.path))) {
    texts.set(f.path, (await getBlob(f.hash)).toString("utf8"));
  }
  return wizardDataIssues(draft, paths, (p) => texts.get(p) ?? null).map((i) => ({
    message: i.message,
  }));
}

/**
 * Everything wrong with a draft: its structure, its workspace files and the skills and SQL among
 * them, its space's connectors and plugins.
 */
export async function checkDraft(
  spaceId: string,
  draft: WizardDefinition,
  files?: WorkspaceFile[],
) {
  return [
    ...validateWizard(
      draft,
      files?.map((f) => f.path),
    ),
    ...(files ? await workspaceSkillIssues(files) : []),
    ...(files ? await draftDataIssues(draft, files) : []),
    ...(await connectorIssues(spaceId, draft)),
    ...(await spaceConnectionIssues(spaceId, draft)),
    ...(await pluginIssues(draft)),
  ];
}

/** Validator issues of the draft, checked against its workspace and the space's connectors. */
export async function draftIssues(w: WizardRow) {
  return checkDraft(w.spaceId, w.draft, await draftFiles(w.id));
}

/** The draft with its validator issues and whether it differs from the published version. */
export async function wizardState(w: WizardRow) {
  const published = await publishedVersion(w);
  const files = await draftFiles(w.id);
  return {
    ...wizardSummary(w),
    draft: w.draft,
    files,
    issues: await checkDraft(w.spaceId, w.draft, files),
    /** Steps that save and publish and fail in a run as the space's rules are now. */
    warnings: await stepWarnings(w.spaceId, w.draft),
    dirty:
      !published ||
      JSON.stringify(published.definition) !== JSON.stringify(w.draft) ||
      !sameFiles(published.files, files),
    shareUrl: shareUrl(w.shareToken),
    studioUrl: studioUrl(w.id),
  };
}

/**
 * What "Änderungen live schalten" says: the version people run, what the draft changes of it,
 * and the latest test run of exactly this draft and its files.
 */
export async function draftChanges(w: WizardRow) {
  const published = await publishedVersion(w);
  const files = await draftFiles(w.id);
  const draft = JSON.stringify(w.draft);
  const tests = await db.query.run.findMany({
    where: and(eq(schema.run.wizardId, w.id), eq(schema.run.mode, "test")),
    orderBy: [desc(schema.run.createdAt)],
    columns: { id: true, definition: true, files: true, createdAt: true, status: true },
    limit: 20,
  });
  const tested = tests.find(
    (r) => JSON.stringify(r.definition) === draft && sameFiles(r.files, files),
  );
  return {
    version: published?.version ?? null,
    published: published?.definition ?? null,
    changes: published ? versionChanges(published, { definition: w.draft, files }) : [],
    tested: tested
      ? { runId: tested.id, at: tested.createdAt.toISOString(), status: tested.status }
      : null,
  };
}

export async function wizardMessages(wizardId: string) {
  return db.query.wizardMessage.findMany({
    where: eq(schema.wizardMessage.wizardId, wizardId),
    orderBy: [schema.wizardMessage.createdAt],
  });
}

export async function addMessage(
  wizardId: string,
  message: { role: "user" | "assistant"; content: string; changed?: boolean },
  writer: Writer = { source: "studio" },
): Promise<string> {
  const id = nanoid(12);
  await db.insert(schema.wizardMessage).values({
    id,
    wizardId,
    role: message.role,
    content: message.content,
    changed: message.changed ?? false,
    source: writer.source,
    client: writer.source === "mcp" ? writer.client : null,
  });
  return id;
}

/** The schema check every write passes. Validator issues are allowed in a draft; a wrong shape is not. */
export function parseDraft(
  raw: unknown,
  files?: string[],
): { draft: WizardDefinition; issues: ValidationIssue[] } {
  const parsed = wizardSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ServiceError(
      "invalid",
      { server: "schemaMismatch" },
      {
        issues: shapeIssues(parsed.error, raw),
      },
    );
  }
  // Every writer saves `requires` as the steps say.
  const draft = withRequires(parsed.data);
  return { draft, issues: validateWizard(draft, files) };
}

export async function createWizard(
  userId: string,
  input: {
    spaceId?: string;
    /** A marketplace entry or a plugin's starter to start from, in `lang` where it is translated. */
    starterId?: string;
    lang?: string;
    definition?: unknown;
    note?: string;
  },
  writer: Writer = { source: "studio" },
) {
  // Asked first: a tenant that builds nothing here has no space of its own to name.
  await requireBuild();
  const named = () => (input.spaceId ? ownedSpace(userId, input.spaceId) : defaultSpace(userId));
  await requireMaker(async () => (await named()).id);
  const space = await named();
  await requireWritable(space);
  const starter = input.starterId
    ? await marketplaceWizard(input.starterId, asLang(input.lang))
    : undefined;
  if (input.starterId && !starter) {
    throw new ServiceError("invalid", note("unknownTemplate", { starterId: input.starterId }));
  }
  const maker = input.lang?.toLowerCase().startsWith("de") ? "de" : "en";
  const { draft, issues } =
    input.definition !== undefined
      ? parseDraft(input.definition)
      : starter
        ? // A starter names the language it is written in, where its definition does not.
          {
            draft: { ...starter.definition, lang: starter.definition.lang ?? starter.language },
            issues: [],
          }
        : { draft: blankWizard(maker), issues: [] };
  const fromStarter = input.definition === undefined ? starter : undefined;
  const id = nanoid(12);
  const shareToken = newShareToken();
  await db.insert(schema.wizard).values({
    id,
    spaceId: space.id,
    tenantId: currentTenant(),
    title: draft.title,
    draft,
    shareToken,
    dailyRunLimit: env.limits.defaultDailyRuns,
    starter: fromStarter?.id ?? null,
    starterRevision: fromStarter?.revision ?? null,
  });
  await putLink(shareToken, "wizard", id);
  pushWizards();
  if (fromStarter) {
    await seedFiles(id, fromStarter.files);
    // Counted at the marketplace, beside the request; a plugin's starter is not the marketplace's.
    if (!fromStarter.plugin) {
      void countInstall(fromStarter.id);
    }
  }
  if (input.note) {
    await addMessage(id, { role: "assistant", content: input.note, changed: true }, writer);
  } else if (fromStarter) {
    await addMessage(id, {
      role: "assistant",
      content: serverText(fromStarter.language, "templateSetUp", { title: fromStarter.title }),
    });
  }
  return { id, revision: 0, issues, studioUrl: studioUrl(id) };
}

/**
 * Replaces the draft if nobody wrote since `baseRevision`. Every draft write — studio inspector,
 * architect, MCP — goes through here, so the revision counts all of them.
 */
export async function writeDraft(
  userId: string,
  wizardId: string,
  input: { definition: unknown; baseRevision: number; note?: string },
  writer: Writer = { source: "studio" },
) {
  const w = await writableWizard(userId, wizardId);
  const files = await draftFiles(w.id);
  const paths = files.map((f) => f.path);
  const { draft } = parseDraft(input.definition, paths);
  const issues = await checkDraft(w.spaceId, draft, files);
  const [row] = await db
    .update(schema.wizard)
    .set({
      draft,
      title: draft.title,
      revision: sql`${schema.wizard.revision} + 1`,
      updatedAt: new Date(),
    })
    .where(and(eq(schema.wizard.id, w.id), eq(schema.wizard.revision, input.baseRevision)))
    .returning({ revision: schema.wizard.revision });
  if (!row) {
    const current = await ownedWizard(userId, wizardId);
    throw new ServiceError("revision_conflict", note("wizardChangedMeantime"), {
      revision: current.revision,
    });
  }
  if (input.note) {
    await addMessage(w.id, { role: "assistant", content: input.note, changed: true }, writer);
  }
  await emitDraftChanged({
    wizardId: w.id,
    kind: "draft",
    revision: row.revision,
    source: writer.source,
    client: writer.source === "mcp" ? writer.client : null,
    note: input.note ?? null,
    touched: changedSteps(w.draft, draft),
  });
  return { revision: row.revision, issues, warnings: await stepWarnings(w.spaceId, draft), draft };
}

export async function editWizard(
  userId: string,
  wizardId: string,
  input: { ops: WizardOp[]; baseRevision: number; note?: string },
  writer: Writer,
) {
  const w = await writableWizard(userId, wizardId);
  if (w.revision !== input.baseRevision) {
    throw new ServiceError("revision_conflict", note("wizardChangedMeantime"), {
      revision: w.revision,
    });
  }
  // A theme belongs to the space: it is saved there first, and the ops put it into the chain.
  for (const op of input.ops) {
    if (op.op === "set_theme") {
      await saveTheme(userId, w.spaceId, op.theme);
    }
  }
  let definition: unknown;
  try {
    definition = applyOps(w.draft, input.ops);
  } catch (err) {
    if (err instanceof OpError) {
      throw new ServiceError("invalid", saidOf(err));
    }
    throw err;
  }
  return writeDraft(
    userId,
    wizardId,
    { definition, baseRevision: input.baseRevision, note: input.note },
    writer,
  );
}

export async function updateWizardSettings(
  userId: string,
  wizardId: string,
  patch: {
    shareEnabled?: boolean;
    dailyRunLimit?: number;
    dailyMailLimit?: number;
    spaceId?: string;
    runners?: RunnerSettings;
    translate?: boolean;
  },
) {
  const w = await writableWizard(userId, wizardId);
  if (patch.spaceId) {
    await requireWritable(await ownedSpace(userId, patch.spaceId));
  }
  const runners = patch.runners ? await checkRunnerSettings(patch.runners) : undefined;
  await db
    .update(schema.wizard)
    .set({ ...patch, ...(runners ? { runners } : {}), updatedAt: new Date() })
    .where(eq(schema.wizard.id, w.id));
  // Switched off, the wizard leaves the organization's public page; on, it may return to it.
  if (patch.shareEnabled !== undefined && patch.shareEnabled !== w.shareEnabled) {
    pushPages();
    pushWizards();
  }
  return wizardSummary(await ownedWizard(userId, wizardId));
}

/**
 * Who answers the wizard's team steps: for whoever edits it. Not a setting of its sharing, which is
 * the admins' alone: a member with the Studio open to them can get a wizard ready to publish.
 */
export async function setAnswerers(
  userId: string,
  wizardId: string,
  answerers: string[] | "admins",
) {
  const w = await writableWizard(userId, wizardId);
  await checkAnswerers(answerers);
  await db
    .update(schema.wizard)
    .set({ answerers, updatedAt: new Date() })
    .where(eq(schema.wizard.id, w.id));
  return wizardSummary(await ownedWizard(userId, wizardId));
}

/** Those named under "Answered by" are people of the organization, and no client of it. */
async function checkAnswerers(answerers: string[] | "admins") {
  if (answerers === "admins" || !managed) {
    return;
  }
  const { members } = await tenantMembers(currentTenant());
  const unknown = answerers.filter(
    (id) => !members.some((m) => m.userId === id && m.role !== "client"),
  );
  if (unknown.length) {
    throw new ServiceError("invalid", "Someone named here is not in this organization.");
  }
}

export async function rotateShareLink(userId: string, wizardId: string) {
  const w = await writableWizard(userId, wizardId);
  const token = newShareToken();
  await db
    .update(schema.wizard)
    .set({ shareToken: token, updatedAt: new Date() })
    .where(eq(schema.wizard.id, w.id));
  await dropLinks([w.shareToken]);
  await putLink(token, "wizard", w.id);
  // The public page's start button leads to the new link.
  pushPages();
  pushWizards();
  return { shareToken: token, shareUrl: shareUrl(token) };
}

export async function duplicateWizard(userId: string, wizardId: string) {
  await requireMaker(async () => (await writableWizard(userId, wizardId)).spaceId);
  const w = await writableWizard(userId, wizardId);
  const id = nanoid(12);
  const draft = { ...w.draft, title: `${w.draft.title} (Kopie)` };
  const shareToken = newShareToken();
  await db.insert(schema.wizard).values({
    id,
    spaceId: w.spaceId,
    tenantId: currentTenant(),
    title: draft.title,
    draft,
    shareToken,
    dailyRunLimit: w.dailyRunLimit,
    starter: w.starter,
  });
  await putLink(shareToken, "wizard", id);
  await copyFiles(w.id, id);
  pushWizards();
  return { id };
}

export async function deleteWizard(userId: string, wizardId: string) {
  await requireAdmin();
  const w = await writableWizard(userId, wizardId);
  await forgetWizardLinks(wizardId);
  // Its databases are files or databases of their own: their rows go with the wizard's, they don't.
  await dropWizardData(wizardId);
  await db
    .delete(schema.wizard)
    .where(and(eq(schema.wizard.id, wizardId), eq(schema.wizard.tenantId, currentTenant())));
  await unlistWizard(w.spaceId, wizardId);
  pushWizards();
}

/** A wizard that is gone leaves its space's public page, which is sent again without it. */
async function unlistWizard(spaceId: string, wizardId: string) {
  const p = await db.query.space.findFirst({
    where: eq(schema.space.id, spaceId),
    columns: { page: true },
  });
  if (!p?.page?.wizards.includes(wizardId)) {
    return;
  }
  const { [wizardId]: _gone, ...examples } = p.page.examples;
  await db
    .update(schema.space)
    .set({
      page: { ...p.page, wizards: p.page.wizards.filter((id) => id !== wizardId), examples },
      updatedAt: new Date(),
    })
    .where(eq(schema.space.id, spaceId));
  pushPages();
}

/** A wizard with validator issues is never published — same rule for studio and MCP. */
export async function requireClean(w: WizardRow) {
  const files = await draftFiles(w.id);
  const issues = await checkDraft(w.spaceId, w.draft, files);
  if (issues.length) {
    throw new ServiceError("has_issues", note("wizardStillErrors"), { issues });
  }
  return { definition: w.draft, files };
}

export async function publishWizard(userId: string, wizardId: string) {
  const w = await writableWizard(userId, wizardId);
  const { definition, files } = await requireClean(w);
  // Runs already out still reach the admins if the list empties later (`teamToAsk`).
  if (
    managed &&
    (await answeringNarrowed()) &&
    Array.isArray(w.answerers) &&
    !w.answerers.length &&
    definition.steps.some((s) => whoOf(s) === "team")
  ) {
    throw new ServiceError("refused", note("teamNobodyNamed"));
  }
  const version = (w.publishedVersion ?? 0) + 1;
  await db
    .insert(schema.wizardVersion)
    .values({ id: nanoid(12), wizardId: w.id, version, definition, files });
  await db
    .update(schema.wizard)
    .set({ publishedVersion: version, updatedAt: new Date() })
    .where(eq(schema.wizard.id, w.id));
  // The organization's public page shows the new version's title, results and steps.
  pushPages();
  pushWizards();
  return { version, shareUrl: shareUrl(w.shareToken), shareEnabled: w.shareEnabled };
}
