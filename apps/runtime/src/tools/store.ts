import { allFields } from "@engenty-wizards/shared/definition";
import { TableColumnValueError } from "@engenty-wizards/shared/engenty/data-tables";
import type { ListDef } from "@engenty-wizards/shared/store";
import { createTool } from "@mastra/core/tools";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/client.js";
import { parseDocument, type ScanKind, scanDocument } from "../documents/parse.js";
import type { StepContext } from "../engine/types.js";
import { loadAsset } from "../files/storage.js";
import { deleteRows, listRows, readStoreFile, saveRows, storeFiles } from "../store/index.js";
import { attempt, clip, type FileKeeper } from "./shared.js";

/** One upload of the person, as agents name it. */
export interface UploadRef {
  ref: string;
  name: string;
  mime: string;
  field: string;
}

/** Files the person gave on earlier pages: `upload:<id>` is how tools address them. */
export async function personUploads(ctx: StepContext): Promise<UploadRef[]> {
  const out: UploadRef[] = [];
  for (const field of allFields(ctx.def)) {
    if (field.kind !== "image" && field.kind !== "file") {
      continue;
    }
    const value = ctx.state.values[field.id];
    const ids = (Array.isArray(value) ? value : [value]).filter(
      (v): v is string => typeof v === "string" && v.length > 0,
    );
    for (const id of ids) {
      const row = await db.query.asset.findFirst({ where: eq(schema.asset.id, id) });
      if (row?.runId === ctx.runId) {
        out.push({ ref: `upload:${id}`, name: row.name, mime: row.mime, field: field.label });
      }
    }
  }
  return out;
}

/** A file by the name agents use: `upload:<id>` (given by the person) or a path in the store. */
export async function resolveFile(ctx: StepContext, file: string) {
  if (file.startsWith("upload:")) {
    const found = await loadAsset(file.slice("upload:".length));
    if (!found || found.row.runId !== ctx.runId) {
      throw new Error(`No upload ${file}.`);
    }
    return { data: new Uint8Array(found.data), name: found.row.name, mime: found.row.mime };
  }
  const stored = await readStoreFile(ctx.store, file);
  if (!stored) {
    throw new Error(`No file "${file}". Use files_list to see what is kept.`);
  }
  return {
    data: new Uint8Array(stored.data),
    name: stored.file.path.split("/").pop() ?? stored.file.path,
    mime: stored.file.mime,
  };
}

function describeColumns(def: ListDef): string {
  return def.columns
    .map((c) => {
      const rule =
        c.type === "date"
          ? c.format.kind === "date"
            ? "YYYY-MM-DD"
            : c.format.kind
          : c.type === "number"
            ? c.format.style === "currency"
              ? `number, ${c.format.currency}`
              : "number"
            : c.type === "select"
              ? `one of: ${c.format.options.map((o) => o.id).join(", ")}${c.format.allowCustom ? " (or your own)" : ""}`
              : c.type;
      return `${c.id} (${rule}${c.required ? ", required" : ""})`;
    })
    .join("; ");
}

/**
 * What every agent step can do with the wizard's store and the person's files: read and write
 * the lists, read documents (PDF, scans, photos, Word, Excel, CSV, saved mails).
 */
