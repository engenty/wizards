import { codeFolding, foldGutter, foldKeymap } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";

/**
 * Line numbers and folding, as every file in the studio's editor has them: a chevron beside each
 * part that folds, pointing down while open, and "…" in place of what is folded.
 */

/** The fold mark: a chevron, pointing down while open. */
const marker = (open: boolean) => {
  const span = document.createElement("span");
  span.textContent = "›";
  span.className = open ? "cm-fold-open" : "cm-fold-closed";
  return span;
};

export function foldParts(): Extension[] {
  return [
    lineNumbers(),
    codeFolding({ placeholderText: "…" }),
    foldGutter({ markerDOM: marker }),
    keymap.of(foldKeymap),
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
  ];
}
