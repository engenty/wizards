import type { Lang } from "@engenty/wizards-shared/definition";
import { wizardLang } from "@engenty/wizards-shared/definition";
import type { LiveItem, LiveKind } from "@engenty/wizards-shared/live";
import { wizardTexts } from "@engenty/wizards-shared/translation";
import { eq } from "drizzle-orm";
import type { Subject } from "../broker/rwx.js";
import { listConnectors } from "../connectors/external.js";
import { db, schema } from "../db/client.js";
import { embeddingModel } from "../models.js";
import { mayBuild, spaceWritable } from "../services/access.js";
import { cloudLinked, cloudState } from "../services/cloud.js";
import { ServiceError } from "../services/errors.js";
import { studioOpen } from "../services/members-studio.js";
import { presentIn } from "../services/presence.js";
import { getPage, getRow, getTableHeader } from "../services/space-data.js";
import { fileView, spaceFiles } from "../services/space-files.js";
import { listSpaces, ownedSpace } from "../services/spaces.js";
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
  /** Who reads, for the broker (broker/rwx.ts): the person and their role. */
  who: Subject[];
}

/** The spaces, as the studio lists them. */
export async function spacesView(r: Reader) {
  const spaces = await listSpaces(r.userId, r.lang);
  const build = await mayBuild();
  return Promise.all(
    spaces.map(async (p) => ({
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
      /** „Mitglieder dürfen ins Studio“: the organization's members build here too. */
      membersStudio: p.membersStudio,
      /** Whether this person reaches the space's Studio: a member only by the rule above. */
      studio: await studioOpen(p),
      /** How the admins hear of the broker's critical lines: Work's bell, the hourly mail. */
      notify: p.notify,
    })),
  );
}

/** A space's wizards, as its cards show them. */
export async function wizardsView(r: Reader, spaceId: string) {
  await ownedSpace(r.userId, spaceId);
  const wizards = await listWizards(r.userId, spaceId);
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
  const space = await ownedSpace(r.userId, w.spaceId);
  return {
    ...(await wizardState(w)),
    /** Shown and run here, changed elsewhere: a local install's wizard, or nothing is built here. */
    readOnly: !(await spaceWritable(space)),
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
export async function filesView(r: Reader, spaceId: string) {
  const space = await ownedSpace(r.userId, spaceId);
  return {
    files: (await spaceFiles(space.id)).map(fileView),
    /** Whether documents get vectors, or the index works on keywords alone. */
    embeddings: Boolean(await embeddingModel().catch(() => null)),
  };
}

/** The connectors a space's wizards can name. */
export async function connectorsView(r: Reader, spaceId: string) {
  const space = await ownedSpace(r.userId, spaceId);
  return listConnectors(space.id);
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
    const summary = x.spaceId
      ? (await wizardsView(r, x.spaceId)).find((w) => w.id === x.item)
      : undefined;
    return summary ? { summary, detail: await wizardView(r, x.item) } : null;
  },
  translation: async (r, x) => (x.parent ? translationsView(r, x.parent) : null),
  message: null,
  page: (r, x) => getPage(r.userId, x.item, r.who),
  table: (r, x) => getTableHeader(r.userId, x.item, r.who),
  row: async (r, x) => {
    const row = x.parent ? await getRow(r.userId, x.parent, x.item, r.who) : null;
    return row ? { ...row, tableId: x.parent } : null;
  },
  category: null,
  // Work's chats: the studio reads the chat and the sidebar again (routes/live.ts checks each).
  chat: null,
  presence: async (_r, x) =>
    x.parent ? presentIn(x.parent, x.item.slice(x.parent.length + 1)) : [],
  file: async (_r, x) => {
    const row = await db.query.spaceFile.findFirst({ where: eq(schema.spaceFile.id, x.item) });
    return row ? fileView(row) : null;
  },
  // The studio asks for the space's skills again: a list of names, no view of its own.
  skill: null,
  connector: async (r, x) => {
    if (!x.spaceId) {
      return null;
    }
    const id = x.item.slice(x.spaceId.length + 1);
    return (await connectorsView(r, x.spaceId)).find((c) => c.id === id) ?? null;
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
