import { EditorSelection, EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { applyText } from "./CodeEditor";
import { endList, link, wrap } from "./markdown";

// The page editor's own commands, on CodeMirror's state: what they write and where the caret goes.

/** A view that has a state and takes transactions: all the commands use. */
function editor(doc: string, from: number, to = from) {
  let state = EditorState.create({ doc, selection: EditorSelection.single(from, to) });
  const view = {
    get state() {
      return state;
    },
    dispatch(spec: TransactionSpec) {
      state = state.update(spec).state;
    },
  } as unknown as EditorView;
  return { view, text: () => state.doc.toString(), caret: () => state.selection.main };
}

describe("the page editor's commands", () => {
  it("bolds the word at the caret, and again unbolds it", () => {
    const e = editor("Some word here", 7);
    wrap("**")(e.view);
    expect(e.text()).toBe("Some **word** here");
    wrap("**")(e.view);
    expect(e.text()).toBe("Some word here");
  });

  it("puts a link around the selection with the caret in the address", () => {
    const e = editor("See the guide", 4, 13);
    link(e.view);
    expect(e.text()).toBe("See [the guide]()");
    expect(e.caret().head).toBe(16);
  });

  it("ends a list on an empty item with a blank line", () => {
    const e = editor("- one\n- ", 8);
    expect(endList(e.view)).toBe(true);
    expect(e.text()).toBe("- one\n\n");
    expect(e.caret().head).toBe(7);
  });

  it("leaves Enter alone outside an empty item", () => {
    expect(endList(editor("- one", 5).view)).toBe(false);
    expect(endList(editor("Text", 4).view)).toBe(false);
  });
});

describe("a change from elsewhere", () => {
  it("is the smallest change, so the caret keeps its place in the text", () => {
    const e = editor("Hello world.\n\nStep one.", 19);
    applyText(e.view, "Hello world, from elsewhere.\n\nStep one.");
    expect(e.text()).toBe("Hello world, from elsewhere.\n\nStep one.");
    // Still after "Step ".
    expect(e.text().slice(0, e.caret().head).endsWith("Step ")).toBe(true);
  });
});
