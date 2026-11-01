import { existsSync, type FSWatcher, mkdirSync, watch } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  PluginAssistantTool,
  PluginDb,
  PluginTool,
  WizardsPluginApi,
  WizardsPluginFactory,
} from "@engenty/wizards/plugin";
import {
  FIELD_KINDS,
  PLUGIN_ID,
  PLUGIN_TOOL_NAME,
  wizardSchema,
} from "@engenty/wizards-shared/definition";
import {
  BUILT_IN_RUNNERS,
  OUTPUT_KINDS,
  type OutputKind,
  RESERVED_PATHS,
  RUNNER_ID,
} from "@engenty/wizards-shared/runners";
import { generateText, Output } from "ai";
import { and, eq } from "drizzle-orm";
import { createJiti } from "jiti";
import { z } from "zod";
import { readPage } from "../agents/website.js";
import { packageRoot } from "../cli/home.js";
import { pluginConnections } from "../connectors/plugin-connections.js";
import { db, onTenantOpen, schema } from "../db/client.js";
import { parseDocument } from "../documents/parse.js";
import { env } from "../env.js";
import { currentFeatures } from "../features.js";
import { managed } from "../manage.js";
import { conversationAccess, ModelUnavailableError, textModel } from "../models.js";
import { seal, unseal } from "../secrets/crypto.js";
import { putIndexEntry, removeIndexEntries } from "../services/space-index.js";
import { originData } from "../services/space-origin.js";
import {
  addSourceEntries,
  isCoreKind,
  runDueSources,
  sourceView,
  startSource,
} from "../services/space-sources.js";
import { readSetting, writeSetting } from "../settings.js";
import { safeFetch } from "../tools/net-guard.js";
import { channelsApi } from "./channels.js";
import { claimsApiFor } from "./claims.js";
import { discoverPlugins, type PluginProblem, type PluginSource } from "./discovery.js";
import { migrateOpenTenants, migratePlugins } from "./migrations.js";
import { proModulesDir, proSources } from "./pro-state.js";
import { publicRefOf, publicUrlOf, sharedUrlOf } from "./public.js";
import {
  announceChange,
  compileRoute,
  dropPlugin,
  emptyRecord,
  type LoadedPlugin,
  loadedPlugin,
  loadedPlugins,
  setPlugin,
} from "./registry.js";
import { runsApiFor } from "./runs.js";

/**
 * Loading plugins (docs/content/dev/plugins). A plugin's server half is TypeScript or JavaScript read
 * from its file as it is: no build step, and a reload reads the files again. What a plugin
 * imports of the runtime's own packages comes from the runtime's copies, wherever the plugin's
 * file lies.
 */

/** Where Settings › Plugins puts the plugins someone installs here (plugins/install.ts). */
export const installedPluginsDir = () => join(env.dataDir, "plugins");

/** What ships with this runtime, then the folders of `PLUGINS_DIR`, then what was installed here. */
export function pluginDirs(): string[] {
  return [join(packageRoot, "modules"), ...env.plugins.dirs, installedPluginsDir()];
}

/** The plugins switched off in Settings › Plugins: found, not loaded. */
const OFF = "plugins-off";
let off = new Set<string>();
/** Everything the last look found, the switched-off ones too. */
let lastFound: PluginSource[] = [];

/** Everything found, switched off or not, as of the last look. */
export function foundPlugins(): PluginSource[] {
  return lastFound;
}

export function pluginOff(id: string): boolean {
  return off.has(id);
}

/** Switches a plugin on or off: off it unloads and its files and tables stay; on it loads again. */
export async function setPluginOn(id: string, on: boolean): Promise<void> {
  const next = new Set(off);
  if (on) {
    next.delete(id);
  } else {
    next.add(id);
  }
  off = next;
  await writeSetting(OFF, [...next].sort());
  await findNewPlugins();
}

const own = (specifier: string) => fileURLToPath(import.meta.resolve(specifier));

/**
 * The longer name first: an alias also matches what begins with it. `@engenty-wizards/plugin-sdk`
 * is the name plugins written before `@engenty/wizards/plugin` import.
 */
function aliases(): Record<string, string> {
  const thread = own("@engenty/wizards/plugin/thread");
  const plugin = own("@engenty/wizards/plugin");
  return {
    "@engenty/wizards/plugin/thread": thread,
    "@engenty/wizards/plugin": plugin,
    "@engenty-wizards/plugin-sdk/thread": thread,
    "@engenty-wizards/plugin-sdk": plugin,
    "drizzle-orm/sqlite-core": own("drizzle-orm/sqlite-core"),
    "drizzle-orm": own("drizzle-orm"),
    zod: own("zod"),
  };
}

