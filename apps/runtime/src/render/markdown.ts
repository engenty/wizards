import TurndownService from "turndown";

// HTML as Markdown, without anything else of render/: what reading a Word file needs
// (documents/read.ts), in the runtime and in the documents service (apps/documents).

/** Elements that turndown writes as blocks of their own, with blank lines around them. */
const BLOCKS = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "DIV",
  "DL",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "HR",
  "LI",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "TABLE",
  "UL",
]);

const holdsBlock = (node: Node): boolean =>
  [...node.childNodes].some((child) => BLOCKS.has(child.nodeName) || holdsBlock(child));

/**
 * A link around blocks (a teaser: a `<div>` with a picture and a heading in one `<a>`) would come
 * out with blank lines inside its brackets, which no Markdown reads as a link. Its content goes
 * on one line instead: `[![Bild](…) Titel](…)`.
 */
export function linkBlocks(service: TurndownService): TurndownService {
  return service.addRule("blockLink", {
    filter: (node) =>
      node.nodeName === "A" && Boolean(node.getAttribute("href")) && holdsBlock(node),
    replacement: (text, node) => {
      const inner = text
        .replace(/\s*\n+\s*/g, " ")
        .replace(/(^|\s)#{1,6}\s+/g, "$1")
        .trim();
      if (!inner) {
        return "";
      }
      const el = node as HTMLElement;
      const href = (el.getAttribute("href") ?? "").replace(/([()])/g, "\\$1");
      const title = el.getAttribute("title");
      return `[${inner}](${href}${title ? ` "${title.replace(/"/g, '\\"')}"` : ""})`;
    },
  });
}

const turndown = linkBlocks(new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" }));

export function htmlToMarkdown(html: string): string {
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
  return turndown.turndown(
    body.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<script[\s\S]*?<\/script>/gi, ""),
  );
}
