# Plan: media, files and the Ressource „Dateien“

Status: planned on 2026-11-01; nothing built. Page with the mockups: the artifact “Medien und
Dateien” (claude.ai/artifact/27Dg6VwV159DGsetPywyaU; source `media-and-files.html`). It sits beside
`docs/plans/knowledge-base.md` (Wissen's tree, editor and search), planned the same day; where the
two meet is said below.

Decided by the user on 2026-11-01:

| | Decision |
|---|---|
| D1 Ressourcen by owner | What the space owns is Info, Marke, Wissen, Daten. What another party owns (a computer's folder, a drive, a bucket) is a new Ressource, **Dateien**: mounted, read and indexed where it lives, edited through a publish back to its source |
| D2 Several mounts | A space has any number of mounts, each with its own connection and its own access |
| D3 No text kept for mounted files | A mounted file keeps a pointer, vectors, a word index without its text, a fingerprint and a thumbnail. Agents and the search read the original |
| D4 Pictures by what they show | EmbeddingGemma 2 embeds pictures and PDF pages as pictures, on a computer in Ollama and in the cloud in an Ollama of engenty's own, as peer-it does |

Today Wissen takes in text. A web page becomes Markdown with its pictures as outside URLs
(`server.web.read` → `htmlToMarkdown`; `plugins/data-sourcer/src/run.ts` in the Manage repo). A
picture uploaded into Wissen is read by a vision model into a page of text. A folder of the sources
plugin is copied file by file into the space (at most 1000 listed, 200 per run, 30 MB per document).
None of that carries a photo archive, a drive of 40 GB or the pictures of a website into something a
wizard can find and use.

## What is there today

| | Where | What it means for media and files |
|---|---|---|
| Rows | tenant database (libSQL; Turso in the cloud) | `space_page.markdown`, `space_table` rows, `space_file` (kind `logo`, `asset`, `document`, `pattern`), Kategorien, the index `space_chunk` (FTS5 words and trigrams over `space_chunk.text`, vectors) |
| Bytes | `objects` (`files/objects.ts`): `DATA_DIR/objects/` on a computer, an S3 bucket in the cloud (RustFS on the VPS) | Every key under `t/<tenant>/`. Space files and run files at `assets/<id>.<ext>` (random id, no dedupe); workspace and sync files at `blobs/<aa>/<sha256>` |
| Reading cache | `DATA_DIR/parsed/<sha256>.json` | A file is read and paid for once |
| Pictures of the web in results | `files/web-images.ts` | Already copies: a generated page loads nothing from the network, so each picture is fetched once into the run as `asset://ID` |
| Embeddings | `models.ts` `embeddingModel()` | On a computer EmbeddingGemma in Ollama by default, called through the OpenAI-style API: text only. In the cloud the Manage class `wizards/embedding`, routed per model tier, `openai/text-embedding-3-small` |
| Drives | `connections-google` `google-drive`, `connections-microsoft` `microsoft-onedrive` | Steps search, list and read files through a connection. Nothing indexes or keeps a drive |

## What peer-it already does

peer-it's docs app (`/Users/m/code/peer-it/packages/docs-server/src`):

| | |
|---|---|
| Model service | Coolify `peer-it-ollama`: `ollama/ollama:0.40.13`, internal, on the same VPS; the docs app reaches it at `OLLAMA_BASE_URL` |
| Model | `embeddinggemma-2:740m`; text and pictures share one 768-dimension space |
| The call | Ollama's `/api/embed` with `{ image: base64 }` (`embedding.ts`); the OpenAI-style endpoint takes no pictures |
| Pictures | One unit each, a 768 px JPEG embedded as a picture; words: the file name |
| PDFs | One unit per page: its text, and its picture embedded (first 40 pages); a 320 px thumbnail in the database (`media.ts`) |
| Word, Excel, text | Passages of text, as wizards cuts them |
| Embedding | In the background, only units without a vector of the current model; visual units read the file again (`embedFile`) |
| Search | Words (FTS5) and meaning fused by rank; a decision model ranks the text hits, pictures keep their place; meaning counts only where the best stand out (`MIN_LEAD`) |
| Not handled | Audio and video; the model takes audio too |

## 1. Pictures of pages Wissen takes in: copy them

**Copy the pictures a page shows into the space, once, deduplicated; keep the outside URL as the
source.** This is Wissen (owned by the space), not Dateien.

| | A. Copy (recommended) | B. Keep the URL |
|---|---|---|
| Found by what it shows („Foto vom Messestand“) | Yes, embedded as a picture | Only the alt text |
| Usable in a wizard's result | Yes, `asset://ID` | No: a generated page loads nothing from the network |
| When the site changes or goes | Still there | Broken image |
| Offline on a computer | Yes | No |
| Rights | A copy for the space's own use; the source stays named; never published by Wissen itself | No copy |

What is copied: the pictures of the page's content (the reader's `content` field; until then
`<main>`/`<article>`), not under 10 KB or 200 px, no SVG sprites, the same bytes once, at most 30 per
page and 8 MB each (`web-images.ts`), from a `srcset` the largest up to 2000 px.

- The Markdown points at the copy: `![Messestand 2026](asset://Xy12…)`; the file keeps `source`.
- Pictures show in the page and its „Bilder“ strip, and in the search's picture group; not as items
  in the tree. „In Marke übernehmen“ makes one a brand asset (same bytes).
- Where no embedding model takes pictures (no Ollama on a computer), a vision model describes the
  picture in one sentence, as `describeImage` does for Marke today.
- A picture no page of the source uses any more goes with the next run.

## 2. Where it lives

**The database keeps what is searched and edited; the object store keeps the space's own bytes, by
their hash; caches stay rebuildable; a mount's bytes stay at its source.**

| | Database (tenant) | Object store (`objects`) | Cache (`DATA_DIR`) | The source |
|---|---|---|---|---|
| Wissen, Marke | Pages, tables, file rows, Kategorien, index units with their text | Originals, copied pictures, texts, thumbnails | Reading results | — |
| Dateien | Mount and file rows (pointer, fingerprint, Kategorien), index units without text, vectors | Thumbnails | Read originals, bounded (2 GB, oldest out) | The files |
| Cloud | Turso | S3 bucket (RustFS) | the runtime's volume | Drive, SharePoint, a bucket |
| Computer | `data/*.db` | `data/objects/` | `data/parsed/` | the folder |

```text
t/<tenant>/
  blobs/ab/ab12…             Wissen and Marke originals and texts, by sha256
  derived/ab12…/thumb.jpg    320 px, for lists and search
  derived/m/<mount>/<file>.jpg   a mounted file's thumbnail
  assets/<id>.<ext>          run files, logos (public links), as today
```

- `space_file.hash`: a space file's bytes move from `assets/<id>` to `blobs/` by hash; the same
  picture on 200 pages, or in Marke and in Wissen, is stored once, and sync already moves blobs by
  hash. Logos keep their asset (public links). Existing files move once, by a `wizards` command,
  with no second path in the code.
- Not Markdown files on disk as the truth: Wissen saves as you type, has live changes, Kategorien
  and access per item. A folder of `.md` files someone keeps is a mount.

## 3. Dateien: mounted file trees

A mount is a file tree another party owns: a folder on this computer, an S3 bucket, a Google Drive
folder, a OneDrive or SharePoint folder. Dateien shows it as it is there.

### What a mounted file keeps

| Kept | For |
|---|---|
| Pointer: the mount, the file's id or path, where each unit stands in it (page, offset) | Reading the original at that place |
| Vectors per unit: passages of text, pictures and PDF pages as pictures (EmbeddingGemma 2) | Search by meaning |
| A word index without the text (FTS5 `content=''`) | Codes, names, part numbers |
| Fingerprint | Changes, without reading again |
| Thumbnail (320 px) | Grids and search results |
| Kategorien: the space's one set, shared with Wissen, keyed by the file's id | Filtering; Wissen's Kategorien tab lists mounted files with where they live |

No text is kept. What needs it reads the original:

| When | What is read | What stays |
|---|---|---|
| Mounting, and on each change | The listing, then each changed file once, to cut and embed it | The table above |
| A search | The units of the first ~24 hits, for the decision model and the snippets | The bounded cache |
| Opening in the studio | The original, streamed through the runtime | Nothing |
| A step uses it | The original, into the run as a run file | The run file, as long as the run |
| „In Wissen übernehmen“ | The original | A copy in Wissen, converted as an upload is |

What it costs: while a source is away (a computer off, an account disconnected) the search still
finds by meaning and words, but nothing opens and no snippet shows. A new embedding model reads
every original again.

### Change detection

| Source | Fingerprint | Changes |
|---|---|---|
| Folder on a computer | time and size; hash when they differ | `fs.watch` recursive plus a rescan at start and hourly |
| S3 bucket | ETag | `ListObjectsV2` against the rows; daily or by the signal address |
| Google Drive | `md5Checksum`, `modifiedTime`; Google Docs by `version` | `changes.list` from a saved page token |
| OneDrive, SharePoint | `cTag`/`eTag` | `/delta` from a saved delta link; a webhook later |

A file keeps its row when it moves or is renamed (drive ids; on a computer the hash), so its
Kategorien stay.

### Editing and „Veröffentlichen“

As peer-it's Publish: an edit stays a draft in engenty, „Veröffentlichen“ writes it to the source
with the version it was read at. Changed there meanwhile: „Vergleichen“, „Meine behalten“, „Ihre
übernehmen“ (`text-merge` for text). A mount is read-only unless the person allows writing when
mounting; only then does the connection ask for write scopes (Drive `drive`, Microsoft
`Files.ReadWrite.All`, the folder's write right).

### Access

- A mount's connection reaches what the account or key reaches; pick a folder, not a whole drive.
- Each mount says who in the space sees it and which wizards may use it (broker `rwx` per mount).
  The mount dialog says it in one line: „Alle in diesem Space sehen, was in diesem Ordner liegt.“
- Mirroring a drive's sharing per file is later (Team).

### For wizards and Goose

- Path: `dateien/<mount>/<path>`, apart from Wissen's `files/<name>`.
- `space_search` searches Wissen and the mounts the wizard may use; a hit says where it lives.
  A step reads a hit's original through the same tool as a Wissen file (`space_document`).

### Wissen takes in from Dateien

A Wissen source of the kind „aus Dateien“ copies a mount (or a folder of it) into a Wissen folder,
read and converted as uploads are, and keeps it current. „In Wissen übernehmen“ does it for one file.

## 4. Pictures by what they show, on a computer and in the cloud

- **The runtime** gets an embedder that takes pictures, taken over from peer-it: `images`,
  `embedImage(jpeg)` over Ollama's `/api/embed`, `jpegOf`, `pdfPages`, `thumbOf`. Pictures and PDF
  pages become units embedded as pictures, for Wissen, Marke and Dateien.
- **In the cloud**: an Ollama of engenty's own on the VPS (`ollama/ollama`, `embeddinggemma-2:740m`,
  internal), not `peer-it-ollama`. The Manage class `wizards/embedding` gets a route to it, and the
  gateway a call that passes pictures to `/api/embed`. Running on the own EU server also suits the
  EU-Souverän tier.
- **Switching models** embeds everything again in the background (units record their model, as
  today); for mounts that reads every original once more.
- **Large indexes**: a libSQL vector index (DiskANN, `libsql_vector_idx`) instead of comparing every
  vector, and peer-it's `MIN_LEAD`.
- **Before building**: one measurement on the VPS (100 pictures, 10 PDFs against an Ollama there).
  It is a CPU; the answer says whether a 40 GB mount takes hours or needs a GPU host.

## 5. Open core, plugin, plans

| Core (open, every install) | Sources plugin `data-sourcer` (closed, optional) |
|---|---|
| Storage by hash, thumbnails, the picture embedder | Websites, sitemaps, address lists into Wissen, with their pictures (`putPage` `images`) |
| The Ressource Dateien: mounts, the text-free index, open on demand, drafts and „Veröffentlichen“, access per mount | Mounts of S3, Google Drive, OneDrive and SharePoint, through connections |
| A folder on the computer as a mount | Schedules, the signal address |
| Wissen sources pipeline (`knowledge-base.md`), the source „aus Dateien“ | Kategorien a model proposes from samples |
| `registerKnowledgeSource` and a mount reader: `list`, `changes`, `read`, `stat`, `write` | Its kinds implement the reader |

Model work in the cloud runs on credits; on a computer's own Ollama it is free. No plan check in the
core.

## Where this meets `knowledge-base.md`

| That plan | This plan |
|---|---|
| „Ordner verbinden“ as a Wissen source, ingested into one Wissen folder | A folder is mounted in Dateien; Wissen takes in from a mount by the source „aus Dateien“. Its source pipeline and `registerKnowledgeSource` stay as planned there |
| Files stay files, pages only by „Als Seite übernehmen“ | Holds for Wissen; in Dateien files are never converted, „In Wissen übernehmen“ copies |
| The tree and `parent_id` | Copied pictures stand under their page. Dateien has its own tree, the source's |
| Viewers (PDF, Excel, pictures), the ⌘K palette | Shared by Wissen and Dateien; the palette groups hits by where they live |
| Goose's proposal card „Verbinde meinen Ordner …“ | Proposes a mount in Dateien |

## Steps

Behind the switch `dateien` for the Ressource and `knowledgeMedia` for Wissen's pictures, in small
PRs.

1. **Measure.** EmbeddingGemma on the VPS's CPU: pictures and PDF pages per minute.
2. **Bytes by hash.** `space_file.hash`, `blobs/`, thumbnails in `derived/`, the one-time command.
3. **Pictures embedded as pictures.** The embedder with `embedImage`; Wissen and Marke pictures and
   PDF pages as visual units; the Ollama service on the VPS, its route in Manage, the gateway's
   picture call. Everything embedded again once.
4. **Pictures of web pages.** `images` on `putPage`; copy, rewrite to `asset://`, index; the sources
   plugin passes the content's pictures. The „Bilder“ strip, „In Marke übernehmen“.
5. **Dateien, read.** The Ressource with a folder on this computer as its first mount: mount and file
   rows, the source's tree, the text-free index, open on demand, access per mount, the wizards' path
   and search over both.
6. **Mounts of drives.** The mount reader; the sources plugin brings S3, Google Drive, OneDrive and
   SharePoint.
7. **Editing and „Veröffentlichen“.** Drafts, writing back, the comparison; write scopes on request.
8. **Wissen from Dateien.** The source „aus Dateien“ and „In Wissen übernehmen“.
9. **Later.** The libSQL vector index, audio and video, a computer's mount seen from a cloud space,
   drives' sharing per file.

## Open points (the user decides)

1. The Ressource's name: „Dateien“ (recommended; Wissen's „Dateien hochladen“ becomes „Hochladen“),
   „Ablage“ or „Laufwerke“.
2. Drive and bucket mounts in the sources plugin (recommended, as Pro) or in the core next to the
   computer's folder.
3. A mount read-only by default, writing allowed per mount (recommended), or writable by default.
4. The Ollama service: engenty's own (recommended) or shared with peer-it.
5. FAQ: a table format in Wissen (recommended; tables already have `format: "faq"`, and a
   Ressource comes from a different owner, not from a kind of content), or a Ressource of its own.
   The same open point stands in `knowledge-base.md`.
