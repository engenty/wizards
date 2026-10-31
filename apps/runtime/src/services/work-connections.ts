import { eq } from "drizzle-orm";
import type { Who } from "../broker/index.js";
import { listSpaceConnections } from "../connectors/space-connections.js";
import { db, schema } from "../db/client.js";
import { prompt } from "../prompts.js";
import {
  type ConnectionTool,
  callConnection,
  connectionRefusalNote,
  connectionResult,
  connectionToolsOf,
  makeConnectionTools,
  usableConnections,
} from "../tools/connections.js";
import { type AssistantToolLabel, assistantToolRisk } from "../tools/plugin.js";
import { isAdminRole, roleOf } from "./access.js";
import { holdCall } from "./work-approvals.js";

/*
 * A Work chat's grant (docs/plans/capabilities.md, A7): the space's connections whose audience
 * includes the person the turn is for. Their read actions are tools that run at once; a write, a
 * send or a delete is a confirmed action: the AI fills in its fields, the gate holds the call for
 * the person (`chat_approval`, the card in the chat), and once they confirm it the broker decides
 * by the connection's rules. „Mit Freigabe“ on a connection that signs in as the space holds it
 * again, for the space's admins under the bell; an admin's yes runs it.
 */

/** Who a chat's turn calls as: the person, an admin where their role in the organization says so. */
async function chatWho(userId: string): Promise<Who> {
  const role = await roleOf(userId);
  return { kind: isAdminRole(role) ? "admin" : "person", id: userId };
}

/**
 * The connections of the space this person reaches in a chat: those open to their role, and of
 * the ones in which each person signs in, only those they signed in to.
 */
async function chatConnectionTools(spaceId: string, userId: string, who: Who) {
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

/** What a hold answers the AI: the same shape as the gate's, so the chat draws the card. */
const waiting = (approval: string, note: string) => ({ approval, status: "waiting", note });

export interface ConnectionTurn {
  space: { id: string; name: string };
  userId: string;
  /** The chat a hold is stored with; none where an approved call runs with no chat to hold in. */
  chatId: string | null;
  /** The call runs because an admin approved it („Mit Freigabe“ met). */
  byAdmin?: boolean;
}

/**
 * The space's connections as the turn's tools, for the person the turn is for. The writes are
 * marked `outside`, so the gate (work-ai.ts `gated`) holds each call for the person first; what
 * runs here is the confirmed call.
 */
export async function workConnectionTools(turn: ConnectionTurn): Promise<{
  tools: Record<string, unknown>;
  labels: Record<string, AssistantToolLabel>;
}> {
  const who = await chatWho(turn.userId);
  const tools = await chatConnectionTools(turn.space.id, turn.userId, who);
  if (!tools.length) {
    return { tools: {}, labels: {} };
  }
  const where = { chatId: turn.chatId ?? undefined, spaceId: turn.space.id };
  const made = makeConnectionTools({
    tools,
    who,
    where: () => where,
    writeNote: (tool) =>
      tool.row.signIn === "space" && tool.row.rules[tool.kind] === "ask"
        ? prompt("tools", "connection.confirms_admins")
        : prompt("tools", "connection.confirms"),
    write: async (tool, input) => {
      // The person confirmed this exact call on its card: their own yes is given.
      const out = await callConnection(tool, who, where, input, {
        confirmed: true,
        approved: turn.byAdmin === true,
        ask: async () => ({ type: "done" }),
      });
      if (!out.ok && out.refused === "needs_approval" && turn.chatId) {
        const id = await holdCall(
          { chatId: turn.chatId, userId: turn.userId },
          tool.name,
          input,
          "admins",
        );
        return waiting(id, prompt("tools", "note.connection_waits_admins"));
      }
      if (!out.ok) {
        // Thrown, so the approved call is marked failed and the AI hears why.
        throw new Error(connectionRefusalNote(out.refused, serviceOf(tool)));
      }
      return connectionResult(out, serviceOf(tool));
    },
  });
  for (const name of made.writes) {
    assistantToolRisk.set(made.tools[name] as object, "outside");
  }
  return { tools: made.tools, labels: made.labels };
}

const serviceOf = (tool: ConnectionTool) => `${tool.row.name} (${tool.connector.name})`;

/** How the chat names the connections' tools, for the person who opened it. */
export async function workConnectionLabels(
  spaceId: string,
  userId: string,
): Promise<Record<string, AssistantToolLabel>> {
  const who = await chatWho(userId);
  const tools = await chatConnectionTools(spaceId, userId, who);
  return Object.fromEntries(
    tools.map((t) => [
      t.name,
      { plugin: t.row.name, tool: t.action.summary || t.action.id, label: null },
    ]),
  );
}
