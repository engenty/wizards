import type { PluginSpaceData } from "@engenty/wizards/plugin";
import type { CategoryInput } from "@engenty-wizards/shared/knowledge";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { UnreadableDocument } from "../documents/parse.js";
import { ServiceError } from "./errors.js";
import { filePaths, pageTree, tablePaths } from "./knowledge.js";
import { convertDocument, fillCategories, summarizeValues } from "./knowledge-model.js";
import { projectFileContent, putOriginFile } from "./project-files.js";
import { queueIndex } from "./project-index.js";
import { putCategory, setItemCategories } from "./space-categories.js";
import { listOrigin, putOriginPage, putOriginTable, removeOrigin } from "./space-data.js";

/**
 * `server.spaceData` of a plugin: Knowledge it writes under keys of its own, with categories. The
 * plugin's id is the origin of everything it writes; a person who changes an item keeps it.
 */
export function originData(origin: string): PluginSpaceData {
  return {
    async putCategories({ space, categories, proposed }) {
      for (const c of categories) {
        let tableId: string | null = null;
        if (c.column) {
          const table = await db.query.spaceTable.findFirst({
            where: and(
              eq(schema.spaceTable.projectId, space),
              eq(schema.spaceTable.origin, origin),
              eq(schema.spaceTable.originKey, c.column.table),
            ),
            columns: { id: true },
          });
          if (!table) {
            throw new ServiceError(
              "invalid",
              `There is no table with the key "${c.column.table}".`,
            );
          }
          tableId = table.id;
        }
        await putCategory(
          space,
          {
            name: c.name,
            type: c.type,
            unit: c.unit,
            multiple: c.multiple,
            ordered: c.ordered,
            hint: c.hint,
            values: c.values,
            tableId,
            columnId: c.column?.column ?? null,
          },
          { origin, proposed },
        );
      }
    },
    async putPage(input) {
      const written = await putOriginPage(origin, {
        ...input,
        categories: input.categories as CategoryInput | undefined,
      });
      if (input.fill && written.state === "written") {
        const changed = await fillCategories(
          input.space,
          { pageId: written.id },
          input.markdown,
          input.title,
        ).catch((err) => {
          console.error(`[plugin ${origin}] categories`, err);
          return false;
        });
        if (changed) {
          queueIndex(`P:${written.id}`);
        }
      }
      return { ...written, path: (await pageTree(input.space)).get(written.id)?.path ?? "" };
    },
    async putTable(input) {
      const written = await putOriginTable(origin, {
        ...input,
        categories: input.categories as CategoryInput | undefined,
      });
      return { ...written, path: (await tablePaths(input.space)).get(written.id) ?? "" };
    },
    async putFile(input) {
      const id = await putOriginFile(origin, {
        ...input,
        categories: input.categories as CategoryInput | undefined,
      });
      return { id, path: (await filePaths(input.space)).get(id) ?? "" };
    },
    async putDocument(input) {
      const id = await putOriginFile(origin, { ...input, categories: undefined });
      const file = await db.query.projectFile.findFirst({ where: eq(schema.projectFile.id, id) });
      if (!file) {
        throw new ServiceError("not_found", "The document was removed while it was being read.");
      }
      const path = (await filePaths(input.space)).get(id) ?? "";
      const kept =
        (await db.query.spacePage.findFirst({
          where: and(eq(schema.spacePage.fileId, id), eq(schema.spacePage.kept, true)),
          columns: { id: true },
        })) ??
        (await db.query.spaceTable.findFirst({
          where: and(eq(schema.spaceTable.fileId, id), eq(schema.spaceTable.kept, true)),
          columns: { id: true },
        }));
      if (kept) {
        return { id, path, state: "kept", items: [], review: null };
      }
      let converted: Awaited<ReturnType<typeof convertDocument>>;
      try {
        converted = await convertDocument(file, input.data);
      } catch (err) {
        if (err instanceof UnreadableDocument) {
          queueIndex(`f:${id}`);
          return { id, path, state: "written", items: [], review: err.message };
        }
        throw err;
      }
      await db
        .update(schema.projectFile)
        .set({
          textHash: converted.textHash,
          pages: converted.pages,
          chars: converted.chars,
          updatedAt: new Date(),
        })
        .where(eq(schema.projectFile.id, id));
      const [tree, tables] = await Promise.all([pageTree(input.space), tablePaths(input.space)]);
      const items = await Promise.all(
        converted.items.map(async (key) => {
          const itemId = key.slice(2);
          if (key[0] === "p") {
            const node = tree.get(itemId);
            return {
              kind: "page" as const,
              id: itemId,
              path: node?.path ?? "",
              title: node?.title ?? "",
            };
          }
          const table = await db.query.spaceTable.findFirst({
            where: eq(schema.spaceTable.id, itemId),
            columns: { title: true },
          });
          return {
            kind: "table" as const,
            id: itemId,
            path: tables.get(itemId) ?? "",
            title: table?.title ?? "",
          };
        }),
      );
      const first = items[0];
      const ref = first
        ? first.kind === "page"
          ? { pageId: first.id }
          : { tableId: first.id }
        : { fileId: id };
      if (input.categories) {
        await setItemCategories(input.space, ref, input.categories as CategoryInput, "origin");
      }
      if (input.fill) {
        await fillCategories(input.space, ref, converted.text, input.name).catch((err) => {
          console.error(`[plugin ${origin}] categories`, err);
          return false;
        });
      }
      if (input.categories || input.fill) {
        queueIndex(first ? `${first.kind === "page" ? "P" : "t"}:${first.id}` : `f:${id}`);
      }
      const review =
        first?.kind === "page"
          ? ((
              await db.query.spacePage.findFirst({
                where: eq(schema.spacePage.id, first.id),
                columns: { review: true },
              })
            )?.review ?? null)
          : null;
      return { id, path, state: "written", items, review };
    },
    async readPages(space, opts) {
      const tree = await pageTree(space);
      const rows = await db.query.spacePage.findMany({
        where: and(
          eq(schema.spacePage.projectId, space),
          isNull(schema.spacePage.wizardId),
          opts?.parent ? eq(schema.spacePage.parentId, opts.parent) : undefined,
        ),
        orderBy: [schema.spacePage.position, schema.spacePage.title],
      });
      return rows.map((r) => ({
        id: r.id,
        title: r.title,
        path: tree.get(r.id)?.path ?? `pages/${r.slug ?? r.id}`,
        parentId: r.parentId,
        markdown: r.markdown,
        origin: r.origin,
        originKey: r.originKey,
        updatedAt: r.updatedAt.toISOString(),
      }));
    },
    async files(space, kind = "document") {
      const rows = await db.query.projectFile.findMany({
        where: and(
          eq(schema.projectFile.projectId, space),
          eq(schema.projectFile.kind, kind),
          eq(schema.projectFile.status, "ready"),
        ),
        orderBy: [desc(schema.projectFile.updatedAt)],
      });
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        mime: r.mime,
        size: r.size,
        kind: r.kind,
        updatedAt: r.updatedAt.toISOString(),
      }));
    },
    async readFile(space, fileId) {
      const { row, data } = await projectFileContent(space, fileId);
      return {
        id: row.id,
        name: row.name,
        mime: row.mime,
        size: row.size,
        kind: row.kind,
        updatedAt: row.updatedAt.toISOString(),
        data: new Uint8Array(data),
      };
    },
    list: (space) => listOrigin(origin, space),
    remove: (space, key) => removeOrigin(origin, space, key),
    summarize: (space, category, value) => summarizeValues(space, category, value),
  };
}
