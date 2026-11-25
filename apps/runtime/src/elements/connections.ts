import { createTool } from "@mastra/core/tools";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Who } from "../broker/index.js";
import { listSpaceConnections } from "../connectors/space-connections.js";
import { db, schema } from "../db/client.js";
import {
  callConnection,
  connectionResult,
  connectionToolsOf,
  usableConnections,
} from "../tools/connections.js";
import { attempt } from "../tools/shared.js";
import type { ElementCaller } from "./caller.js";
import { ELEMENT_SPECS } from "./specs.js";

/**
 * The space's connections for an outside client (docs/plans/modular.md, phase 3): the actions the
 * person may use, behind two calls. Each call is the broker's
 * (`brokerCall`), which decides it by the connection's audience and rules and writes its line
 * with the client's name. A write, a send or a delete runs only where the rule says Erlaubt: the
 * person's yes is never taken from the client (I4), so a call the rule would ask them about
 * („Mit Freigabe“) is refused with why. Its secret stays in the broker (I5).
 */

const personOf = (caller: ElementCaller) =>
  (caller.who.kind === "person" || caller.who.kind === "admin") && caller.who.id
    ? caller.who.id
    : null;

/**
 * The connections of the space the caller's person reaches: those open to their role, and of the
 * ones in which each person signs in, only those they signed in to.
 */
async function reachableConnectionTools(spaceId: string, userId: string, who: Who) {
  const rows = await listSpaceConnections(spaceId);
  const own = rows.some((r) => r.signIn === "person")
    ? new Set(
        (
          await db.query.spaceConnectionSignIn.findMany({
            where: eq(schema.spaceConnectionSignIn.userId, userId),
            columns: { connectionId: true },
          })
        ).map((s) => s.connectionId),
      )
    : new Set<string>();
  const reachable = rows.filter((r) => r.signIn === "space" || own.has(r.id));
  return connectionToolsOf(await usableConnections(reachable, who));
}

export async function connectionElementTools(caller: ElementCaller): Promise<Record<string, any>> {
  const userId = personOf(caller);
  if (!userId) {
    return {};
  }
  const tools = await reachableConnectionTools(caller.space.id, userId, caller.who);
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
