import { WIZARD_SCHEMA_URL } from "@engenty/wizards-shared/wizard-package";
import { prompt } from "../prompts.js";
import { sandboxGuideLine } from "../sandbox/index.js";
import { EXAMPLE_WIZARD } from "./example.js";

/**
 * How a wizard is written down and what makes a good one (prompts/authoring.md). The studio's
 * architect and the MCP tools hand the same text to whichever model authors the wizard.
 */

export interface GuideConnector {
  id: string;
  name: string;
  toolPrefix: string;
  /** Whether people can connect an account on this server right now. */
  usable: boolean;
  actions: { id: string; group: string }[];
}

function connectorsLine(connectors: GuideConnector[]): string {
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

/** A connection of the space, as the guide lists it. */
export interface GuideSpaceConnection {
  id: string;
  name: string;
  connector: string;
  signIn: "space" | "person";
  /** The connector's actions it is for; empty: every action. */
  actions: { id: string; group: string }[];
}

function spaceConnectionsLine(connections: GuideSpaceConnection[]): string {
  if (!connections.length) {
    return "";
  }
  const lines = connections.map((c) => {
    const actions = c.actions
      .slice(0, 40)
      .map((a) => `${a.id}${a.group === "read" ? "" : ` (${a.group})`}`)
      .join(", ");
    const who = c.signIn === "space" ? "signs in as the space" : "each person signs in";
    return `- ${c.id} — ${c.name} (${c.connector}), ${who}, actions: ${actions || prompt("authoring", "line.connectors.no_actions")}`;
  });
  return prompt("authoring", "line.space_connections", { connections: lines.join("\n") });
}

export interface GuideTool {
  /** `<plugin>.<tool>`, as a step lists it. */
  id: string;
  description: string;
}

/** The tools this app's plugins add; nothing where there are none. */
function pluginToolsLine(tools: GuideTool[]): string {
  if (!tools.length) {
    return "";
  }
  const lines = tools.map((t) => `- ${t.id} — ${t.description}`);
  return prompt("authoring", "line.plugin_tools", { tools: lines.join("\n") });
}

/** What the space offers agent steps: its connectors, its connections and plugin tools. */
export function spaceLines(
  connectors: GuideConnector[],
  pluginTools: GuideTool[],
  connections: GuideSpaceConnection[] = [],
): string {
  return [
    connectorsLine(connectors),
    spaceConnectionsLine(connections),
    pluginToolsLine(pluginTools),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function exampleWizard(): string {
  return JSON.stringify(EXAMPLE_WIZARD, null, 2);
}

/** The guide an MCP client reads before it writes a wizard. */
export function authoringGuide(
  connectors: GuideConnector[] = [],
  pluginTools: GuideTool[] = [],
  connections: GuideSpaceConnection[] = [],
): string {
  return prompt("authoring", "guide", {
    schema: prompt("authoring", "schema"),
    principles: prompt("authoring", "principles", { sandbox: sandboxGuideLine() }),
    widgets: prompt("authoring", "widgets"),
    surfaces: prompt("authoring", "surfaces"),
    space_tools: spaceLines(connectors, pluginTools, connections),
    schema_url: WIZARD_SCHEMA_URL,
    example: exampleWizard(),
  });
}
