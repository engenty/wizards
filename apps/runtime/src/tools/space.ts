import { whereSchema } from "@engenty/wizards-shared/knowledge";
import { createTool } from "@mastra/core/tools";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/client.js";
import type { StepContext } from "../engine/types.js";
import { prompt } from "../prompts.js";
import {
  filePaths,
  knowledgeCounts,
  listForStep,
  readPage,
  readTable,
  resolvePath,
} from "../services/knowledge.js";
import { documentText, hasIndexEntries, searchKnowledge } from "../services/space-index.js";
import { attempt, clip } from "./shared.js";

/**
 * Knowledge, for every agent step of the space's wizards: search it (a question, filtered by
 * categories first, checked by a classifier after), list it by categories, read a page, a table
 * or a file whole by its path. Hits and reads look like files — a path, front matter, Markdown or
 * CSV — so a model reads them as it reads files. The search also finds what the space's plugins
 * put into the index.
 */

const where = whereSchema.optional().describe(prompt("tools", "tool.space.where"));

export const pageReadInput = {
  path: z.string().describe("The page's path, as space_search or space_list give it: pages/…"),
  section: z
    .string()
    .optional()
    .describe("Only this section: a heading of the page, or the start of one"),
  from: z.number().int().min(0).optional().describe("Character to continue a long page at"),
};

/** A page of Knowledge by its path, for a step: its front matter and Markdown, in parts. */
export function readKnowledgePage(
  ctx: StepContext,
  input: { path: string; section?: string; from?: number },
) {
  return attempt(async () => {
    const read = await readPage(ctx.space.id, input.path, input);
    await ctx.emit("tool", { code: "reads", params: { name: read.path } });
    return read;
  });
}

export async function spaceTools(ctx: StepContext): Promise<Record<string, any>> {
  const spaceId = ctx.space.id;
  const counts = await knowledgeCounts(spaceId);
  const entries = await hasIndexEntries(spaceId);
  if (!(counts.pages || counts.tables || counts.files || entries)) {
    return {};
  }
  const tools: Record<string, any> = {
    space_search: createTool({
      id: "space_search",
      description: prompt("tools", "tool.space_search"),
      inputSchema: z.object({
        query: z.string().describe("What to look for: a question or keywords"),
        where,
        limit: z.number().int().min(1).max(12).optional().describe("Items to get, 6 by default"),
      }),
      execute: (input) =>
        attempt(async () => {
          const found = await searchKnowledge(spaceId, input.query, {
            where: input.where,
            limit: input.limit,
            signal: ctx.signal,
          });
          await ctx.emit("tool", {
            code: "searchesKnowledge",
            params: {
              query: input.query.slice(0, 60),
              relevant: found.hits.length,
              candidates: found.candidates,
            },
          });
          return {
            hits: found.hits.map((h) => ({
              ...(h.path ? { path: h.path } : {}),
              title: h.title,
              ...(h.categories.length ? { categories: h.categories } : {}),
              ...(h.heading ? { section: h.heading } : {}),
              ...(h.sheet ? { page: h.sheet } : {}),
              ...(h.relevance !== null ? { relevance: h.relevance } : {}),
              text: clip(h.text, 1500),
            })),
            checked: found.checked,
            candidates: found.candidates,
            ...(found.filtered !== null ? { filtered: found.filtered } : {}),
          };
        }),
    }),
    space_list: createTool({
      id: "space_list",
      description: prompt("tools", "tool.space_list"),
      inputSchema: z.object({ where }),
      execute: (input) =>
        attempt(async () => {
          const listed = await listForStep(spaceId, input.where);
          await ctx.emit("tool", { code: "listsKnowledge" });
          return listed;
        }),
    }),
  };
  if (counts.pages) {
    tools.page_read = createTool({
      id: "page_read",
      description: prompt("tools", "tool.page_read.knowledge"),
      inputSchema: z.object(pageReadInput),
      execute: (input) => readKnowledgePage(ctx, input),
    });
  }
  if (counts.tables) {
    tools.table_read = createTool({
      id: "table_read",
      description: prompt("tools", "tool.table_read"),
      inputSchema: z.object({
        path: z.string().describe("The table's path: tables/…"),
        where: whereSchema.optional().describe("Filter by columns, by their names"),
        columns: z.array(z.string()).max(40).optional().describe("Only these columns"),
        limit: z.number().int().min(1).max(1000).optional(),
        offset: z.number().int().min(0).optional(),
      }),
      execute: (input) =>
        attempt(async () => {
          const read = await readTable(spaceId, input.path, input);
          await ctx.emit("tool", { code: "reads", params: { name: read.path } });
          return read;
        }),
    });
  }
  if (counts.files) {
    tools.space_document = createTool({
      id: "space_document",
      description: prompt("tools", "tool.space_document"),
      inputSchema: z.object({
        path: z
          .string()
          .describe("The file's path: files/…, as the page's front matter or a hit names it"),
        from: z.number().int().min(0).optional().describe("Character to start at"),
      }),
      execute: ({ path, from }) =>
        attempt(async () => {
          const found = await resolvePath(
            spaceId,
            path.startsWith("files/") ? path : `files/${path}`,
          );
          if (found?.kind !== "file") {
            const there = [...(await filePaths(spaceId)).values()].slice(0, 40);
            throw new Error(`No file "${path}". There are: ${there.join(", ")}`);
          }
          const file = await db.query.spaceFile.findFirst({
            where: and(eq(schema.spaceFile.id, found.id), eq(schema.spaceFile.spaceId, spaceId)),
          });
          if (!file) {
            throw new Error(`No file "${path}".`);
          }
          await ctx.emit("tool", { code: "reads", params: { name: file.name } });
          const text = (await documentText(file)) || file.description;
          const start = Math.min(from ?? 0, text.length);
          const part = text.slice(start, start + 12_000);
          return {
            path: found.path,
            text: clip(part, 12_000),
            next: start + part.length < text.length ? start + part.length : null,
            length: text.length,
          };
        }),
    });
  }
  return tools;
}
