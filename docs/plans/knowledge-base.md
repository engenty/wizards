# Plan: Wissen as a knowledge base

Status: planned on 2026-11-01; nothing built. Page with the mockups: the artifact “Wissen, neu
geordnet” (claude.ai/artifact/WFg4DJ2vgFCKthpY3MSyqW). The user decides the open points below.

Wissen (`/studio/space/knowledge`) holds what a space's wizards look up: pages with sub-pages,
tables, files, and typed Kategorien across all of them. It works, but its start page does not
explain itself, it shows no structure, and the most common way in (a folder someone already has)
is a closed plugin's text field. peer-it's docs app (`/Users/m/code/peer-it/apps/docs`) solved the
editor, the tree, the viewers and the search for a git folder of Markdown. This plan brings those
ideas over, puts the source pipeline in the core, and keeps the sources plugin optional. Folders
other parties own are mounted in a new Ressource, Dateien (`media-and-files.md`); Wissen takes
from them what it wants to own.

## What is hard to understand today

| What a person sees | Why it confuses |
|---|---|
| The hint names three ideas at once: steps look things up, documents become pages and tables, Kategorien keep entries apart | Nobody knows yet what a Kategorie is for. The page explains its mechanism before its use |
| Three buttons of equal weight: + Seite, + Tabelle, + Kategorie | A Kategorie is not content. The most common way in, bringing documents, is a drop area under the whole list |
| A flat list, A–Z, every item with every category value and the source in one grey line | No structure, no hierarchy. Sub-pages are hidden. The meta line is noise (“Client Cases engrd (Sitemap)” on every row) |
| The menu: Alles, KATEGORIEN with counts, DATA SOURCER › Quellen | Kategorien look like folders but open a settings page. The plugin's name leaks into the menu. Where content comes from is apart from the content |
| The filter chips repeat the menu's Kategorien | Two ways to the same thing that behave differently |
| „Suche testen …“ | The search is framed as a test of what a step gets, not as a way to find something |
| Tables and files have no place | Only pages have a parent (`space_page.parent_id`). A table or a file can't sit next to the page it belongs to |
| A grey line under everything: no embedding model, no classifier | A state that matters reads like a footnote |

## Proposed structure

### Decided by this plan (recommendation)

**Two tabs at the top of Wissen's menu: Ordner and Kategorien.** Ordner is the default.

- **Ordner** is a tree, the way everyone knows it from Finder or Explorer. Folders, pages,
  tables and files. A folder a source fills has a small mark: a link for „Aus Dateien“, a globe
  for a website.
