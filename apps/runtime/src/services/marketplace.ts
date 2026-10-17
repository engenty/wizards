import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import {
  DEFINITION_VERSION,
  readable,
  type WizardDefinition,
  wizardSchema,
} from "@engenty-wizards/shared/definition";
import {
  type Capability,
  capabilitiesOf,
  costTierOf,
  effortOf,
  formatsOf,
  MARKETPLACE_LANGS,
  type MarketplaceEntry,
  type MarketplaceExport,
  type MarketplaceFacets,
  type MarketplaceFilters,
  type MarketplaceItem,
  type MarketplaceLang,
  type MarketplacePage,
  type MarketplaceSummary,
  type MarketplaceSyncItem,
  pluginsOf,
} from "@engenty-wizards/shared/marketplace";
import { type WizardOutline, wizardOutline } from "@engenty-wizards/shared/marketplace-entry";
import { searchEntries } from "@engenty-wizards/shared/marketplace-search";
import { note } from "@engenty-wizards/shared/run";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import { formulaEstimate } from "../credits/estimate.js";
import { control, controlDb, db, schema, withTenant } from "../db/client.js";
import {
  missingCapabilities,
  optionalCapabilities,
  stepsWithoutModel,
} from "../engine/requirements.js";
import { env } from "../env.js";
import { managed } from "../manage.js";
import {
  classCatalog,
  type GatewayCatalog,
  imageCostUsd,
  tokenCostUsd,
  videoCostUsd,
  WEB_SEARCH_COST_USD,
} from "../models.js";
import { type PluginStarterEntry, pluginIdsOf, pluginStartersOf } from "../plugins/registry.js";
import { readSetting, writeSetting } from "../settings.js";
import { currentTenant, LOCAL_TENANT } from "../tenants/tenant.js";
import { ServiceError } from "./errors.js";

/**
 * The marketplace is an app of its own; this runtime is one of its clients
 * (docs/marketplace-contract.md). It searches the marketplace live and starts wizards from its
 * entries. Its starters and what people starred are kept in the control database, so the list
 * and starting a wizard work without a connection too.
 *
 * Beside them stand the starters the tenant's plugins bring (docs/content/dev/plugins/starters.md),
 * listed first and never fetched. They are known as `<plugin id>.<starter id>`; a marketplace
 * entry's id has no dot, so the two never meet.
 */

export const asLang = (raw: string | undefined | null): MarketplaceLang =>
  (MARKETPLACE_LANGS as readonly string[]).includes(raw ?? "") ? (raw as MarketplaceLang) : "en";

/** A search waits this long for the marketplace; then it searches what is kept here. */
const TIMEOUT_MS = 5000;

/** One call to the marketplace's API; null without an answer, or with an error. */
async function call<T>(path: string, init?: RequestInit): Promise<T | null> {
  if (!env.marketplace.url) {
    return null;
  }
  try {
    const res = await fetch(`${env.marketplace.url}/api/v1${path}`, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      return null;
    }
    return res.status === 204 ? ({} as T) : ((await res.json()) as T);
  } catch {
    return null;
  }
}

// --- stars: a person's own, in the tenant's database ------------------------------------

async function starredIds(): Promise<string[]> {
  const rows = await db
    .select({ id: schema.marketplaceStar.entryId })
    .from(schema.marketplaceStar)
    .orderBy(schema.marketplaceStar.createdAt);
  return rows.map((r) => r.id);
}

/** Stars an entry or takes the star away; a starred entry is kept for offline use. */
export async function starEntry(tenantId: string, entryId: string, on: boolean) {
  if (on) {
    await db.insert(schema.marketplaceStar).values({ tenantId, entryId }).onConflictDoNothing();
  } else {
    await db
      .delete(schema.marketplaceStar)
      .where(
        and(
          eq(schema.marketplaceStar.tenantId, tenantId),
          eq(schema.marketplaceStar.entryId, entryId),
        ),
      );
  }
  // What is kept follows at once, beside the request.
  void syncMarketplace(true).catch(() => undefined);
}

// --- what is kept for offline use --------------------------------------------------------

async function kept(ids?: string[]): Promise<MarketplaceExport[]> {
  const rows = await controlDb
    .select({ entry: control.marketplaceCache.entry })
    .from(control.marketplaceCache)
    .where(ids ? inArray(control.marketplaceCache.id, ids) : undefined);
  return rows.map((r) => r.entry);
}

