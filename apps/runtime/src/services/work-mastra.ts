import type { Client } from "@libsql/client";
import { Mastra } from "@mastra/core";
import { Agent } from "@mastra/core/agent";
import { LibSQLStore } from "@mastra/libsql";
import { Memory } from "@mastra/memory";
import { isNotNull } from "drizzle-orm";
import { cacheMarksProcessor, markedInstructions } from "../agents/space-agent.js";
import { db, schema, tenantClient } from "../db/client.js";
import { agentModel } from "../models.js";
import { currentTenant } from "../tenants/tenant.js";
import { type LazyTurn, TURN_KEY, type WorkTurn } from "./work-ai.js";

/**
 * Mastra for Work's chats (docs/plans/work-chats.md): per tenant one store in the tenant's own
 * database (Mastra's `mastra_` tables beside ours), one Memory and one Mastra instance, made once
 * and kept while the database stays open. A chat is a memory thread: thread id = chat id,
 * resource id = the space. Messages of people go in as Mastra's messages (signals), with the
 * author as attributes; the space's AI answers in the same thread. Its model, tools and
 * instructions are the turn's (work-ai.ts), read from the request context.
 */

/** Messages a turn of the AI reads as they are; older ones through observational memory later. */
export const LAST_MESSAGES = 40;

export const SPACE_AI = "spaceAi";

interface TenantMastra {
  client: Client;
  ready: Promise<void>;
  memory: Memory;
  mastra: Mastra;
}

const byTenant = new Map<string, TenantMastra>();

/**
 * A turn doesn't outlive the process that ran it: when this process first serves a tenant's
 * chats, none of them is answering (a chat still marked so was left by a process that died).
 */
async function forgetDeadTurns() {
  await db
    .update(schema.chat)
    .set({ answeringSince: null })
    .where(isNotNull(schema.chat.answeringSince));
}

/** The turn the request runs (work-ai.ts), made on first use; a run without one is a mistake of ours. */
function turnOf(context: { get(key: string): unknown }): Promise<WorkTurn> {
  const turn = context.get(TURN_KEY) as LazyTurn | undefined;
  if (!turn) {
    throw new Error("A turn of the space's AI runs without its turn context.");
  }
  return turn.get();
}

function make(client: Client): TenantMastra {
  const store = new LibSQLStore({ id: "work-chats", client });
  const memory = new Memory({ storage: store, options: { lastMessages: LAST_MESSAGES } });
  const mastra = new Mastra({
    agents: {
      [SPACE_AI]: new Agent({
        id: "space-ai",
        name: "Space AI",
        instructions: async ({ requestContext }) =>
          markedInstructions((await turnOf(requestContext)).instructions),
        model: async ({ requestContext }) => agentModel((await turnOf(requestContext)).resolved),
        tools: async ({ requestContext }: { requestContext: { get(key: string): unknown } }) =>
          (await turnOf(requestContext)).tools as never,
        memory,
        inputProcessors: [cacheMarksProcessor as never],
      }),
    },
    storage: store,
    logger: false,
  });
  return { client, ready: store.init().then(forgetDeadTurns), memory, mastra };
}

/** The current tenant's Mastra, its store ready. */
export async function workMastra(): Promise<{ memory: Memory; agent: Agent }> {
  const tenant = currentTenant();
  const client = await tenantClient(tenant);
  let entry = byTenant.get(tenant);
  if (!entry || entry.client !== client) {
    entry = make(client);
    byTenant.set(tenant, entry);
    entry.ready.catch(() => byTenant.delete(tenant));
  }
  await entry.ready;
  return { memory: entry.memory, agent: entry.mastra.getAgent(SPACE_AI) };
}
