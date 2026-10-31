import { createTool } from "@mastra/core/tools";
import { and, eq } from "drizzle-orm";
import { assertRwx } from "../broker/rwx.js";
import { db, schema } from "../db/client.js";
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
import { attempt, clip } from "../tools/shared.js";
import type { ElementCaller } from "./caller.js";
import { elementCall } from "./gate.js";
import { ELEMENT_SPECS } from "./specs.js";

/**
 * The space's Knowledge as tools of the catalogue: search it (a question, filtered by categories
 * first, checked by a classifier after), list it by categories, read a page, a table or a file
 * whole by its path. Hits and reads look like files — a path, front matter, Markdown or CSV — so
 * a model reads them as it reads files. The search also finds what the space's plugins put into
 * the index. Every read is the caller's: the broker decides each item before it is handed out
 * (broker/rwx.ts), and each call is a line of its log (gate.ts).
 */

export { pageReadInput } from "./specs.js";

/** A page of Knowledge by its path, for the caller: its front matter and Markdown, in parts. */
export function readKnowledgePage(
  caller: ElementCaller,
  input: { path: string; section?: string; from?: number },
) {
  return attempt(() =>
    elementCall(caller, { action: "page_read", perm: "r", input }, async () => {
      const read = await readPage(caller.space.id, input.path, input, caller.subjects);
      await caller.note?.({ code: "reads", params: { name: read.path } });
      return read;
    }),
  );
}

/** The Knowledge tools for the caller; none where the space has no Knowledge yet. */
export async function knowledgeTools(caller: ElementCaller): Promise<Record<string, any>> {
  const spaceId = caller.space.id;
  const who = caller.subjects;
  const counts = await knowledgeCounts(spaceId);
  const entries = await hasIndexEntries(spaceId);
  if (!(counts.pages || counts.tables || counts.files || entries)) {
    return {};
  }
  const call = <T>(action: string, input: unknown, run: () => Promise<T>) =>
    attempt(() => elementCall(caller, { action, perm: "r", input }, run));
  const tools: Record<string, any> = {
    space_search: createTool({
      id: "space_search",
      description: prompt("tools", "tool.space_search"),
      inputSchema: ELEMENT_SPECS.space_search.input,
      execute: (input) =>
        call("space_search", input, async () => {
          const found = await searchKnowledge(spaceId, input.query, {
            where: input.where,
            limit: input.limit,
            signal: caller.signal,
            who,
          });
          await caller.note?.({
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
              ...(h.open ? { open: h.open } : {}),
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
      inputSchema: ELEMENT_SPECS.space_list.input,
      execute: (input) =>
        call("space_list", input, async () => {
          const listed = await listForStep(spaceId, input.where, who);
          await caller.note?.({ code: "listsKnowledge" });
          return listed;
        }),
    }),
  };
  if (counts.pages) {
    tools.page_read = createTool({
      id: "page_read",
      description: prompt("tools", "tool.page_read.knowledge"),
      inputSchema: ELEMENT_SPECS.page_read.input,
      execute: (input) => readKnowledgePage(caller, input),
    });
  }
  if (counts.tables) {
    tools.table_read = createTool({
      id: "table_read",
      description: prompt("tools", "tool.table_read"),
      inputSchema: ELEMENT_SPECS.table_read.input,
      execute: (input) =>
        call("table_read", input, async () => {
          const read = await readTable(spaceId, input.path, input, who);
          await caller.note?.({ code: "reads", params: { name: read.path } });
          return read;
        }),
    });
  }
  if (counts.files) {
    tools.space_document = createTool({
      id: "space_document",
      description: prompt("tools", "tool.space_document"),
      inputSchema: ELEMENT_SPECS.space_document.input,
      execute: (input) =>
        call("space_document", input, async () => {
          const { path, from } = input;
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
          await assertRwx(spaceId, who, { kind: "document", id: file.id }, "r");
          await caller.note?.({ code: "reads", params: { name: file.name } });
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
