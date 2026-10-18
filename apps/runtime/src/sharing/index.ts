import type {
  ShareJobView,
  ShareLang,
  ShareOverview,
  SharePreview,
  SharePreviewTarget,
  ShareTargetInfo,
  ShareTargetView,
} from "@engenty-wizards/shared/sharing";
import { and, desc, eq } from "drizzle-orm";
import { listConnectors, resolveConnector } from "../connectors/external.js";
import {
  connectionViews,
  connectorOptions,
  registerConnectionSource,
} from "../connectors/index.js";
import { db, schema } from "../db/client.js";
import { renderTemplate, type TemplateScope } from "../engine/template.js";
import type { RunRow } from "../engine/types.js";
import type { WizardRow } from "../services/wizards.js";
import { scopeOf } from "../store/index.js";
import { currentTenant } from "../tenants/tenant.js";
import { resultStepOf, resultText } from "./files.js";
import { shareJobs } from "./state.js";
import { browserTarget } from "./targets/browser.js";
import { canPublish, connectorTarget } from "./targets/connector.js";
import { emailTarget } from "./targets/email.js";
import { slackTarget } from "./targets/slack.js";
import { storageConnectors, storageTarget } from "./targets/storage.js";
import { type ShareTarget, sayIn, type TargetScope } from "./types.js";

export type { ShareContext, ShareTarget } from "./types.js";

/**
 * The share targets of this runtime. The fixed ones are listed here; every connector that
 * stores files adds `storage:<connector>`, every connector that can write `connector:<connector>`.
 * To add a target, write it in `./targets` and name it here.
 */
const FIXED: readonly ShareTarget[] = [emailTarget, slackTarget, browserTarget];

/** A share target by its id; null when this project has none of that name. */
export async function shareTarget(projectId: string, id: string): Promise<ShareTarget | null> {
  const fixed = FIXED.find((t) => t.id === id);
  if (fixed) {
    return fixed;
  }
  const cut = id.indexOf(":");
  const [kind, connectorId] = [id.slice(0, cut), id.slice(cut + 1)];
  if (kind === "storage") {
    const connector = storageConnectors().find((c) => c.id === connectorId);
    return connector ? storageTarget(connector) : null;
  }
  if (kind === "connector") {
    const found = await resolveConnector(projectId, connectorId);
    return found && canPublish(found.connector)
      ? connectorTarget(found.connector, found.imported)
      : null;
  }
  return null;
}

/** Every target of a project, in the order a result shows them. */
async function projectTargets(projectId: string): Promise<ShareTarget[]> {
  const imported = (await listConnectors(projectId)).filter((c) => c.sourceKind !== "builtin");
  const through = await Promise.all(
    imported.map((c) => shareTarget(projectId, `connector:${c.id}`)),
  );
  return [
    emailTarget,
    ...storageConnectors().flatMap((c) => storageTarget(c) ?? []),
    slackTarget,
    ...through.filter((t): t is ShareTarget => Boolean(t)),
    browserTarget,
  ];
}

/**
 * Every target a wizard of the project can name on its result, for the editor and for whoever
 * authors a wizard: the default ones, and one for each built-in connector that can write.
 */
export async function projectShareTargets(
  projectId: string,
  lang: ShareLang,
): Promise<ShareTargetInfo[]> {
  const targets = await projectTargets(projectId);
  const builtin = (await listConnectors(projectId)).filter((c) => c.sourceKind === "builtin");
  for (const connector of builtin) {
    const target = await shareTarget(projectId, `connector:${connector.id}`);
    if (target) {
      targets.push(target);
    }
  }
  return Promise.all(
    targets.map(async (target) => ({
      id: target.id,
      name: sayIn(lang, target.name),
      description: sayIn(lang, target.description),
      icon: target.icon,
      agent: Boolean(target.agent),
      usable: await offerable(target, projectId),
      byDefault: target.byDefault !== false,
      fields: target.fields.map((f) => ({ id: f.id, label: sayIn(lang, f.label), kind: f.kind })),
    })),
  );
}

