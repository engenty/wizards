import { createHash, randomBytes } from "node:crypto";
import type {
  PluginKnowledgeSource,
  PluginSourceContext,
  PluginSourceFound,
  PluginSourceInfo,
  PluginSourceRead,
  PluginSourceView,
} from "@engenty/wizards/plugin";
import { and, asc, desc, eq, inArray, like } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema } from "../db/client.js";
import { loadedPlugins, pluginsOf } from "../plugins/registry.js";
import { currentTenant } from "../tenants/tenant.js";
import { requireWritableSpace } from "./access.js";
import { notFound, ServiceError } from "./errors.js";
import { pageTree } from "./knowledge.js";
import { placeItem } from "./space-data.js";
import { originData } from "./space-origin.js";

/**
 * Sources of Knowledge (docs/plans/knowledge-base.md, „A source fills a folder“): a website, a
 * sitemap, a list of addresses. A plugin brings each kind and its reader
 * (`registerKnowledgeSource`); the core keeps the source's row, its entries and its runs, and
 * writes what the reader reads into the source's own folder of Knowledge. Everything there has the
 * origin `source:<id>`: read-only in the studio until a person takes a page over, and gone with
 * the source but for what a person took.
 */

type SourceRow = typeof schema.spaceSource.$inferSelect;
type EntryRow = typeof schema.spaceSourceEntry.$inferSelect;

/** How many entries a source lists at most; a run reads the first 200 of them. */
export const MAX_FOUND = 1000;
export const MAX_RUN = 200;
/** Below the source's folder, folders go this deep; deeper paths stand in the last one. */
const MAX_DEPTH = 4;

export const originOf = (sourceId: string) => `source:${sourceId}`;
const ROOT = "root";
const dirKey = (path: string[]) => `dir:${path.join("/")}`;

// --- kinds ----------------------------------------------------------------------------------

/** A kind a plugin registered, with the plugin's id; `core` for the core's own. */
interface Kind {
  plugin: string;
  source: PluginKnowledgeSource;
}

/** What the core's own kinds are written as, in place of a plugin. */
export const CORE = "core";

/** The core's own kinds („Aus Dateien übernehmen“), each with when a tenant has it. */
const coreKinds = new Map<string, { source: PluginKnowledgeSource; on: () => Promise<boolean> }>();

export function registerCoreSource(source: PluginKnowledgeSource, on: () => Promise<boolean>) {
  coreKinds.set(source.kind, { source, on });
}

export const isCoreKind = (kind: string) => coreKinds.has(kind);

/** The kinds of the current tenant: the core's that are on, then its plugins'. */
export async function kindsOf(): Promise<Kind[]> {
  const core: Kind[] = [];
  for (const { source, on } of coreKinds.values()) {
    if (await on()) {
      core.push({ plugin: CORE, source });
    }
  }
  return [
    ...core,
    ...(await pluginsOf(currentTenant())).flatMap((plugin) =>
      [...plugin.knowledgeSources.values()].map((source) => ({ plugin: plugin.source.id, source })),
    ),
  ];
}

/** A source's kind, wherever its plugin is loaded: null when the plugin is gone. */
function kindOfRow(row: SourceRow): Kind | null {
  if (row.plugin === CORE) {
    const core = coreKinds.get(row.kind);
    return core ? { plugin: CORE, source: core.source } : null;
  }
  const plugin = loadedPlugins().find((p) => p.source.id === row.plugin);
  const source = plugin?.knowledgeSources.get(row.kind);
  return plugin && source ? { plugin: plugin.source.id, source } : null;
}

