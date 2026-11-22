import type { z } from "zod";
import type { PluginManifest } from "./manifest.js";

/**
 * What every host gives a tool when it runs. A host may give more (engenty wizards: the run and
 * the step); a tool that needs only this runs in every host.
 */
export interface PluginToolContext {
  /** Aborted when the person stops what the tool is part of. */
  signal: AbortSignal;
  /** One line for the person: what the tool is doing. */
  emit(message: string): void | Promise<void>;
}

/** A JSON Schema of a tool's input, for a plugin that does not use zod. */
export type JsonSchema = Record<string, unknown>;

export interface PluginTool<
  S extends z.ZodType | JsonSchema = z.ZodType,
  C extends PluginToolContext = PluginToolContext,
> {
  /** Lower case, digits and `_`, at most 40 characters. */
  name: string;
  /** What a person sees it called. */
  title?: string;
  /** For the model: what it does and when to use it. */
  description: string;
  /** A zod schema, or a JSON Schema of an object. */
  inputSchema: S;
  /**
   * The tool only reads: it changes nothing anywhere. A host asks the person before every
   * other tool runs; leave it out when in doubt.
   */
  readOnly?: boolean;
  execute(input: S extends z.ZodType ? z.infer<S> : Record<string, unknown>, context: C): unknown;
}

/**
 * What every host offers a plugin's server half. engenty wizards' `WizardsPluginApi` is a
 * superset: a plugin that uses only this loads in both products.
 */
export interface PluginApi {
  plugin: PluginManifest;
  /** A setting the host keeps for the plugin. */
  config: { get(key: string): string | undefined };
  log: {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };
  /** A file of the plugin as an absolute path. */
  resolvePath(relative: string): string;
  server: {
    registerTool(tool: PluginTool<any>): void;
    /** Runs when the plugin unloads or loads again. */
    onUnload(dispose: () => void | Promise<void>): void;
  };
}

export type PluginFactory<A extends PluginApi = PluginApi> = (api: A) => void | Promise<void>;

/** Types the factory; it does nothing else. */
export function definePlugin<A extends PluginApi = PluginApi>(
  factory: PluginFactory<A>,
): PluginFactory<A> {
  return factory;
}

/** A tool as the process host reports it: its input as JSON Schema. */
export interface PluginToolInfo {
  name: string;
  title?: string;
  description: string;
  inputSchema: JsonSchema;
  readOnly: boolean;
}