async function importFactory(entry: string): Promise<WizardsPluginFactory> {
  // No module cache: every load evaluates the plugin's files anew.
  const jiti = createJiti(import.meta.url, { moduleCache: false, alias: aliases() });
  const factory = await jiti.import(entry, { default: true });
  if (typeof factory !== "function") {
    throw new Error("The default export is not a function.");
  }
  return factory as WizardsPluginFactory;
}

/** The job that reads a plugin's sources of Knowledge again on their schedule. */
const SOURCES_JOB = "knowledge_sources";

/** A job runs at most this often. */
const MIN_EVERY_MS = 60_000;

/** The built-in runners and the sub-paths of a wizard's address that are something else. */
const RESERVED_RUNNER_IDS = new Set([...BUILT_IN_RUNNERS.map((r) => r.id), ...RESERVED_PATHS]);

/** What a plugin says about a runner, checked: the lists hold known kinds only. */
const runnerInfoSchema = z.object({
  id: z.string().regex(RUNNER_ID, 'lower case, digits and "-", at most 24 characters'),
  label: z.object({ de: z.string().min(1), en: z.string().min(1) }),
  kind: z.enum(["page", "channel"]),
  capabilities: z.object({
    input: z.array(z.enum(FIELD_KINDS)),
    output: z.object({
      shows: z.array(z.enum(OUTPUT_KINDS as [OutputKind, ...OutputKind[]])),
      pictures: z.array(z.enum(OUTPUT_KINDS as [OutputKind, ...OutputKind[]])),
    }),
    asks: z.array(z.enum(["confirm", "login"])),
    review: z.array(z.enum(["accept", "regenerate", "edit"])),
    waits: z.boolean(),
    handoff: z.array(z.enum(["screen", "thread", "sms", "push"])),
  }),
  plugin: z.string(),
});

