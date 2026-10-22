import { WIZARD_SCHEMA_URL } from "@engenty/wizards-shared/wizard-package";
import { prompt } from "../prompts.js";
import { sandboxGuideLine } from "../sandbox/index.js";
import { EXAMPLE_WIZARD } from "./example.js";

/**
 * How a wizard is written down and what makes a good one (prompts/authoring.md). The studio's
 * architect and the MCP tools hand the same text to whichever model authors the wizard.
 */
export function schemaDoc(): string {
  return `\n${prompt("authoring", "schema")}`;
}

export function principles(): string {
  return `\n${prompt("authoring", "principles", { sandbox: sandboxGuideLine() })}`;
}

export function widgetGuide(): string {
  return `\n${prompt("authoring", "widgets")}`;
}

/** What a model needs to compose a surface: the catalog, briefly. */
export function surfaceGuide(): string {
  return prompt("authoring", "surfaces");
}

export interface GuideServer {
  id: string;
  name: string;
}

export interface GuideConnector {
  id: string;
  name: string;
  toolPrefix: string;
  /** Whether people can connect an account on this server right now. */
  usable: boolean;
  actions: { id: string; group: string }[];
}

export function connectorsLine(connectors: GuideConnector[]): string {
  const lines = connectors.map((c) => {
    const actions = c.actions
      .slice(0, 40)
      .map((a) => `${a.id}${a.group === "read" ? "" : ` (${a.group})`}`)
      .join(", ");
    const more = c.actions.length > 40 ? `, … ${c.actions.length - 40} more (list_connectors)` : "";
    const state = c.usable ? "" : ` — ${prompt("authoring", "line.connectors.not_set_up")}`;
    return `- ${c.id} — ${c.name}${state}, tools ${c.toolPrefix}_*: ${actions || prompt("authoring", "line.connectors.no_actions")}${more}`;
  });
  return prompt("authoring", "line.connectors", { connectors: lines.join("\n") });
}

export interface GuideTool {
  /** `<plugin>.<tool>`, as a step lists it. */
  id: string;
  description: string;
}

/** The tools this app's plugins add; nothing where there are none. */
export function pluginToolsLine(tools: GuideTool[]): string {
  if (!tools.length) {
    return "";
  }
  const lines = tools.map((t) => `- ${t.id} — ${t.description}`);
  return `\n\n${prompt("authoring", "line.plugin_tools", { tools: lines.join("\n") })}`;
}

export function mcpServersLine(mcp: GuideServer[]): string {
  const servers = mcp.length
    ? mcp.map((m) => `${m.id} (${m.name})`).join(", ")
    : prompt("authoring", "line.mcp_servers.none");
  return prompt("authoring", "line.mcp_servers", { servers });
}

export function exampleWizard(): string {
  return JSON.stringify(EXAMPLE_WIZARD, null, 2);
}

/** The guide an MCP client reads before it writes a wizard. */
export function authoringGuide(
  mcp: GuideServer[],
  connectors: GuideConnector[] = [],
  pluginTools: GuideTool[] = [],
): string {
  return prompt("authoring", "guide", {
    schema: schemaDoc(),
    principles: principles(),
    widgets: widgetGuide(),
    surfaces: surfaceGuide(),
    mcp_servers: mcpServersLine(mcp),
    connectors: connectorsLine(connectors),
    plugin_tools: pluginToolsLine(pluginTools),
    schema_url: WIZARD_SCHEMA_URL,
    example: exampleWizard(),
  });
}
