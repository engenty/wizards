import { type Extension, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

/**
 * A `SKILL.md`'s front matter (`---` … `---` on its first lines) in plain mono, as data: Markdown
 * would read its last line above the closing `---` as a heading.
 */

const line = Decoration.line({ class: "cm-frontmatter" });

function decorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;
  if (doc.lines > 1 && doc.line(1).text.trim() === "---") {
    for (let end = 2; end <= Math.min(doc.lines, 80); end++) {
      if (doc.line(end).text.trim() === "---") {
        for (let n = 1; n <= end; n++) {
          builder.add(doc.line(n).from, doc.line(n).from, line);
        }
        break;
      }
    }
  }
  return builder.finish();
}

export function frontmatterLines(): Extension[] {
  return [
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
          this.decorations = decorations(view);
        }
        update(u: ViewUpdate) {
          if (u.docChanged) {
            this.decorations = decorations(u.view);
          }
        }
      },
      { decorations: (v) => v.decorations },
    ),
    EditorView.theme({
      ".cm-frontmatter, .cm-frontmatter *": {
        fontFamily: "var(--f-mono)",
        fontSize: "0.8125rem !important",
        fontWeight: "400 !important",
        color: "var(--ink-3) !important",
        textDecoration: "none !important",
      },
    }),
  ];
}
