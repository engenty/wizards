# Plan: a computer's Dateien seen from its cloud space

Status: planned on 2026-11-01, reworked the same day; nothing built. Step 9 of
`docs/plans/media-and-files.md`, the part „a computer's mount seen from a cloud space“. Page: the
artifact “Dateien aus der Cloud” (claude.ai/artifact/3n2eFataR8ktmPpHzXcgWD; source
`dateien-from-the-cloud.html`).

Decided by the user on 2026-11-01:

| | Decision |
|---|---|
| C1 The index goes to the cloud | A mount's metadata and index sync to the cloud: the tree, file rows, units, vectors, the word index, Kategorien. Only the files' bytes stay on the computer |
| C2 Previews go too | Each file gets a small preview, a thumbnail and an excerpt, kept on the computer and synced: for lists, search hits and what an agent sees before it opens a file |
| C3 One model on both sides | The cloud embeds with the same EmbeddingGemma 2 as the computer, so the computer's vectors are used as they are and the cloud embeds nothing of the mount again |

A person mounts a folder of their computer in Dateien, say a Dropbox folder of 378 MB. Today the
cloud sees none of it: sync (`sync/records.ts`, `KIND_ORDER`) carries space, files, tables,
categories, rows, pages, connectors, skills and wizards, no mounts. Only what goes into Wissen
arrives in the cloud. Wissen's files go with their bytes (by hash), and the cloud embeds them again
with its own model (`queueIndex` in the `file` kind's `write`).

The goal: the cloud space lists that folder, finds its files by words and meaning, and shows their
previews, whether the computer is on or not. Opening a file reads it from the computer while the
computer is on. Who uses it: the same person in the studio in a browser or on the phone, wizards
that run in the cloud (share links, starts), and members of the space.

## Verdict

**Two pieces.**

1. **The index syncs, one way.** Mounts and their files are two new sync kinds, written by the
   computer only. A file's record carries its metadata, its excerpt and two blob hashes: its
   thumbnail and its index (units, vectors, words). Blobs move by hash, as Wissen's files do. The
   cloud writes the rows and fills its own word index from the words; vectors go in as they are.
2. **Files open through the computer.** For the bytes or the full text, the computer keeps a
   streamed call to the cloud open (`GET /api/v1/dateien/live`, SSE, as the sync's live call),
   signed in with the linked account's token. The cloud sends a request down that stream; the
   computer answers with `POST /api/v1/dateien/calls/:id`. Across the cloud's processes a request is
   a row in the tenant database, as `device_call` is for the phone (`engine/device.ts`). No port is
   opened and no public tunnel runs.

| | Kept in the cloud | Read from the computer, while it is on |
|---|---|---|
| Tree: paths, names, sizes, times, hashes, status | yes | |
| Kategorien | yes (two-way) | |
| Thumbnail (320 px) and excerpt | yes | |
| Units, vectors, word index | yes | |
| A search hit's passage (snippet) | the excerpt where the computer is away | yes |
| A file's full text, its bytes | no | yes |

## What exists

| Piece | Where | Use here |
|---|---|---|
| Sync kinds, change log, blobs by hash | `sync/records.ts`, `sync/log.ts`, `files/blobs.ts` | Two kinds `mount`, `mountFile`; triggers on `space_mount`, `space_mount_file`; thumbnails and index blobs by hash |
| Mount rows | `space_mount`, `space_mount_file` (`title`, `hash`, `status`, `thumb`), `space_mount_unit` (`heading`, `sheet`, `start`, `end`, `embedding`, `model`, `kind`) | The record and the index blob are made of these; the cloud writes the same rows |
| The indexer | `mounts/mounts.ts` (`scanMount`), `mounts/units.ts`, `mounts/cache.ts` | Writes the index blob and the excerpt when it indexes a file |
| Search with mounts | `services/space-index.ts` `searchKnowledge`, `usableMounts`, `readableMounts` | Works in the cloud as it is, over the synced rows |
| The embedder | `models.ts` `embeddingBy`, `LOCAL_EMBEDDING_MODEL` | The cloud's `credits` way must reach EmbeddingGemma (step 1) |
| The sync's live call | `routes/api.ts` `/sync/live`, `sync/client.ts` `followCloud` | The shape of the stream that opens files: token, `x-wizards-install`, ping every 20 s, 30 min, back-off 2 s to 60 s. Its own route, since `followCloud` runs only with the two-way sync and `liveChanges` on |
| The phone as a model | `engine/device.ts` | The request row, the 250 ms poll, the time-out, the delete in `finally`, the answer written once and only by its owner |
| Processes in the cloud | `docs/plans/runner-process.md` | `/api/v1` is served by the studio process, steps run on the runner: a row bridges them |
| Access per mount | `mountRules(id, see, wizards, writable)`, broker kind `mount` | The cloud's row gets rules the same way, never `w` |
| Plugin mount kinds | `readerOf`, `startMounts` | A computer's mount in the cloud has no reader there: `startMounts` skips it |

## 1. One model on both sides

The cloud embeds through the Manage class `wizards/embedding` (the `credits` way); its default is
`openai/text-embedding-3-small`. Manage's main has no EmbeddingGemma route and no
`picture-embedding` call yet; #425 built only the runtime's half of step 3 of
`media-and-files.md`. That cloud half comes first:

- An Ollama of engenty's own on the VPS (`embeddinggemma-2:740m`, internal), the class
  `wizards/embedding` bound to it, the gateway's `/v4/ai/picture-embedding`.
- One name for the model on every way. Units record the model they were made with and only vectors
  of one model are compared. The computer records `ollama:embeddinggemma-2:740m`; the cloud must
  record the same name, so `embeddingBy` names EmbeddingGemma alike whichever way reaches it.
- The cloud embeds the search words with it; they meet the computer's vectors, pictures included.
- Where the two differ (a computer set to another model, a tier binding another one), the cloud
  ignores the synced vectors and finds by words; it can't embed again without the text.

## 2. What syncs

Two kinds, after `file` in `KIND_ORDER`: `mount`, then `mountFile`.

| Kind | Record | Blobs |
|---|---|---|
| `mount` | name, slug, kind, where it lives (`computer`: the computer's name; a folder's path), file count, size, `see`, `wizards`, `writable`, Kategorie of the first level | — |
| `mountFile` | mount, path, `sourceId`, name, mime, size, modified, hash, status, pages, title, excerpt, Kategorien, `thumb` (a hash), `index` (a hash) | the thumbnail, the index |

- **The index blob:** per file, its units (idx, heading, sheet, start, end, kind), their vectors
  (768 float32 each, with the model's name) and their words. Made by the indexer when it indexes the
  file, stored by its hash. A file whose index didn't change sends nothing again.
- **Words:** the words of each unit, in their order of first appearance, each once, lower case.
  The cloud fills `space_mount_unit_fts` and `_tri` from them. Phrase searches across words don't
  work in the cloud; single words, codes, names and part numbers do.
- **Thumbnails** move from `derived/m/<mount>/<file>.jpg` into the blobs by hash, so they sync as
  any blob and a picture in two mounts is kept once.
- **One way, but Kategorien:** the computer owns the mount. The cloud refuses a push of `mount` and
  `mountFile`; Kategorien set on a mounted file in the cloud come back as today's categories do.
- **Which mounts:** see D1.
- **Wissen too:** with one model, a Wissen file's vectors can travel the same way (its index blob
  beside `textHash`), and the cloud stops embedding again what the computer already did. Step 7.

## 3. Previews

| | Thumbnail | Excerpt |
|---|---|---|
| What | 320 px JPEG, as today | the title (`title`) and the first ~400 characters of the file's text, cut at a sentence |
| For | grids, search hits | lists, search hits while the computer is away, what an agent sees before it opens a file |
| Pictures | the picture | none (D5: or a one-line description) |
| PDF | the first page | the first page's text |
| Spreadsheets | — | sheet names and the first header row |
| Kept on the computer | `blobs/`, by hash | `space_mount_file.excerpt` |

The excerpt changes D3 of `media-and-files.md` („no text kept“) a little: 400 characters per file
are kept, on the computer and in the cloud. Everything else of the text stays at the source.

## 4. Opening a file

`askComputer(install, request, timeoutMs)` in the cloud, `answerComputer(id, install, answer)` on
the route: `device.ts` with a table `mount_call` (id, install, request, answer, `relay`, created).
The studio process holding a computer's stream polls the open calls of its installs every 250 ms
and sends each once.

| Call | Asks | Answers | Limit | Waits |
|---|---|---|---|---|
| `units` | units of up to 24 hits | their passages, for snippets and the decision model | 24 × 2 000 characters | 3 s, then the excerpt |
| `text` | a file | its text, from the computer's cache (`ownText`) | 200 000 characters | 20 s |
| `bytes` | a file | the original | 25 MB | 60 s |

- **The connection:** the computer opens it when an account is linked, a space with mounts syncs
  with the cloud and the switch `dateienCloud` is on. The person behind the token needs build
  rights in the cloud space; a space of another organization is refused
  (`refuseOtherOrganization`). A row `install_link` per computer (install id, person, name, `seen`)
  says it is on: `seen` under 45 s old. `followDateien`, in the shape of `followCloud`, opens it
  again after 30 minutes, after a drop or after the computer wakes.
- **On the computer** a call runs as the linked person through the existing functions
  (`mountFileText`, `mountFileContent`, `unitTexts`), only for a mount that syncs, only paths
  inside it.
- **Answers up to 256 KB** go into the row. Bigger ones go to the object store under
  `t/<tenant>/relay/<callId>`: the waiter reads the key and deletes it at once, a sweep removes keys
  older than 10 minutes. Where the waiter and the stream are the same process (opening a file in the
  studio) the bytes are handed over in memory.
- **Several computers:** each mount names its computer; a call goes to the computer the mount is on.

## 5. While the computer is away

The cloud keeps working on what it holds:

- Dateien shows the tree, thumbnails, excerpts and Kategorien, with „Auf MacBook Pro · nicht
  erreichbar seit 14:02“ in the mount's header.
- Search finds by words and meaning; a hit shows the excerpt in place of its passage.
- Opening a file says the computer is away. A step that needs the file: D3.
- A start in the cloud at night (a schedule, a webhook) finds the file but can't read it while a
  laptop sleeps.

## 6. Access

- **Who sees it in the cloud:** on the computer one person sees the space; in the cloud the whole
  team may. `MountSee` gains a third value, `owner` (only the person whose computer it is) (D2).
- **Which wizards:** the computer's `wizards` setting, written for the cloud row by `mountRules`.
  A wizard a visitor runs through a share link searches the mount only if that wizard may use it,
  as with Wissen.
- **Writing:** no writing from the cloud (D4). Drafts and „Veröffentlichen“ stay on the computer.
- **Checked twice:** the cloud's broker before it searches or asks; the computer checks the mount
  and the path before it answers.

## 7. Privacy

| Kept in the cloud | Passes through the cloud, kept nowhere | Stays on the computer |
|---|---|---|
| Paths, names, sizes, times, hashes, Kategorien | A hit's passages | The files' bytes |
| Thumbnails, excerpts (~400 characters) | A file's text or bytes when it is opened | The full text |
| Units, vectors, each unit's words | | |

- Each unit's words and the vectors say a lot about a file, and vectors can be turned back into
  text in part. The mount dialog says it plainly: „Namen, Vorschauen und der Suchindex dieses
  Ordners kommen in der Cloud an. Die Dateien selbst bleiben auf diesem Computer.“
- A run that reads a file keeps it as a run file as long as the run, as every file a step uses.
- What a step reads goes to that step's model, under the organization's model tier.
- Answers of the calls carry `cache-control: private, no-store`; relay keys live for seconds.

## 8. Costs and limits

- **Models:** the computer embeds, free on its Ollama. The cloud embeds only search words, on its
  own Ollama.
- **Storage in the cloud:** a unit's vector is 3 KB. The measurement of step 5 (6.4 GB, 2,218 files)
  gave 9,590 passages, 1,296 pictures and 2,299 PDF pages: about 40 MB of vectors and 40 MB of
  thumbnails. The 378 MB Dropbox folder is a fraction of that; a 40 GB drive may be ten times.
- **First sync:** the whole index once, in pages of 300 records with their blobs; afterwards only
  changed files.
- **Opening:** the computer's upload. A 25 MB file over 10 Mbit/s takes about 20 s.
- **Per computer:** 4 calls at once, 120 per minute; more wait in the row queue.
- **Plan:** the switch `dateienCloud` per plan in Manage (everyone → plan → team) (D6).
- **Measure before the switch flips:** the first sync of the Dropbox folder, a search in the cloud,
  a 25 MB file from the VPS to a home connection.

## 9. Steps

Behind the switch `dateienCloud` (off), which needs `dateien`, in small PRs. Tables land in one
tenant migration on both sides in one release, since the sync refuses mismatched schemas
(`requireSchema`).

1. **EmbeddingGemma in the cloud** (Manage and the VPS): engenty's Ollama, `wizards/embedding`
   bound to it, the picture call; one model name on every way in `embeddingBy`.
2. **Previews and the index blob on the computer.** `space_mount_file.excerpt`, `thumb` as a hash
   in `blobs/`, the index blob written by the indexer; a `wizards` command builds both once for
   mounts indexed before.
3. **The sync kinds.** `mount`, `mountFile`; triggers; the cloud writes rows, units and its word
   index from the blob; pushes of both refused in the cloud but Kategorien; `startMounts` skips a
   computer's mount there.
4. **Dateien and search in the cloud's studio.** The computer's mounts with their tree,
   thumbnails, excerpts; „nicht erreichbar seit …“; search and ⌘K over them.
5. **Opening through the computer.** `mount_call`, `install_link`, the routes `live` and
   `calls/:id`, `followDateien`, the calls `units`, `text`, `bytes`, the relay keys and their sweep.
6. **Wizards in the cloud.** `space_search` with excerpts; `space_document` reads
   `dateien/<slug>/…` from the computer; the message when it is away.
7. **Wissen's vectors travel too.** With one model, a Wissen file's index goes with it; the cloud
   embeds only what it wrote itself.
8. **Limits and the switch.** Rates, sizes, the switch per plan in Manage, the measurement; a docs
   page under `docs/content` when the switch flips.

## Decisions (the user)

1. **D1 Which mounts sync:** every mount of a space that syncs, as everything else in it, with
   „Nur auf diesem Computer“ per mount (recommended), or only the mounts someone turns on.
2. **D2 Who in the cloud sees a computer's folder:** asked when it first syncs, default „Nur ich“
   (recommended; new value `owner`), or the computer's setting as it is.
3. **D3 A step that needs a file of an away computer:** the step stops with „MacBook Pro ist nicht
   erreichbar“ (recommended), waits up to 15 minutes, or goes on with the excerpt.
4. **D4 Writing from the cloud:** none, read only (recommended), or drafts in the cloud that the
   computer publishes when it is back.
5. **D5 A picture's excerpt:** none, it has its thumbnail (recommended), or a one-line description
   by a vision model.
6. **D6 Plans:** Pro and Team (recommended), or every plan.
7. **D7 Other computers of the space:** they don't pull a computer's mounts (recommended for now),
   or they show them as the cloud does and open files through the cloud.
8. **D8 Largest file through the connection:** 25 MB (recommended), or 100 MB.
