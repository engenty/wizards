import { type Format, formatsFor, type Step, widgetSize } from "@engenty-wizards/shared/definition";
import type { AssetRef, StepOutput } from "@engenty-wizards/shared/run";
import type { ListDef, ListRow } from "@engenty-wizards/shared/store";
import { listAsMarkdown } from "@engenty-wizards/shared/store";
import { and, eq } from "drizzle-orm";
import { zipSync } from "fflate";
import { db, schema } from "../db/client.js";
import { extFor, inlineAssetRefs, loadAsset, loadAssetText, saveAsset } from "../files/storage.js";
import { widgetMp4, widgetPdf, widgetPng } from "../widgets/render.js";
import {
  allTables,
  firstTable,
  htmlToDocx,
  htmlToMarkdown,
  htmlToPdf,
  htmlToPng,
  jsonToMarkdown,
  MIME,
  markdownToHtml,
  tablesToXlsx,
  tableToCsv,
} from "./convert.js";
import { guardHtml } from "./guard.js";
import { shapedCsvRows, shapedMarkdown, shapedTables } from "./shaped.js";

export interface Download {
  data: Uint8Array | string;
  mime: string;
  filename: string;
}

export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/ß/g, "ss")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "result"
  );
}

/**
 * Renders of an asset (PDF, PNG, MP4 …) are kept next to it: a shared link opened a hundred
 * times renders once. A regenerated output is a new asset, so its renders start fresh.
 */
async function cachedRender(
  source: AssetRef,
  format: Format,
  produce: () => Promise<Uint8Array | null>,
): Promise<Uint8Array | null> {
  const name = `${source.id}.${format}`;
  const hit = await db.query.asset.findFirst({
    where: and(eq(schema.asset.kind, "render"), eq(schema.asset.name, name)),
  });
  if (hit) {
    const found = await loadAsset(hit.id);
    if (found) {
      return new Uint8Array(found.data);
    }
  }
  const data = await produce();
  if (data) {
    const row = await db.query.asset.findFirst({ where: eq(schema.asset.id, source.id) });
    await saveAsset({
      runId: row?.runId ?? null,
      stepId: row?.stepId ?? null,
      kind: "render",
      mime: MIME[format],
      name,
      data,
    });
  }
  return data;
}

/** The HTML a step produced, ready to show or save: images inlined, network and frames locked. */
export async function stepHtml(output: StepOutput): Promise<string | null> {
  const asset = output.assets?.find((a) => a.mime === "text/html");
  if (!asset) {
    return null;
  }
  return guardHtml(await inlineAssetRefs(await loadAssetText(asset.id)));
}

/** One step's output in one format. Conversions happen on demand. */
export async function renderDownload(
  step: Step,
  output: StepOutput,
  format: Format,
  baseName: string,
): Promise<Download | null> {
  if (!formatsFor(step).includes(format)) {
    return null;
  }
  const name = slug(baseName);
  const file = (ext: string) => `${name}.${ext}`;

  if ((step.type === "widget" && step.video) || step.type === "film") {
    // A film was rendered when its step ran: the video and its poster are the files.
    const asset = output.assets?.find((a) => a.kind === (format === "mp4" ? "video" : "poster"));
    const found = asset ? await loadAsset(asset.id) : null;
    return found
      ? { data: new Uint8Array(found.data), mime: found.row.mime, filename: file(format) }
      : null;
  }

  if (step.type === "surface") {
    return {
      data: JSON.stringify(output.surface ?? {}, null, 2),
      mime: MIME.json,
      filename: file("json"),
    };
  }

  if (step.type === "widget") {
    const source = output.assets?.find((a) => a.mime === "text/html");
    if (format === "json") {
      return {
        data: JSON.stringify(output.json ?? {}, null, 2),
        mime: MIME.json,
        filename: file("json"),
      };
    }
    if (!source) {
      return null;
    }
    const html = await loadAssetText(source.id);
    const size = widgetSize(step);
    const data =
      format === "html"
        ? html
        : await cachedRender(source, format, async () => {
            // Pictures the widget took from the web are assets: the renderer gets them inline.
            const inlined = await inlineAssetRefs(html);
            switch (format) {
              case "png":
                return widgetPng(inlined, size);
              case "pdf":
                return widgetPdf(inlined, size);
              case "mp4":
                return output.widget?.duration ? widgetMp4(inlined, size) : null;
              default:
                return null;
            }
          });
    return data ? { data, mime: MIME[format], filename: file(format) } : null;
  }

  if (step.type === "generate") {
    const asset = output.assets?.[0];
    if (!asset) {
      return null;
    }
    if (format === "zip") {
      const zip = await zipAssets(output.assets ?? []);
      return zip ? { data: zip, mime: MIME.zip, filename: file("zip") } : null;
    }
    if (step.asset === "image" || step.asset === "video" || step.asset === "voice") {
      const found = await loadAsset(asset.id);
      return found
        ? {
            data: new Uint8Array(found.data),
            mime: found.row.mime,
            filename: file(extFor(found.row.mime)),
          }
        : null;
    }
    const html = await inlineAssetRefs(await loadAssetText(asset.id));
    const render = (produce: () => Promise<Uint8Array>) =>
      cachedRender(asset, format, produce) as Promise<Uint8Array>;
    switch (format) {
      case "html":
        return { data: guardHtml(html), mime: MIME.html, filename: file("html") };
      case "pdf":
        return { data: await render(() => htmlToPdf(html)), mime: MIME.pdf, filename: file("pdf") };
      case "png":
        return { data: await render(() => htmlToPng(html)), mime: MIME.png, filename: file("png") };
      case "docx":
        return {
          data: await render(() => htmlToDocx(html)),
          mime: MIME.docx,
          filename: file("docx"),
        };
      case "md":
        return { data: htmlToMarkdown(html), mime: MIME.md, filename: file("md") };
      default:
        return null;
    }
  }

  if (step.type === "agent") {
    if (format === "zip") {
      const zip = await zipAssets(output.assets?.filter((a) => a.kind === "file") ?? []);
      return zip ? { data: zip, mime: MIME.zip, filename: file("zip") } : null;
    }
    const text = output.text ?? "";
    if (step.output.format === "json") {
      // A step with a schema: its lists by their labels, the tree as headings.
      const shape = step.output.schema;
      const data = (output.json ?? {}) as Record<string, unknown>;
      const rows = shape ? shapedCsvRows(shape, data) : firstTable(output.json);
      const tables = shape ? shapedTables(shape, data) : allTables(output.json);
      const md = shape
        ? `# ${baseName}\n\n${shapedMarkdown(shape, data)}`
        : jsonAsMarkdown(output.json);
      switch (format) {
        case "json":
          return {
            data: JSON.stringify(output.json, null, 2),
            mime: MIME.json,
            filename: file("json"),
          };
        case "csv":
          return rows ? { data: tableToCsv(rows), mime: MIME.csv, filename: file("csv") } : null;
        case "xlsx":
          return tables.length
            ? { data: await tablesToXlsx(tables), mime: MIME.xlsx, filename: file("xlsx") }
            : null;
        case "md":
          return { data: md, mime: MIME.md, filename: file("md") };
        case "pdf":
          return {
            data: await htmlToPdf(markdownToHtml(md, baseName)),
            mime: MIME.pdf,
            filename: file("pdf"),
          };
        default:
          return null;
      }
    }
    switch (format) {
      case "md":
        return { data: text, mime: MIME.md, filename: file("md") };
      case "txt":
        return { data: text, mime: MIME.txt, filename: file("txt") };
      case "html":
        return { data: markdownToHtml(text, baseName), mime: MIME.html, filename: file("html") };
      case "pdf":
        return {
          data: await htmlToPdf(markdownToHtml(text, baseName)),
          mime: MIME.pdf,
          filename: file("pdf"),
        };
      case "docx":
        return {
          data: await htmlToDocx(markdownToHtml(text, baseName)),
          mime: MIME.docx,
          filename: file("docx"),
        };
      default:
        return null;
    }
  }
  return null;
}