/** The words of a kept entry in a language: a translation where it has one, else its own. */
function textIn(e: MarketplaceExport, lang: MarketplaceLang) {
  return e.texts.find((t) => t.language === lang) ?? e.texts.find((t) => t.language === e.language);
}

function keptSummary(e: MarketplaceExport, lang: MarketplaceLang): MarketplaceSummary {
  const { texts: _texts, files: _files, ...summary } = e;
  const text = textIn(e, lang);
  return text
    ? { ...summary, language: text.language, title: text.title, pitch: text.pitch }
    : summary;
}

function keptItem(e: MarketplaceExport, lang: MarketplaceLang): MarketplaceItem | null {
  const text = textIn(e, lang);
  return text ? { ...keptSummary(e, lang), definition: text.definition, files: e.files } : null;
}

// --- the plugins' starters ------------------------------------------------------------------

/** One of the starters the tenant's plugins bring, by its id; undefined for any other id. */
async function pluginStarter(id: string): Promise<PluginStarterEntry | undefined> {
  if (!id.includes(".")) {
    return undefined;
  }
  return (await pluginStartersOf(currentTenant())).find((s) => s.id === id);
}

/** A plugin's starter as the marketplace lists an entry, read from its definition. */
function pluginSummary({ id, plugin, starter }: PluginStarterEntry): MarketplaceSummary {
  const definition = starter.definition as WizardDefinition;
  const { name, version } = plugin.source.manifest;
  const capabilities = capabilitiesOf(definition);
  const changed = statSync(plugin.source.entry ?? plugin.source.root, { throwIfNoEntry: false });
  return {
    id,
    revision: 0,
    hash: createHash("sha256")
      .update(`${version}\n${JSON.stringify(definition)}`)
      .digest("hex")
      .slice(0, 16),
    updatedAt: (changed?.mtime ?? new Date()).toISOString(),
    starter: true,
    language: starter.language ?? "en",
    title: starter.title,
    pitch: starter.description,
    // Found by the plugin's name as well: "Termine" finds the appointment plugin's starters.
    terms: [name],
    avatar: definition.avatar,
    formats: formatsOf(definition),
    industries: ["any"],
    useCases: [],
    capabilities,
    effort: effortOf(definition),
    costTier: costTierOf(capabilities),
    steps: definition.steps.length,
    version: definition.version,
    plugins: [plugin.source.id],
    plan: "pro",
  };
}

/** A plugin's starter as this app shows it: never starred, and marked with its plugin. */
function pluginEntry(found: PluginStarterEntry, unavailable: Set<Capability>): MarketplaceEntry {
  const { id, name } = found.plugin.source.manifest;
  return {
    ...asEntry(pluginSummary(found), new Set(), unavailable, optionalOf(found.starter.definition)),
    plugin: { id, name },
  };
}

/** Two searches' counts per option, added up. */
function addFacets(a: MarketplaceFacets, b: MarketplaceFacets): MarketplaceFacets {
  const add = <K extends string>(
    x: Partial<Record<K, number>> = {},
    y: Partial<Record<K, number>> = {},
  ) => {
    const out: Partial<Record<K, number>> = { ...x };
    for (const [key, n] of Object.entries(y) as [K, number][]) {
      out[key] = (out[key] ?? 0) + n;
    }
    return out;
  };
  return {
    useCase: add(a.useCase, b.useCase),
    industry: add(a.industry, b.industry),
    format: add(a.format, b.format),
    capability: add(a.capability, b.capability),
    plan: add(a.plan, b.plan),
  };
}

/**
 * The marketplace's entries as this tenant sees them: an entry that stands for a starter of a
 * plugin it has is left out (the plugin's own is listed), and the others say which plugins they
 * need that it does not have.
 */
async function withPlugins(entries: MarketplaceEntry[]): Promise<MarketplaceEntry[]> {
  if (!entries.some((e) => e.plugins?.length || e.pluginStarter)) {
    return entries;
  }
  const tenant = currentTenant();
  const [have, starters] = await Promise.all([
    pluginIdsOf(tenant),
    pluginStartersOf(tenant).then((list) => new Set(list.map((s) => s.id))),
  ]);
  return entries.flatMap((e) => {
    if (e.pluginStarter && starters.has(e.pluginStarter)) {
      return [];
    }
    const needs = (e.plugins ?? []).filter((id) => !have.has(id));
    return [needs.length ? { ...e, needs } : e];
  });
}

// --- searching -----------------------------------------------------------------------------

