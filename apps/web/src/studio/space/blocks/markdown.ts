// Markdown ⇄ the block editor's document (ProseMirror JSON). From peer-it's docs app
// (packages/docs-ui/src/blocks/markdown.ts).
//
// A page stays Markdown, and a small edit gives a small change of its text (and of what a live
// change merges with `mergeText`):
// - Each top-level block keeps the source it was read from. A block the editor leaves as it was is
//   written back from that source, byte for byte, with the blank lines that followed it.
// - A block that changed is written in one style: `-` lists, `|` tables with `---`,
//   `#` headings, `**` bold. Line breaks inside a paragraph are kept (`softBreak`), so editing a
//   hard-wrapped paragraph changes the lines that were edited.
// - What the editor can't show (frontmatter, HTML, link definitions, footnotes, a list mixing
//   tasks and items) stays as a markdown block (`rawMarkdown`), edited as text.
// A block is shown as blocks only when writing it again renders the same HTML as its source.

import { marked, type Token, type Tokens } from "marked";

export interface Mark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface Json {
  type: string;
  attrs?: Record<string, unknown>;
  content?: Json[];
  marks?: Mark[];
  text?: string;
}

export interface SourceBlock {
  /** The markdown the block was read from, without the line breaks after it. */
  raw: string;
  /** What followed it up to the next block: line breaks and blank lines. */
  after: string;
}

export interface Parsed {
  doc: Json;
  /** One per top-level node of `doc`. */
  blocks: SourceBlock[];
  /** Blank lines before the first block. */
  lead: string;
  crlf: boolean;
}

class Unsupported extends Error {}

const html = (md: string) => marked.parse(md, { gfm: true, async: false }) as string;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};
const decode = (s: string) =>
  s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code =
        e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });

const sameMark = (a: Mark, b: Mark) =>
  a.type === b.type && JSON.stringify(a.attrs ?? {}) === JSON.stringify(b.attrs ?? {});

function text(value: string, marks: Mark[]): Json {
  return marks.length ? { type: "text", text: value, marks } : { type: "text", text: value };
}

function inline(tokens: Token[] | undefined, marks: Mark[] = []): Json[] {
  const out: Json[] = [];
  for (const t of tokens ?? []) {
    switch (t.type) {
      case "text":
        if ("tokens" in t && t.tokens?.length) {
          out.push(...inline(t.tokens, marks));
        } else {
          // A line break inside a paragraph stays a line break in the file.
          decode(t.text)
            .split("\n")
            .forEach((line, i) => {
              if (i > 0) {
                out.push({ type: "softBreak" });
              }
              if (line) {
                out.push(text(line, marks));
              }
            });
        }
        break;
      case "escape":
        out.push(text(t.text, marks));
        break;
      case "strong":
        out.push(...inline(t.tokens, [...marks, { type: "bold" }]));
        break;
      case "em":
        out.push(...inline(t.tokens, [...marks, { type: "italic" }]));
        break;
      case "del":
        out.push(...inline(t.tokens, [...marks, { type: "strike" }]));
        break;
      case "codespan":
        out.push(text(t.text, [...marks, { type: "code" }]));
        break;
      case "link": {
        const l = t as Tokens.Link & { autolink?: boolean };
        const auto =
          l.autolink || /^<[^>]+>$/.test(l.raw) ? (l.raw.startsWith("<") ? "angle" : "bare") : null;
        const attrs: Record<string, unknown> = { href: l.href };
        if (l.title) {
          attrs.title = l.title;
        }
        if (auto) {
          attrs.auto = auto;
        }
        out.push(...inline(l.tokens, [...marks, { type: "link", attrs }]));
        break;
      }
      case "image": {
        const attrs: Record<string, unknown> = { src: t.href, alt: decode(t.text) };
        if (t.title) {
          attrs.title = t.title;
        }
        out.push(marks.length ? { type: "image", attrs, marks } : { type: "image", attrs });
        break;
      }
      case "br":
        out.push({ type: "hardBreak" });
        break;
      case "html":
        if (/^<br\s*\/?>$/i.test(t.raw)) {
          out.push({ type: "hardBreak" });
          break;
        }
        throw new Unsupported(t.type);
      case "checkbox":
        break;
      default:
        throw new Unsupported(t.type);
    }
  }
  // Neighbouring text with the same marks is one text node, as ProseMirror keeps it.
  const merged: Json[] = [];
  for (const n of out) {
    const prev = merged[merged.length - 1];
    if (
      prev?.type === "text" &&
      n.type === "text" &&
      (prev.marks ?? []).length === (n.marks ?? []).length &&
      (prev.marks ?? []).every((m, i) => sameMark(m, n.marks![i]!))
    ) {
      merged[merged.length - 1] = { ...prev, text: (prev.text ?? "") + (n.text ?? "") };
    } else {
      merged.push(n);
    }
  }
  return merged;
}