function apiFor(record: LoadedPlugin): WizardsPluginApi {
  const { source } = record;
  const tag = `[plugin ${source.id}]`;
  /** The names a step's model sees: the plugin's step tools and its context tools share them. */
  const stepToolNames = () => [
    ...record.tools.keys(),
    ...record.contexts.flatMap((c) => (c.tools ?? []).map((t) => t.name)),
  ];
  const named = (kind: string, name: string) => {
    if (!PLUGIN_TOOL_NAME.test(name)) {
      throw new Error(`${kind} "${name}": a name is lower case, digits and "_".`);
    }
  };
  /** A source of one of the plugin's kinds, of the current tenant. */
  const ownSource = async (id: string) => {
    const row = await db.query.spaceSource.findFirst({
      where: and(eq(schema.spaceSource.id, id), eq(schema.spaceSource.plugin, source.id)),
    });
    if (!row) {
      throw Object.assign(new Error("There is no such source."), {
        status: 404,
        code: "not_found",
      });
    }
    return row;
  };
  return {
    plugin: source.manifest,
    resolvePath: (relative) => resolve(source.root, relative),
    config: { get: (key) => process.env[key]?.trim() || undefined },
    features: {
      // A short name is the plugin's own switch; a dotted or core name is taken as it is.
      has: async (name) => {
        const all = await currentFeatures();
        const own = `${source.id}.${name}`;
        return (own in all ? all[own] : all[name]) === true;
      },
      all: currentFeatures,
    },
    log: {
      info: (...args) => console.log(tag, ...args),
      warn: (...args) => console.warn(tag, ...args),
      error: (...args) => console.error(tag, ...args),
    },
    server: {
      registerHttpRoute(route) {
        record.routes.push(compileRoute(route));
      },
      registerTool(tool) {
        named("Tool", tool.name);
        if (stepToolNames().includes(tool.name)) {
          throw new Error(`Tool "${tool.name}" is registered twice.`);
        }
        record.tools.set(tool.name, tool as unknown as PluginTool);
      },
      registerSpaceContext(context) {
        const names = (context.tools ?? []).map((t) => t.name);
        for (const name of names) {
          named("Tool", name);
          if (stepToolNames().includes(name) || names.indexOf(name) !== names.lastIndexOf(name)) {
            throw new Error(`Tool "${name}" is registered twice.`);
          }
        }
        record.contexts.push(context);
      },
      registerAssistantTool(tool) {
        named("Assistant tool", tool.name);
        if (record.assistantTools.has(tool.name)) {
          throw new Error(`Assistant tool "${tool.name}" is registered twice.`);
        }
        record.assistantTools.set(tool.name, tool as unknown as PluginAssistantTool);
      },
      registerAssistantContext(context) {
        record.assistantPages.push(context);
      },
      registerPublicRoute(route) {
        record.publicRoutes.push(compileRoute(route));
      },
      registerRunner(runner) {
        const info = runnerInfoSchema.parse({ ...runner, plugin: source.id });
        if (record.runners.has(info.id) || RESERVED_RUNNER_IDS.has(info.id)) {
          throw new Error(`Runner "${info.id}" is taken.`);
        }
        if (info.kind === "page" && typeof runner.page !== "function") {
          throw new Error(`Runner "${info.id}": a page runner needs a page.`);
        }
        record.runners.set(info.id, {
          info,
          page: runner.page,
          problem: runner.problem,
          address: runner.address,
        });
      },
      publicUrl: (path) => publicUrlOf(source.id, path),
      publicRef: () => publicRefOf(source.id),
      registerSharedRoute(route) {
        record.sharedRoutes.push(compileRoute(route));
      },
      sharedUrl: (path) => sharedUrlOf(source.id, path),
      channels: channelsApi,
      claims: claimsApiFor(source.id),
      runs: runsApiFor(source.id),
      speech: {
        async conversation() {
          const access = await conversationAccess().catch((err: unknown) => {
            throw err instanceof ModelUnavailableError
              ? Object.assign(err, { name: "ModelUnavailableError", status: 503, code: "no_model" })
              : err;
          });
          return { provider: "openai" as const, ...access };
        },
      },
      every(name, everyMs, handler) {
        named("Job", name);
        if (record.jobs.has(name)) {
          throw new Error(`Job "${name}" is registered twice.`);
        }
        record.jobs.set(name, { everyMs: Math.max(MIN_EVERY_MS, everyMs), handler });
      },
      index: {
        put: (entry) => putIndexEntry(source.id, entry),
        remove: (space, key) => removeIndexEntries(source.id, space, key),
      },
      spaceData: originData(source.id),
      registerKnowledgeSource(kind) {
        if (!/^[a-z0-9-]{1,24}$/.test(kind.kind)) {
          throw new Error(`Source "${kind.kind}": a kind is lower case, digits and "-".`);
        }
        const taken = loadedPlugins().some(
          (p) => p.source.id !== source.id && p.knowledgeSources.has(kind.kind),
        );
        if (taken || isCoreKind(kind.kind) || record.knowledgeSources.has(kind.kind)) {
          throw new Error(`Source "${kind.kind}" is taken.`);
        }
        record.knowledgeSources.set(kind.kind, kind);
        // Its sources are read again on their schedule, in every tenant that has the plugin.
        if (!record.jobs.has(SOURCES_JOB)) {
          record.jobs.set(SOURCES_JOB, {
            everyMs: 15 * 60_000,
            handler: () => runDueSources(source.id),
          });
        }
      },
      knowledgeSources: {
        async list(space) {
          const rows = await db.query.spaceSource.findMany({
            where: and(
              eq(schema.spaceSource.plugin, source.id),
              space ? eq(schema.spaceSource.spaceId, space) : undefined,
            ),
          });
          return Promise.all(rows.map(sourceView));
        },
        async byToken(token) {
          const row = await db.query.spaceSource.findFirst({
            where: and(
              eq(schema.spaceSource.plugin, source.id),
              eq(schema.spaceSource.token, token),
            ),
          });
          return row ? sourceView(row) : null;
        },
        async run(id) {
          const row = await ownSource(id);
          if (row.state === "taken") {
            startSource(row.id);
          }
        },
        async addEntries(id, addresses) {
          const row = await ownSource(id);
          await addSourceEntries(row.spaceId, row.id, addresses);
        },
      },
      spaces: {
        async brand(space) {
          const p = await db.query.space.findFirst({ where: eq(schema.space.id, space) });
          return p
            ? {
                name: p.brand.name ?? "",
                colors: (p.brand.colors ?? []).map(({ name, value }) => ({ name, value })),
                fonts: (p.brand.fonts ?? []).map(({ family, role, weights }) => ({
                  family,
                  role,
                  weights,
                })),
              }
            : null;
        },
      },
      web: {
        fetch: (url, init) => safeFetch(url, init),
        read: (url, options) => readPage(url, options?.signal),
      },
      documents: {
        async parse(file, options) {
          const parsed = await parseDocument(file, { signal: options?.signal });
          return { markdown: parsed.markdown, pages: parsed.pages };
        },
      },
      registerMigrations(folder) {
        record.migrations.push(resolve(source.root, folder));
      },
      on(event, listener) {
        const listeners = (record.listeners[event] ?? []) as (typeof listener)[];
        listeners.push(listener);
        record.listeners[event] = listeners as LoadedPlugin["listeners"][typeof event];
      },
      getTenantDb: () => db as unknown as PluginDb,
      async generate(request) {
        const resolved = await textModel(request.model ?? "low").catch((err: unknown) => {
          // Said so a route can pass it on as it is: 503 with the code `no_model`.
          throw err instanceof ModelUnavailableError
            ? Object.assign(err, { name: "ModelUnavailableError", status: 503, code: "no_model" })
            : err;
        });
        const files = request.files ?? [];
        const result = await generateText({
          model: resolved.model,
          system: request.system,
          // Pictures and PDFs go with the prompt as parts of one message.
          ...(files.length
            ? {
                messages: [
                  {
                    role: "user" as const,
                    content: [
                      ...files.map((f) => ({
                        type: "file" as const,
                        data: f.data,
                        mediaType: f.mediaType,
                        ...(f.name ? { filename: f.name } : {}),
                      })),
                      { type: "text" as const, text: request.prompt },
                    ],
                  },
                ],
              }
            : { prompt: request.prompt }),
          maxOutputTokens: request.maxOutputTokens,
          abortSignal: request.signal ?? AbortSignal.timeout(120_000),
          ...(request.schema ? { output: Output.object({ schema: request.schema }) } : {}),
        });
        return {
          text: result.text,
          object: (request.schema ? result.output : undefined) as never,
        };
      },
      connections: pluginConnections(source.id),
      secrets: { seal, unseal },
      registerStarter(starter) {
        if (!PLUGIN_ID.test(starter.id)) {
          throw new Error(`Starter "${starter.id}": an id is lower case, digits and "-".`);
        }
        if (record.starters.has(starter.id)) {
          throw new Error(`Starter "${starter.id}" is registered twice.`);
        }
        const parsed = wizardSchema.safeParse(starter.definition);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          throw new Error(
            `Starter "${starter.id}": ${issue?.path.join(".") || "definition"}: ${issue?.message}`,
          );
        }
        record.starters.set(starter.id, { ...starter, definition: parsed.data });
      },
      onUnload(dispose) {
        record.disposers.push(dispose);
      },
    },
  };
}

