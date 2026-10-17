import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import type {
  PluginAssistantPage,
  PluginAssistantTool,
  PluginEvents,
  PluginPublicRoute,
  PluginRoute,
  PluginRunner,
  PluginSharedRoute,
  PluginSpaceContext,
  PluginStarter,
  PluginTick,
  PluginTool,
} from "@engenty/wizards/plugin";
import type { RunnerInfo } from "@engenty-wizards/shared/runners";
import { env } from "../env.js";
import { managed, tenantInfo } from "../manage.js";
import type { PluginSource } from "./discovery.js";

/**
 * What the loaded plugins added. Everything a plugin registers is kept on its own record, so
 * unloading one is dropping that record and running what it asked to have undone.
 */

type Listener<E extends keyof PluginEvents> = (payload: PluginEvents[E]) => void | Promise<void>;

export interface RouteEntry<R> {
  route: R;
  /** Matches the address below the plugin's own; the groups are the `:name` parts in order. */
  pattern: RegExp;
  params: string[];
}
export type PluginRouteEntry = RouteEntry<PluginRoute>;

/** A runner a plugin registered: its description for the registry, and its page where it has one. */
export interface RegisteredRunner {
  info: RunnerInfo;
  page?: PluginRunner["page"];
  /** Why the runner cannot be used in the current tenant right now; asked where it is listed. */
  problem?: PluginRunner["problem"];
  /** Where a person reaches a wizard through it: the number, the keyword, the link. */
  address?: PluginRunner["address"];
}

/** A job of `server.every`. */
export interface PluginJob {
  everyMs: number;
  handler: (tick: PluginTick) => void | Promise<void>;
}

export interface LoadedPlugin {
  source: PluginSource;
  /** Counts every load of any plugin: a reload gives the plugin a higher one. */
  generation: number;
  /** Why the server half did not load. The plugin then adds nothing on the server. */
  error: string | null;
  routes: PluginRouteEntry[];
  tools: Map<string, PluginTool>;
  /** Blocks and tools for every agent step of a space's wizards. */
  contexts: PluginSpaceContext[];
  /** Tools of the space assistant, by name. */
  assistantTools: Map<string, PluginAssistantTool>;
  /** What the space assistant is told on the plugin's own page. */
  assistantPages: PluginAssistantPage[];
  publicRoutes: RouteEntry<PluginPublicRoute>[];
  /** Routes for every tenant at once, below `/api/public/plugins/<id>/shared`. */
  sharedRoutes: RouteEntry<PluginSharedRoute>[];
  /** The runners the plugin adds, by id: what `/w/<token>/<id>` serves, and what it can do. */
  runners: Map<string, RegisteredRunner>;
  jobs: Map<string, PluginJob>;
  /** Wizards it brings as templates, by their id within the plugin. */
  starters: Map<string, PluginStarter>;
  listeners: { [E in keyof PluginEvents]?: Listener<E>[] };
  /** Folders of `.sql` files for the tenant databases. */
  migrations: string[];
  disposers: (() => void | Promise<void>)[];
  /** Aborted when the plugin unloads: what its jobs are handed. */
  stopped: AbortController;
}

const plugins = new Map<string, LoadedPlugin>();
let generations = 0;

export function nextGeneration(): number {
  return ++generations;
}

export function emptyRecord(source: PluginSource): LoadedPlugin {
  return {
    source,
    generation: nextGeneration(),
    error: null,
    routes: [],
    tools: new Map(),
    contexts: [],
    assistantTools: new Map(),
    assistantPages: [],
    publicRoutes: [],
    sharedRoutes: [],
    runners: new Map(),
    jobs: new Map(),
    starters: new Map(),
    listeners: {},
    migrations: [],
    disposers: [],
    stopped: new AbortController(),
  };
}

export function setPlugin(record: LoadedPlugin) {
  plugins.set(record.source.id, record);
}

export function dropPlugin(id: string): LoadedPlugin | undefined {
  const record = plugins.get(id);
  plugins.delete(id);
  return record;
}

export function loadedPlugin(id: string): LoadedPlugin | undefined {
  return plugins.get(id);
}

export function loadedPlugins(): LoadedPlugin[] {
  return [...plugins.values()];
}

/** `/items/:id` as a pattern for the address below the plugin's own. */
export function compileRoute<R extends { path: string }>(route: R): RouteEntry<R> {
  const params: string[] = [];
  const path = route.path.startsWith("/") ? route.path : `/${route.path}`;
  const source = path
    .replace(/\/+$/, "")
    .split("/")
    .map((part) => {
      if (part.startsWith(":")) {
        params.push(part.slice(1));
        return "([^/]+)";
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { route, pattern: new RegExp(`^${source}/?$`), params };
}

// --- which tenant has which plugin -----------------------------------------------------

/**
 * The ids of the plugins a tenant has. A runtime that runs alone has every plugin it loaded.
 * Managed, a tenant has the ones in `PLUGINS_DEFAULT` and the ones the Manage-App lists for it
 * (`modules` of `GET /v1/tenants/:id`).
 */
export async function pluginIdsOf(tenantId: string): Promise<Set<string>> {
  if (!managed) {
    return new Set(plugins.keys());
  }
  const listed = await tenantInfo(tenantId)
    .then((info) => info.modules ?? [])
    .catch(() => []);
  return new Set([...env.plugins.defaults, ...listed].filter((id) => plugins.has(id)));
}

export async function pluginsOf(tenantId: string): Promise<LoadedPlugin[]> {
  const ids = await pluginIdsOf(tenantId);
  return loadedPlugins().filter((p) => ids.has(p.source.id));
}

/** The tools the tenant's plugins add, by the id a step lists them under. */
export async function pluginToolsOf(
  tenantId: string,
): Promise<{ id: string; title: string; description: string }[]> {
  return (await pluginsOf(tenantId)).flatMap((plugin) =>
    [...plugin.tools.values()].map((tool) => ({
      id: `${plugin.source.id}.${tool.name}`,
      title: tool.title ?? tool.name,
      description: tool.description,
    })),
  );
}

/** A starter a plugin brings, with the id it is known as: `<plugin id>.<starter id>`. */
export interface PluginStarterEntry {
  id: string;
  plugin: LoadedPlugin;
  starter: PluginStarter;
}

/** The starters the tenant's plugins bring, in the order the plugins registered them. */
export async function pluginStartersOf(tenantId: string): Promise<PluginStarterEntry[]> {
  return (await pluginsOf(tenantId)).flatMap((plugin) =>
    [...plugin.starters.values()].map((starter) => ({
      id: `${plugin.source.id}.${starter.id}`,
      plugin,
      starter,
    })),
  );
}

// --- the studio half -------------------------------------------------------------------

export interface PluginAsset {
  file: string;
  /** Changes with the file's content: the address the studio asks carries it. */
  rev: string;
}

/** The built studio half as it is on disk now; null when the plugin has none. */
export function pluginAsset(record: LoadedPlugin, kind: "studio" | "styles"): PluginAsset | null {
  const file = record.source[kind];
  if (!file) {
    return null;
  }
  try {
    return {
      file,
      rev: createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 12),
    };
  } catch {
    return null;
  }
}

// --- telling the studio ----------------------------------------------------------------

export interface PluginChange {
  /** The plugin that loaded again or went; null: the list of plugins changed. */
  id: string | null;
}

const changes = new EventEmitter();
changes.setMaxListeners(0);

export function announceChange(change: PluginChange) {
  changes.emit("change", change);
}

export function onPluginChange(listener: (change: PluginChange) => void): () => void {
  changes.on("change", listener);
  return () => changes.off("change", listener);
}