- **Kategorien** is a tree too: each Kategorie opens to its values (a choice's values, a date's
  years, a number's ranges, yes and no). A value opens the items that have it, as cards, with the
  value's summary on top. This is where “categories as the tree” lives.
- The page beside the menu shows what is picked. A folder shows its own text (if it has any) and
  its contents as cards. Every card and every opened item shows its category values as chips:
  the link between the two tabs.

| | A. Tabs: Ordner, Kategorien (recommended) | B. One tree, Kategorien only as filters | C. Kategorien are the tree |
|---|---|---|---|
| First look | Folders, as known | Folders, as known | Unfamiliar: “Kunde › A1 Telekom” before anything was sorted |
| Kategorien | Their own tree, one tab away, with an empty state that explains them | Chips above a folder's contents; no place to see a Kategorie's values | Everything |
| Items with several values | Show once per value in Kategorien, once in Ordner | Once | Several times in the tree |
| Connected folders | Keep their structure | Keep their structure | Lose it, or need a Kategorie per level |
| Number and date Kategorien | Ranges and years as tree nodes | Range filters | Ranges and years as tree nodes |
| Build cost | Medium | Low | Medium; the menu as it is today goes |

**Why A:** folders are what people bring and know; Kategorien are the powerful, unfamiliar part
and get a tab where they can be explained once, instead of mixing into the tree. The filter chips
stay, above a folder's or a search's results, for narrowing down.

### A folder is a page

No new kind of item. A page already holds sub-pages; it now also holds tables and files.

- `space_table.parent_id` and `space_file.parent_id` (for documents), pointing at a page, null at
  the top. `position` orders siblings as it does for pages.
- A page without text shows as a folder (folder icon) and opens as its contents. A page with text
  shows its text above its contents, as peer-it shows a folder's `README.md`.
- **A wizard's path does not change** when a table or a file moves: `tables/<slug>` and
  `files/<name>` stay unique in the space. A page's path still follows its parents, as today.
  Moving a page renames its path; the studio says so before the move when a wizard names it.

### The start page

- Heading „Wissen“, one sentence: „Was deine Wizards nachschlagen.“ One button „Hinzufügen“ with
  a menu: Seite, Tabelle, Hochladen (files or a folder), Aus Dateien übernehmen, and what plugins
  add (Website, Sitemap).
- Empty: Goose first. Its introduction stands at the top of the page (`AssistantSlot` with
  `useAssistantPage` in `SpaceSettings.tsx`, which Wissen already has): „Was sollen deine Wizards
  wissen?“, one field that takes documents, and suggestions for the common cases („Binde meinen
  Ordner ein …“, „Lies diese Website ins Wissen: …“, „Wie kommt Wissen in den Space?“). Goose
  answers with a proposal card: a folder becomes a mount in Dateien (the review of „Ordner
  einbinden“), a website a source of Wissen. The person presses the button; Goose never mounts or
  connects on its own. Under it, the ways by hand as one row of buttons (Hochladen, Aus Dateien
  übernehmen, Seite schreiben), and one line on Kategorien: they come later, and engenty proposes
  them.
- Goose's tools for this: `propose_source` and its card move from the sources plugin into core
  with the pipeline; the plugin's kinds add theirs; a mount's card is the media plan's. Writing pages is the Goose
  tool built in a parallel session (uncommitted).
- Filled: the top-level folders as cards (count, link mark, last change), then „Zuletzt
  geändert“ as rows. Rows show the kind, the title, where it sits, at most two category chips.
- The search field says „Wissen durchsuchen“ and opens the palette (below).
- What a step can't do yet (no embedding model, no classifier) is a notice with a link to
  Modelle, not a grey line at the end.

## Folders: Wissen owns, Dateien mounts

Decided by the user on 2026-11-01, through the media plan (`media-and-files.md` v2, worktree
`hopeful-mcclintock-b76b50`): **Ressourcen are split by owner.** Info, Marke, Wissen and Daten are
the space's own. A new Ressource **Dateien** holds file trees another party owns: a folder on this
computer, S3, Google Drive, OneDrive or SharePoint. A space can have any number of them. A mount
is indexed where it lies, and edits go back through „Veröffentlichen“. Dateien is the media
plan's; this plan only says how Wissen meets it.

What that means for Wissen:

- **Wissen is what the space owns:** written in the studio, uploaded, or taken in from a source.
  It never mounts an outside file system and never writes back to one.
- **„Ordner verbinden“ leaves Wissen.** Mounting a folder is „Ordner einbinden“ in Dateien. The
  flow (system folder dialog, review of what was found, folder names as a Kategorie) is the same
  one, drawn in Mockup 4 and owned by the media plan.
- **A mount is a source for Wissen.** The new source kind „Aus Dateien übernehmen“ takes a folder
  of a mount, or one file, into Wissen: copied and converted as uploads are (pages, tables, the
  original kept), and kept current by the source. That is for the part someone wants to curate,
  e.g. `Kunden/Referenzen`, not for the whole drive. A wizard can search a mount directly.
- **Uploads stay in Wissen:** „Hochladen“ takes files or a whole folder from the browser
  (`<input webkitdirectory>`), with its structure, copied once. It is renamed from „Dateien
  hochladen“ so it doesn't clash with the Ressource.

### A source fills a folder

Every source writes into its own folder of Wissen and owns what it wrote, marked with its origin
as plugin items are today (`origin`, `originKey`, `kept`, `server.spaceData`). One pipeline for
every kind: list, changes, read, ingest, index. A person learns one idea, a Quelle, with one
status and one place for its settings (the folder's ⋯ › Quelle).

| Kind | Where | Reads |
|---|---|---|
| Aus Dateien übernehmen | Core | A mount's reader (the media plan's `list`, `changes`, `read`, `stat`) |
| Website, sitemap, list of addresses | Sources plugin | Crawling, schedules, the signal address |

- The source's items are read-only in Wissen. „Als eigene Seite übernehmen“ makes a page the
  source no longer touches. A file changed at the mount is read again.
- A directory becomes a sub-folder of the source's folder (its `README.md` or `index.md` is the
  folder's text). `.md` and `.txt` become pages, `.csv` and `.xlsx` tables, PDFs and Word files
  pages with sub-pages and the original, anything else a file.
- Removing a source removes what it wrote, except what a person took over.

**Decided by this plan (recommendation): core owns the pipeline; the sources plugin owns the web.**

| Core (open, every install) | Sources plugin `data-sourcer` (closed, optional) |
|---|---|
| The tree, folders, moving, drag and drop | Websites, sitemaps, lists of addresses |
| Hochladen: files or a folder, with its structure, once | Schedules („täglich“, „wöchentlich“), the signal address |
| The source pipeline: source rows, list, changes, read, ingest, status, refresh | Kategorien a model proposes from samples, filled per entry |
| „Aus Dateien übernehmen“, the source kind on a mount's reader | Leaving entries out, the Protokoll |
| Goose's `propose_source` and its card, moved from the plugin | Its kinds in the same card and dialog |
| The „Hinzufügen“ menu, with a slot for plugins (`registerKnowledgeSource`) | |

**Why in core:** taking a folder in needs no model, no schedule and no account, only the reader
core already has, so the open version must do it. The web needs crawling, schedules and a model,
which is what a Pro module is for.

### What changes in the sources plugin

- Its source rows and run loop move into the core pipeline; it keeps its web kinds. Its `folder`
  kind becomes a mount in Dateien plus, where it filled Wissen, an „Aus Dateien“ source, once, by
  command. Today it flattens a folder into the top level (`plugins/data-sourcer/src/discover.ts`,
  `run.ts`); that goes.
- Each source writes into its own folder (a root page, `putPage` with `parent`), and a website's
  paths become sub-folders.
- Its kinds come into the „Hinzufügen“ menu and Goose's card through
  `registerKnowledgeSource({ kind, label, icon, form, reader })`. The menu group „Data Sourcer ›
  Quellen“ goes; a source's settings open from its folder (⋯ › Quelle).
- Without the plugin: no Website or Sitemap in the menu. Everything else is there.

## What to take from peer-it

peer-it's docs app stores Markdown files in git; Wissen stores rows with categories, origin and
access rules. So the data model stays; the editor, the tree, the viewers and the search come over.
Several pieces came from wizards in the first place (`text-merge`, the search chunks).

| peer-it (`/Users/m/code/peer-it/packages/docs-ui/src`) | In Wissen | Where it goes |
|---|---|---|
| TipTap block editor with a lossless Markdown round trip: each block keeps its source and is written back byte for byte unless edited (`blocks/markdown.ts`; checked by `docs-ui/scripts/round-trip.ts`) | „Schreiben“ becomes the block editor; „Markdown“ is the CodeMirror view of the same text (the CodeMirror plan's reason against TipTap, lossy saves, no longer holds) | `apps/web/src/studio/space/PageEditor.tsx`, new `space/blocks/` |
| Slash menu: text, headings, lists, task list, quote, code, table, divider, „Link to a page“, „Table from the docs“, „Image/Document from the docs“, upload | Same, with „Link zu einer Seite“, „Tabelle aus Wissen“ (embeds a Wissen table), „Datei aus Wissen“; uploads go into the page's folder | `blocks/slash.tsx` |
| Block gutter: + and ⋮⋮ (drag, turn into, duplicate, delete); bubble menu for marks and links | Same | `blocks/gutter.tsx` |
| A lone link to a CSV renders as an embedded table | A lone link to `tables/<slug>` renders the Wissen table | Reader and editor |
| Tree rows: kind icons, hover „+“ and „⋯“ (Open, New here, Copy link, Rename or move, Delete), auto-expand to the open item, resizable column | Same, plus drag and drop (positions exist), the mark of a source's folder, a dot for „Prüfen“ | `SpacePage.tsx` knowledge menu, new `space/KnowledgeTree.tsx` |
| A folder shows its README, else a listing (`FolderView`) | A folder page shows its text, then cards | `Knowledge.tsx` |
| Viewers: tables with sort and edit, Excel with sheet tabs (SheetJS), sandboxed HTML, images, CodeMirror for text | Same for originals; Wissen adds a PDF viewer (pdf.js), opening at a search hit's page (`KnowledgeHit.sheet`) | `space/Documents.tsx` (`FileView`) |
| ⌘K palette: „Changed lately“ before typing, results in groups (files, images and pages, passages), „Ask Goose“ on ⌘↵, a hit opens at its passage and flashes it | Same over Wissen's search, plus category chips to narrow it; „So findet es ein Wizard“ shows the relevance numbers (today's „Suche testen“) | New `space/KnowledgePalette.tsx`; `POST /search` exists |
| Upload review: keep or drop per file, „replaces“ where one exists | A large upload, and „Aus Dateien übernehmen“ (Dateien's „Ordner einbinden“ uses it too) | `NewFile.tsx` → `space/AddDialog.tsx` |

Not taken: the git store and „Publish“ (Wissen saves as you type and has live changes), presence
and comments (live changes have presence already; comments are a later plan), the energy app.

## Steps

Behind the switch `knowledgeTree` (`packages/shared/src/feature-flags.ts`), in small PRs. The PR
that turns it on names the feature.

1. **The start page explains itself.** No data change. The heading and sentence, „Hinzufügen“
   with its menu, the empty state with Goose first and three ways by hand, quieter rows, the search placeholder, the
   models notice. A plugin's knowledge section can drop its group label, so „Data Sourcer“ leaves
   the menu.
2. **Ordner.** Migration: `parent_id` on `space_table` and `space_file`. The tree in the menu
   (pages with their sub-pages, tables, files), folder pages with cards, breadcrumbs, „Neuer
   Ordner“, move by drag and drop and by „Verschieben nach …“. `listKnowledge` gives the tree.
3. **Kategorien as a tab.** The two tabs; categories open to their values; a value's page shows
   its summary and its items as cards (`ValueView`, `CategoryItems` exist). Category settings
   move behind „⋯ › Bearbeiten“. An empty Kategorien tab explains them in two sentences.
4. **Sources and folders.** The source pipeline in core (source rows, list, changes, read,
   ingest); Hochladen with folders; „Aus Dateien übernehmen“ once Dateien has its first mount (the
   media plan's step on a folder of this computer); „Als eigene Seite übernehmen“. Sources plugin:
   its kinds on the pipeline, own folder per source (Manage repo, its own PR).
5. **Editor and viewers.** The block editor with its slash menu, gutter and embeds; the Markdown
   view stays. PDF, Excel, HTML and image viewers in `FileView`.
6. **Search.** The ⌘K palette with groups, recent items, category chips, „Goose fragen“, and a
   hit that opens at its passage. Hits are grouped by where they live: Wissen, then each mount of
   Dateien the person may see. The palette is shared with Dateien.

Later: comments on pages. Shared with Dateien (media plan): the tree, the editor, the viewers and
the palette. Not planned: Wissen writing back to a source.

## Open points (the user decides)

1. Tabs (A) or one tree with Kategorien as filters only (B). Recommendation: A.
2. Kategorien across Wissen and Dateien: one set for the space, so the Kategorien tab lists
   mounted files beside Wissen's items, each with where it lives (recommended). Or a set per
   Ressource. To settle with the media plan, which keys Kategorien on mounted files by file id.
3. The tab names: „Ordner“ and „Kategorien“ (recommended), or „Inhalt“ and „Kategorien“.
4. FAQ: a table format in Wissen (`format: "faq"`, the media plan's reading and recommended
   here), or a Ressource of its own as you mentioned („Another Ressource could be an FAQ
   knowledge base“). Under the rule „a Ressource is another owner“ it stays in Wissen.
5. Whether a table's and a file's path should follow the folder, as a page's does. Recommended:
   no, so moving never breaks a wizard.