/** Runs what the plugin asked to have undone, the last first. */
async function dispose(record: LoadedPlugin) {
  // Its jobs are told to stop; the runtime stops starting them with the record gone.
  record.stopped.abort();
  for (const undo of record.disposers.splice(0).reverse()) {
    try {
      await undo();
    } catch (err) {
      console.error(`[plugins] ${record.source.id}: undoing failed:`, err);
    }
  }
}

async function load(source: PluginSource): Promise<LoadedPlugin> {
  const record = emptyRecord(source);
  if (source.entry) {
    try {
      const factory = await importFactory(source.entry);
      await factory(apiFor(record));
    } catch (err) {
      // Half a plugin is worse than none: what it registered before it failed goes as well.
      await dispose(record);
      record.routes = [];
      record.tools.clear();
      record.contexts = [];
      record.assistantTools.clear();
      record.assistantPages = [];
      record.publicRoutes = [];
      record.sharedRoutes = [];
      record.runners.clear();
      record.jobs.clear();
      record.starters.clear();
      record.listeners = {};
      record.migrations = [];
      record.error = (err as Error)?.message || String(err);
      console.error(`[plugins] ${source.id} did not load:`, err);
    }
  }
  setPlugin(record);
  return record;
}

async function unload(id: string) {
  const record = dropPlugin(id);
  if (record) {
    await dispose(record);
  }
}

let problems: PluginProblem[] = [];

/** Files and folders that look like a plugin and are none, as of the last look. */
export function pluginProblems(): PluginProblem[] {
  return problems;
}

function discover(): PluginSource[] {
  const result = discoverPlugins(pluginDirs());
  // Pro modules come last and only while the plan has them (pro-state.ts).
  const pro = managed ? null : discoverPlugins([proModulesDir()]);
  const allowed = pro
    ? proSources(pro.found, new Set(result.found.map((s) => s.id)))
    : { load: [], problems: [] };
  problems = [...result.problems, ...(pro?.problems ?? []), ...allowed.problems];
  for (const problem of problems) {
    console.error(`[plugins] ${problem.path}: ${problem.message}`);
  }
  lastFound = [...result.found, ...allowed.load];
  return lastFound.filter((source) => !off.has(source.id));
}

/** One load at a time: the watcher and a person may ask for a reload at the same moment. */
let queue: Promise<unknown> = Promise.resolve();
function inTurn<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.catch(() => undefined).then(work);
  queue = next;
  return next;
}

let hooked = false;

