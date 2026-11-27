import { z } from "zod";

/** The file that makes a folder a plugin. */
export const MANIFEST_FILE = "engenty.plugin.json";

/** A plugin's id: lower case, digits and `-`, starting with a letter, at most 40 characters. */
export const PLUGIN_ID = /^[a-z][a-z0-9-]{0,39}$/;

/** A tool's name inside its plugin: lower case, digits and `_`, starting with a letter. */
export const TOOL_NAME = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * What every host reads of `engenty.plugin.json`. Fields a host does not know stay as they are,
 * so each product keeps its own (engenty wizards: `studio`, `styles`, `features`).
 */
export const pluginManifestSchema = z.looseObject({
  id: z.string().regex(PLUGIN_ID),
  name: z.string().min(1),
  version: z.string().default("0.0.0"),
  description: z.string().optional(),
  /** The file that registers tools, from the plugin's folder. */
  server: z.string().optional(),
  /** The folder of skills, each a folder with a `SKILL.md`. Default `skills`. */
  skills: z.string().optional(),
});

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  server?: string;
  skills?: string;
  [field: string]: unknown;
}

/** A tool's id across plugins, as a wizard names it: `<plugin id>.<tool name>`. */
export const toolId = (pluginId: string, tool: string): string => `${pluginId}.${tool}`;

/** The same id as a model reads it: `_` for `.` and `-`. */
export const modelToolName = (pluginId: string, tool: string): string =>
  toolId(pluginId, tool).replace(/[.-]/g, "_");