function paragraph(content: Json[]): Json {
  // A list item's text can end in its line break.
  const end = content.findLastIndex((n) => n.type !== "softBreak");
  const kept = content.slice(0, end + 1);
  return kept.length ? { type: "paragraph", content: kept } : { type: "paragraph" };
}

function blocks(tokens: Token[]): Json[] {
  return tokens.filter((t) => t.type !== "space" && t.type !== "checkbox").map(block);
}

function block(t: Token): Json {
  switch (t.type) {
    case "paragraph":
      if (/^\[\^[^\]]+\]:/.test(t.raw)) {
        throw new Unsupported("footnote");
      }
      return paragraph(inline(t.tokens));
    case "text":
      return paragraph(inline("tokens" in t && t.tokens ? t.tokens : [t]));
    case "heading":
      return { type: "heading", attrs: { level: t.depth }, content: inline(t.tokens) };
    case "hr":
      return { type: "horizontalRule", attrs: { markup: t.raw.trim() } };
    case "code": {
      const fence = t.raw.match(/^ {0,3}(`{3,}|~{3,})/)?.[1] ?? "indent";
      const attrs = { language: t.lang || null, fence };
      return t.text
        ? { type: "codeBlock", attrs, content: [{ type: "text", text: t.text }] }
        : { type: "codeBlock", attrs };
    }
    case "blockquote":
      return { type: "blockquote", content: nonEmpty(blocks(t.tokens ?? [])) };
    case "list":
      return list(t as Tokens.List);
    case "table":
      return table(t as Tokens.Table);
    default:
      throw new Unsupported(t.type);
  }
}

const nonEmpty = (content: Json[]) => (content.length ? content : [paragraph([])]);

function list(t: Tokens.List): Json {
  const tasks = t.items.filter((i) => i.task).length;
  if (tasks && tasks !== t.items.length) {
    throw new Unsupported("mixed task list");
  }
  const tight = !t.loose;
  if (t.ordered) {
    const delim = t.raw.match(/^ *\d+([.)])/)?.[1] ?? ".";
    return {
      type: "orderedList",
      attrs: { start: Number(t.start === "" ? 1 : t.start), tight, delim },
      content: t.items.map((i) => ({ type: "listItem", content: nonEmpty(blocks(i.tokens)) })),
    };
  }
  const bullet = t.raw.trimStart()[0] ?? "-";
  return {
    type: tasks ? "taskList" : "bulletList",
    attrs: { tight, bullet },
    content: t.items.map((i) =>
      tasks
        ? {
            type: "taskItem",
            attrs: { checked: Boolean(i.checked) },
            content: nonEmpty(blocks(i.tokens)),
          }
        : { type: "listItem", content: nonEmpty(blocks(i.tokens)) },
    ),
  };
}

function table(t: Tokens.Table): Json {
  const cell = (type: string, c: Tokens.TableCell, align: string | null): Json => ({
    type,
    attrs: { align },
    content: [paragraph(inline(c.tokens))],
  });
  return {
    type: "table",
    content: [
      {
        type: "tableRow",
        content: t.header.map((c, i) => cell("tableHeader", c, t.align[i] ?? null)),
      },
      ...t.rows.map((r) => ({
        type: "tableRow",
        content: r.map((c, i) => cell("tableCell", c, t.align[i] ?? null)),
      })),
    ],
  };
}

const rawBlock = (raw: string): Json =>
  raw ? { type: "rawMarkdown", content: [{ type: "text", text: raw }] } : { type: "rawMarkdown" };

const FRONTMATTER = /^(---|\+\+\+)\n[\s\S]*?\n\1[ \t]*(?:\n|$)/;

export function parseMarkdown(source: string): Parsed {
  const crlf = source.includes("\r\n");
  let rest = crlf ? source.replace(/\r\n/g, "\n") : source;
  const content: Json[] = [];
  const out: SourceBlock[] = [];
  let lead = "";

  const front = rest.match(FRONTMATTER)?.[0];
  if (front) {
    const raw = front.replace(/\n+$/, "");
    content.push(rawBlock(raw));
    out.push({ raw, after: front.slice(raw.length) });
    rest = rest.slice(front.length);
  }

  const tokens = marked.lexer(rest, { gfm: true });
  if (tokens.map((t) => t.raw).join("") !== rest) {
    // marked changed something on the way (tabs, odd line breaks): keep the file as text.
    return {
      doc: { type: "doc", content: [rawBlock(source.replace(/\n+$/, ""))] },
      blocks: [{ raw: source.replace(/\n+$/, ""), after: source.match(/\n*$/)?.[0] ?? "" }],
      lead: "",
      crlf: false,
    };
  }
  // Link definitions go along when a block is checked on its own, for `[text][ref]`.
  const defs = tokens
    .filter((t) => t.type === "def")
    .map((t) => t.raw.trim())
    .join("\n");
  const check = (md: string) => html(defs ? `${md}\n\n${defs}` : md);

  for (const t of tokens) {
    if (t.type === "space") {
      const last = out[out.length - 1];
      if (last) {
        last.after += t.raw;
      } else {
        lead += t.raw;
      }
      continue;
    }
    const raw = t.raw.replace(/\n+$/, "");
    let node: Json;
    try {
      node = block(t);
      if (check(serializeBlock(node)) !== check(raw)) {
        node = rawBlock(raw);
      }
    } catch (e) {
      if (!(e instanceof Unsupported)) {
        throw e;
      }
      node = rawBlock(raw);
    }
    content.push(node);
    out.push({ raw, after: t.raw.slice(raw.length) });
  }
  return { doc: { type: "doc", content: nonEmpty(content) }, blocks: out, lead, crlf };
}

/** Markdown pasted or uploaded into a page, as nodes to insert. */
export const markdownToNodes = (md: string) => parseMarkdown(md).doc.content ?? [];

/* ── Writing ── */

/**
 * The doc as markdown. `source` is what it was read from, with `keys` the top-level nodes as
 * they were then (JSON). A node equal to one of them is written as its source.
 */
export function toMarkdown(
  nodes: Json[],
  source: { parsed: Parsed; keys: string[] },
  keyOf: (node: Json, i: number) => string = (n) => JSON.stringify(n),
): string {
  const { blocks: src, lead, crlf } = source.parsed;
  const free = new Map<string, number[]>();
  source.keys.forEach((k, i) => {
    free.set(k, [...(free.get(k) ?? []), i]);
  });
  // Empty paragraphs have no markdown.
  const kept = nodes
    .map((node, i) => ({ node, key: keyOf(node, i) }))
    .filter(({ node }) => node.type !== "paragraph" || (node.content?.length ?? 0) > 0);
  // Which source block each node is: an unchanged one by its content, an edited one by where it
  // sits (between two unchanged blocks with as many sources between them as edited nodes). A
  // block a page has several times is the one nearest to where the node sits: the first free one
  // would shift every copy after an edited one.
  const at: (number | null)[] = [];
  let expected = 0;
  for (const { key } of kept) {
    const candidates = free.get(key) ?? [];
    let best = -1;
    candidates.forEach((index, k) => {
      if (
        best < 0 ||
        Math.abs(index - expected) < Math.abs((candidates[best] as number) - expected)
      ) {
        best = k;
      }
    });
    const index = best < 0 ? null : (candidates.splice(best, 1)[0] as number);
    at.push(index);
    expected = index === null ? expected + 1 : index + 1;
  }
  for (let i = 0; i < at.length; i++) {
    if (at[i] !== null) {
      continue;
    }
    let j = i;
    while (j < at.length && at[j] === null) {
      j++;
    }
    const before = i > 0 ? (at[i - 1] as number) : -1;
    const after = j < at.length ? (at[j] as number) : src.length;
    if (after - before - 1 === j - i) {
      for (let k = i; k < j; k++) {
        at[k] = before + 1 + (k - i);
      }
    }
    i = j;
  }

  let out = kept.length && at[0] === 0 ? lead : "";
  kept.forEach(({ node, key }, i) => {
    const index = at[i];
    const unchanged = index !== null && index !== undefined && source.keys[index] === key;
    out += unchanged ? src[index]!.raw : serializeBlock(node);
    const next = at[i + 1];
    if (i === kept.length - 1) {
      out += index === src.length - 1 ? src[index]!.after : "\n";
    } else {
      out +=
        index !== null && index !== undefined && next === index + 1 ? src[index]!.after : "\n\n";
    }
  });
  return crlf ? out.replace(/\n/g, "\r\n") : out;
}

/** One block as markdown, without a line break at the end. */
export function serializeBlock(node: Json): string {
  const children = node.content ?? [];
  switch (node.type) {
    case "paragraph":
      return inlineMd(children);
    case "heading":
      return `${"#".repeat(Number(node.attrs?.level ?? 1))} ${inlineMd(children, { inLine: true })}`.trimEnd();
    case "horizontalRule":
      return String(node.attrs?.markup ?? "---");
    case "codeBlock": {
      const code = children.map((c) => c.text ?? "").join("");
      const fence = String(node.attrs?.fence ?? "```");
      if (fence === "indent") {
        return code
          .split("\n")
          .map((l) => (l ? `    ${l}` : l))
          .join("\n");
      }
      const runs = code.match(fence[0] === "~" ? /~{3,}/g : /`{3,}/g) ?? [];
      const longest = Math.max(fence.length - 1, ...runs.map((r) => r.length));
      const f = fence[0]!.repeat(longest + 1);
      return `${f}${node.attrs?.language ?? ""}\n${code}${code ? "\n" : ""}${f}`;
    }
    case "blockquote":
      return blocksMd(children, false)
        .split("\n")
        .map((line) => (line ? `> ${line}` : ">"))
        .join("\n");
    case "bulletList":
    case "taskList":
    case "orderedList": {
      const tight = node.attrs?.tight !== false;
      const start = Number(node.attrs?.start ?? 1);
      return children
        .map((item, i) => {
          const marker =
            node.type === "orderedList"
              ? `${start + i}${node.attrs?.delim ?? "."} `
              : `${node.attrs?.bullet ?? "-"} `;
          const box = item.type === "taskItem" ? `[${item.attrs?.checked ? "x" : " "}] ` : "";
          const body = blocksMd(item.content ?? [], tight);
          return prefix(box + body, marker, " ".repeat(marker.length));
        })
        .join(tight ? "\n" : "\n\n");
    }
    case "table":
      return tableMd(node);
    case "rawMarkdown":
      return children.map((c) => c.text ?? "").join("");
    default:
      return inlineMd(children);
  }
}

function blocksMd(nodes: Json[], tight: boolean) {
  return nodes
    .filter((n, i) => n.type !== "paragraph" || n.content?.length || i === 0)
    .map(serializeBlock)
    .join(tight ? "\n" : "\n\n");
}

/** Prefixes the first line with `first` and the others with `rest`; blank lines stay blank. */
function prefix(text: string, first: string, rest: string) {
  return text
    .split("\n")
    .map((line, i) => (i === 0 ? first + line : line ? rest + line : line))
    .join("\n");
}

function tableMd(node: Json) {
  const rows = node.content ?? [];
  const cells = rows.map((r) =>
    (r.content ?? []).map((c) =>
      (c.content ?? [])
        .map((p) => inlineMd(p.content ?? [], { table: true, inLine: true }))
        .filter(Boolean)
        .join("<br>"),
    ),
  );
  const width = Math.max(1, ...cells.map((r) => r.length));
  const line = (r: string[]) =>
    `|${Array.from({ length: width }, (_, i) => (r[i] ? ` ${r[i]} ` : " ")).join("|")}|`;
  const aligns = (rows[0]?.content ?? []).map((c) => c.attrs?.align ?? null);
  const rule = `|${Array.from({ length: width }, (_, i) => {
    const a = aligns[i];
    return ` ${a === "center" ? ":---:" : a === "left" ? ":---" : a === "right" ? "---:" : "---"} `;
  }).join("|")}|`;
  return [line(cells[0] ?? []), rule, ...cells.slice(1).map(line)].join("\n");
}

/* ── Inline ── */

const ORDER = ["link", "bold", "italic", "strike", "code"];
const EMPHASIS = new Set(["bold", "italic", "strike"]);

/** Spaces at the edge of bold or italic text go outside it: `**a** b`, not `**a **b`. */
function outerSpaces(nodes: Json[]) {
  const out: Json[] = [];
  for (const n of nodes) {
    const marks = n.marks ?? [];
    if (n.type !== "text" || !marks.some((m) => EMPHASIS.has(m.type))) {
      out.push(n);
      continue;
    }
    const [, lead = "", core = "", trail = ""] =
      (n.text ?? "").match(/^(\s*)([\s\S]*?)(\s*)$/) ?? [];
    const plain = marks.filter((m) => !EMPHASIS.has(m.type));
    if (lead) {
      out.push({ ...n, text: lead, marks: plain });
    }
    if (core) {
      out.push({ ...n, text: core });
    }
    if (trail) {
      out.push({ ...n, text: trail, marks: plain });
    }
  }
  return out;
}

/** `inLine`: the text does not start a line of its own (a heading's or a table cell's). */
function inlineMd(nodes: Json[], opts: { table?: boolean; inLine?: boolean } = {}): string {
  let out = "";
  let open: Mark[] = [];
  const items = outerSpaces(nodes);
  const isAutolink = (m: Mark, i: number) => {
    // `<https://…>` or a bare URL: one text node that is the address itself.
    const n = items[i];
    const href = String(m.attrs?.href ?? "");
    const others = (n?.marks ?? []).filter((x) => x.type !== "link");
    const alone =
      !items[i + 1]?.marks?.some((x) => sameMark(x, m)) &&
      !items[i - 1]?.marks?.some((x) => sameMark(x, m));
    return (
      n?.type === "text" &&
      others.length === 0 &&
      alone &&
      (n.text === href || `http://${n.text}` === href || `mailto:${n.text}` === href) &&
      (m.attrs?.auto || (n.text === href && /^https?:\/\//.test(href)))
    );
  };
  const openMark = (m: Mark, i: number) => {
    if (m.type === "link") {
      if (isAutolink(m, i)) {
        return m.attrs?.auto === "bare" ? "" : "<";
      }
      return "[";
    }
    return m.type === "bold" ? "**" : m.type === "italic" ? "*" : m.type === "strike" ? "~~" : "";
  };
  const closeMark = (m: Mark, i: number) => {
    if (m.type === "link") {
      if (isAutolink(m, i)) {
        return m.attrs?.auto === "bare" ? "" : ">";
      }
      const title = m.attrs?.title ? ` "${String(m.attrs.title).replace(/"/g, '\\"')}"` : "";
      return `](${destination(String(m.attrs?.href ?? ""))}${title})`;
    }
    return m.type === "bold" ? "**" : m.type === "italic" ? "*" : m.type === "strike" ? "~~" : "";
  };

  let lineStart = !opts.inLine;
  items.forEach((n, i) => {
    const marks = [...(n.marks ?? [])]
      .filter((m) => m.type !== "code")
      .sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type));
    let keep = 0;
    while (keep < open.length && keep < marks.length && sameMark(open[keep]!, marks[keep]!)) {
      keep++;
    }
    for (let k = open.length - 1; k >= keep; k--) {
      out += closeMark(open[k]!, i - 1);
    }
    open = open.slice(0, keep);
    for (const m of marks.slice(keep)) {
      out += openMark(m, i);
      open.push(m);
    }
    const linkOpen = open.find((m) => m.type === "link");
    if (n.type === "softBreak") {
      out += "\n";
      lineStart = true;
      return;
    }
    if (n.type === "hardBreak") {
      out += opts.table ? "<br>" : "\\\n";
      lineStart = true;
      return;
    }
    if (n.type === "image") {
      const title = n.attrs?.title ? ` "${String(n.attrs.title).replace(/"/g, '\\"')}"` : "";
      out += `![${escapeText(String(n.attrs?.alt ?? ""), false, opts)}](${destination(String(n.attrs?.src ?? ""))}${title})`;
      lineStart = false;
      return;
    }
    const value = n.text ?? "";
    if (n.marks?.some((m) => m.type === "code")) {
      out += codeSpan(value);
    } else if (linkOpen && isAutolink(linkOpen, i)) {
      out += value;
    } else {
      out += escapeText(value, lineStart, opts);
    }
    lineStart = false;
  });
  for (let k = open.length - 1; k >= 0; k--) {
    out += closeMark(open[k]!, items.length - 1);
  }
  return out;
}

function codeSpan(value: string) {
  const runs = value.match(/`+/g) ?? [];
  const ticks = "`".repeat(Math.max(0, ...runs.map((r) => r.length)) + 1);
  const pad = value.startsWith("`") || value.endsWith("`") || /^ .*[^ ].* $/.test(value) ? " " : "";
  return `${ticks}${pad}${value}${pad}${ticks}`;
}

function destination(href: string) {
  return /[\s<>]/.test(href) || /[()]/.test(href.replace(/\([^()]*\)/g, ""))
    ? `<${href.replace(/[<>]/g, (c) => encodeURIComponent(c))}>`
    : href;
}

const ALNUM = /[\p{L}\p{N}]/u;

function escapeText(value: string, lineStart: boolean, opts: { table?: boolean }) {
  let out = "";
  const tildes = (value.match(/~/g) ?? []).length > 1;
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    const prev = value[i - 1] ?? "";
    const next = value[i + 1] ?? "";
    if (c === "\\" || c === "`" || c === "*") {
      out += `\\${c}`;
    } else if (c === "_") {
      out += ALNUM.test(prev) && ALNUM.test(next) ? c : "\\_";
    } else if (c === "~") {
      out += tildes ? "\\~" : c;
    } else if (c === "[") {
      out +=
        /^\[[^\]]*\][([]/.test(value.slice(i)) ||
        (lineStart && i === 0 && /^\[[^\]]*\]:/.test(value))
          ? "\\["
          : c;
    } else if (c === "<") {
      out += /[a-zA-Z/!?]/.test(next) ? "\\<" : c;
    } else if (c === "&") {
      out += /^&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i.test(value.slice(i)) ? "\\&" : c;
    } else if (c === "|" && opts.table) {
      out += "\\|";
    } else {
      out += c;
    }
  }
  if (lineStart) {
    // What would start a heading, quote, list or rule at the start of a line.
    out = out
      .replace(/^(\s*)([#>+-])(?=\s|$)/, "$1\\$2")
      .replace(/^(\s*)(=+|-+)\s*$/, "$1\\$2")
      .replace(/^(\s*\d+)([.)])(?=\s|$)/, "$1\\$2");
  }
  return out;
}
