# Pages in CodeMirror

A technical plan, 2026-10-22. No code changes yet. It follows the live changes
([live-changes.md](live-changes.md)) and comes after its last PR. Editing together in real time
is not part of it; this plan only makes it possible later.

The goal: a page of a space is written in a real editor. It stays Markdown, as the person types
it, but it reads better while writing, undoes properly, and takes changes from elsewhere without
the caret jumping.

## Verdict

**Use CodeMirror 6, with Markdown as the language, for the "Write" tab of a page.** It is no
WYSIWYG editor: the text is the Markdown source, styled as it is typed. The "Preview" and
"Original" tabs stay as they are.

Why CodeMirror and not Tiptap or Monaco:

| | CodeMirror 6 | Tiptap (ProseMirror) | Monaco |
| --- | --- | --- | --- |
| What the person edits | The Markdown itself, as today | Formatted text; Markdown only on the way in and out | Code |
| Round trip of the page | Exact: the text is the file | Lossy: tables, HTML, unusual Markdown change shape on save | Exact |
| Size, gzip | About 60 KB for what we use (measured in PR 1) | About 100 KB and up | Above 1 MB |
| Phones | Works (contenteditable) | Works | Poor |
| Changes from elsewhere | Transactions map the caret and stay out of undo | Same | Same |
| Later: editing together | `y-codemirror.next` | `y-prosemirror` | `y-monaco` |

Pages are read by wizards, the AI and the two-way sync as Markdown text. An editor that keeps the
text exactly as written changes nothing for any of them. engenty-pro's `packages/tiptap-editor`
serves documents that are formatted text at heart, which pages are not.

## What exists today

- **`apps/web/src/studio/project/PageEditor.tsx`** has three tabs:
  - "Write": a plain `<textarea>`, monospace, `field-sizing-content`.
  - "Preview": `Markdown` from `@engenty/wizards-runner`. Clicking a `pages/…` link opens that
    page.
  - "Original": the PDF or image a page came from.
- **`useAutosave`** (`project/data.ts`) saves 700 ms after the last change. Last writer wins.
- **`SurfaceEditor.tsx`** edits a view step's JSON in a textarea over a hand-made highlighting
  `<pre>`. That is a second editor built by hand, and the second user of a shared component.
- There is no CodeMirror, Monaco or Tiptap in the studio. `apps/web` has no unit tests; the
  browser tests use `playwright-core` (`apps/runtime/test/browser-fast`).
- The live-changes plan has the page editor:
  - patched when nothing is unsaved;
  - holding a change from elsewhere until the autosave while the person types;
  - showing presence at a paragraph.

  On a textarea each of these needs hand work: keeping the caret, and an undo history that
  breaks on every value set from code. CodeMirror has them built in.

## Design

### 1. One editor component: `apps/web/src/ui/code-editor/`

- **`CodeEditor`** is a React wrapper around one `EditorView`.
  - Props: `value`, `onChange`, `language` (`"markdown"` or `"json"`), `readOnly`, `ariaLabel`,
    `placeholder`, `extensions` (extra ones from the caller).
  - It is uncontrolled inside: `value` is applied only when it differs from the document, as a
    transaction, never by remounting.
  - The `EditorView` is exposed through a ref, for the live adapter (5).
- **Loaded lazily.** `React.lazy` puts CodeMirror in its own chunk, loaded when "Write" opens for
  the first time. The fallback is the textarea of today, styled the same, so a slow chunk
  doesn't hide the text. The MCP app build (`vite.mcp-app.config.ts`) doesn't import it.
- **The theme comes from the studio's own tokens** (`--ink`, `--paper`, `--accent`, the focus
  ring), set with `EditorView.theme`. Dark mode follows the studio without a second theme.
  Highlighting uses `HighlightStyle` with the same tokens, with no CodeMirror default theme.
- **Texts.** Its phrases (search panel, "Go to line") go through `EditorState.phrases`, in German
  and English from `lib/i18n.ts`.

### 2. The page editor's "Write" tab

- **Markdown as it is typed.**
  - Headings are larger and bold, `**bold**` is bold, `_italic_` italic, `code` in mono, and
    links in the accent colour.
  - The marks themselves (`#`, `**`, `[]()`) stay visible, in a lighter ink. Nothing is hidden,
    so what is typed is what is saved.
- **Font.** It moves from mono to the studio's text font, so a page reads like text while being
  written. Code spans and code blocks stay mono. Lines wrap.
- **Keys:**

  | Key | Does |
  | --- | --- |
  | Cmd/Ctrl+B, Cmd/Ctrl+I | Bold, italic, around the selection or the word |
  | Cmd/Ctrl+K | A link around the selection, with the caret in the address |
  | Enter in a list or quote | Continues it (`insertNewlineContinueMarkup`); Enter on an empty item ends it |
  | Tab, Shift+Tab in a list | Indents or outdents the item. Outside lists Tab leaves the editor, so the keyboard isn't trapped |
  | Cmd/Ctrl+F | Search and replace in the page |
  | Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z | Undo, redo: one step per pause in typing |

- **Saving is unchanged.** `onChange` feeds the same `useAutosave` with the same 700 ms.
- **Read-only pages** keep showing the preview only, as today.
- **The hint** "Markdown: # heading, **bold**, - list" stays in the tab bar and adds
  "Cmd/Ctrl+B, I, K".
- **Phones.** CodeMirror works with the on-screen keyboard. A Playwright run in a phone viewport
  is part of PR 1.

### 3. Links to pages and files

Knowledge items already have paths, the way steps name them: `pages/handbuch/montage`,
`tables/kettenprogramm`, `files/plan.dwg` (`KnowledgeItem.path`, resolved by `resolvePath` in
`services/knowledge.ts`).

