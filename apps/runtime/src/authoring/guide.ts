import { WIZARD_SCHEMA_URL } from "@engenty/wizards-shared/wizard-package";
import { MAIL_CONNECTORS, missingSetup, usable } from "../connectors/builtin.js";
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
  /** What the server's owner has to set before it connects; null where nothing is known. */
  missingSetup: string | null;
  actions: { id: string; group: string }[];
}

/** After a connector that can't connect here: that it can't, and what the server's owner sets. */
function notSetUp(c: { usable: boolean; missingSetup: string | null }): string {
  if (c.usable) {
    return "";
  }
  const settings = c.missingSetup
    ? ` ${prompt("authoring", "line.connectors.settings", { settings: c.missingSetup })}`
    : "";
  return ` — ${prompt("authoring", "line.connectors.not_set_up")}${settings}`;
}

function connectorsLine(connectors: GuideConnector[]): string {
  const lines = connectors.map((c) => {
    const actions = c.actions
      .slice(0, 40)
      .map((a) => `${a.id}${a.group === "read" ? "" : ` (${a.group})`}`)
      .join(", ");
    const more = c.actions.length > 40 ? `, … ${c.actions.length - 40} more (list_connectors)` : "";
    return `- ${c.id} — ${c.name}${notSetUp(c)}, tools ${c.toolPrefix}_*: ${actions || prompt("authoring", "line.connectors.no_actions")}${more}`;
  });
  return prompt("authoring", "line.connectors", { connectors: lines.join("\n") });
}

/** A connector behind a connection of kind "mail", and whether it connects here. */
export interface GuideMail {
  name: string;
  usable: boolean;
  missingSetup: string | null;
}

/** The connectors behind kind "mail" on this server, each with whether it connects. */
export async function guideMail(): Promise<GuideMail[]> {
  return Promise.all(
    MAIL_CONNECTORS.map(async (c) => {
      const ready = await usable(c);
      return { name: c.name, usable: ready, missingSetup: ready ? null : missingSetup(c) };
    }),
  );
}

/** How kind "mail" connects here: one line per connector. */
function mailLine(mail: GuideMail[]): string {
  if (!mail.length) {
    return "";
  }
  const lines = mail.map((c) => `- ${c.name}${notSetUp(c)}`);
  return prompt("authoring", "line.connectors.mail", { connectors: lines.join("\n") });
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

/**
 * What the space offers agent steps: its connectors, how kind "mail" connects here, its
 * connections and plugin tools.
 */
export function spaceLines(
  connectors: GuideConnector[],
  mail: GuideMail[],
  pluginTools: GuideTool[],
  connections: GuideSpaceConnection[] = [],
): string {
  return [
    connectorsLine(connectors),
    mailLine(mail),
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
  mail: GuideMail[] = [],
  pluginTools: GuideTool[] = [],
  connections: GuideSpaceConnection[] = [],
  /** Switches whose part of the format is in the guide only while a run can do it. */
  on: { durableRuns?: boolean; codeSteps?: boolean } = {},
): string {
  return prompt("authoring", "guide", {
    schema: prompt("authoring", "schema"),
    durable: on.durableRuns ? prompt("authoring", "durable") : "",
    code: on.codeSteps ? prompt("authoring", "code") : "",
    principles: prompt("authoring", "principles", { sandbox: sandboxGuideLine() }),
    widgets: prompt("authoring", "widgets"),
    surfaces: prompt("authoring", "surfaces"),
    space_tools: spaceLines(connectors, mail, pluginTools, connections),
    schema_url: WIZARD_SCHEMA_URL,
    example: exampleWizard(),
  });
}
