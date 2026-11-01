// The block editor's nodes and marks: what markdown has, plus what `markdown.ts` needs to write a
// block back the way it was (list markers, fences, line breaks, autolinks), and markdown blocks.
// From peer-it's docs app (packages/docs-ui/src/blocks/schema.ts).

import { Extension, type Extensions, Node } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import StarterKit from "@tiptap/starter-kit";

/** Markdown the editor can't show as blocks (frontmatter, HTML, footnotes, …), edited as text. */
export const RawMarkdown = Node.create({
  name: "rawMarkdown",
  group: "block",
  content: "text*",
  marks: "",
  code: true,
  defining: true,
  parseHTML: () => [{ tag: "pre[data-markdown]", preserveWhitespace: "full" }],
  renderHTML: () => ["pre", { "data-markdown": "", class: "raw-md" }, ["code", 0]],
});

/** A line break inside a paragraph: shown as a space, written as a line break. */
export const SoftBreak = Node.create({
  name: "softBreak",
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,
  renderText: () => " ",
  parseHTML: () => [{ tag: "span.soft-break" }],
  renderHTML: () => ["span", { class: "soft-break" }],
});

const off = { rendered: false } as const;

const MarkdownAttributes = Extension.create({
  name: "markdownAttributes",
  addGlobalAttributes: () => [
    {
      types: ["bulletList", "taskList"],
      attributes: { tight: { default: true, ...off }, bullet: { default: "-", ...off } },
    },
    {
      types: ["orderedList"],
      attributes: { tight: { default: true, ...off }, delim: { default: ".", ...off } },
    },
    { types: ["codeBlock"], attributes: { fence: { default: "```", ...off } } },
    { types: ["horizontalRule"], attributes: { markup: { default: "---", ...off } } },
    {
      types: ["tableHeader", "tableCell"],
      attributes: {
        align: {
          default: null,
          parseHTML: (el) => el.style.textAlign || null,
          renderHTML: (attrs) => (attrs.align ? { style: `text-align: ${attrs.align}` } : {}),
        },
      },
    },
    { types: ["link"], attributes: { auto: { default: null, ...off } } },
  ],
});

/** `resolve` turns an image's `src` in the text into one the browser can load. */
export function blockExtensions(opts: { resolve?: (src: string) => string } = {}): Extensions {
  const resolve = opts.resolve ?? ((src: string) => src);
  return [
    StarterKit.configure({
      underline: false,
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      link: { openOnClick: false, autolink: true, linkOnPaste: true },
    }),
    TableKit.configure({ table: { resizable: false } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Image.configure({ inline: true, allowBase64: true }).extend({
      addNodeView() {
        return ({ node }) => {
          const img = document.createElement("img");
          const show = (n: typeof node) => {
            img.dataset.src = n.attrs.src ?? "";
            img.src = resolve(n.attrs.src ?? "");
            img.alt = n.attrs.alt ?? "";
            img.title = n.attrs.title ?? "";
          };
          show(node);
          return {
            dom: img,
            update: (n) => {
              if (n.type !== node.type) {
                return false;
              }
              show(n);
              return true;
            },
          };
        };
      },
    }),
    RawMarkdown,
    SoftBreak,
    MarkdownAttributes,
  ];
}
