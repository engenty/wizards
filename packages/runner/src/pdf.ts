import { marked, type Token, type Tokens } from "marked";
import type { Content, TableCell, TDocumentDefinitions } from "pdfmake/interfaces";
import { t } from "./i18n.js";

/**
 * A written output as a PDF, made in the browser. A host whose server writes no PDF (the
 * WordPress plugin: PHP, no Chromium) still hands the visitor the file the result step
 * promised: pdfmake lays it out from a content tree — a Markdown text through marked's tokens,
 * a structured output as the result page shows it (label, value, list, table) — with Roboto
 * bundled, so German, Czech or Polish read as written. The library and its fonts weigh about
 * 1.5 MB and are loaded on the first click only; the content tree itself is small and pure.
 */

export interface Written {
  /** The step's title: the document's heading and the file's name. */
  title: string;
  /** A Markdown or plain text. */
  text?: string;
  /** A structured output; its keys are named by `label`. */
  json?: unknown;
  /** What a key of the structured output is called (the step's output fields). */
  label?: (key: string) => string;
  /** The line at the foot of every page: the wizard, the date. */
  foot?: string;
}

/** A run of text with its look, as pdfmake takes it. */
interface Run {
  text: string;
  bold?: boolean;
  italics?: boolean;
  link?: string;
  color?: string;
  decoration?: "underline" | "lineThrough";
}

const INK = "#282623";
const INK_3 = "#81807e";
const LINK = "#1a5fb4";
const LINE = "#dbd9d6";
/** A4 less the margins: what a rule spans. */
const TEXT_WIDTH = 595.28 - 2 * 56;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
  nbsp: " ",
};

/** marked keeps some text escaped for HTML; a PDF wants the characters. */
function plain(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (all, name: string) => {
    if (name[0] === "#") {
      const code =
        name[1]?.toLowerCase() === "x" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : all;
    }
    return ENTITIES[name.toLowerCase()] ?? all;
  });
}

/** Tags out of a raw HTML token: its text is what a PDF can hold. */
function untagged(html: string): string {
  return plain(html.replace(/<[^>]+>/g, "")).trim();
}

/** Inline tokens as runs: bold, italics, code, links and line breaks kept; images as their text. */
function runs(tokens: Token[] | undefined, look: Omit<Run, "text"> = {}): Run[] {
  const out: Run[] = [];
  for (const token of tokens ?? []) {
    switch (token.type) {
      case "text": {
        const inner = (token as Tokens.Text).tokens;
        if (inner?.length) {
          out.push(...runs(inner, look));
        } else {
          out.push({ ...look, text: plain(token.text) });
        }
        break;
      }
      case "escape":
        out.push({ ...look, text: plain(token.text) });
        break;
      case "strong":
        out.push(...runs((token as Tokens.Strong).tokens, { ...look, bold: true }));
        break;
      case "em":
        out.push(...runs((token as Tokens.Em).tokens, { ...look, italics: true }));
        break;
      case "del":
        out.push(...runs((token as Tokens.Del).tokens, { ...look, decoration: "lineThrough" }));
        break;
      case "codespan":
        out.push({ ...look, text: plain(token.text), color: "#3d3b38" });
        break;
      case "link": {
        const link = token as Tokens.Link;
        out.push(
          ...runs(link.tokens, { ...look, link: link.href, color: LINK, decoration: "underline" }),
        );
        break;
      }
      case "image":
        out.push({ ...look, text: (token as Tokens.Image).text });
        break;
      case "br":
        out.push({ ...look, text: "\n" });
        break;
      case "html":
        out.push({ ...look, text: untagged(token.text) });
        break;
      default:
        if ("tokens" in token && Array.isArray(token.tokens)) {
          out.push(...runs(token.tokens, look));
        } else if ("text" in token && typeof token.text === "string") {
          out.push({ ...look, text: plain(token.text) });
        }
    }
  }
  return out;
}

/** A list item: its own text without a paragraph's space under it, a nested list below. */
function item(tokens: Token[]): Content {
  const parts = blocks(tokens);
  if (parts.length === 1 && typeof parts[0] === "object" && "style" in parts[0]) {
    const { style: _, ...rest } = parts[0];
    return rest as Content;
  }
  return parts.length === 1 ? parts[0] : { stack: parts };
}