/** At start: finds the plugins and loads each. Must run before a tenant database opens. */
export function loadPlugins(): Promise<void> {
  return inTurn(async () => {
    if (!hooked) {
      hooked = true;
      // A plugin whose tables cannot be made must not keep the tenant's database from opening.
      onTenantOpen((tenantId, client) =>
        migratePlugins(tenantId, client).catch((err) =>
          console.error(`[plugins] tables for tenant ${tenantId}:`, (err as Error).message),
        ),
      );
    }
    off = new Set((await readSetting<string[]>(OFF)) ?? []);
    const found = discover();
    for (const source of found) {
      await load(source);
    }
    if (found.length) {
      console.log(`plugins: ${found.map((s) => s.id).join(", ")}`);
    }
    await migrateOpenTenants();
    if (env.plugins.watch) {
      watchPlugins();
    }
  });
}

/** Loads one plugin again from its files; a plugin whose files are gone unloads. */
export function reloadPlugin(id: string): Promise<LoadedPlugin | null> {
  return inTurn(async () => {
    const found = discover();
    const source = found.find((s) => s.id === id);
    await unload(id);
    const record = source ? await load(source) : null;
    // Its manifest may name another id now: under the old one it is gone, under the new one new.
    await loadMissing(found);
    await migrateOpenTenants();
    announceChange({ id });
    return record;
  });
}

/** Loads what was found and is not loaded yet. */
async function loadMissing(found: PluginSource[]): Promise<boolean> {
  const missing = found.filter((source) => !loadedPlugin(source.id));
  for (const source of missing) {
    await load(source);
  }
  return missing.length > 0;
}

/**
 * Looks again and leaves what is loaded alone: plugins that are new load, plugins whose files
 * went unload.
 */
export function findNewPlugins(): Promise<void> {
  return inTurn(async () => {
    const found = discover();
    const gone = loadedPlugins().filter((p) => !found.some((s) => s.id === p.source.id));
    for (const plugin of gone) {
      await unload(plugin.source.id);
    }
    if ((await loadMissing(found)) || gone.length) {
      await migrateOpenTenants();
      announceChange({ id: null });
    }
  });
}

/** Loads every plugin anew, new ones included, and unloads what is gone. */
export function rescanPlugins(): Promise<void> {
  return inTurn(async () => {
    const found = discover();
    for (const loaded of loadedPlugins()) {
      await unload(loaded.source.id);
    }
    for (const source of found) {
      await load(source);
    }
    await migrateOpenTenants();
    announceChange({ id: null });
  });
}

/** The studio half was built again: the server half stays as it is, the studio fetches the files. */
function refreshStudioHalf(id: string): Promise<void> {
  return inTurn(async () => {
    const record = loadedPlugin(id);
    const source = discover().find((s) => s.id === id);
    if (record && source) {
      record.source = { ...record.source, studio: source.studio, styles: source.styles };
      announceChange({ id });
    }
  });
}

const watchers: FSWatcher[] = [];

/**
 * Reloads a plugin when one of its files changes. `ui/` is left alone: it only counts once it
 * is built, and a change below `dist/` is that build.
 */
function watchPlugins() {
  for (const watcher of watchers.splice(0)) {
    watcher.close();
  }
  const timers = new Map<string, NodeJS.Timeout>();
  const soon = (key: string, run: () => Promise<unknown>) => {
    clearTimeout(timers.get(key));
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        run().catch((err) => console.error("[plugins]", err));
      }, 150),
    );
  };
  for (const dir of pluginDirs()) {
    // A folder of this install's own plugins is made, so the first plugin put there is seen.
    if (env.plugins.dirs.includes(dir)) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch {
        // a place that cannot be written to
      }
    }
    if (!existsSync(dir)) {
      continue;
    }
    const watcher = watch(dir, { recursive: true }, (_event, file) => {
      const parts = file?.toString().split(sep) ?? [];
      if (!parts.length || parts.includes("node_modules") || parts.some((p) => p.startsWith("."))) {
        return;
      }
      const top = join(dir, parts[0]);
      const plugin = loadedPlugins().find((p) =>
        p.source.single ? p.source.entry === top : p.source.root === top,
      );
      const { id, entry } = plugin?.source ?? {};
      if (!id) {
        // A plugin that is new here, or what is left of one that went. The others stay loaded.
        soon("*", findNewPlugins);
      } else if (parts[1] === "dist" && !entry?.startsWith(join(top, "dist") + sep)) {
        soon(`${id}/studio`, () => refreshStudioHalf(id));
      } else if (parts[1] !== "ui") {
        soon(id, () => reloadPlugin(id));
      }
    });
    watcher.unref();
    watchers.push(watcher);
  }
}
