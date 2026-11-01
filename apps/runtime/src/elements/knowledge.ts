import { createTool } from "@mastra/core/tools";
import { and, eq } from "drizzle-orm";
import { assertRwx } from "../broker/rwx.js";
import { db, schema } from "../db/client.js";
import { fileByPath, mountFileText, usableMounts } from "../mounts/mounts.js";
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

/**
 * Where the caller's Knowledge is read: the space, and for a client space its parent too
 * (docs/plans/client-spaces.md). The rules decide each item of the parent as for any reader: a
 * client reads only what the parent opened to clients, the firm reads all of it.
 */
async function readsFrom(spaceId: string): Promise<{ id: string; name: string; own: boolean }[]> {
  const space = await db.query.space.findFirst({
    columns: { id: true, name: true, kind: true, parentId: true },
    where: eq(schema.space.id, spaceId),
  });
  if (!(space?.kind === "client" && space.parentId)) {
    return [{ id: spaceId, name: space?.name ?? "", own: true }];
  }
  const parent = await db.query.space.findFirst({
    columns: { id: true, name: true },
    where: eq(schema.space.id, space.parentId),
  });
  return [
    { id: spaceId, name: space.name, own: true },
    ...(parent ? [{ id: parent.id, name: parent.name, own: false }] : []),
  ];
}

/** The first space that has it: the client space before its parent. A refusal stands. */
async function firstFound<T>(
  spaces: { id: string }[],
  read: (spaceId: string) => Promise<T>,
): Promise<T> {
  let missing: unknown = null;
  for (const space of spaces) {
    try {
      return await read(space.id);
    } catch (err) {
      if ((err as { code?: string })?.code === "forbidden") {
        throw err;
      }
      missing ??= err;
    }
  }
  throw missing;
}

/** A page of Knowledge by its path, for the caller: its front matter and Markdown, in parts. */
export function readKnowledgePage(
  caller: ElementCaller,
  input: { path: string; section?: string; from?: number },
) {
  return attempt(() =>
    elementCall(caller, { action: "page_read", perm: "r", input }, async () => {
      const read = await firstFound(await readsFrom(caller.space.id), (spaceId) =>
        readPage(spaceId, input.path, input, caller.subjects),
      );
      await caller.note?.({ code: "reads", params: { name: read.path } });
      return read;
    }),
  );
}

/** The Knowledge tools for the caller; none where the space has no Knowledge yet. */
export async function knowledgeTools(caller: ElementCaller): Promise<Record<string, any>> {
  const spaceId = caller.space.id;
  const who = caller.subjects;
  const spaces = await readsFrom(spaceId);
  const counts = { pages: 0, tables: 0, files: 0 };
  let entries = false;
  for (const space of spaces) {
    const of = await knowledgeCounts(space.id);
    counts.pages += of.pages;
    counts.tables += of.tables;
    counts.files += of.files;
    entries ||= await hasIndexEntries(space.id);
  }
  // The folders of Dateien the caller may use: searched, and read by their path.
  const mounted = (await usableMounts(spaceId, who)).length > 0;
  if (!(counts.pages || counts.tables || counts.files || entries || mounted)) {
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
          const found = await searchAll(spaces, input.query, {
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
              ...(h.mount ? { in: `Dateien › ${h.mount.name}` } : {}),
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
          const parent = spaces.find((p) => !p.own);
          if (parent) {
            return {
              ...listed,
              [`from ${parent.name}`]: await listForStep(parent.id, input.where, who),
            };
          }
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
          const read = await firstFound(spaces, (id) => readTable(id, input.path, input, who));
          await caller.note?.({ code: "reads", params: { name: read.path } });
          return read;
        }),
    });
  }
  if (counts.files || mounted) {
    tools.space_document = createTool({
      id: "space_document",
      description: prompt("tools", "tool.space_document"),
      inputSchema: ELEMENT_SPECS.space_document.input,
      execute: (input) =>
        call("space_document", input, async () => {
          const { path, from } = input;
          if (path.startsWith("dateien/")) {
            return readMounted(path, from);
          }
          const wanted = path.startsWith("files/") ? path : `files/${path}`;
          const inSpace = await firstFound(spaces, async (id) => {
            const hit = await resolvePath(id, wanted);
            if (hit?.kind !== "file") {
              throw new Error("not here");
            }
            return id;
          }).catch(() => spaceId);
          const found = await resolvePath(inSpace, wanted);
          if (found?.kind !== "file") {
            const there = [...(await filePaths(spaceId)).values()].slice(0, 40);
            throw new Error(`No file "${path}". There are: ${there.join(", ")}`);
          }
          const file = await db.query.spaceFile.findFirst({
            where: and(eq(schema.spaceFile.id, found.id), eq(schema.spaceFile.spaceId, inSpace)),
          });
          if (!file) {
            throw new Error(`No file "${path}".`);
          }
          await assertRwx(inSpace, who, { kind: "document", id: file.id }, "r");
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

  /** A file of a mount, read from where it lives: the mount's rules decided before. */
  async function readMounted(path: string, from: number | undefined) {
    const found = await fileByPath(spaceId, path, who);
    if (!found) {
      throw new Error(`No file "${path}" in the folders you may use.`);
    }
    await caller.note?.({ code: "reads", params: { name: found.file.name } });
    const text = await mountFileText(found.mount, found.file).catch(() => {
      throw new Error(`"${path}" can't be read now: its folder is not there.`);
    });
    if (!text) {
      return { path, text: "", note: `${found.file.mime}: no text of its own.`, length: 0 };
    }
    const start = Math.min(from ?? 0, text.length);
    const part = text.slice(start, start + 12_000);
    return {
      path,
      text: clip(part, 12_000),
      next: start + part.length < text.length ? start + part.length : null,
      length: text.length,
    };
  }
}

/** A search over the client space and its parent, the best of both by relevance. */
async function searchAll(
  spaces: { id: string; name: string; own: boolean }[],
  query: string,
  opts: Parameters<typeof searchKnowledge>[2],
) {
  if (spaces.length === 1) {
    return searchKnowledge(spaces[0].id, query, opts);
  }
  const each = await Promise.all(spaces.map((p) => searchKnowledge(p.id, query, opts)));
  const limit = Math.min(Math.max(1, opts?.limit ?? 6), 12);
  const hits = each
    .flatMap((found) => found.hits)
    .sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0))
    .slice(0, limit);
  return {
    hits,
    checked: each.every((f) => f.checked),
    candidates: each.reduce((n, f) => n + f.candidates, 0),
    filtered: each.some((f) => f.filtered !== null)
      ? each.reduce((n, f) => n + (f.filtered ?? 0), 0)
      : null,
  };
}
