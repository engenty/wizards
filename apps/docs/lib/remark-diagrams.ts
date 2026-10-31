import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * A diagram is an SVG file in docs/assets/diagrams, linked from a page as a plain image:
 * `![What it shows](../../assets/diagrams/name.svg)`. The page's Markdown stays readable (the AI
 * clients' copy keeps the link), and the site draws the SVG inline as <Diagram />, so its
 * classes take the theme's colours in light and dark (app/global.css, `.diagram`).
 *
 * The SVG is read when the page compiles and named as a dependency of the page. The dev server
 * may not watch it: after changing an SVG, save its page again.
 */
interface Node {
  type: string;
  url?: string;
  alt?: string | null;
  children?: Node[];
  [key: string]: unknown;
}

/** fumadocs-mdx's compiler, which the page's file carries. */
type Compiler = { addDependency(file: string): void };

const DIAGRAM = /(^|\/)assets\/diagrams\/[\w-]+\.svg$/;

export function remarkDiagrams() {
  return (tree: Node, file: { path?: string; data: Record<string, unknown> }) => {
    const walk = (node: Node) => {
      if (!node.children) {
        return;
      }
      node.children = node.children.map((child) => {
        const image =
          child.type === "paragraph" && child.children?.length === 1 ? child.children[0] : null;
        if (!(image?.type === "image" && image.url && DIAGRAM.test(image.url) && file.path)) {
          walk(child);
          return child;
        }
        const path = resolve(dirname(file.path), image.url);
        (file.data._compiler as Compiler | undefined)?.addDependency(path);
        const svg = readFileSync(path, "utf8")
          .replace(/<\?xml[^>]*>\s*/, "")
          .trim();
        return {
          type: "mdxJsxFlowElement",
          name: "Diagram",
          attributes: [
            { type: "mdxJsxAttribute", name: "svg", value: svg },
            { type: "mdxJsxAttribute", name: "alt", value: image.alt ?? "" },
          ],
          children: [],
        };
      });
    };
    walk(tree);
  };
}