/** A summary as this app shows it: whether it can read and run it, and whether it is starred. */
function asEntry(
  summary: MarketplaceSummary,
  starred: Set<string>,
  unavailable: Set<Capability>,
  optional: Set<Capability> = new Set(),
): MarketplaceEntry {
  const lacking = summary.capabilities.filter((c) => unavailable.has(c));
  return {
    ...summary,
    credits: null,
    usable: summary.version <= DEFINITION_VERSION,
    starred: starred.has(summary.id),
    missing: lacking.filter((c) => !optional.has(c)),
    optional: lacking.filter((c) => optional.has(c)),
  };
}

/** What only some paths of a wizard need; nothing where it cannot be read. */
function optionalOf(definition: unknown): Set<Capability> {
  return readable(definition)
    ? optionalCapabilities(wizardSchema.parse(definition))
    : new Set<Capability>();
}

/**
 * Per entry, what only some of its paths need, read from the wizards kept here (the starters
 * and what is starred); an entry not kept counts everything it needs as needed.
 */
async function keptOptional(
  ids: string[],
  lang: MarketplaceLang,
  unavailable: Set<Capability>,
): Promise<Map<string, Set<Capability>>> {
  const out = new Map<string, Set<Capability>>();
  if (!(unavailable.size && ids.length)) {
    return out;
  }
  for (const e of await kept(ids)) {
    const text = textIn(e, lang);
    if (text) {
      out.set(e.id, optionalOf(text.definition));
    }
  }
  return out;
}

export interface MarketplaceSearch extends MarketplaceFilters {
  q?: string;
  lang: MarketplaceLang;
  /** Only the starred entries. */
  starred?: boolean;
  limit?: number;
  offset?: number;
}

export interface MarketplaceResult extends MarketplacePage<MarketplaceEntry> {
  /** True: the marketplace did not answer, and the result is what is kept here. */
  offline: boolean;
  /** The capabilities this runtime has no model for. */
  unavailable: Capability[];
}

/**
 * Searches the tenant's plugins' starters and the marketplace, in that order: a page holds the
 * plugins' starters the words and filters find, then the marketplace's entries.
 */
export async function searchMarketplace(search: MarketplaceSearch): Promise<MarketplaceResult> {
  const { q = "", starred, limit = 60, offset = 0, lang: _lang, ...filters } = search;
  const own = starred ? [] : await pluginStartersOf(currentTenant());
  if (!own.length) {
    return searchListed(search);
  }
  const byId = new Map(own.map((s) => [s.id, s]));
  const found = searchEntries(own.map(pluginSummary), q, filters, { limit: own.length });
  const shown = found.entries.slice(offset, offset + limit);
  // The marketplace fills what is left of the page, and counts from where its entries begin.
  const room = limit - shown.length;
  const listed = await searchListed({
    ...search,
    limit: Math.max(1, room),
    offset: Math.max(0, offset - found.total),
  });
  const unavailable = new Set(listed.unavailable);
  return {
    ...listed,
    entries: [
      ...shown.flatMap((e) => {
        const entry = byId.get(e.id);
        return entry ? [pluginEntry(entry, unavailable)] : [];
      }),
      ...listed.entries.slice(0, room),
    ],
    total: found.total + listed.total,
    all: own.length + listed.all,
    facets: addFacets(listed.facets, found.facets),
  };
}

/**
 * The gallery for someone not signed in (the studio's start page for guests): what the
 * marketplace lists, without a tenant's stars and plugins. An entry that needs a plugin says so.
 */
export function searchMarketplaceAsGuest(
  search: Omit<MarketplaceSearch, "starred">,
): Promise<MarketplaceResult> {
  return searchListed(search, true);
}

