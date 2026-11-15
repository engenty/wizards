import { closeBrackets } from "@codemirror/autocomplete";
import { javascript } from "@codemirror/lang-javascript";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { tags } from "@lezer/highlight";

/** TypeScript in the studio's editor: a wizard's step files, highlighted in the studio's colours. */

const style = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: "var(--cobalt)" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--moss)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--ember-strong)" },
  { tag: [tags.comment], color: "var(--ink-3)", fontStyle: "italic" },
  { tag: [tags.typeName, tags.className], color: "var(--ink-2)" },
]);

export function typescriptParts(): Extension[] {
  return [
    javascript({ typescript: true }),
    syntaxHighlighting(style),
    closeBrackets(),
    lineNumbers(),
    EditorView.theme({
      ".cm-lineNumbers .cm-gutterElement": { color: "var(--ink-4)", padding: "0 0.5rem 0 0.75rem" },
    }),
    EditorView.contentAttributes.of({ spellcheck: "false" }),
  ];
}