/** Whether a target can work here right now: what it drives is there, its account can be connected. */
async function offerable(target: ShareTarget, projectId: string): Promise<boolean> {
  if (target.available && !(await target.available())) {
    return false;
  }
  const connection = target.connection?.();
  return !connection || (await connectorOptions(connection, projectId)).length > 0;
}

/** A target as one result offers it: under its own name, with what the wizard prefills. */
export interface OfferedTarget {
  key: string;
  target: ShareTarget;
  label?: string;
  values: Record<string, string>;
}

/**
 * The targets a result names: its own list, else every target of the project a result offers
 * by default. `missing` names listed targets this project does not have.
 */
async function namedTargets(
  run: RunRow,
  projectId: string,
): Promise<{ entries: OfferedTarget[]; listed: boolean; missing: string[] }> {
  const result = resultStepOf(run);
  if (!result) {
    return { entries: [], listed: true, missing: [] };
  }
  if (!result.share) {
    const entries = (await projectTargets(projectId))
      .filter((target) => target.byDefault !== false)
      .map((target) => ({ key: target.id, target, values: {} }));
    return { entries, listed: false, missing: [] };
  }
  const entries: OfferedTarget[] = [];
  const missing: string[] = [];
  for (const [i, option] of result.share.entries()) {
    const target = await shareTarget(projectId, option.target);
    if (target) {
      entries.push({
        key: `${i}:${option.target}`,
        target,
        label: option.label,
        values: option.values ?? {},
      });
    } else {
      missing.push(option.label ?? option.target);
    }
  }
  return { entries, listed: true, missing };
}

/**
 * The targets a finished run offers. A wizard that lists them on its result decides; else every
 * target that needs no model is offered, and the ones an agent drives only to the wizard's owner
 * — they run on the wizard's credits.
 */
export async function offeredTargets(
  run: RunRow,
  projectId: string,
  member: boolean,
): Promise<OfferedTarget[]> {
  const { entries, listed } = await namedTargets(run, projectId);
  const asked = entries.filter((e) => listed || !e.target.agent || member);
  const usable = await Promise.all(asked.map((e) => offerable(e.target, projectId)));
  return asked.filter((_, i) => usable[i]);
}

export function targetScope(run: RunRow, projectId: string, lang: ShareLang): TargetScope {
  const result = resultStepOf(run);
  return {
    run,
    projectId,
    lang,
    title: [result?.title, run.definition.title].filter(Boolean).join(" · "),
    message: result?.message ?? null,
    text: resultText(run),
  };
}

async function templateScope(run: RunRow, projectId: string): Promise<TemplateScope> {
  const project = await db.query.project.findFirst({ where: eq(schema.project.id, projectId) });
  return {
    def: run.definition,
    state: run.state,
    brand: project?.brand ?? {},
  };
}

async function targetView(
  entry: OfferedTarget,
  scope: TargetScope,
  templates: TemplateScope,
): Promise<ShareTargetView> {
  const { target } = entry;
  const { lang } = scope;
  const connection = target.connection?.() ?? null;
  const [account] = connection
    ? await connectionViews([connection], scopeOf(scope.run), scope.projectId, lang)
    : [null];
  const defaults = (await target.defaults?.(scope)) ?? {};
  return {
    key: entry.key,
    target: target.id,
    name: entry.label ?? sayIn(lang, target.name),
    description: sayIn(lang, target.description),
    icon: target.icon,
    connection: account,
    fields: target.fields.map((f) => ({
      ...f,
      label: sayIn(lang, f.label),
      placeholder: f.placeholder && sayIn(lang, f.placeholder),
      help: f.help && sayIn(lang, f.help),
      value:
        entry.values[f.id] !== undefined
          ? renderTemplate(entry.values[f.id], templates)
          : (defaults[f.id] ?? ""),
    })),
    takes: target.takes,
    agent: Boolean(target.agent),
    presets: (target.presets ?? []).map((p) => ({
      label: p.label,
      values: Object.fromEntries(Object.entries(p.values).map(([id, v]) => [id, sayIn(lang, v)])),
    })),
  };
}