- **Completion.** Inside the address of a link, after `](`, the editor offers the space's pages,
  tables and files by title. Picking one writes its path: `[Montage](pages/handbuch/montage)`.
  - The source is the cached `["knowledge", projectId]` query, with sub-pages from its tree. No
    new route.
  - It runs through `@codemirror/autocomplete`, only inside a link address, never while typing
    prose.
- **Following a link.** Cmd/Ctrl+click on a `pages/…`, `tables/…` or `files/…` link opens it.
  The preview follows `pages/…` only today; it gets tables and files too. The `resolve` call
  behind both moves into one helper.

### 4. The view step's JSON on the same component

`SurfaceEditor.tsx`'s textarea over a highlighting `<pre>` becomes a `CodeEditor` with
`language="json"`.

- Its own highlighter (`highlight(value)`) goes away.
- A line that doesn't parse gets a mark at the line, from `JSON.parse`'s position, instead of
  only refusing to keep the JSON.
- Its dark look stays: the component takes a `tone="dark"` for it.

### 5. With live changes and presence

This part needs PRs 5 and 9 of the live-changes plan. The rules of its section 6 stay: show at
once when nothing is unsaved, hold while typing, merge at the autosave.

- **A `TextSurface` interface.** Live-changes PR 5 writes the page editor against a small
  interface: `get()`, `apply(nextText)` and `hasUnsavedEdits()`, with a textarea version first.
  This plan adds the CodeMirror version. Nothing else in the live code changes.
- **Applying a change from elsewhere.**
  - The CodeMirror version turns `nextText` into changes (a diff of the two texts) and
    dispatches them with the annotation `remote` and `addToHistory: false`.
  - The caret and the selection map through the changes by themselves, and Cmd/Ctrl+Z undoes
    only one's own typing, never a colleague's change.
- **Presence at a paragraph.** A presence entry with a place (the heading above someone's caret)
  becomes a line decoration: a thin bar in that person's colour beside the section, with their
  name on hover.
- **Later: editing together.** A room of the co-editing idea would bind the same `EditorView` to
  a Yjs document with `y-codemirror.next`. Nothing in this plan is built for that, and nothing
  stands in its way.

### 6. Dependencies

These are added to `apps/web`, MIT-licensed, pinned to exact versions that are at least two
weeks old when the PR opens:

- `@codemirror/state`, `@codemirror/view`, `@codemirror/commands`, `@codemirror/language`;
- `@codemirror/lang-markdown`, `@codemirror/lang-json`;
- `@codemirror/search`, `@codemirror/autocomplete`;
- `@lezer/highlight`.

There's no `@uiw/react-codemirror` or other wrapper: the component of 1 is about 100 lines and
keeps control of how values are applied, which 5 needs. There's no `codemirror` meta package
either, which pulls in more than we use.

## Work in small PRs

| # | PR | Contents | Tests |
| --- | --- | --- | --- |
| 1 | `feat(web): pages are written in CodeMirror` | `ui/code-editor` (component, theme from tokens, phrases), the "Write" tab on it, Markdown styling, keys, list continuation, search, lazy chunk with textarea fallback, user guide line in `space.md` | Playwright (with the browser tests in `apps/runtime/test`): typing saves once after 700 ms; Cmd+B wraps the word; Enter continues a list and ends it on an empty item; Tab leaves the editor outside a list; undo after a pause undoes one step; dark mode uses the tokens; a phone viewport types and saves. The chunk loads only on "Write" |
| 2 | `feat(web): links to pages, tables and files complete in the page editor` | Completion inside a link address, Cmd/Ctrl+click follows, the preview follows tables and files too, one `resolve` helper for editor and preview | Completion lists the space's pages, sub-pages, tables and files; picking writes the path `resolvePath` finds; Cmd+click opens it |
| 3 | `refactor(web): the view step's JSON editor on CodeMirror` | `SurfaceEditor` on `CodeEditor` with `tone="dark"`, parse error marks, the hand-made highlighter removed | The JSON edits, keeps only when valid, and marks the line of an error |
| 4 | `feat(web): the page editor takes live changes and shows presence in CodeMirror` | `TextSurface` for CodeMirror, remote transactions out of the undo history, presence decorations. Needs live-changes PRs 5 and 9 | A change from elsewhere keeps the caret in place; undo doesn't undo it; a change while typing waits for the autosave; a presence bar shows beside the section |

PRs 1–3 stand on their own and can go before the live changes are done; 4 waits for them. There
is no feature switch: each PR is complete for what it shows, and the editor keeps the text exactly
as before, so nothing needs to be held back. The release that carries PR 1 is a minor one.

## Risks and answers

- **Bundle size.** CodeMirror is a lazy chunk, loaded only when someone writes a page. PR 1
  measures it and states the number in the PR.
- **A page that is very long.** CodeMirror draws only the visible lines; long pages get faster
  than in a textarea that grows to its full height.
- **Browser spell check.** It stays on for pages (`spellcheck` on the content) and off for JSON.
- **Copy and paste.** It is plain text in and out, as today; pasting from a web page pastes its
  text, not its HTML.
- **Tests on a contenteditable.** Playwright types into CodeMirror like a person
  (`locator(".cm-content").pressSequentially`). The tests don't depend on its DOM beyond
  `.cm-content`.

## Not in scope

- **Editing together in real time** (Yjs, websockets, live cursors). Section 5 says how it would
  fit.
- **WYSIWYG**, hidden marks, slash commands.
- **Pasting or dropping images and files** into a page.
- **Wizard text fields** in the inspector. They are short and stay plain inputs.