function cell(c: Tokens.TableCell, header: boolean): TableCell {
  return {
    text: runs(c.tokens),
    alignment: c.align ?? "left",
    ...(header ? { style: "th" } : {}),
  };
}

/** Thin rules between the rows, nothing between the columns. */
const TABLE_LAYOUT = {
  hLineWidth: () => 0.5,
  vLineWidth: () => 0,
  hLineColor: () => LINE,
  paddingTop: () => 4,
  paddingBottom: () => 4,
};

/** Block tokens as pdfmake content. */
function blocks(tokens: Token[]): Content[] {
  const out: Content[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "space":
        break;
      case "heading": {
        const depth = (token as Tokens.Heading).depth;
        out.push({
          text: runs((token as Tokens.Heading).tokens),
          style: depth <= 1 ? "h1" : depth === 2 ? "h2" : "h3",
        });
        break;
      }
      case "paragraph":
        out.push({ text: runs((token as Tokens.Paragraph).tokens), style: "p" });
        break;
      case "text":
        out.push({ text: runs([token]), style: "p" });
        break;
      case "list": {
        const list = token as Tokens.List;
        const items = list.items.map((i) => item(i.tokens));
        out.push(
          list.ordered
            ? { ol: items, style: "list", start: Number(list.start) || 1 }
            : { ul: items, style: "list" },
        );
        break;
      }
      case "table": {
        const table = token as Tokens.Table;
        if (!table.header.length) {
          break;
        }
        out.push({
          table: {
            headerRows: 1,
            widths: table.header.map(() => "*"),
            body: [
              table.header.map((c) => cell(c, true)),
              ...table.rows.map((row) => row.map((c) => cell(c, false))),
            ],
          },
          layout: TABLE_LAYOUT,
          style: "table",
        });
        break;
      }
      case "code":
        out.push({ text: plain(token.text), style: "code", preserveLeadingSpaces: true });
        break;
      case "blockquote":
        out.push({ stack: blocks((token as Tokens.Blockquote).tokens), style: "quote" });
        break;
      case "hr":
        out.push({
          canvas: [
            { type: "line", x1: 0, y1: 0, x2: TEXT_WIDTH, y2: 0, lineWidth: 0.5, lineColor: LINE },
          ],
          margin: [0, 6, 0, 12],
        });
        break;
      case "html": {
        const text = untagged(token.text);
        if (text) {
          out.push({ text, style: "p" });
        }
        break;
      }
      default:
        if ("tokens" in token && Array.isArray(token.tokens)) {
          out.push({ text: runs(token.tokens), style: "p" });
        } else if ("text" in token && typeof token.text === "string") {
          out.push({ text: plain(token.text), style: "p" });
        }
    }
  }
  return out;
}

/** A Markdown text as content. */
export function markdownContent(text: string): Content[] {
  return blocks(marked.lexer(text));
}

/** A structured output as the result page shows it: each key with its label, then its value. */
export function jsonContent(json: unknown, label: (key: string) => string = (k) => k): Content[] {
  if (!json || typeof json !== "object") {
    return [{ text: JSON.stringify(json, null, 2) ?? "", style: "code" }];
  }
  const out: Content[] = [];
  for (const [key, v] of Object.entries(json as Record<string, unknown>)) {
    out.push({ text: label(key), style: "label" });
    if (typeof v === "boolean") {
      out.push({ text: t(v ? "run.yes" : "run.no"), style: "p" });
    } else if (typeof v === "string" || typeof v === "number") {
      out.push({ text: String(v), style: "p" });
    } else if (Array.isArray(v) && v.every((x) => typeof x !== "object")) {
      out.push({ ul: v.map((x) => String(x)), style: "list" });
    } else if (Array.isArray(v) && v.length && typeof v[0] === "object") {
      const rows = v as Record<string, unknown>[];
      const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
      out.push({
        table: {
          headerRows: 1,
          widths: cols.map(() => "*"),
          body: [
            cols.map((c): TableCell => ({ text: c, style: "th" })),
            ...rows.map((r) =>
              cols.map(
                (c): TableCell => ({
                  text: r[c] === null || r[c] === undefined ? "" : String(r[c]),
                }),
              ),
            ),
          ],
        },
        layout: TABLE_LAYOUT,
        style: "table",
      });
    } else {
      out.push({ text: JSON.stringify(v, null, 2), style: "code" });
    }
  }
  return out;
}

