import { closeBrackets } from "@codemirror/autocomplete";
import { json, jsonParseLinter } from "@codemirror/lang-json";
import {
  codeFolding,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import { linter, lintGutter } from "@codemirror/lint";
import type { Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { tags } from "@lezer/highlight";

/**
 * JSON in the studio's editor: highlighted, foldable by object and list, and marked where it
 * doesn't parse. The view's JSON keeps its dark colours; a file in the studio takes the studio's.
 */

const dark = HighlightStyle.define(
  [
    { tag: tags.propertyName, color: "oklch(80% 0.1 230)" },
    { tag: tags.string, color: "oklch(82% 0.12 150)" },
    { tag: [tags.number, tags.bool, tags.null], color: "oklch(82% 0.12 60)" },
    { tag: [tags.brace, tags.squareBracket, tags.separator], color: "oklch(70% 0.03 260)" },
  ],
  { themeType: "dark" },
);

const light = HighlightStyle.define(
  [
    { tag: tags.propertyName, color: "var(--cobalt)" },
    { tag: tags.string, color: "var(--moss)" },
    { tag: [tags.number, tags.bool, tags.null], color: "var(--ember-strong)" },
    { tag: [tags.brace, tags.squareBracket, tags.separator], color: "var(--ink-3)" },
  ],
  { themeType: "light" },
);

/** The fold mark: a chevron, pointing down while open. */
const marker = (open: boolean) => {
  const span = document.createElement("span");
  span.textContent = "›";
  span.className = open ? "cm-fold-open" : "cm-fold-closed";
  return span;
};

export function jsonParts(): Extension[] {
  return [
    json(),
    syntaxHighlighting(dark),
    syntaxHighlighting(light),
    closeBrackets(),
    lineNumbers(),
    codeFolding({ placeholderText: "…" }),
    foldGutter({ markerDOM: marker }),
    keymap.of(foldKeymap),
    // A line that doesn't parse gets a mark where it breaks.
    linter(jsonParseLinter(), { delay: 400 }),
    lintGutter(),
    EditorView.theme({
      ".cm-lineNumbers .cm-gutterElement": {
        color: "var(--ink-4)",
        padding: "0 0.25rem 0 0.75rem",
      },
      ".cm-foldGutter .cm-gutterElement": {
        width: "1rem",
        textAlign: "center",
        color: "var(--ink-4)",
        cursor: "pointer",
      },
      ".cm-foldGutter .cm-gutterElement:hover": { color: "var(--ink)" },
      ".cm-fold-open, .cm-fold-closed": { display: "inline-block", transition: "transform 120ms" },
      ".cm-fold-open": { transform: "rotate(90deg)" },
      ".cm-foldPlaceholder": {
        backgroundColor: "color-mix(in oklch, var(--ink) 10%, transparent)",
        border: "none",
        borderRadius: "0.25rem",
        color: "var(--ink-3)",
        padding: "0 0.375rem",
        margin: "0 0.25rem",
      },
    }),
    EditorView.contentAttributes.of({ spellcheck: "false" }),
  ];
}
