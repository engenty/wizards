import { autocompletion, type CompletionContext } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import {
  Annotation,
  Compartment,
  EditorState,
  type Extension,
  Transaction,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  drawSelection,
  EditorView,
  keymap,
  placeholder as placeholderText,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { type Ref, useEffect, useImperativeHandle, useRef } from "react";
import { t } from "../../lib/i18n";

/**
 * The studio's editor for text that is code to a machine: a page's Markdown, a view's JSON
 * (docs/plans/page-editor-codemirror.md). CodeMirror 6, themed with the studio's own colours.
 * The text stays exactly what is typed: Markdown is styled as it is written, nothing is hidden.
 */

export interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  language: "markdown" | "json";
  ariaLabel: string;
  placeholder?: string;
  readOnly?: boolean;
  /** The view's JSON keeps its dark look. */
  tone?: "light" | "dark";
  /** Where the caret is, for presence: the text and the caret's offset. */
  onCaret?: (text: string, at: number) => void;
  onBlur?: () => void;
  className?: string;
  extensions?: Extension[];
  /** The editor itself, for what applies changes from elsewhere (studio/live). */
  handle?: Ref<CodeEditorHandle>;
  /** Lines to mark, such as the heading of a section someone else edits (presence). */
  marks?: LineMark[];
  /** What a link's address may name: offered while typing after `](`. */
  links?: LinkTarget[];
  /** Cmd/Ctrl+click on a link's address. */
  onLink?: (href: string) => void;
}

export interface LinkTarget {
  /** What the person knows it by: a page's title. */
  title: string;
  /** What the link says: `pages/handbuch/montage`. */
  path: string;
  /** A word for its kind: page, table, file. */
  kind?: string;
}

/** The editor with its language's parts, which load with the language (index.tsx). */
export type LoadedProps = CodeEditorProps & { languageParts: Extension[] };

export interface LineMark {
  /** The line's text, without the marks of a heading: `Intro` for `## Intro`. */
  heading: string;
  color: string;
  title: string;
}

export interface CodeEditorHandle {
  view: () => EditorView | null;
}

/** A change that came from elsewhere: it keeps the caret, and undo leaves it alone. */
export const remote = Annotation.define<boolean>();

/**
 * Puts `next` in place of the document as the smallest change: the caret and the selection map
 * through it, and it stays out of the undo history.
 */
export function applyText(view: EditorView, next: string) {
  const now = view.state.doc.toString();
  if (now === next) {
    return;
  }
  let from = 0;
  while (from < now.length && from < next.length && now[from] === next[from]) {
    from++;
  }
  let endNow = now.length;
  let endNext = next.length;
  while (endNow > from && endNext > from && now[endNow - 1] === next[endNext - 1]) {
    endNow--;
    endNext--;
  }
  view.dispatch({
    changes: { from, to: endNow, insert: next.slice(from, endNext) },
    annotations: [remote.of(true), Transaction.addToHistory.of(false)],
  });
}

// --- the studio's look -------------------------------------------------------------------------