export function storeTools(ctx: StepContext, uploads: UploadRef[], keeper: FileKeeper) {
  const tools: Record<string, any> = {};
  const lists = ctx.def.lists ?? [];
  const charge = (usd: number) => ctx.chargeUsd(usd);

  if (lists.length) {
    const listId = z.enum(lists.map((l) => l.id) as [string, ...string[]]);
    const defOf = (id: string) => lists.find((l) => l.id === id)!;
    const catalog = lists
      .map(
        (l) =>
          `- ${l.id} — ${l.title}${l.shared ? " (shared: every run of the wizard reads and writes the same rows — never repeat other people's rows to the person)" : ""}${l.key ? ` (rows are matched on "${l.key}")` : ""}: ${describeColumns(l)}`,
      )
      .join("\n");

    tools.list_read = createTool({
      id: "list_read",
      description: `Read one of the lists this wizard keeps between runs: for the person, or for every run where the list is shared.\n${catalog}`,
      inputSchema: z.object({ list: listId }),
      execute: ({ list }) =>
        attempt(async () => {
          const rows = await listRows(ctx.store, defOf(list));
          return {
            list,
            total: rows.length,
            rows: rows.slice(0, 300).map((r) => ({ id: r.id, ...r.cells })),
          };
        }),
    });

    tools.list_write = createTool({
      id: "list_write",
      description: `Save rows into one of the wizard's lists, so the next run knows them. A row whose key column matches an existing row updates that row (only the columns you give change); otherwise it is added. Values must fit the column: dates as YYYY-MM-DD, numbers as numbers.\n${catalog}`,
      inputSchema: z.object({
        list: listId,
        rows: z
          .array(z.record(z.string(), z.unknown()))
          .max(200)
          .optional()
          .describe("Rows as { columnId: value }."),
        delete: z
          .array(z.string())
          .max(200)
          .optional()
          .describe("Rows to remove: their key column's value, or their id."),
      }),
      execute: ({ list, rows, delete: remove }) =>
        attempt(async () => {
          const def = defOf(list);
          try {
            const saved = rows?.length
              ? await saveRows(ctx.store, def, rows)
              : { added: 0, updated: 0 };
            const deleted = remove?.length ? await deleteRows(ctx.store, def, remove) : 0;
            await ctx.emit("tool", { code: "remembers", params: { title: def.title } });
            return { ...saved, deleted };
          } catch (err) {
            if (err instanceof TableColumnValueError) {
              return {
                error: `Column "${err.columnId}": ${err.message}. Nothing after that row was saved.`,
              };
            }
            throw err;
          }
        }),
    });
  }

  tools.files_list = createTool({
    id: "files_list",
    description:
      "List the files this wizard keeps for the person (invoices collected on earlier runs, scans …), optionally only one folder.",
    inputSchema: z.object({ folder: z.string().optional() }),
    execute: ({ folder }) =>
      attempt(async () => {
        const files = await storeFiles(ctx.store, folder);
        return {
          total: files.length,
          files: files.slice(0, 300).map((f) => ({
            path: f.path,
            mime: f.mime,
            size: f.size,
            source: f.source,
            date: f.updatedAt.slice(0, 10),
          })),
        };
      }),
  });

  if (uploads.length) {
    tools.files_keep = createTool({
      id: "files_keep",
      description:
        "Keep files the person gave in the wizard's files, several at once: each is stored under `path`, is there on the next run and belongs to this step's result. Returns the path each file now has.",
      inputSchema: z.object({
        items: z
          .array(
            z.object({
              file: z.string().describe("An upload reference, upload:<id>."),
              path: z.string().describe("e.g. belege/2026-09/2026-09-03_Notion_INV-123.pdf"),
            }),
          )
          .min(1)
          .max(40),
      }),
      execute: ({ items }) =>
        attempt(async () => {
          await ctx.emit("tool", { code: "files", params: { count: items.length } });
          const kept: Record<string, unknown>[] = [];
          for (const item of items) {
            try {
              const source = await resolveFile(ctx, item.file);
              const file = await keeper.keep(item.path, source.data, {
                mime: source.mime,
                source: `Von der Person: ${source.name}`,
              });
              kept.push({ file: item.file, path: file.path });
            } catch (err) {
              kept.push({ file: item.file, error: String((err as Error).message).slice(0, 200) });
            }
          }
          return { kept };
        }),
    });
  }

  const fileHint = uploads.length
    ? ` The person gave: ${uploads.map((u) => `${u.ref} (${u.name})`).join(", ")}.`
    : "";

  tools.read_document = createTool({
    id: "read_document",
    description: `Read a document as text: PDF, scan or photo (read by a vision model), Word, Excel, CSV, a saved mail. \`file\` is an upload reference or a path in the wizard's files.${fileHint}`,
    inputSchema: z.object({
      file: z.string(),
      offset: z.number().int().min(0).optional().describe("Start at this character, to read on."),
    }),
    execute: ({ file, offset }) =>
      attempt(async () => {
        const source = await resolveFile(ctx, file);
        await ctx.emit(
          "tool",
          { code: "reads", params: { name: source.name } },
          file.startsWith("upload:") && source.mime.startsWith("image/")
            ? file.slice("upload:".length)
            : undefined,
        );
        const doc = await parseDocument(source, { charge, signal: ctx.signal, call: ctx.call });
        const start = offset ?? 0;
        return {
          file,
          pages: doc.pages,
          readBy: doc.via,
          length: doc.markdown.length,
          text: clip(doc.markdown.slice(start), 12_000),
        };
      }),
  });

  tools.scan_documents = createTool({
    id: "scan_documents",
    description: `Pull the key fields out of invoices or receipts, several at once: vendor, number, dates, net/tax/total, currency, VAT ID. Cheaper and more exact than reading each document yourself. Amounts come back exactly as printed.${fileHint}`,
    inputSchema: z.object({
      files: z.array(z.string()).min(1).max(30),
      kind: z.enum(["invoice", "receipt"]),
    }),
    execute: ({ files, kind }) =>
      attempt(async () => {
        await ctx.emit("tool", { code: "readsMany", params: { count: files.length } });
        const results: Record<string, unknown>[] = [];
        for (let i = 0; i < files.length; i += 4) {
          const batch = await Promise.all(
            files.slice(i, i + 4).map(async (file) => {
              try {
                const source = await resolveFile(ctx, file);
                const scan = await scanDocument(source, kind as ScanKind, {
                  charge,
                  signal: ctx.signal,
                });
                const { line_items: _items, ...fields } = scan as Record<string, unknown>;
                return { file, ...fields };
              } catch (err) {
                return { file, error: String((err as Error).message).slice(0, 200) };
              }
            }),
          );
          results.push(...batch);
        }
        return { documents: results };
      }),
  });

  return tools;
}
