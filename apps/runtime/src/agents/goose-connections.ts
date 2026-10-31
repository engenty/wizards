import { CONFIRM_ACTION_TOOL } from "@engenty/wizards-shared/assistant";
import type { AskInput } from "@engenty/wizards-shared/run";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Who } from "../broker/index.js";
import { db, schema } from "../db/client.js";
import type { AskResult } from "../engine/asks.js";
import { prompt } from "../prompts.js";
import { isAdminRole } from "../services/access.js";
import { closedToMe } from "../services/members-studio.js";
import {
  type ConnectionTool,
  callConnection,
  connectionResult,
  connectionToolsOf,
  makeConnectionTools,
  usableConnections,
} from "../tools/connections.js";
import { attempt } from "../tools/shared.js";
import type { AssistantInput } from "./studio-assistant.js";

/*
 * Goose's connections (docs/plans/capabilities.md, "Who sees what"): a personal copilot works
 * with its person's own sign-ins alone. Its tools are the connections in which each person signs
 * in, in the spaces where this person has, within their audience. Reads run; a write, a send or a
 * delete asks the person first, on a card in Goose's own chat (the browser's `confirm_action`),
 * with no hold for the admins: it is the person's own account. A connection that signs in as the
 * space is never among them.
 */

/** The widest the person sees of what would be sent. */
const ASK_INPUT = 4000;

/** The person's own sign-ins, with the connection each belongs to. */
async function signedInConnections(userId: string) {
  const rows = await db
    .select({ row: schema.spaceConnection })
    .from(schema.spaceConnectionSignIn)
    .innerJoin(
      schema.spaceConnection,
      eq(schema.spaceConnection.id, schema.spaceConnectionSignIn.connectionId),
    )
    .where(
      and(
        eq(schema.spaceConnectionSignIn.userId, userId),
        eq(schema.spaceConnection.signIn, "person"),
      ),
    );
  return rows.map((r) => r.row);
}

/**
 * Asks the person on a card in Goose's chat, where the browser offers one; `undefined` where it
 * does not (an installed AI client as the model), so the broker answers that nobody can be asked.
 */
function confirmInChat(
  input: AssistantInput,
): ((ask: AskInput) => Promise<AskResult | null>) | undefined {
  if (!input.browserTools.some((t) => t.name === CONFIRM_ACTION_TOOL)) {
    return undefined;
  }
  return async (ask) => {
    if (ask.kind !== "confirm") {
      return null;
    }
    const call = {
      toolCallId: nanoid(10),
      toolCallName: CONFIRM_ACTION_TOOL,
      args: {
        service: ask.service,
        action: ask.action.summary,
        destructive: ask.action.destructive,
        input: ask.input.slice(0, ASK_INPUT),
      },
    };
    input.onToolCall?.(call);
    const out = (await input.callBrowser(call)) as { confirmed?: unknown } | null;
    input.onToolResult?.({ toolCallId: call.toolCallId, content: JSON.stringify(out ?? null) });
    return out?.confirmed === true ? { type: "done" } : { type: "skip" };
  };
}

const serviceOf = (tool: ConnectionTool) => `${tool.row.name} (${tool.connector.name})`;

/** Goose's tools for its person's connections; none where they signed in to none. */
export async function gooseConnectionTools(
  input: AssistantInput,
): Promise<Record<string, unknown>> {
  const userId = input.user.id;
  const who: Who = { kind: "goose", id: userId, admin: isAdminRole(input.user.role) };
  // Not in a space whose Studio is closed to a member: Goose is the Studio's.
  const signedIn = [];
  for (const row of await signedInConnections(userId)) {
    if (!(await closedToMe(row.spaceId))) {
      signedIn.push(row);
    }
  }
  const tools = connectionToolsOf(await usableConnections(signedIn, who));
  if (!tools.length) {
    return {};
  }
  const where = (tool: ConnectionTool) => ({ chatId: input.chat.id, spaceId: tool.row.spaceId });
  const ask = confirmInChat(input);
  return makeConnectionTools({
    tools,
    who,
    where,
    writeNote: () => prompt("tools", "connection.asks_person"),
    write: (tool, fields) =>
      attempt(async () =>
        connectionResult(
          await callConnection(tool, who, where(tool), fields, ask ? { ask } : {}),
          serviceOf(tool),
        ),
      ),
  }).tools;
}