/** The document: A4, the title first, the body, a foot with the page number. */
export function pdfDocument(written: Written): TDocumentDefinitions {
  const body =
    written.json !== undefined && written.json !== null
      ? jsonContent(written.json, written.label)
      : markdownContent(written.text ?? "");
  const foot = written.foot ?? "";
  return {
    info: { title: written.title },
    pageSize: "A4",
    pageMargins: [56, 60, 56, 64],
    defaultStyle: { font: "Roboto", fontSize: 10.5, lineHeight: 1.3, color: INK },
    styles: {
      title: { fontSize: 20, bold: true, lineHeight: 1.15, margin: [0, 0, 0, 16] },
      h1: { fontSize: 15, bold: true, margin: [0, 14, 0, 6] },
      h2: { fontSize: 13, bold: true, margin: [0, 12, 0, 5] },
      h3: { fontSize: 11, bold: true, margin: [0, 10, 0, 4] },
      p: { margin: [0, 0, 0, 7] },
      list: { margin: [0, 0, 0, 7] },
      table: { margin: [0, 2, 0, 10] },
      th: { bold: true, fillColor: "#f3f1ee" },
      label: { fontSize: 8, bold: true, color: INK_3, characterSpacing: 0.6, margin: [0, 8, 0, 2] },
      code: { fontSize: 9, color: "#3d3b38", margin: [0, 0, 0, 8] },
      quote: { italics: true, color: "#5d5b58", margin: [14, 0, 0, 8] },
    },
    content: [{ text: written.title, style: "title" }, ...body],
    footer: (page, pages) => ({
      columns: [
        { text: foot, color: INK_3, fontSize: 8.5 },
        { text: `${page} / ${pages}`, alignment: "right", color: INK_3, fontSize: 8.5 },
      ],
      margin: [56, 26, 56, 0],
    }),
  };
}

/** pdfmake's browser build as it is loaded: one object with the calls used here. */
interface PdfMake {
  addVirtualFileSystem(vfs: Record<string, string>): void;
  addFonts(fonts: Record<string, Record<string, string>>): void;
  createPdf(doc: TDocumentDefinitions): { getBlob(): Promise<Blob> };
}

/** The fonts in pdfmake's own file: Roboto in four cuts. */
export const ROBOTO = {
  Roboto: {
    normal: "Roboto-Regular.ttf",
    bold: "Roboto-Medium.ttf",
    italics: "Roboto-Italic.ttf",
    bolditalics: "Roboto-MediumItalic.ttf",
  },
};

let loading: Promise<PdfMake> | null = null;

/** The library with Roboto, fetched once. */
function pdfMake(): Promise<PdfMake> {
  loading ??= Promise.all([
    import("pdfmake/build/pdfmake") as Promise<{ default: PdfMake }>,
    import("pdfmake/build/vfs_fonts") as Promise<{ default: Record<string, string> }>,
  ])
    .then(([lib, fonts]) => {
      const pdf = lib.default;
      pdf.addVirtualFileSystem(fonts.default);
      pdf.addFonts(ROBOTO);
      return pdf;
    })
    .catch((err) => {
      loading = null;
      throw err;
    });
  return loading;
}

/** A title as a file name: what no file system refuses. */
export function fileName(title: string): string {
  return (
    title
      .replace(/[\\/:*?"<>|]+|\p{Cc}+/gu, "-")
      .replace(/\s+/g, " ")
      .trim() || "result"
  );
}

/** The written output as a PDF file. */
export async function writePdf(written: Written): Promise<File> {
  const pdf = await pdfMake();
  const blob = await pdf.createPdf(pdfDocument(written)).getBlob();
  return new File([blob], `${fileName(written.title)}.pdf`, { type: "application/pdf" });
}
