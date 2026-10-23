import type { Lang } from "@engenty/wizards-shared/definition";
import { wizardLang } from "@engenty/wizards-shared/definition";
import type { LiveItem, LiveKind } from "@engenty/wizards-shared/live";
import { wizardTexts } from "@engenty/wizards-shared/translation";
import { eq } from "drizzle-orm";
import { listConnectors } from "../connectors/external.js";
import { db, schema } from "../db/client.js";
import { embeddingModel } from "../models.js";
import { mayBuild, projectWritable } from "../services/access.js";
import { cloudLinked, cloudState } from "../services/cloud.js";
import { ServiceError } from "../services/errors.js";
import { presentIn } from "../services/presence.js";
import { fileView, projectFiles } from "../services/project-files.js";
import { listProjects, ownedProject } from "../services/projects.js";
import { getPage, getRow, getTableHeader } from "../services/space-data.js";
import { publishedDefinition, translationsOf } from "../services/translations.js";
import { listWizards, ownedWizard, wizardMessages, wizardState } from "../services/wizards.js";

/**
 * What the studio's GET routes answer for an item, one function each (docs/plans/live-changes.md,
 * 2a). The routes call these, and the live hub sends the same view with a change, so the browser
 * can put it into its cache as it is. They read in the current tenant, as the current role.
 */

/** Who reads: the views differ by role (through `asRole`) and by the language of first names. */
export interface Reader {
  userId: string;
  lang: Lang;
}

/** The spaces, as the studio lists them. */
export async function spacesView(r: Reader) {
  const projects = await listProjects(r.userId, r.lang);
  const build = await mayBuild();
  return projects.map((p) => ({
    id: p.id,
    name: p.name,
    brand: p.brand,
    facts: p.facts,
    /** The space's public page; null until it is set up. */
    page: p.page ?? null,
    wizardCount: p.wizardCount,
    /** `local`: synced from a local install, where it is changed. */
    origin: p.origin,
    syncedAt: p.syncedAt?.toISOString() ?? null,
    readOnly: p.origin === "local" || !build,
  }));
}

/** A space's wizards, as its cards show them. */
export async function wizardsView(r: Reader, projectId: string) {
  await ownedProject(r.userId, projectId);
  const wizards = await listWizards(r.userId, projectId);
  // A local install with an account: where each wizard stands in its cloud, for the cards.
  const linked = await cloudLinked();
  return Promise.all(
    wizards.map(async (w) => ({ ...w, cloud: linked ? await cloudState(w.id) : null })),
  );
}

/** A wizard, as the editor opens it. */
export async function wizardView(r: Reader, id: string) {
  const w = await ownedWizard(r.userId, id);
  const messages = await wizardMessages(w.id);
  const project = await ownedProject(r.userId, w.projectId);
  return {
    ...(await wizardState(w)),
    /** Shown and run here, changed elsewhere: a local install's wizard, or nothing is built here. */
    readOnly: !(await projectWritable(project)),
    blank: messages.length === 0 && !w.starter,
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      changed: m.changed,
      source: m.source,
      client: m.client,
    })),
  };
}

/** The languages the published wizard is kept in, each original text with its translation. */
export async function translationsView(r: Reader, wizardId: string) {
  const w = await ownedWizard(r.userId, wizardId);
  const def = await publishedDefinition(w);
  const kept = await translationsOf(w.id);
  return {
    lang: def ? wizardLang(def) : wizardLang(w.draft),
    texts: def ? wizardTexts(def) : [],
    translations: kept.map((t) => ({
      lang: t.lang,
      texts: t.texts,
      updatedAt: t.updatedAt.toISOString(),
    })),
  };
}

/** What a space holds for all its wizards. */
export async function filesView(r: Reader, projectId: string) {
  const project = await ownedProject(r.userId, projectId);
  return {
    files: (await projectFiles(project.id)).map(fileView),
    /** Whether documents get vectors, or the index works on keywords alone. */
    embeddings: Boolean(await embeddingModel().catch(() => null)),
  };
}

/** The connectors a space's wizards can name. */
export async function connectorsView(r: Reader, projectId: string) {
  const project = await ownedProject(r.userId, projectId);
  return listConnectors(project.id);
}

// --- one item, for the live stream ------------------------------------------------------------

const gone = (err: unknown) => err instanceof ServiceError && err.code === "not_found";

/**
 * One changed item's view, as it travels with a change. `null`: the item is gone. `undefined`:
 * the kind has no view, and the browser fetches what shows it.
 */
const ITEM_VIEWS: Record<LiveKind, ((r: Reader, x: LiveItem) => Promise<unknown>) | null> = {
  space: async (r, x) => (await spacesView(r)).find((s) => s.id === x.item) ?? null,
  wizard: async (r, x) => {
    const summary = x.projectId
      ? (await wizardsView(r, x.projectId)).find((w) => w.id === x.item)
      : undefined;
    return summary ? { summary, detail: await wizardView(r, x.item) } : null;
  },
  translation: async (r, x) => (x.parent ? translationsView(r, x.parent) : null),
  message: null,
  page: (r, x) => getPage(r.userId, x.item),
  table: (r, x) => getTableHeader(r.userId, x.item),
  row: async (r, x) => {
    const row = x.parent ? await getRow(r.userId, x.parent, x.item) : null;
    return row ? { ...row, tableId: x.parent } : null;
  },
  category: null,
  presence: async (_r, x) =>
    x.parent ? presentIn(x.parent, x.item.slice(x.parent.length + 1)) : [],
  file: async (_r, x) => {
    const row = await db.query.projectFile.findFirst({ where: eq(schema.projectFile.id, x.item) });
    return row ? fileView(row) : null;
  },
  connector: async (r, x) => {
    if (!x.projectId) {
      return null;
    }
    const id = x.item.slice(x.projectId.length + 1);
    return (await connectorsView(r, x.projectId)).find((c) => c.id === id) ?? null;
  },
};

export async function itemView(r: Reader, x: LiveItem): Promise<unknown> {
  const read = ITEM_VIEWS[x.kind];
  if (!read) {
    return undefined;
  }
  try {
    return await read(r, x);
  } catch (err) {
    if (gone(err)) {
      return null;
    }
    console.error(`[live] the view of ${x.kind} ${x.item}:`, err);
    return undefined;
  }
}

/** Every kind has an entry, a view or none: a test reads this. */
export const viewKinds = Object.keys(ITEM_VIEWS) as LiveKind[];
