import { refreshConnector, resolveConnector } from "../../connectors/external.js";
import type { ConnectorDefinition } from "../../engenty/connections-sdk/types.js";
import { toolsOf } from "../../tools/connector.js";
import { runShareAgent } from "../agent.js";
import { line, ShareError, type ShareTarget } from "../types.js";

const RULES = [
  "You work in the person's account through the service's actions. Look first (search, list) where the result belongs, then write.",
  "Actions that change the account ask the person before they run. When they say no, stop and report it — do not try another way.",
  "To send a file, give `file:<name>` with the file's name as listed, where an action's input asks for `*_base64`.",
].join("\n");

/**
 * The result through any connector that can write: one the product ships, or one the space
 * imported from the integrations registry (Notion, WordPress, an ads account …). The person
 * says in their words what should happen; an agent does it with the connector's actions.
 */
export function connectorTarget(connector: ConnectorDefinition, imported: boolean): ShareTarget {
  const id = `connector:${connector.id}`;
  const connection = (actions: string[]) => ({
    id: `share:${id}`,
    connector: connector.id,
    actions,
    title: connector.name,
  });
  return {
    id,
    name: connector.name,
    description: line("shareConnectorDescription"),
    icon: "plug",
    takes: "files",
    agent: true,
    // What the space imported it wants to use; what ships with the product is named by the wizard.
    byDefault: imported,
    connection: () => connection(connector.actions.map((a) => a.id)),
    fields: [
      {
        id: "instructions",
        kind: "textarea",
        required: true,
        label: line("shareWhatHappens"),
        placeholder: line("shareWhatHappensPlaceholder"),
      },
    ],
    async send(input, ctx) {
      const account = await ctx.account();
      if (!account) {
        throw new ShareError(line("shareConnectFirst", { name: connector.name }));
      }
      // An MCP server that lists its tools only to a signed-in account: ask it now.
      if (imported && !connector.actions.length) {
        await refreshConnector(ctx.spaceId, connector.id, account.ctx.accessToken).catch(
          () => undefined,
        );
      }
      const current = (await resolveConnector(ctx.spaceId, connector.id))?.connector ?? connector;
      return runShareAgent(ctx, input, {
        task: `In ${connector.name}: ${input.values.instructions}`,
        rules: RULES,
        tools: (step, files) => toolsOf(connection(current.actions.map((a) => a.id)), step, files),
      });
    },
  };
}

/** A connector can carry a result somewhere when it has an action that writes. */
export function canPublish(connector: ConnectorDefinition): boolean {
  return !connector.actions.length || connector.actions.some((a) => a.group !== "read");
}