/** Searches the marketplace; without an answer, what is kept here, scored the same way. */
async function searchListed(search: MarketplaceSearch, guest = false): Promise<MarketplaceResult> {
  const { q = "", lang, starred: onlyStarred, limit = 60, offset = 0, ...filters } = search;
  const stars = guest ? [] : await starredIds();
  const starred = new Set(stars);
  const unavailable = guest ? new Set<Capability>() : await missingCapabilities();
  const plugged = (entries: MarketplaceEntry[]) =>
    guest
      ? entries.map((e) => (e.plugins?.length ? { ...e, needs: e.plugins } : e))
      : withPlugins(entries);
  const params = new URLSearchParams({ lang, limit: String(limit), offset: String(offset) });
  if (onlyStarred) {
    params.set("ids", stars.join(","));
  } else {
    if (q.trim()) {
      params.set("q", q.trim());
    }
    for (const [key, value] of Object.entries(filters)) {
      if (value) {
        params.set(key, value);
      }
    }
  }
  const remote =
    onlyStarred && !stars.length
      ? { entries: [], total: 0, all: 0, facets: { useCase: {}, industry: {}, format: {} } }
      : await call<MarketplacePage>(`/entries?${params}`);
  if (remote) {
    const optional = await keptOptional(
      remote.entries.map((e) => e.id),
      lang,
      unavailable,
    );
    return {
      ...remote,
      entries: await plugged(
        remote.entries.map((e) => asEntry(e, starred, unavailable, optional.get(e.id))),
      ),
      offline: false,
      unavailable: [...unavailable],
    };
  }
  const local = (await kept(onlyStarred ? stars : undefined)).map((e) => keptSummary(e, lang));
  const page = onlyStarred
    ? searchEntries(local, "", {}, { limit, offset })
    : searchEntries(local, q, filters, { limit, offset });
  const optional = await keptOptional(
    page.entries.map((e) => e.id),
    lang,
    unavailable,
  );
  return {
    ...page,
    entries: await plugged(
      page.entries.map((e) => asEntry(e, starred, unavailable, optional.get(e.id))),
    ),
    offline: true,
    unavailable: [...unavailable],
  };
}

// --- one entry -----------------------------------------------------------------------------

/** An entry with its wizard: from the marketplace, else from what is kept here. */
async function fetchItem(id: string, lang: MarketplaceLang): Promise<MarketplaceItem | null> {
  const remote = await call<MarketplaceItem>(
    `/entries/${encodeURIComponent(id)}?lang=${encodeURIComponent(lang)}`,
  );
  if (remote) {
    return remote;
  }
  const [local] = await kept([id]);
  return local ? keptItem(local, lang) : null;
}

const CREDITS_PER_USD = 100;

/**
 * Prices for a runtime that has no gateway to ask: what the models each class is bound to by
 * default cost at their list price, in credits. An estimate needs a number even where a run is
 * paid for another way.
 */
function listPrices(): GatewayCatalog {
  const text = (ref: string) => ({
    model: ref,
    kind: "text" as const,
    inputCreditsPerMTok: tokenCostUsd(ref, { inputTokens: 1e6 }) * CREDITS_PER_USD,
    outputCreditsPerMTok: tokenCostUsd(ref, { outputTokens: 1e6 }) * CREDITS_PER_USD,
  });
  const m = env.models;
  return {
    markup: 1,
    webSearchCredits: WEB_SEARCH_COST_USD * CREDITS_PER_USD,
    classes: {
      classifier: text(m.classifier),
      standard: text(m.standard),
      high: text(m.high),
      highest: text(m.highest),
      image: {
        model: m.image,
        kind: "image",
        creditsPerImage: imageCostUsd(m.image) * CREDITS_PER_USD,
      },
      video: {
        model: m.video,
        kind: "video",
        creditsPerSecond: videoCostUsd(m.video, 1) * CREDITS_PER_USD,
      },
    },
  };
}

/** What a run costs: at the gateway's prices where there is one, else at list prices. */
async function priced(definition: WizardDefinition) {
  const catalog = await classCatalog().catch(() => null);
  const price = formulaEstimate(
    definition,
    catalog ?? listPrices(),
    await stepsWithoutModel(definition),
  );
  return { credits: Math.round(price.credits), high: price.high };
}

/** One entry as the app's dialog shows it: what the wizard does, makes, needs and costs. */
export interface MarketplaceDetail extends MarketplaceEntry, WizardOutline {}

/** An entry in a language with its wizard read against this app; null where there is none. */
export async function marketplaceDetail(
  id: string,
  lang: MarketplaceLang,
): Promise<MarketplaceDetail | null> {
  const own = await pluginStarter(id);
  if (own) {
    const definition = own.starter.definition as WizardDefinition;
    return {
      ...pluginEntry(own, await missingCapabilities()),
      credits: await priced(definition),
      ...wizardOutline(definition, Object.keys(own.starter.files ?? {}), lang),
    };
  }
  const found = await fetchItem(id, lang);
  if (!found) {
    return null;
  }
  const { definition, files, ...summary } = found;
  const entry = asEntry(
    summary,
    new Set(await starredIds()),
    await missingCapabilities(),
    optionalOf(definition),
  );
  const parsed = readable(definition) ? wizardSchema.parse(definition) : null;
  if (!parsed) {
    return {
      ...entry,
      usable: false,
      description: "",
      outline: [],
      results: [],
      files: Object.keys(files),
    };
  }
  return {
    ...entry,
    credits: await priced(parsed),
    ...wizardOutline(parsed, Object.keys(files), lang),
  };
}

