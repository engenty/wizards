import { createTool } from "@mastra/core/tools";
import type { z } from "zod";
import {
  type ActionKind,
  type BrokerContext,
  type BrokerResult,
  brokerCall,
  inAudience,
  kindOf,
  type Refusal,
  reachesOutside,
  type Where,
  type Who,
} from "../broker/index.js";
import { resolveConnector } from "../connectors/external.js";
import type { SpaceConnectionRow } from "../connectors/space-connections.js";
import type { ConnectorAction, ConnectorDefinition } from "../engenty/connections-sdk/types.js";
import { prompt } from "../prompts.js";
import type { AssistantToolLabel } from "./plugin.js";
import { attempt, clip } from "./shared.js";

/*
 * The connections of a space as tools of a chat (docs/plans/capabilities.md, A7): a Work chat's
 * AI and Goose. Each action of a connection the caller may use becomes one tool. A read runs
 * through the broker at once; a write, a send or a delete is a confirmed action: the AI fills in
 * its fields, and what happens then is the chat's (`write`): a Work chat holds the call for the
 * person, Goose asks its person. Steps take their tools from `connector.ts`.
 */

/** A connection with its connector and the actions the caller may use through it. */
export interface UsableConnection {
  row: SpaceConnectionRow;
  connector: ConnectorDefinition;
  actions: ConnectorAction[];
}

/** One action of one connection, as the chat's tools name it. */
export interface ConnectionTool {
  name: string;
  row: SpaceConnectionRow;
  connector: ConnectorDefinition;
  action: ConnectorAction;
  kind: ActionKind;
}

/** How the chat runs a confirmed action, once the AI has filled in its fields. */
export type WriteRunner = (tool: ConnectionTool, input: unknown) => Promise<unknown>;

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/** A tool's name: the connector's prefix, the connection (two of one service in a space are two), the action. */
export const connectionToolName = (
  connector: Pick<ConnectorDefinition, "toolPrefix">,
  row: Pick<SpaceConnectionRow, "id">,
  actionId: string,
) => `${connector.toolPrefix}_${row.id}_${actionId}`;

/**
 * The connections among `rows` this caller may use: in their audience, with their connector, and
 * the actions each is for (every action of the connector where the row names none). A connection
 * whose connector is gone is left out.
 */
export async function usableConnections(
  rows: SpaceConnectionRow[],
  who: Who,
): Promise<UsableConnection[]> {
  const usable: UsableConnection[] = [];
  for (const row of rows) {
    if (!inAudience(row.audience, who)) {
      continue;
    }
    const found = await resolveConnector(row.spaceId, row.connectorId);
    if (!found) {
      continue;
    }
    const actions = found.connector.actions.filter(
      (a) => !row.actions.length || row.actions.includes(a.id),
    );
    usable.push({ row, connector: found.connector, actions });
  }
  return usable;
}

/** The connections' actions as the chat's tools, by name; one whose name no model takes is left out. */
export function connectionToolsOf(connections: UsableConnection[]): ConnectionTool[] {
  const tools: ConnectionTool[] = [];
  for (const { row, connector, actions } of connections) {
    for (const action of actions) {
      const name = connectionToolName(connector, row, action.id);
      if (TOOL_NAME.test(name)) {
        const kind = kindOf(action.group);
        reachesOutside(name, { connection: row.id, action: action.id, kind });
        tools.push({ name, row, connector, action, kind });
      }
    }
  }
  return tools;
}

/** What the model reads when the broker refuses a call. */
export function connectionRefusalNote(refused: Refusal, service: string): string {
  switch (refused) {
    case "not_connected":
      return prompt("tools", "note.connector_not_connected", { service });
    case "nobody":
      return prompt("tools", "note.connection_nobody");
    case "declined":
      return prompt("tools", "note.connector_declined");
    case "needs_approval":
      return prompt("tools", "note.connector_needs_approval", { service });
    default:
      return prompt("tools", "note.connector_refused", { service });
  }
}

/** The tool's answer to the model: the action's result as text, or why nothing ran. */
export function connectionResult(out: BrokerResult<unknown>, service: string) {
  if (!out.ok) {
    return { error: connectionRefusalNote(out.refused, service) };
  }
  const text = typeof out.result === "string" ? out.result : JSON.stringify(out.result);
  return { result: clip(text ?? "", 8000) };
}

/** One action, called through the broker as this caller. */
export function callConnection(
  tool: ConnectionTool,
  who: Who,
  where: Where,
  input: unknown,
  ctx?: BrokerContext,
) {
  return brokerCall({
    who,
    where,
    connection: { kind: "space_connection", row: tool.row, connector: tool.connector },
    action: { id: tool.action.id, kind: tool.kind },
    input: input ?? {},
    ctx,
  });
}

/** A text that ends as a sentence, so the notes after it read as their own. */
const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

/**
 * The tools: reads call the broker as `who`; a write, a send or a delete is a confirmed action
 * (`writeNote` says so to the model) that `write` runs. `labels` says how the chat names each
 * tool: the connection, then the action.
 */
export function makeConnectionTools(options: {
  tools: ConnectionTool[];
  who: Who;
  where: (tool: ConnectionTool) => Where;
  write: WriteRunner;
  /** What the model reads about a confirmed action, after what the action does. */
  writeNote: (tool: ConnectionTool) => string;
}): {
  tools: Record<string, unknown>;
  writes: Set<string>;
  labels: Record<string, AssistantToolLabel>;
} {
  const tools: Record<string, unknown> = {};
  const writes = new Set<string>();
  const labels: Record<string, AssistantToolLabel> = {};
  for (const tool of options.tools) {
    const { row, connector, action, name } = tool;
    const service = `${row.name} (${connector.name})`;
    const does = sentence(`${service}: ${action.description || action.summary}`);
    const read = tool.kind === "read";
    tools[name] = createTool({
      id: name,
      description: [does, read ? "" : options.writeNote(tool)]
        .filter(Boolean)
        .join(" ")
        .slice(0, 1100),
      inputSchema: action.inputSchema as z.ZodType<any>,
      // A read's failure is the model's to hear; what a confirmed action throws is the chat's.
      execute: (input) =>
        read
          ? attempt(async () =>
              connectionResult(
                await callConnection(tool, options.who, options.where(tool), input),
                service,
              ),
            )
          : options.write(tool, input),
    });
    if (!read) {
      writes.add(name);
    }
    labels[name] = { plugin: row.name, tool: action.summary || action.id, label: null };
  }
  return { tools, writes, labels };
}