/** What the share sheet shows: the targets of this result and what was sent before. */
export async function shareOverview(
  run: RunRow,
  projectId: string,
  member: boolean,
  lang: ShareLang,
): Promise<ShareOverview> {
  const scope = targetScope(run, projectId, lang);
  const templates = await templateScope(run, projectId);
  const offered = await offeredTargets(run, projectId, member);
  const jobs: ShareJobView[] = await shareJobs(run.id);
  return {
    targets: await Promise.all(offered.map((entry) => targetView(entry, scope, templates))),
    jobs,
  };
}

const PLACEHOLDER = /\{\{\s*([^}]+?)\s*\}\}/g;

/** The placeholders of prefilled values that come out empty. */
function emptyPlaceholders(values: Record<string, string>, templates: TemplateScope): string[] {
  const empty = new Set<string>();
  for (const value of Object.values(values)) {
    for (const [whole, ref] of value.matchAll(PLACEHOLDER)) {
      if (!renderTemplate(whole, templates).trim()) {
        empty.add(ref.trim());
      }
    }
  }
  return [...empty];
}

/** How much of a written deliverable the preview shows. */
const EXCERPT = 1500;

/** A run that never happened, for a wizard without a finished test run: the draft, no answers. */
function standIn(wizard: WizardRow, userId: string): RunRow {
  const now = new Date();
  return {
    id: `preview-${wizard.id}`,
    wizardId: wizard.id,
    tenantId: wizard.tenantId,
    definition: wizard.draft,
    files: [],
    version: null,
    mode: "test",
    runner: null,
    startedBy: null,
    lang: null,
    visitorId: null,
    userId,
    ipHash: null,
    origin: null,
    client: null,
    status: "done",
    cursor: null,
    state: { values: {}, outputs: {}, history: [], notes: {} },
    error: null,
    ask: null,
    answer: null,
    unattended: false,
    deviceOffer: null,
    costMicros: 0,
    shareToken: null,
    sharedAt: null,
    expiresAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * The draft's result page as a visitor (`member` false) or its owner gets it: its share targets,
 * filled from the wizard's last finished test run, and what that run wrote. `resultId` picks the
 * result step where the draft has several.
 */
export async function sharePreview(
  wizard: WizardRow,
  userId: string,
  resultId: string | null,
  member: boolean,
  lang: ShareLang,
): Promise<SharePreview> {
  const last = await db.query.run.findFirst({
    where: and(
      eq(schema.run.tenantId, currentTenant()),
      eq(schema.run.wizardId, wizard.id),
      eq(schema.run.mode, "test"),
      eq(schema.run.status, "done"),
    ),
    orderBy: [desc(schema.run.createdAt)],
  });
  // The draft as it is now, on what the last test run answered and made.
  const run: RunRow = {
    ...(last ?? standIn(wizard, userId)),
    definition: wizard.draft,
    cursor: resultId,
  };
  const scope = targetScope(run, wizard.projectId, lang);
  const templates = await templateScope(run, wizard.projectId);
  const { entries, listed, missing } = await namedTargets(run, wizard.projectId);
  const targets: SharePreviewTarget[] = [];
  const left: SharePreview["left"] = missing.map((name) => ({ name, why: "setup" }));
  for (const entry of entries) {
    const name = entry.label ?? sayIn(lang, entry.target.name);
    if (!listed && entry.target.agent && !member) {
      left.push({ name, why: "agent" });
    } else if (!(await offerable(entry.target, wizard.projectId))) {
      left.push({ name, why: "setup" });
    } else {
      targets.push({
        ...(await targetView(entry, scope, templates)),
        empty: emptyPlaceholders(entry.values, templates),
      });
    }
  }
  const outputs: Record<string, string> = {};
  for (const d of resultStepOf(run)?.deliverables ?? []) {
    const text = run.state.outputs[d.from]?.text?.trim();
    if (text) {
      outputs[d.from] = text.slice(0, EXCERPT);
    }
  }
  return {
    run: last ? { id: last.id, at: last.updatedAt.toISOString() } : null,
    targets,
    left,
    outputs,
  };
}

// The account a target sends with is a connection of its own, kept like the wizard's connections.
registerConnectionSource(async (_run, connectionId, projectId) => {
  if (!connectionId.startsWith("share:")) {
    return null;
  }
  const target = await shareTarget(projectId, connectionId.slice("share:".length));
  return target?.connection?.() ?? null;
});
