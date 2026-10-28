import type { Client } from "@libsql/client";
import { Mastra } from "@mastra/core";
import { Agent } from "@mastra/core/agent";
import { LibSQLStore } from "@mastra/libsql";
import { Memory } from "@mastra/memory";
import { chatTurnWay } from "../agents/subscription.js";
import { tenantClient } from "../db/client.js";
import { managed } from "../manage.js";
import { agentModel, chatModel } from "../models.js";
import { currentTenant } from "../tenants/tenant.js";

/**
 * Mastra for Work's chats (docs/plans/work-chats.md): per tenant one store in the tenant's own
 * database (Mastra's `mastra_` tables beside ours), one Memory and one Mastra instance, made once
 * and kept while the database stays open. A chat is a memory thread: thread id = chat id,
 * resource id = the space. Messages of people go in as Mastra's messages (signals), with the
 * author as attributes; the space's AI answers in the same thread (step 3, PR 3).
 */

/** Messages a turn of the AI reads as they are; older ones through observational memory later. */
const LAST_MESSAGES = 40;

export const SPACE_AI = "spaceAi";

interface TenantMastra {
  client: Client;
  ready: Promise<void>;
  memory: Memory;
  mastra: Mastra;
}

const byTenant = new Map<string, TenantMastra>();

function make(client: Client): TenantMastra {
  const store = new LibSQLStore({ id: "work-chats", client });
  const memory = new Memory({ storage: store, options: { lastMessages: LAST_MESSAGES } });
  const mastra = new Mastra({
    agents: {
      [SPACE_AI]: new Agent({
        id: "space-ai",
        name: "Space AI",
        instructions: "",
        // Resolved when a turn runs, on the way the settings chose (PR 3 gives it its tools).
        model: async () => agentModel(await chatModel(await chatTurnWay(managed), "standard")),
        memory,
      }),
    },
    storage: store,
    logger: false,
  });
  return { client, ready: store.init(), memory, mastra };
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
