import { whereSchema } from "@engenty-wizards/shared/knowledge";
import { createTool } from "@mastra/core/tools";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/client.js";
import type { StepContext } from "../engine/types.js";
import {
  filePaths,
  knowledgeCounts,
  listForStep,
  readPage,
  readTable,
  resolvePath,
} from "../services/knowledge.js";
import { documentText, hasIndexEntries, searchKnowledge } from "../services/project-index.js";
import { attempt, clip } from "./shared.js";

/**
 * Knowledge, for every agent step of the space's wizards: search it (a question, filtered by
 * categories first, checked by a classifier after), list it by categories, read a page, a table
 * or a file whole by its path. Hits and reads look like files — a path, front matter, Markdown or
 * CSV — so a model reads them as it reads files. The search also finds what the space's plugins
 * put into the index.
 */

const where = whereSchema
  .optional()
  .describe(
    'Filter by categories before searching, by their names: a value ("Baustelle": "Graz Süd"), a list of values, a range of numbers ({ "gte": 20000 }) or of days ({ "after": "2026-03-01", "before": "2026-03-31" }), { "contains": "…" } for a text, true/false. project_list without arguments names the categories and their values.',
  );

export const pageReadInput = {
  path: z.string().describe("The page's path, as project_search or project_list give it: pages/…"),
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
    const read = await readPage(ctx.project.id, input.path, input);
    await ctx.emit("tool", { code: "reads", params: { name: read.path } });
    return read;
  });
}

export async function projectTools(ctx: StepContext): Promise<Record<string, any>> {
  const projectId = ctx.project.id;
  const counts = await knowledgeCounts(projectId);
  const entries = await hasIndexEntries(projectId);
  if (!(counts.pages || counts.tables || counts.files || entries)) {
    return {};
  }
  const tools: Record<string, any> = {
    project_search: createTool({
      id: "project_search",
      description:
        "Search the space's Knowledge: its pages, tables and files, and what its plugins keep (wiki pages, questions and answers). Gives items with their path, categories and best section, each checked for relevance. Ask in their language, with the words they would use; filter with `where` when the task names a category's value. Then read the items you need whole with page_read or table_read.",
      inputSchema: z.object({
        query: z.string().describe("What to look for: a question or keywords"),
        where,
        limit: z.number().int().min(1).max(12).optional().describe("Items to get, 6 by default"),
      }),
      execute: (input) =>
        attempt(async () => {
          const found = await searchKnowledge(projectId, input.query, {
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
    project_list: createTool({
      id: "project_list",
      description:
        "List Knowledge by its categories. Without `where`: the categories with their values and how many items each has. With `where`: the items it leaves, with their paths — all of them, where project_search gives the best few.",
      inputSchema: z.object({ where }),
      execute: (input) =>
        attempt(async () => {
          const listed = await listForStep(projectId, input.where);
          await ctx.emit("tool", { code: "listsKnowledge" });
          return listed;
        }),
    }),
  };
  if (counts.pages) {
    tools.page_read = createTool({
      id: "page_read",
      description:
        "Read a page of Knowledge whole by its path: front matter (title, categories, its source and original, its parent and sub-pages) and its Markdown. Long pages come in parts: pass `from` to continue. `section` reads one section.",
      inputSchema: z.object(pageReadInput),
      execute: (input) => readKnowledgePage(ctx, input),
    });
  }
  if (counts.tables) {
    tools.table_read = createTool({
      id: "table_read",
      description:
        "Read a table of Knowledge by its path: its rows as CSV, filtered by its columns (by their names, like `where` of project_search). A few hundred rows at a time: pass `offset` to continue.",
      inputSchema: z.object({
        path: z.string().describe("The table's path: tables/…"),
        where: whereSchema.optional().describe("Filter by columns, by their names"),
        columns: z.array(z.string()).max(40).optional().describe("Only these columns"),
        limit: z.number().int().min(1).max(1000).optional(),
        offset: z.number().int().min(0).optional(),
      }),
      execute: (input) =>
        attempt(async () => {
          const read = await readTable(projectId, input.path, input);
          await ctx.emit("tool", { code: "reads", params: { name: read.path } });
          return read;
        }),
    });
  }
  if (counts.files) {
    tools.project_document = createTool({
      id: "project_document",
      description:
        "Read a file of Knowledge as text by its path (files/…): a file that is not a page, or the original a page was read from. Long files come in parts: pass `from` to continue.",
      inputSchema: z.object({
        path: z
          .string()
          .describe("The file's path: files/…, as the page's front matter or a hit names it"),
        from: z.number().int().min(0).optional().describe("Character to start at"),
      }),
      execute: ({ path, from }) =>
        attempt(async () => {
          const found = await resolvePath(
            projectId,
            path.startsWith("files/") ? path : `files/${path}`,
          );
          if (found?.kind !== "file") {
            const there = [...(await filePaths(projectId)).values()].slice(0, 40);
            throw new Error(`No file "${path}". There are: ${there.join(", ")}`);
          }
          const file = await db.query.projectFile.findFirst({
            where: and(
              eq(schema.projectFile.id, found.id),
              eq(schema.projectFile.projectId, projectId),
            ),
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
