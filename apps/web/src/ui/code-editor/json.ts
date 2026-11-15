import { closeBrackets } from "@codemirror/autocomplete";
import { json, jsonParseLinter } from "@codemirror/lang-json";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { linter, lintGutter } from "@codemirror/lint";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { foldParts } from "./folding";

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

export function jsonParts(): Extension[] {
  return [
    json(),
    syntaxHighlighting(dark),
    syntaxHighlighting(light),
    closeBrackets(),
    ...foldParts(),
    // A line that doesn't parse gets a mark where it breaks.
    linter(jsonParseLinter(), { delay: 400 }),
    lintGutter(),
    EditorView.contentAttributes.of({ spellcheck: "false" }),
  ];
}