/** The rule an address falls under; null when none does. Case does not matter. */
export function ruleFor(address: string, rules: SourceRow["rules"]) {
  const a = address.toLowerCase();
  for (const rule of rules) {
    const p = rule.pattern.toLowerCase().trim();
    if (!p) {
      continue;
    }
    if (p.includes("*")) {
      const re = new RegExp(
        `^${p
          .split("*")
          .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*")}$`,
      );
      if (re.test(a) || re.test(a.replace(/[?#].*$/, ""))) {
        return rule;
      }
    } else if (a.includes(p)) {
      return rule;
    }
  }
  return null;
}

// --- rows -----------------------------------------------------------------------------------

async function sourceRow(spaceId: string, sourceId: string): Promise<SourceRow> {
  const row = await db.query.spaceSource.findFirst({
    where: and(eq(schema.spaceSource.id, sourceId), eq(schema.spaceSource.spaceId, spaceId)),
  });
  if (!row) {
    throw notFound();
  }
  return row;
}

async function updateSource(sourceId: string, patch: Partial<SourceRow>) {
  await db
    .update(schema.spaceSource)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(schema.spaceSource.id, sourceId));
}

async function updateEntry(entryId: string, patch: Partial<EntryRow>) {
  await db
    .update(schema.spaceSourceEntry)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(schema.spaceSourceEntry.id, entryId));
}

async function entriesOf(sourceId: string): Promise<EntryRow[]> {
  return db.query.spaceSourceEntry.findMany({
    where: eq(schema.spaceSourceEntry.sourceId, sourceId),
    orderBy: [asc(schema.spaceSourceEntry.address)],
  });
}

const infoOf = (row: SourceRow): PluginSourceInfo => ({
  id: row.id,
  space: row.spaceId,
  kind: row.kind,
  address: row.address,
  label: row.label,
  rules: row.rules,
});

/** The page that is a source's folder; null before it is taken or when it was removed. */
async function folderOf(row: SourceRow) {
  return (
    (await db.query.spacePage.findFirst({
      where: and(
        eq(schema.spacePage.spaceId, row.spaceId),
        eq(schema.spacePage.origin, originOf(row.id)),
        eq(schema.spacePage.originKey, ROOT),
      ),
      columns: { id: true, parentId: true },
    })) ?? null
  );
}

export async function sourceView(row: SourceRow): Promise<PluginSourceView> {
  return {
    ...infoOf(row),
    plugin: row.plugin,
    state: row.state,
    everyHours: row.everyHours,
    token: row.token,
    status: row.status,
    error: row.error,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    folderId: (await folderOf(row))?.id ?? null,
  };
}

const entryView = (e: EntryRow) => ({
  id: e.id,
  address: e.address,
  title: e.title,
  path: e.path,
  included: e.included,
  reason: e.reason,
  decidedBy: e.decidedBy,
  status: e.status,
  result: e.result,
  note: e.note,
  updatedAt: e.updatedAt.toISOString(),
});

/**
 * Takes in what a source holds now: new addresses come in under the rules (a rule leaves one
 * out, with its reason), known ones keep what a person decided. Returns the entries that are no
 * longer there.
 */
async function mergeFound(
  row: SourceRow,
  found: PluginSourceFound[],
  opts: { keepMissing?: boolean } = {},
): Promise<EntryRow[]> {
  const known = await entriesOf(row.id);
  const byAddress = new Map(known.map((e) => [e.address, e]));
  for (const f of found.slice(0, MAX_FOUND)) {
    const path = (f.path ?? []).map((p) => p.trim().slice(0, 120)).filter(Boolean);
    const was = byAddress.get(f.address);
    if (was) {
      if ((f.title && !was.title) || path.join("/") !== was.path.join("/")) {
        await updateEntry(was.id, { title: was.title || f.title || null, path });
      }
      continue;
    }
    const rule = ruleFor(f.address, row.rules);
    await db
      .insert(schema.spaceSourceEntry)
      .values({
        id: nanoid(12),
        sourceId: row.id,
        address: f.address.slice(0, 2000),
        title: f.title?.slice(0, 300) || null,
        path,
        included: !rule,
        reason: rule?.reason ?? null,
        decidedBy: rule ? "rule" : null,
        status: "new",
        result: null,
        note: null,
        fingerprint: null,
      })
      .onConflictDoNothing();
  }
  if (opts.keepMissing) {
    return [];
  }
  const there = new Set(found.map((f) => f.address));
  return known.filter((e) => !there.has(e.address));
}

// --- the list of a space --------------------------------------------------------------------

/**
 * What a run is doing now: listing the source, reading entries (so many of so many), or
 * finishing (the Übersichten of the values it filled).
 */
export interface RunNow {
  phase: "listing" | "reading" | "finishing";
  /** The entries being read at this moment, by title or address. */
  reading: string[];
  done: number;
  of: number;
}

/** Runs going on in this process, by source: a source runs once at a time. */
const running = new Map<string, { stop: AbortController; now: RunNow }>();
/** Sources asked to run while they ran: they run once more after. */
const again = new Set<string>();

async function runsOf(sourceId: string, limit = 5) {
  const rows = await db.query.spaceSourceRun.findMany({
    where: eq(schema.spaceSourceRun.sourceId, sourceId),
    orderBy: [desc(schema.spaceSourceRun.startedAt)],
    limit,
  });
  return rows.map((r) => ({
    id: r.id,
    startedAt: r.startedAt.toISOString(),
    endedAt: r.endedAt?.toISOString() ?? null,
    status: r.status,
    written: r.written,
    unchanged: r.unchanged,
    failed: r.failed,
    leftOut: r.leftOut,
    log: r.log,
  }));
}

/**
 * A space's sources, each with its counts, what it is doing now and how its last run went (its
 * log's last line, not the whole log); and the kinds the tenant's plugins bring.
 */
export async function listSources(spaceId: string) {
  const rows = await db.query.spaceSource.findMany({
    where: eq(schema.spaceSource.spaceId, spaceId),
    orderBy: [asc(schema.spaceSource.createdAt)],
  });
  const entries = rows.length
    ? await db.query.spaceSourceEntry.findMany({
        where: inArray(
          schema.spaceSourceEntry.sourceId,
          rows.map((r) => r.id),
        ),
        columns: { sourceId: true, included: true, status: true },
      })
    : [];
  const sources = await Promise.all(
    rows.map(async (r) => {
      const own = entries.filter((e) => e.sourceId === r.id && e.included);
      const [last] = await runsOf(r.id, 1);
      const { log, ...lastRun } = last ?? { log: [] };
      return {
        ...(await sourceView(r)),
        available: Boolean(kindOfRow(r)),
        manual: Boolean(kindOfRow(r)?.source.manual),
        counts: {
          entries: entries.filter((e) => e.sourceId === r.id).length,
          included: own.length,
          done: own.filter((e) => e.status === "done" || e.status === "kept").length,
          check: own.filter((e) => e.status === "check").length,
          failed: own.filter((e) => e.status === "failed").length,
        },
        running: running.has(r.id),
        now: running.get(r.id)?.now ?? null,
        lastRun: last ? { ...lastRun, lastLine: log.at(-1) ?? null } : null,
      };
    }),
  );
  const kinds = (await kindsOf()).map((k) => ({
    kind: k.source.kind,
    plugin: k.plugin,
    manual: Boolean(k.source.manual),
  }));
  return { sources, kinds };
}

/** One source with its entries and its last runs, as its settings show it. */
export async function getSource(spaceId: string, sourceId: string) {
  const row = await sourceRow(spaceId, sourceId);
  const kind = kindOfRow(row);
  return {
    source: {
      ...(await sourceView(row)),
      available: Boolean(kind),
      manual: Boolean(kind?.source.manual),
      running: running.has(row.id),
      now: running.get(row.id)?.now ?? null,
    },
    entries: (await entriesOf(row.id)).map(entryView),
    runs: await runsOf(row.id),
  };
}

// --- proposing and taking -------------------------------------------------------------------

/** What the proposal card shows; small, it travels to the chat as it is. */
export interface SourceProposal {
  id: string;
  label: string;
  kind: string;
  plugin: string;
  address: string;
  state: SourceRow["state"];
  found: number;
  included: number;
  leftOut: { title: string; reason: string }[];
  categories: { name: string; type: string; unit?: string; hint?: string }[];
  folderId: string | null;
}

export async function proposalOf(row: SourceRow): Promise<SourceProposal> {
  const entries = await entriesOf(row.id);
  return {
    id: row.id,
    label: row.label,
    kind: row.kind,
    plugin: row.plugin,
    address: row.address,
    state: row.state,
    found: entries.length,
    included: entries.filter((e) => e.included).length,
    leftOut: entries
      .filter((e) => !e.included)
      .slice(0, 6)
      .map((e) => ({ title: e.title || e.address, reason: e.reason ?? "" })),
    categories: row.categories.map((c) => ({
      name: c.name,
      type: c.type,
      ...(c.unit ? { unit: c.unit } : {}),
      ...(c.hint ? { hint: c.hint } : {}),
    })),
    folderId: (await folderOf(row))?.id ?? null,
  };
}

/** What a source is called before anyone named it: the folder's name, the site and its path. */
function nameOf(address: string): string {
  try {
    const url = new URL(address);
    return `${url.host.replace(/^www\./, "")}${url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "")}`;
  } catch {
    return address.replace(/\/+$/, "").split(/[/\\]/).pop() || address;
  }
}

/** The kind that takes what a person named: the one asked for, else the first that matches. */
async function pickKind(address: string, kind?: string | null) {
  const kinds = await kindsOf();
  if (kind) {
    const k = kinds.find((x) => x.source.kind === kind);
    if (!k) {
      throw new ServiceError("invalid", `There is no source of the kind "${kind}".`);
    }
    return { kind: k, address: k.source.match?.(address) ?? address.trim() };
  }
  for (const k of kinds) {
    const matched = k.source.match?.(address);
    if (matched) {
      return { kind: k, address: matched };
    }
  }
  throw new ServiceError("invalid", "No source here reads that.", { code: "no_kind" });
}

/**
 * Proposes a source of the space: lists it, leaves out by rule, and lets the kind propose a name,
 * Kategorien and the entries that do not belong. Nothing is written into Knowledge before a
 * person takes it. The same address again proposes anew, unless it is taken already.
 */
export async function proposeSource(
  spaceId: string,
  input: { address: string; kind?: string | null; label?: string | null },
  ctx: Partial<PluginSourceContext> = {},
): Promise<SourceProposal> {
  await requireWritableSpace(spaceId);
  const signal = ctx.signal ?? new AbortController().signal;
  const emit = ctx.emit ?? (() => {});
  const picked = await pickKind(input.address, input.kind);
  const { source: kind, plugin } = picked.kind;
  const same = await db.query.spaceSource.findFirst({
    where: and(
      eq(schema.spaceSource.spaceId, spaceId),
      eq(schema.spaceSource.kind, kind.kind),
      eq(schema.spaceSource.address, picked.address),
    ),
  });
  if (same?.state === "taken") {
    return proposalOf(same);
  }
  if (same) {
    await db.delete(schema.spaceSource).where(eq(schema.spaceSource.id, same.id));
  }
  const id = nanoid(12);
  const row: SourceRow = {
    id,
    tenantId: currentTenant(),
    spaceId,
    kind: kind.kind,
    plugin,
    address: picked.address,
    label: (input.label?.trim() || nameOf(picked.address)).slice(0, 120),
    state: "proposed",
    rules: kind.rules ?? [],
    categories: [],
    everyHours: null,
    token: randomBytes(18).toString("base64url"),
    status: "idle",
    error: null,
    lastRunAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  // A source whose entries come by hand starts with the address it was named by.
  let found: PluginSourceFound[] = kind.manual ? [{ address: picked.address }] : [];
  if (!kind.manual) {
    try {
      found = await kind.reader.list(infoOf(row), { signal, emit });
    } catch (err) {
      throw new ServiceError("invalid", (err as Error).message, { code: "not_readable" });
    }
    if (!found.length) {
      throw new ServiceError("invalid", "There is nothing to read there.", { code: "empty" });
    }
  }
  await db.insert(schema.spaceSource).values(row);
  await mergeFound(row, found);
  if (kind.reader.propose) {
    const entries = (await entriesOf(id)).slice(0, MAX_FOUND);
    try {
      const proposal = await kind.reader.propose(
        infoOf(row),
        entries.map((e) => ({
          address: e.address,
          title: e.title,
          included: e.included,
          reason: e.reason,
        })),
        { signal, emit },
      );
      await updateSource(id, {
        label: (input.label?.trim() || proposal.label?.trim() || row.label).slice(0, 120),
        categories: (proposal.categories ?? []).slice(0, 7).map((c) => ({
          name: c.name.trim().slice(0, 80),
          type: c.type,
          ...(c.unit ? { unit: c.unit } : {}),
          ...(c.type === "choice" && c.multiple ? { multiple: true } : {}),
          ...(c.hint ? { hint: c.hint.slice(0, 120) } : {}),
          ...(c.type === "choice" && c.values?.length ? { values: c.values.slice(0, 60) } : {}),
        })),
      });
      const byAddress = new Map(entries.map((e) => [e.address, e]));
      for (const out of proposal.leaveOut ?? []) {
        const e = byAddress.get(out.address);
        if (e?.included) {
          await updateEntry(e.id, {
            included: false,
            reason: out.reason.slice(0, 120),
            decidedBy: "model",
          });
        }
      }
    } catch (err) {
      // Without a model the source is still proposed: by its rules, without Kategorien.
      if ((err as { code?: string }).code !== "no_model") {
        console.warn(`[sources] ${plugin} proposes:`, (err as Error).message);
      }
    }
  }
  return proposalOf(await sourceRow(spaceId, id));
}

/**
 * Takes a proposed source: its Kategorien go into the space, its folder is made (in `parentId`,
 * or at the top), its first run starts.
 */
export async function takeSource(
  spaceId: string,
  sourceId: string,
  opts: { parentId?: string | null } = {},
): Promise<SourceProposal> {
  await requireWritableSpace(spaceId);
  const row = await sourceRow(spaceId, sourceId);
  const kind = kindOfRow(row);
  if (row.state !== "taken") {
    if (row.categories.length) {
      await originData(originOf(row.id)).putCategories({
        space: spaceId,
        categories: row.categories,
      });
    }
    await updateSource(row.id, {
      state: "taken",
      everyHours: row.everyHours ?? kind?.source.everyHours ?? null,
    });
    const folder = await ensureFolder({ ...row, state: "taken" });
    if (opts.parentId) {
      await placeItem(spaceId, `p:${folder}`, opts.parentId);
    }
  }
  startSource(row.id);
  return proposalOf(await sourceRow(spaceId, row.id));
}

/** The source's folder, made when it is missing: a page named as the source, at the top. */
async function ensureFolder(row: SourceRow): Promise<string> {
  const had = await folderOf(row);
  if (had) {
    return had.id;
  }
  const made = await originData(originOf(row.id)).putPage({
    space: row.spaceId,
    key: ROOT,
    label: row.label,
    title: row.label,
    markdown: "",
  });
  return made.id;
}

// --- changing ------------------------------------------------------------------------------

export async function updateSourceSettings(
  spaceId: string,
  sourceId: string,
  patch: { label?: string; everyHours?: number | null; rules?: SourceRow["rules"] },
) {
  await requireWritableSpace(spaceId);
  const row = await sourceRow(spaceId, sourceId);
  await updateSource(row.id, patch);
  if (patch.label && patch.label !== row.label) {
    // The folder is called as the source; a person who renamed it keeps their name.
    const folder = await folderOf(row);
    if (folder) {
      await db
        .update(schema.spacePage)
        .set({ title: patch.label, originLabel: patch.label, updatedAt: new Date() })
        .where(and(eq(schema.spacePage.id, folder.id), eq(schema.spacePage.kept, false)));
    }
  }
  return sourceView(await sourceRow(spaceId, row.id));
}

/** The eye: a person leaves an entry out of Knowledge, or takes it in again. */
export async function setEntryIncluded(
  spaceId: string,
  sourceId: string,
  entryId: string,
  included: boolean,
) {
  await requireWritableSpace(spaceId);
  const row = await sourceRow(spaceId, sourceId);
  const e = await db.query.spaceSourceEntry.findFirst({
    where: and(
      eq(schema.spaceSourceEntry.id, entryId),
      eq(schema.spaceSourceEntry.sourceId, row.id),
    ),
  });
  if (!e) {
    throw notFound();
  }
  await updateEntry(e.id, {
    included,
    reason: included ? null : "Von Hand",
    decidedBy: "person",
  });
  if (row.state === "taken") {
    startSource(row.id, [e.id]);
  }
  return entryView({ ...e, included });
}

/** Adds addresses to a source whose entries come by hand, and reads them. */
export async function addSourceEntries(spaceId: string, sourceId: string, addresses: string[]) {
  await requireWritableSpace(spaceId);
  const row = await sourceRow(spaceId, sourceId);
  await mergeFound(
    row,
    addresses.map((address) => ({ address })),
    { keepMissing: true },
  );
  if (row.state === "taken") {
    startSource(row.id);
  }
  return (await entriesOf(row.id)).map(entryView);
}

/**
 * Removes a source and what it wrote. What a person took over stays, as theirs: it moves to where
 * the source's folder stood.
 */
export async function removeSource(spaceId: string, sourceId: string) {
  await requireWritableSpace(spaceId);
  const row = await sourceRow(spaceId, sourceId);
  stopSource(row.id);
  const origin = originOf(row.id);
  const folder = await folderOf(row);
  const parentId = folder?.parentId ?? null;
  const kept = await Promise.all([
    db.query.spacePage.findMany({
      where: and(eq(schema.spacePage.origin, origin), eq(schema.spacePage.kept, true)),
      columns: { id: true },
    }),
    db.query.spaceTable.findMany({
      where: and(eq(schema.spaceTable.origin, origin), eq(schema.spaceTable.kept, true)),
      columns: { id: true },
    }),
  ]);
  const tree = await pageTree(spaceId);
  for (const page of kept[0]) {
    // Out of the folders that go; a kept page under another kept page stays under it.
    const parent = tree.get(page.id)?.parentId;
    if (!parent || !kept[0].some((k) => k.id === parent)) {
      await placeItem(spaceId, `p:${page.id}`, parentId);
    }
  }
  for (const table of kept[1]) {
    await placeItem(spaceId, `t:${table.id}`, parentId);
  }
  for (const table of [schema.spacePage, schema.spaceTable] as const) {
    await db
      .update(table)
      .set({ origin: null, originKey: null })
      .where(and(eq(table.origin, origin), eq(table.kept, true)));
  }
  await originData(origin).remove(spaceId);
  await db.delete(schema.spaceSource).where(eq(schema.spaceSource.id, row.id));
}

/**
 * „Als eigene Seite übernehmen“: a page or table a source wrote becomes the space's own. The
 * source no longer writes it, and it stays when the source goes.
 */
export async function keepItem(spaceId: string, key: string) {
  await requireWritableSpace(spaceId);
  const id = key.slice(2);
  const table = key[0] === "p" ? schema.spacePage : key[0] === "t" ? schema.spaceTable : null;
  if (!table) {
    throw notFound();
  }
  const done = await db
    .update(table)
    .set({ kept: true, updatedAt: new Date() })
    .where(and(eq(table.id, id), eq(table.spaceId, spaceId), like(table.origin, "source:%")))
    .returning({ id: table.id });
  if (!done.length) {
    throw notFound();
  }
}

// --- running ---------------------------------------------------------------------------------

export const isRunning = (sourceId: string) => running.has(sourceId);

export function stopSource(sourceId: string) {
  again.delete(sourceId);
  running.get(sourceId)?.stop.abort();
}

interface Outcome {
  kind: "written" | "unchanged" | "failed";
  status: EntryRow["status"];
  itemKey?: string | null;
  result?: EntryRow["result"];
  note?: string | null;
  fingerprint?: string | null;
}

const hashOf = (text: string) =>
  `h:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;

/** What each entry's path is below the folder, cut to the depth folders go. */
const pathOf = (e: EntryRow) => e.path.slice(0, MAX_DEPTH);

/** Writes what the reader read of one entry into the source's folder. */
async function writeEntry(
  row: SourceRow,
  kind: PluginKnowledgeSource,
  e: EntryRow,
  read: PluginSourceRead,
  dirs: Set<string>,
): Promise<Outcome> {
  if (read.kind === "unchanged") {
    return { kind: "unchanged", status: e.status };
  }
  if (read.kind === "failed") {
    return {
      kind: "failed",
      status: "failed",
      note: read.note.slice(0, 300),
      fingerprint: read.fingerprint ?? null,
    };
  }
  const data = originData(originOf(row.id));
  const path = pathOf(e);
  // The source's own folder's text: a README at the top of what it reads.
  const isRoot = read.kind === "page" && path.length === 0 && Boolean(read.folder);
  // A page whose path is a folder of others is that folder's text.
  const isDir = read.kind === "page" && path.length > 0 && dirs.has(path.join("/"));
  // The last part of its path is its own name.
  const where = path.slice(0, -1);
  const parent = where.length ? dirKey(where) : ROOT;
  if (read.kind === "page") {
    const fingerprint = read.fingerprint ?? hashOf(read.markdown);
    if (e.result && e.status !== "failed" && fingerprint === e.fingerprint) {
      return { kind: "unchanged", status: e.status };
    }
    const key = isRoot ? ROOT : isDir ? dirKey(path) : `e:${e.id}`;
    const put = await data.putPage({
      space: row.spaceId,
      key,
      label: row.label,
      ...(isRoot ? {} : { parent }),
      // A folder's text keeps the folder's name: the source's, its path's last part.
      title: isRoot
        ? row.label
        : isDir && read.folder
          ? titleOfSegment(path[path.length - 1])
          : read.title,
      markdown: read.markdown.slice(0, 190_000),
      images: read.images,
      fill: kind.fill,
    });
    if (put.state === "kept") {
      return { kind: "unchanged", status: "kept", fingerprint, itemKey: key };
    }
    return {
      kind: "written",
      status: "done",
      itemKey: key,
      result: { kind: "page", id: put.id, path: put.path, title: read.title },
      note: null,
      fingerprint,
    };
  }
  const key = `e:${e.id}`;
  const doc = await data.putDocument({
    space: row.spaceId,
    key,
    label: row.label,
    name: read.name,
    mime: read.mime,
    data: read.data,
    fill: kind.fill,
  });
  const folder = await db.query.spacePage.findFirst({
    where: and(
      eq(schema.spacePage.spaceId, row.spaceId),
      eq(schema.spacePage.origin, originOf(row.id)),
      eq(schema.spacePage.originKey, parent),
    ),
    columns: { id: true },
  });
  if (folder) {
    await placeItem(row.spaceId, `f:${doc.id}`, folder.id);
  }
  if (doc.state === "kept") {
    return { kind: "unchanged", status: "kept", fingerprint: read.fingerprint, itemKey: key };
  }
  const first = doc.items[0];
  return {
    kind: "written",
    status: doc.review ? "check" : "done",
    itemKey: key,
    result: first
      ? { kind: first.kind, id: first.id, path: first.path, title: first.title }
      : { kind: "file", id: doc.id, path: doc.path, title: read.name },
    note: doc.review,
    fingerprint: read.fingerprint ?? null,
  };
}

/**
 * The folders a source's entries stand in: made where missing, named by their path's last part.
 * Folders no entry stands in any more go, unless a person took them or something stands in them.
 */
async function syncFolders(row: SourceRow, entries: EntryRow[]): Promise<Set<string>> {
  const data = originData(originOf(row.id));
  const dirs = new Set<string>();
  for (const e of entries.filter((x) => x.included)) {
    const path = pathOf(e);
    for (let i = 1; i < path.length; i++) {
      dirs.add(path.slice(0, i).join("/"));
    }
  }
  // An entry whose path is a folder of others writes the folder's text.
  const own = await db.query.spacePage.findMany({
    where: and(
      eq(schema.spacePage.spaceId, row.spaceId),
      eq(schema.spacePage.origin, originOf(row.id)),
      like(schema.spacePage.originKey, "dir:%"),
    ),
    columns: { id: true, originKey: true, kept: true },
  });
  const have = new Set(own.map((p) => p.originKey));
  for (const dir of [...dirs].sort((a, b) => a.split("/").length - b.split("/").length)) {
    const path = dir.split("/");
    if (!have.has(dirKey(path))) {
      await data.putPage({
        space: row.spaceId,
        key: dirKey(path),
        label: row.label,
        parent: path.length > 1 ? dirKey(path.slice(0, -1)) : ROOT,
        title: titleOfSegment(path[path.length - 1]),
        markdown: "",
      });
    }
  }
  const gone = own.filter((p) => !p.kept && !dirs.has((p.originKey ?? "").slice(4)));
  if (gone.length) {
    const tree = await pageTree(row.spaceId);
    for (const p of gone) {
      const holds = [...tree.values()].some((n) => n.parentId === p.id);
      if (!holds) {
        await data.remove(row.spaceId, p.originKey ?? "");
      }
    }
  }
  return dirs;
}

/** A folder's name from a part of an address: `foerder-programme` → „Foerder programme“. */
function titleOfSegment(segment: string): string {
  let s = segment;
  try {
    s = decodeURIComponent(segment);
  } catch {}
  s = s
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/[-_+]+/g, " ")
    .trim();
  return (s.charAt(0).toUpperCase() + s.slice(1)).slice(0, 120) || segment;
}

/** Takes an entry's item out of Knowledge; a folder that holds others keeps them, without text. */
async function removeEntryItem(row: SourceRow, e: EntryRow) {
  const key = e.itemKey ?? `e:${e.id}`;
  const data = originData(originOf(row.id));
  // The source's folder stays: only its text goes.
  if (key === ROOT) {
    await db
      .update(schema.spacePage)
      .set({ markdown: "", updatedAt: new Date() })
      .where(
        and(
          eq(schema.spacePage.spaceId, row.spaceId),
          eq(schema.spacePage.origin, originOf(row.id)),
          eq(schema.spacePage.originKey, ROOT),
          eq(schema.spacePage.kept, false),
        ),
      );
    return;
  }
  if (key.startsWith("dir:")) {
    const page = await db.query.spacePage.findFirst({
      where: and(
        eq(schema.spacePage.spaceId, row.spaceId),
        eq(schema.spacePage.origin, originOf(row.id)),
        eq(schema.spacePage.originKey, key),
      ),
      columns: { id: true, kept: true },
    });
    const tree = await pageTree(row.spaceId);
    if (page && !page.kept && [...tree.values()].some((n) => n.parentId === page.id)) {
      await db
        .update(schema.spacePage)
        .set({ markdown: "", updatedAt: new Date() })
        .where(eq(schema.spacePage.id, page.id));
      return;
    }
  }
  await data.remove(row.spaceId, key);
}

/**
 * A line of a run's log: what happened and to what, tab-separated, for the studio to say in the
 * person's language. `read`, `unchanged`, `gone` name an entry; `failed` and `error` an entry and
 * why; `limit` how many a run reads; `summary` a Kategorie and why its Übersicht failed;
 * `aborted` why the run stopped.
 */
export type LogCode =
  | "read"
  | "unchanged"
  | "gone"
  | "failed"
  | "error"
  | "limit"
  | "summary"
  | "aborted";

const line = (code: LogCode, ...parts: string[]) =>
  [code, ...parts.map((p) => p.replace(/\s+/g, " ").trim())].join("\t");

export interface RunSummary {
  written: number;
  unchanged: number;
  failed: number;
  leftOut: number;
}

/**
 * Runs a source: lists it again, reads what is in and changed, takes out what was left out or
 * went away. `only`: these entries alone, without listing the source again.
 */
export async function runSource(
  sourceId: string,
  opts: { only?: string[]; signal?: AbortSignal } = {},
): Promise<RunSummary> {
  const summary: RunSummary = { written: 0, unchanged: 0, failed: 0, leftOut: 0 };
  const row = await db.query.spaceSource.findFirst({
    where: eq(schema.spaceSource.id, sourceId),
  });
  if (row?.state !== "taken") {
    return summary;
  }
  if (running.has(row.id)) {
    // Asked again while it reads: once more when it is done, for what changed meanwhile.
    again.add(row.id);
    return summary;
  }
  const kind = kindOfRow(row);
  if (!kind) {
    await updateSource(row.id, {
      status: "failed",
      error:
        row.plugin === CORE
          ? `There is no source of the kind "${row.kind}" here.`
          : `The plugin "${row.plugin}" that reads it is not there.`,
    });
    return summary;
  }
  const stop = new AbortController();
  const now: RunNow = { phase: "listing", reading: [], done: 0, of: 0 };
  running.set(row.id, { stop, now });
  const signal = opts.signal ? AbortSignal.any([opts.signal, stop.signal]) : stop.signal;
  const ctx: PluginSourceContext = { signal, emit: () => {} };
  const runId = nanoid(12);
  const log: string[] = [];
  const save = (values: Partial<typeof schema.spaceSourceRun.$inferInsert>) =>
    db
      .update(schema.spaceSourceRun)
      .set({ ...summary, log: log.slice(-200), ...values })
      .where(eq(schema.spaceSourceRun.id, runId));
  await db.insert(schema.spaceSourceRun).values({
    id: runId,
    sourceId: row.id,
    startedAt: new Date(),
    status: "running",
    ...summary,
    log: [],
  });
  await updateSource(row.id, { status: "running", error: null });
  try {
    await ensureFolder(row);
    let found: PluginSourceFound[] = [];
    if (!opts.only && !kind.source.manual) {
      found = await kind.source.reader.list(infoOf(row), ctx);
      const gone = await mergeFound(row, found);
      for (const e of gone) {
        if (e.result) {
          await removeEntryItem(row, e);
        }
        log.push(line("gone", e.title || e.address));
      }
      if (gone.length) {
        await db.delete(schema.spaceSourceEntry).where(
          inArray(
            schema.spaceSourceEntry.id,
            gone.map((e) => e.id),
          ),
        );
      }
    }
    const byAddress = new Map(found.map((f) => [f.address, f]));
    const all = await entriesOf(row.id);
    const dirs = await syncFolders(row, all);
    const entries = all.filter((e) => !opts.only || opts.only.includes(e.id));
    // What was left out since it was written goes out of Knowledge.
    for (const e of entries.filter((x) => !x.included && x.result)) {
      await removeEntryItem(row, e);
      await updateEntry(e.id, {
        result: null,
        itemKey: null,
        status: "new",
        fingerprint: null,
        note: null,
      });
      summary.leftOut++;
    }
    // What the list says did not change is not read and does not count against a run's reads.
    const same = (e: EntryRow) => {
      const f = byAddress.get(e.address);
      return Boolean(
        e.result && e.status !== "failed" && f?.fingerprint && f.fingerprint === e.fingerprint,
      );
    };
    const included = entries.filter((e) => e.included);
    for (const e of included.filter(same)) {
      summary.unchanged++;
      log.push(line("unchanged", e.result?.title ?? e.title ?? e.address));
    }
    const work = included.filter((e) => !same(e));
    const todo = work.slice(0, MAX_RUN);
    now.phase = "reading";
    now.of = todo.length;
    for (let i = 0; i < todo.length && !signal.aborted; i += 3) {
      const batch = todo.slice(i, i + 3);
      now.reading = batch.map((e) => e.title || e.address);
      await Promise.all(
        batch.map(async (e) => {
          try {
            const f = byAddress.get(e.address) ?? null;
            const out = await writeEntry(
              row,
              kind.source,
              e,
              await kind.source.reader.read(
                infoOf(row),
                {
                  id: e.id,
                  address: e.address,
                  title: e.title,
                  fingerprint: e.fingerprint,
                  found: f,
                },
                ctx,
              ),
              dirs,
            );
            summary[out.kind]++;
            if (out.kind !== "unchanged" || out.status !== e.status) {
              await updateEntry(e.id, {
                status: out.status,
                ...(out.itemKey !== undefined ? { itemKey: out.itemKey } : {}),
                ...(out.result !== undefined ? { result: out.result } : {}),
                ...(out.note !== undefined ? { note: out.note } : {}),
                ...(out.fingerprint !== undefined ? { fingerprint: out.fingerprint } : {}),
              });
            }
            if (out.kind === "written") {
              log.push(line("read", out.result?.title ?? e.address));
            } else if (out.kind === "unchanged") {
              log.push(line("unchanged", e.result?.title ?? e.title ?? e.address));
            } else {
              log.push(line("failed", e.title || e.address, out.note ?? ""));
            }
          } catch (err) {
            if (signal.aborted) {
              return;
            }
            summary.failed++;
            const message = (err as Error).message.slice(0, 300);
            log.push(line("error", e.title || e.address, message));
            await updateEntry(e.id, { status: "failed", note: message });
          }
        }),
      );
      now.done = Math.min(i + 3, todo.length);
      await save({});
    }
    now.phase = "finishing";
    now.reading = [];
    if (work.length > MAX_RUN) {
      log.push(line("limit", String(MAX_RUN)));
      // The core's kinds ask no model: the next reads follow at once.
      if (row.plugin === CORE && !signal.aborted) {
        again.add(row.id);
      }
    }
    // The values the source filled get an Übersicht once they have three items.
    if (summary.written && kind.source.fill && !signal.aborted) {
      for (const c of row.categories.filter((x) => x.type === "choice")) {
        await originData(originOf(row.id))
          .summarize(row.spaceId, c.name)
          .catch((err: Error) => {
            log.push(line("summary", c.name, err.message));
          });
      }
    }
    await save({ status: signal.aborted ? "stopped" : "done", endedAt: new Date() });
    await updateSource(row.id, { status: "idle", lastRunAt: new Date() });
    return summary;
  } catch (err) {
    const message = (err as Error).message.slice(0, 300);
    log.push(line("aborted", message));
    await save({ status: "failed", endedAt: new Date() });
    await updateSource(row.id, { status: "failed", error: message, lastRunAt: new Date() });
    return summary;
  } finally {
    running.delete(row.id);
    if (again.delete(row.id)) {
      startSource(row.id);
    }
  }
}

/** A run in the background, as a route, a signal or the schedule starts it. */
export function startSource(sourceId: string, only?: string[]) {
  void runSource(sourceId, { only }).catch((err) => console.error("[sources] run", err));
}

/** Runs the sources of a plugin's kinds whose hours are up: its turn of `every`. */
export async function runDueSources(pluginId: string, now = Date.now()) {
  const rows = await db.query.spaceSource.findMany({
    where: and(eq(schema.spaceSource.plugin, pluginId), eq(schema.spaceSource.state, "taken")),
  });
  for (const r of rows) {
    if (
      r.everyHours &&
      !running.has(r.id) &&
      (!r.lastRunAt || now - r.lastRunAt.getTime() >= r.everyHours * 3_600_000)
    ) {
      startSource(r.id);
    }
  }
}