const look = (tone: "light" | "dark", language: "markdown" | "json") =>
  EditorView.theme(
    {
      "&": {
        color: tone === "dark" ? "oklch(92% 0.02 260)" : "var(--ink)",
        backgroundColor: "transparent",
        fontSize: language === "json" ? "0.75rem" : "0.9375rem",
      },
      "&.cm-focused": { outline: "none" },
      ".cm-scroller": {
        fontFamily: language === "json" ? "var(--f-mono)" : "var(--f-ui)",
        lineHeight: language === "json" ? "1.6" : "1.65",
      },
      ".cm-content": {
        padding: language === "json" ? "0.625rem 0" : "1rem 0",
        caretColor: tone === "dark" ? "white" : "var(--ink)",
      },
      ".cm-line": { padding: language === "json" ? "0 0.75rem" : "0 1rem" },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: tone === "dark" ? "white" : "var(--ink)",
      },
      "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
        { backgroundColor: "color-mix(in oklch, var(--ember) 28%, transparent)" },
      ".cm-placeholder": { color: "var(--ink-4)" },
      ".cm-panels": {
        backgroundColor: "var(--card)",
        color: "var(--ink)",
        borderColor: "var(--border)",
      },
      ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--border)" },
      ".cm-search": { fontFamily: "var(--f-ui)", fontSize: "0.8125rem" },
      ".cm-textfield": {
        backgroundColor: "var(--paper)",
        border: "1px solid var(--input)",
        borderRadius: "0.375rem",
        color: "var(--ink)",
      },
      ".cm-button": {
        backgroundImage: "none",
        backgroundColor: "var(--accent)",
        border: "1px solid var(--border)",
        borderRadius: "0.375rem",
        color: "var(--ink)",
      },
      ".cm-searchMatch": { backgroundColor: "color-mix(in oklch, var(--ember) 22%, transparent)" },
      ".cm-searchMatch-selected": {
        backgroundColor: "color-mix(in oklch, var(--ember) 45%, transparent)",
      },
      ".cm-selectionMatch": { backgroundColor: "color-mix(in oklch, var(--ink) 10%, transparent)" },
      ".cm-gutters": { backgroundColor: "transparent", border: "none" },
      ".cm-lintRange-error": {
        backgroundImage: "none",
        textDecoration: "underline wavy oklch(70% 0.18 25)",
      },
      ".cm-tooltip.cm-tooltip-autocomplete": { padding: "0.25rem" },
      ".cm-tooltip.cm-tooltip-autocomplete > ul": { fontFamily: "var(--f-ui)", maxHeight: "16rem" },
      ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
        padding: "0.375rem 0.625rem",
        borderRadius: "0.375rem",
        display: "flex",
        gap: "0.75rem",
        alignItems: "baseline",
      },
      ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
        backgroundColor: "var(--accent)",
        color: "var(--ink)",
      },
      ".cm-completionLabel": { fontSize: "0.875rem" },
      ".cm-completionDetail": {
        fontStyle: "normal",
        fontSize: "0.75rem",
        color: "var(--ink-3)",
        marginLeft: "auto",
      },
      ".cm-tooltip": {
        backgroundColor: "var(--card)",
        color: "var(--ink)",
        border: "1px solid var(--border)",
        borderRadius: "0.5rem",
      },
    },
    { dark: tone === "dark" },
  );

const phrases = () =>
  EditorState.phrases.of({
    Find: t("code.find"),
    Replace: t("code.replace"),
    next: t("code.next"),
    previous: t("code.previous"),
    all: t("code.all"),
    "match case": t("code.matchCase"),
    regexp: t("code.regexp"),
    "by word": t("code.byWord"),
    replace: t("code.replace"),
    "replace all": t("code.replaceAll"),
    close: t("code.close"),
    "Go to line": t("code.goToLine"),
    go: t("code.go"),
  });

/** Inside a link's address (`[text](…`): the targets whose title or path has what is typed. */
function linkCompletion(links: LinkTarget[]): Extension {
  if (!links.length) {
    return [];
  }
  return autocompletion({
    icons: false,
    override: [
      (ctx: CompletionContext) => {
        const before = ctx.matchBefore(/\]\([^)\s]*/);
        if (!before) {
          return null;
        }
        const typed = before.text.slice(2).toLowerCase();
        return {
          from: before.from + 2,
          filter: false,
          options: links
            .filter(
              (l) =>
                !typed ||
                l.title.toLowerCase().includes(typed) ||
                l.path.toLowerCase().includes(typed),
            )
            .slice(0, 50)
            .map((l) => ({ label: l.title, detail: l.path, type: l.kind, apply: l.path })),
        };
      },
    ],
  });
}

/** The address of the Markdown link at `pos`, or null. */
function linkAt(view: EditorView, pos: number): string | null {
  const line = view.state.doc.lineAt(pos);
  for (const m of line.text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const from = line.from + (m.index ?? 0);
    if (pos >= from && pos <= from + m[0].length) {
      return m[1] ?? null;
    }
  }
  return null;
}

