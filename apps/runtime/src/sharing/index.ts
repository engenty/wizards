import type {
  ShareJobView,
  ShareLang,
  ShareOverview,
  ShareTargetInfo,
  ShareTargetView,
} from "@engenty-wizards/shared/sharing";
import { eq } from "drizzle-orm";
import { listConnectors, resolveConnector } from "../connectors/external.js";
import {
  connectionViews,
  connectorOptions,
  registerConnectionSource,
} from "../connectors/index.js";
import { db, schema } from "../db/client.js";
import { renderTemplate, type TemplateScope } from "../engine/template.js";
import type { RunRow } from "../engine/types.js";
import { scopeOf } from "../store/index.js";
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
 * The targets a finished run offers. A wizard that lists them on its result decides; else every
 * target that needs no model is offered, and the ones an agent drives only to the wizard's owner
 * — they run on the wizard's credits.
 */
export async function offeredTargets(
  run: RunRow,
  projectId: string,
  member: boolean,
): Promise<OfferedTarget[]> {
  const result = resultStepOf(run);
  if (!result) {
    return [];
  }
  const entries: OfferedTarget[] = [];
  if (result.share) {
    for (const [i, option] of result.share.entries()) {
      const target = await shareTarget(projectId, option.target);
      if (target) {
        entries.push({
          key: `${i}:${option.target}`,
          target,
          label: option.label,
          values: option.values ?? {},
        });
      }
    }
  } else {
    for (const target of await projectTargets(projectId)) {
      if (target.byDefault !== false && (!target.agent || member)) {
        entries.push({ key: target.id, target, values: {} });
      }
    }
  }
  const usable = await Promise.all(entries.map((e) => offerable(e.target, projectId)));
  return entries.filter((_, i) => usable[i]);
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

// The account a target sends with is a connection of its own, kept like the wizard's connections.
registerConnectionSource(async (_run, connectionId, projectId) => {
  if (!connectionId.startsWith("share:")) {
    return null;
  }
  const target = await shareTarget(projectId, connectionId.slice("share:".length));
  return target?.connection?.() ?? null;
});