/** A structured result as readable Markdown: text fields as paragraphs, tables as tables. */
/** The files a step collected, as one archive. Two files of the same name both stay. */
async function zipAssets(assets: AssetRef[]): Promise<Uint8Array | null> {
  const entries: Record<string, Uint8Array> = {};
  for (const asset of assets) {
    const found = await loadAsset(asset.id);
    if (!found) {
      continue;
    }
    let name = asset.name;
    for (let n = 2; name in entries; n++) {
      name = asset.name.replace(/(\.[^.]+)?$/, (ext) => `-${n}${ext}`);
    }
    entries[name] = new Uint8Array(found.data);
  }
  return Object.keys(entries).length ? zipSync(entries, { level: 6 }) : null;
}

/**
 * A stored list in one format. Column labels head the spreadsheet; ids stay the JSON keys.
 * `files` reads a kept file by its path — a zip holds the files the rows name, and the list.
 */
export async function listDownload(
  def: ListDef,
  rows: ListRow[],
  format: Format,
  baseName: string,
  files?: (path: string) => Promise<Uint8Array | null>,
): Promise<Download | null> {
  const name = slug(baseName);
  if (format === "zip") {
    const column = def.check?.file;
    if (!column || !files) {
      return null;
    }
    const entries: Record<string, Uint8Array> = {};
    for (const row of rows) {
      const path = String(row.cells[column] ?? "").trim();
      const data = path && !(path in entries) ? await files(path) : null;
      if (data) {
        entries[path] = data;
      }
    }
    const sheet = await listDownload(def, rows, "xlsx", baseName);
    if (sheet) {
      entries[sheet.filename] = sheet.data as Uint8Array;
    }
    return { data: zipSync(entries, { level: 6 }), mime: MIME.zip, filename: `${name}.zip` };
  }
  const cells = rows.map((r) => r.cells);
  const headers = Object.fromEntries(def.columns.map((c) => [c.id, c.name]));
  const labelled = cells.map((row) =>
    Object.fromEntries(def.columns.map((c) => [c.name, row[c.id] ?? null])),
  );
  switch (format) {
    case "xlsx":
      return {
        data: await tablesToXlsx([{ name: def.title, rows: cells, headers }]),
        mime: MIME.xlsx,
        filename: `${name}.xlsx`,
      };
    case "csv":
      return { data: tableToCsv(labelled), mime: MIME.csv, filename: `${name}.csv` };
    case "json":
      return { data: JSON.stringify(cells, null, 2), mime: MIME.json, filename: `${name}.json` };
    case "md":
      return {
        data: `# ${def.title}\n\n${listAsMarkdown(def, rows, 5000)}`,
        mime: MIME.md,
        filename: `${name}.md`,
      };
    default:
      return null;
  }
}

export function jsonAsMarkdown(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return jsonToMarkdown(value);
  }
  return Object.entries(value as Record<string, unknown>)
    .map(([key, v]) => {
      const heading = `### ${key}`;
      if (typeof v === "string" || typeof v === "number") {
        return `${heading}\n${v}`;
      }
      if (Array.isArray(v) && v.every((x) => typeof x !== "object")) {
        return `${heading}\n${v.map((x) => `- ${x}`).join("\n")}`;
      }
      return `${heading}\n${jsonToMarkdown(v)}`;
    })
    .join("\n\n");
}
