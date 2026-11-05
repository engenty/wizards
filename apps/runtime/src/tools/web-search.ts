import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { GatewayAccess } from "../models.js";
import { prompt } from "../prompts.js";

/** One result as the gateway answers it (its gateway/web.ts). */
interface WebResult {
  title: string;
  url: string;
  published: string | null;
  highlights: string[];
}

/**
 * `web_search` through the gateway: the same tool for every model and client (a Work chat,
 * Goose, a step, a local AI client), metered and booked there, its provider the gateway's
 * business. Reading a result's page is `web_fetch`, the runtime's own.
 */
export function gatewayWebSearch(access: GatewayAccess, meta: { runId?: string | null } = {}) {
  return createTool({
    id: "web_search",
    description: prompt("tools", "tool.web_search"),
    inputSchema: z.object({
      query: z.string().min(1).max(500).describe("What to search for, as one would type it"),
      num: z.number().int().min(1).max(10).optional().describe("How many results, 6 by default"),
    }),
    execute: async ({ query, num }, options) => {
      const res = await fetch(`${access.baseUrl}/v1/web/search`, {
        method: "POST",
        signal: (options as { abortSignal?: AbortSignal } | undefined)?.abortSignal,
        headers: {
          authorization: `Bearer ${access.token}`,
          "content-type": "application/json",
          ...(access.tenant ? { "x-wizards-tenant": access.tenant } : {}),
          ...(meta.runId ? { "x-wizards-run": meta.runId } : {}),
        },
        body: JSON.stringify({ query, ...(num ? { num } : {}) }),
      });
      const body = (await res.json().catch(() => null)) as {
        results?: WebResult[];
        error?: { message?: string };
      } | null;
      if (!res.ok) {
        return { error: body?.error?.message ?? `The web search answered ${res.status}.` };
      }
      return { results: body?.results ?? [] };
    },
  });
}