/** Cmd/Ctrl+click on a link opens what it names. */
function followLinks(open: (href: string) => void): Extension {
  return EditorView.domEventHandlers({
    mousedown(e, view) {
      if (!(e.metaKey || e.ctrlKey)) {
        return false;
      }
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      const href = pos === null ? null : linkAt(view, pos);
      if (!href) {
        return false;
      }
      e.preventDefault();
      open(href);
      return true;
    },
  });
}

/** A bar in a colour beside each marked heading, with who is there on hover. */
function markLines(marks: LineMark[]): Extension {
  if (!marks.length) {
    return [];
  }
  const build = (view: EditorView): DecorationSet => {
    const out = [];
    for (const { from, to } of view.visibleRanges) {
      for (let pos = from; pos <= to; ) {
        const line = view.state.doc.lineAt(pos);
        const head = /^#{1,6}\s+(.+?)\s*#*$/.exec(line.text)?.[1]?.toLowerCase();
        const mark = head ? marks.find((m) => m.heading.toLowerCase() === head) : undefined;
        if (mark) {
          out.push(
            Decoration.line({
              attributes: {
                title: mark.title,
                style: `box-shadow: inset 3px 0 0 ${mark.color}`,
              },
            }).range(line.from),
          );
        }
        pos = line.to + 1;
      }
    }
    return Decoration.set(out);
  };
  return ViewPlugin.define(
    (view) => ({
      decorations: build(view),
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged) {
          this.decorations = build(u.view);
        }
      },
    }),
    { decorations: (v) => v.decorations },
  );
}

export default function CodeEditor({
  value,
  onChange,
  language,
  ariaLabel,
  placeholder,
  readOnly = false,
  tone = "light",
  onCaret,
  onBlur,
  className,
  extensions = [],
  handle,
  marks = [],
  links = [],
  onLink,
  languageParts,
}: LoadedProps) {
  const marked = useRef(new Compartment());
  const completing = useRef(new Compartment());
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef({ onChange, onCaret, onBlur, onLink });
  latest.current = { onChange, onCaret, onBlur, onLink };
  useImperativeHandle(handle, () => ({ view: () => view.current }), []);

  // One editor for the component's life; what changes later is applied as transactions.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the props that set it up are read once.
  useEffect(() => {
    if (!host.current) {
      return;
    }
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          drawSelection(),
          search({ top: false }),
          highlightSelectionMatches(),
          keymap.of([...searchKeymap, ...historyKeymap, ...defaultKeymap]),
          phrases(),
          look(tone, language),
          ...languageParts,
          EditorState.readOnly.of(readOnly),
          EditorView.contentAttributes.of({ "aria-label": ariaLabel }),
          placeholder ? placeholderText(placeholder) : [],
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !u.transactions.some((tr) => tr.annotation(remote))) {
              latest.current.onChange(u.state.doc.toString());
            }
            if (u.selectionSet || u.docChanged) {
              latest.current.onCaret?.(u.state.doc.toString(), u.state.selection.main.head);
            }
            if (u.focusChanged && !u.view.hasFocus) {
              latest.current.onBlur?.();
            }
          }),
          marked.current.of(markLines(marks)),
          completing.current.of(linkCompletion(links)),
          followLinks((href) => latest.current.onLink?.(href)),
          ...extensions,
        ],
      }),
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
  }, []);

  // Who is where changes on its own: only the marks are set again.
  const marksKey = JSON.stringify(marks);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `marksKey` stands for `marks`.
  useEffect(() => {
    view.current?.dispatch({ effects: marked.current.reconfigure(markLines(marks)) });
  }, [marksKey]);

  // The targets change as Knowledge does: only the completion is set again.
  const linksKey = JSON.stringify(links);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `linksKey` stands for `links`.
  useEffect(() => {
    view.current?.dispatch({ effects: completing.current.reconfigure(linkCompletion(links)) });
  }, [linksKey]);

  // A value from outside (a save's answer, a change from elsewhere): applied as the smallest
  // change, so the caret stays where it was.
  useEffect(() => {
    if (view.current) {
      applyText(view.current, value);
    }
  }, [value]);

  return <div ref={host} className={className} />;
}
