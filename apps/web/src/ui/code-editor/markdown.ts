import { indentLess, indentMore } from "@codemirror/commands";
import { markdown, markdownKeymap } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorSelection, type Extension, Prec } from "@codemirror/state";
import { type Command, EditorView, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";

/** Markdown in the studio's editor: styled as it is typed, its keys, its own chunk. */

/** Wraps the selection, or the word at the caret, in `mark` on both sides; again unwraps it. */
export const wrap =
  (mark: string): Command =>
  (view) => {
    view.dispatch(
      view.state.changeByRange((range) => {
        let { from, to } = range;
        if (from === to) {
          const word = view.state.wordAt(from);
          if (word) {
            ({ from, to } = word);
          }
        }
        const doc = view.state.doc;
        const before = doc.sliceString(from - mark.length, from);
        const after = doc.sliceString(to, to + mark.length);
        if (before === mark && after === mark) {
          return {
            changes: [
              { from: from - mark.length, to: from },
              { from: to, to: to + mark.length },
            ],
            range: EditorSelection.range(from - mark.length, to - mark.length),
          };
        }
        return {
          changes: [
            { from, insert: mark },
            { from: to, insert: mark },
          ],
          range: EditorSelection.range(from + mark.length, to + mark.length),
        };
      }),
    );
    return true;
  };

/** A link around the selection, with the caret in the address. */
export const link: Command = (view) => {
  view.dispatch(
    view.state.changeByRange((range) => {
      const text = view.state.sliceDoc(range.from, range.to);
      const insert = `[${text}]()`;
      const at = range.from + insert.length - 1;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.cursor(text ? at : range.from + 1),
      };
    }),
  );
  return true;
};

/** Tab in a list item indents it; elsewhere it leaves the editor, so the keyboard isn't trapped. */
const inList =
  (command: Command): Command =>
  (view) => {
    const line = view.state.doc.lineAt(view.state.selection.main.head);
    return /^\s*([-*+]|\d+[.)])\s/.test(line.text) ? command(view) : false;
  };

/**
 * Enter on an empty list item ends the list with a blank line, so what follows is a paragraph
 * of its own and not part of the last item.
 */
export const endList: Command = (view) => {
  const { state } = view;
  const head = state.selection.main;
  if (!head.empty) {
    return false;
  }
  const line = state.doc.lineAt(head.head);
  if (!/^\s*([-*+]|\d+[.)])\s*$/.test(line.text) || head.head !== line.to) {
    return false;
  }
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: "\n" },
    selection: EditorSelection.cursor(line.from + 1),
    userEvent: "input",
  });
  return true;
};

const markdownKeys = [
  { key: "Enter", run: endList },
  { key: "Mod-b", run: wrap("**") },
  { key: "Mod-i", run: wrap("_") },
  { key: "Mod-k", run: link },
  { key: "Tab", run: inList(indentMore) },
  { key: "Shift-Tab", run: inList(indentLess) },
  ...markdownKeymap,
];

const markdownStyle = HighlightStyle.define([
  { tag: tags.heading1, fontSize: "1.5em", fontWeight: "650", fontFamily: "var(--f-display)" },
  { tag: tags.heading2, fontSize: "1.25em", fontWeight: "650", fontFamily: "var(--f-display)" },
  { tag: tags.heading3, fontSize: "1.1em", fontWeight: "650" },
  { tag: [tags.heading4, tags.heading5, tags.heading6], fontWeight: "650" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.link, color: "var(--ember)" },
  { tag: tags.url, color: "var(--ink-3)" },
  { tag: tags.monospace, fontFamily: "var(--f-mono)", fontSize: "0.92em" },
  { tag: tags.quote, color: "var(--ink-2)", fontStyle: "italic" },
  // The marks themselves: `#`, `**`, `-`, `[]()`. Visible, in a lighter ink.
  { tag: [tags.processingInstruction, tags.meta, tags.contentSeparator], color: "var(--ink-4)" },
]);

export function markdownParts(): Extension[] {
  return [
    markdown({ addKeymap: false }),
    syntaxHighlighting(markdownStyle),
    // Before the default keys: Enter continues a list, Tab indents an item.
    Prec.high(keymap.of(markdownKeys)),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ spellcheck: "true" }),
  ];
}
