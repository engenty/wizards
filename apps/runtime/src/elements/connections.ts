import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { chatConnectionTools } from "../services/work-connections.js";
import { callConnection, connectionResult } from "../tools/connections.js";
import { attempt } from "../tools/shared.js";
import type { ElementCaller } from "./caller.js";
import { ELEMENT_SPECS } from "./specs.js";

/**
 * The space's connections for an outside client (docs/plans/modular.md, phase 3): the actions the
 * person may use, as a Work chat has them, behind two calls. Each call is the broker's
 * (`brokerCall`), which decides it by the connection's audience and rules and writes its line
 * with the client's name. A write, a send or a delete runs only where the rules say *Immer*: the
 * person's yes is never taken from the client (I4), and a call that waits for the space's
 * admins („Mit Freigabe“) is refused with why. Its secret stays in the broker (I5).
 */

const personOf = (caller: ElementCaller) =>
  (caller.who.kind === "person" || caller.who.kind === "admin") && caller.who.id
    ? caller.who.id
    : null;

export async function connectionElementTools(caller: ElementCaller): Promise<Record<string, any>> {
  const userId = personOf(caller);
  if (!userId) {
    return {};
  }
  const tools = await chatConnectionTools(caller.space.id, userId, caller.who);
  if (!tools.length) {
    return {};
  }
  const service = (t: (typeof tools)[number]) => `${t.row.name} (${t.connector.name})`;
  return {
    connection_list: createTool({
      id: "connection_list",
      description: ELEMENT_SPECS.connection_list.description(),
      inputSchema: ELEMENT_SPECS.connection_list.input,
      execute: async () => ({
        actions: tools.map((t) => ({
          name: t.name,
          service: service(t),
          does: t.action.summary || t.action.id,
          kind: t.kind,
          input: t.action.inputSchema
            ? z.toJSONSchema(t.action.inputSchema as z.ZodType, { unrepresentable: "any" })
            : {},
        })),
      }),
    }),
    connection_call: createTool({
      id: "connection_call",
      description: ELEMENT_SPECS.connection_call.description(),
      inputSchema: ELEMENT_SPECS.connection_call.input,
      execute: ({ name, input }) =>
        attempt(async () => {
          const tool = tools.find((t) => t.name === name);
          if (!tool) {
            return { error: `No action ${name}. connection_list names the ones you may use.` };
          }
          // No ask and no yes: a write that needs one is refused by the broker, not run.
          const out = await callConnection(tool, caller.who, caller.where, input);
          return connectionResult(out, service(tool));
        }),
    }),
  };
}
