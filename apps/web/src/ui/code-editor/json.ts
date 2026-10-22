import { closeBrackets } from "@codemirror/autocomplete";
import { json, jsonParseLinter } from "@codemirror/lang-json";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { linter, lintGutter } from "@codemirror/lint";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";

/** JSON in the studio's editor: highlighted, and marked where it doesn't parse. */

const jsonStyle = HighlightStyle.define([
  { tag: tags.propertyName, color: "oklch(80% 0.1 230)" },
  { tag: tags.string, color: "oklch(82% 0.12 150)" },
  { tag: [tags.number, tags.bool, tags.null], color: "oklch(82% 0.12 60)" },
  { tag: [tags.brace, tags.squareBracket, tags.separator], color: "oklch(70% 0.03 260)" },
]);

export function jsonParts(): Extension[] {
  return [
    json(),
    syntaxHighlighting(jsonStyle),
    closeBrackets(),
    // A line that doesn't parse gets a mark where it breaks.
    linter(jsonParseLinter(), { delay: 400 }),
    lintGutter(),
    EditorView.contentAttributes.of({ spellcheck: "false" }),
  ];
}