export interface MarketplaceWizard {
  id: string;
  /** The entry's revision; null for a plugin's starter, which changes with the plugin. */
  revision: number | null;
  /** The plugin it comes with, by id: nothing is counted at the marketplace then. */
  plugin?: string;
  title: string;
  language: MarketplaceLang;
  definition: WizardDefinition;
  files: Record<string, Buffer>;
}

/** An entry's wizard and workspace in a language: what a wizard is made from. */
export async function marketplaceWizard(
  id: string,
  lang: MarketplaceLang,
): Promise<MarketplaceWizard | null> {
  const own = await pluginStarter(id);
  if (own) {
    // A plugin's starter is in its one language, whatever is asked for.
    const { starter, plugin } = own;
    return {
      id,
      revision: null,
      plugin: plugin.source.id,
      title: starter.title,
      language: starter.language ?? "en",
      definition: structuredClone(starter.definition as WizardDefinition),
      files: Object.fromEntries(
        Object.entries(starter.files ?? {}).map(([path, data]) => [
          path,
          typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data),
        ]),
      ),
    };
  }
  const found = await fetchItem(id, lang);
  if (!found) {
    return null;
  }
  if (!readable(found.definition)) {
    throw new ServiceError("refused", note("templateNeedsNewerVersion"));
  }
  // A wizard whose plugins are not here would stop at its first step that uses them.
  const have = await pluginIdsOf(currentTenant());
  const needs = pluginsOf(wizardSchema.parse(found.definition)).filter((p) => !have.has(p));
  if (needs.length) {
    throw new ServiceError(
      "refused",
      note("templateNeedsPlugins", { count: needs.length, plugins: needs }),
    );
  }
  return {
    id: found.id,
    revision: found.revision,
    title: found.title,
    language: found.language,
    definition: wizardSchema.parse(found.definition),
    files: Object.fromEntries(
      Object.entries(found.files).map(([path, data]) => [path, Buffer.from(data, "base64")]),
    ),
  };
}

/** Tells the marketplace a wizard was made from an entry. */
export async function countInstall(id: string) {
  await call(`/entries/${encodeURIComponent(id)}/installs`, { method: "POST" });
}

// --- keeping the starters and the starred ones ----------------------------------------------

// Not the key the copying into the database used before: the first look after an update is
// not held back.
const SYNCED = "marketplace:kept";
const SYNC_EVERY_MS = 3600_000;
let syncing: Promise<void> | null = null;

/** The stars that count for what is kept: a runtime that runs alone has one person's. */
async function keptStars(): Promise<string[]> {
  return managed ? [] : withTenant(LOCAL_TENANT, starredIds);
}

async function takeOver(): Promise<void> {
  const list = await call<{ items: MarketplaceSyncItem[] }>(
    `/sync?ids=${encodeURIComponent((await keptStars()).join(","))}`,
  );
  if (!list?.items) {
    return;
  }
  const have = await controlDb
    .select({ id: control.marketplaceCache.id, hash: control.marketplaceCache.hash })
    .from(control.marketplaceCache);
  for (const item of list.items) {
    if (have.some((h) => h.id === item.id && h.hash === item.hash)) {
      continue;
    }
    const entry = await call<MarketplaceExport>(`/entries/${encodeURIComponent(item.id)}/export`);
    if (!entry) {
      continue;
    }
    const values = { id: entry.id, hash: entry.hash, entry, fetchedAt: new Date() };
    await controlDb
      .insert(control.marketplaceCache)
      .values(values)
      .onConflictDoUpdate({ target: control.marketplaceCache.id, set: values });
  }
  // What the marketplace no longer lists here is not kept either.
  await controlDb.delete(control.marketplaceCache).where(
    notInArray(
      control.marketplaceCache.id,
      list.items.map((i) => i.id),
    ),
  );
  await writeSetting(SYNCED, Date.now());
}

/**
 * Keeps the marketplace's starters and the starred entries, by hash: an entry is fetched again
 * only when it changed. At most once an hour unless forced.
 */
export async function syncMarketplace(force = false): Promise<void> {
  if (!env.marketplace.url) {
    return;
  }
  const last = await readSetting<number>(SYNCED);
  if (!force && last && Date.now() - last < SYNC_EVERY_MS) {
    return;
  }
  syncing ??= takeOver()
    .catch((err) => console.error("[marketplace]", (err as Error).message))
    .finally(() => {
      syncing = null;
    });
  await syncing;
}
