# Plan: a computer's Dateien seen from its cloud space

Status: planned on 2026-11-01, reworked the same day, every decision taken the same evening;
nothing built. Step 9 of
`docs/plans/media-and-files.md`, the part „a computer's mount seen from a cloud space“. Page: the
artifact “Dateien aus der Cloud” (claude.ai/artifact/3n2eFataR8ktmPpHzXcgWD; source
`dateien-from-the-cloud.html`).

Decided by the user on 2026-11-01:

| | Decision |
|---|---|
| C1 The index goes to the cloud | A mount's metadata and index sync to the cloud: the tree, file rows, units, vectors, the word index, Kategorien. Only the files' bytes stay on the computer |
| C2 Previews go too | Each file gets a small preview, a thumbnail and an excerpt, kept on the computer and synced: for lists, search hits and what an agent sees before it opens a file |
| C3 One model on both sides | The cloud embeds with the same EmbeddingGemma 2 as the computer, so the computer's vectors are used as they are and the cloud embeds nothing of the mount again |
| D1 Which mounts sync | Every mount of a space that syncs, as everything else in it; „Nur auf diesem Computer“ per mount keeps one out |
| D2 Who sees, who opens | Everybody in the cloud space the mount's setting names sees the tree, the metadata, the previews and finds by the index. Opening a file through the computer (its text, its bytes, a hit's live passage) is the owner's alone, the person whose computer it is, unless the mount allows more |
| D2a Wizards open too | A wizard the mount allows opens its files through the computer in the cloud, as on the computer: share links and starts included |
| D2b Passages as opening | A search hit's live passage counts as opening: who may not open sees the excerpt, as while the computer is away |
| D3 A step and an away computer | The step stops: „MacBook Pro ist nicht erreichbar“ |
| D4 No writing from the cloud | Read only. Drafts and „Veröffentlichen“ stay on the computer |
| D5 No excerpt for pictures | A picture has its thumbnail; no model describes it |
| D6 Plans | Pro and Team |
| D7 Other computers | They don't pull a computer's mounts, for now; only the cloud shows them |
| D8 Largest file | 25 MB through the connection |
| D9 Gone from the cloud at once | When a mount stops syncing („Nur auf diesem Computer“, removed, the account unlinked), its rows, index, thumbnails and excerpts go from the cloud at once |
| D10 Words without positions | The cloud's word index holds each unit's words without their positions: single words, codes, names and part numbers are found, phrases are not, and the text can't be rebuilt from it |

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
| The embedder | `models.ts` `embeddingBy`, `LOCAL_EMBEDDING_MODEL` | The `credits` way records the bound model's name (`bound.model`), the `local` way `ollama:<name>`: bound to EmbeddingGemma, both say `ollama:embeddinggemma-2:740m` |
| The sync's live call | `routes/api.ts` `/sync/live`, `sync/client.ts` `followCloud` | The shape of the stream that opens files: token, `x-wizards-install`, ping every 20 s, 30 min, back-off 2 s to 60 s. Its own route, since `followCloud` runs only with the two-way sync and `liveChanges` on |
| The phone as a model | `engine/device.ts` | The request row, the 250 ms poll, the time-out, the delete in `finally`, the answer written once and only by its owner |
| Processes in the cloud | `docs/plans/runner-process.md` | `/api/v1` is served by the studio process, steps run on the runner: a row bridges them |
| Access per mount | `mountRules(id, { see, wizards, agents, writable })`, broker kind `mount`; `see` is a list of audiences (team, clients, guests), the owner and admin roles always read | The cloud's row gets rules the same way, never `w`; opening is a `person` rule (D2) |
| Plugin mount kinds | `readerOf`, `startMounts` | A computer's mount in the cloud has no reader there: `startMounts` already skips a folder where `managed` |

## 1. One model on both sides

The cloud embeds through the Manage class `wizards/embedding` (the `credits` way). Manage's code
for it is on main since engenty/engenty-wizards-manage#169 (merged 2026-11-01): the source
`ollama` over `OLLAMA_URL`, the catalog row `ollama:embeddinggemma-2:740m`, the gateway's
`/v4/ai/picture-embedding`. Set up as Manage's `docs/content/setup/ai-gateway.md` („Our own
Ollama“) says; checked on 2026-11-01:

- An Ollama of engenty's own runs on the VPS: the Coolify service `ollama` in the project
  `engenty-wizards` (`ollama/ollama:0.40.13`, internal), apart from peer-it's, with
  `embeddinggemma-2:740m` pulled. `OLLAMA_URL` on the `manage` app reaches it.
- The class `embedding` of the tier General is bound to `ollama:embeddinggemma-2:740m` (route
  „engenty Ollama“, AT, region EU); a test call answers 768 dimensions in 395 ms. EU Private and
  EU Sovereign have no models in their lists yet and bind nothing.
- Measured on the VPS's CPU (`measure-pictures.ts`, one per call): 18.6 pictures and 12.8 PDF pages
  a minute (an Apple M4: about 30). Enough for the search words and Wissen's own pictures; a
  mount's pictures are embedded on the computer.
- One name for the model on every way. Units record the model they were made with and only vectors
  of one model are compared. The computer records `ollama:embeddinggemma-2:740m`; the cloud records
  `bound.model`, the same name. `test/embedding-ways.test.ts` holds the two together.
- Binding embeds every cloud space's Wissen again, once.
- The cloud embeds the search words with it; they meet the computer's vectors, pictures included.
- Where the two differ (a computer set to another model, a tier binding another one), the cloud
  ignores the synced vectors and finds by words; it can't embed again without the text.

## 2. What syncs

Two kinds, after `file` in `KIND_ORDER`: `mount`, then `mountFile`.

| Kind | Record | Blobs |
|---|---|---|
| `mount` | name, slug, kind, where it lives (`computer`: the install's id and the computer's name; a folder's path), file count, size, `see`, `wizards`, `open`, Kategorie of the first level | — |
| `mountFile` | mount, path, `sourceId`, name, mime, size, modified, hash, status, pages, title, excerpt, Kategorien, `thumb` (a hash), `index` (a hash) | the thumbnail, the index |

- **The index blob:** per file, its units (idx, heading, sheet, start, end, kind), their vectors
  (768 float32 each, with the model's name) and their words. Made by the indexer when it indexes the
  file, stored by its hash. A file whose index didn't change sends nothing again.
- **Words (D10):** the words of each unit, in their order of first appearance, each once, lower
  case, no positions. The cloud fills `space_mount_unit_fts` and `_tri` from them. Phrase searches
  across words don't work in the cloud; single words, codes, names and part numbers do.
- **Thumbnails** move from `derived/m/<mount>/<file>.jpg` into the blobs by hash, so they sync as
  any blob and a picture in two mounts is kept once.
- **One way, but Kategorien:** the computer owns the mount. The cloud refuses a push of `mount` and
  `mountFile`; Kategorien set on a mounted file in the cloud come back as today's categories do.
- **Which mounts (D1):** every mount of a space that syncs. „Nur auf diesem Computer“ in the mount's
  settings (`space_mount.cloud`, on by default) keeps one out.
- **Gone at once (D9):** a mount turned to „Nur auf diesem Computer“ or removed is sent as a delete;
  the cloud removes its rows, units, word index, excerpts and the thumbnails and index blobs no other
  row holds. Before the account is unlinked (`forgetCloud`) the computer sends the delete of each
  of its mounts; a cloud that removes an install's link removes that computer's mounts itself.
- **Not to other computers (D7):** the hub sends `mount` and `mountFile` to no install; a computer
  that pulls the space sees only its own mounts.
- **Wissen too:** with one model, a Wissen file's vectors can travel the same way (its index blob
  beside `textHash`), and the cloud stops embedding again what the computer already did. Step 7.

## 3. Previews

| | Thumbnail | Excerpt |
|---|---|---|
| What | 320 px JPEG, as today | the title (`title`) and the first ~400 characters of the file's text, cut at a sentence |
| For | grids, search hits | lists, search hits while the computer is away, what an agent sees before it opens a file |
| Pictures | the picture | none (D5) |
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
| `bytes` | a file | the original | 25 MB (D8) | 60 s |

Every call is opening (D2, D2b): the cloud asks only for who may open the mount, the owner or a
wizard the mount allows. Everyone else who sees it gets the excerpt in place of a passage and „Nur
<Name> kann diese Datei öffnen“ in place of the file.

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
- Opening a file says the computer is away.
- A step that needs the file stops with „MacBook Pro ist nicht erreichbar“ (D3): the run fails at
  that step, as a step whose connection is gone does. It neither waits nor goes on with the excerpt.
- A start in the cloud at night (a schedule, a webhook) finds the file but can't read it while a
  laptop sleeps.

## 6. Access

Two rights per mount in the cloud (D2):

| | Who | Rule |
|---|---|---|
| Seeing: the tree, metadata, thumbnails, excerpts, Kategorien; found by the index | the owner and admin roles, and the audiences of the mount's `see` (team, clients, guests), as on the computer | `r`, written by `mountRules` as today |
| Opening through the computer: a file's text, its bytes, a hit's live passage | the owner (the person the computer is linked as, from `install_link`) and the wizards the mount allows (D2a); „Alle, die ihn sehen“ widens it to who sees it | `x` on the mount: a `person` rule for the owner, the `wizard` rules, the audiences' roles when widened |

- **The setting:** `open` on the mount, „Nur ich“ (default) or „Alle, die ihn sehen“, in the mount's
  settings on the computer beside „Wer sieht den Ordner“. It syncs with the mount.
- **Which wizards:** the computer's `wizards` setting, written for the cloud row by `mountRules`.
  A wizard a visitor runs through a share link searches the mount only if that wizard may use it,
  as with Wissen, and then opens its files through the computer too (D2a).
- **Writing:** no writing from the cloud (D4). Drafts and „Veröffentlichen“ stay on the computer;
  the cloud's rules never hold `w` for a computer's mount.
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
- **Plan (D6):** Pro and Team. The switch `dateienCloud` is on in those plans' `features` in Manage
  (everyone → plan → team).
- **Measure before the switch flips:** the first sync of the Dropbox folder, a search in the cloud,
  a 25 MB file from the VPS to a home connection.

## 9. Steps

Behind the switch `dateienCloud` (off), which needs `dateien`, in small PRs; each ships on its own
with the switch off. Paths are under `apps/runtime/src/` unless they say otherwise. A tenant
migration ships to the computer and the cloud in the same release; until both run it they don't
sync (`requireSchema`), as for every migration.

| # | Step | Files | Manage, Coolify |
|---|---|---|---|
| 1 | **EmbeddingGemma in the cloud.** Done on 2026-11-01: the Ollama service, `OLLAMA_URL`, General's binding, the measurement (§1), and a test that the `local` and `credits` ways name the bound EmbeddingGemma alike | `apps/runtime/test/embedding-ways.test.ts` | Done. Once EU Private and EU Sovereign get models: bind their `embedding` too |
| 2 | **The switch and the schema.** `dateienCloud` (kind `plan`, off). One tenant migration: `space_mount.cloud` (on), `space_mount.open` (`owner`), `space_mount.computer`, `space_mount.computer_name`; `space_mount_file.excerpt`, `thumb` as a hash, `index`; the tables `mount_call` and `install_link`. No behaviour | `packages/shared/src/feature-flags.ts`, `db/schema.ts`, `db/migrations/tenant/00xx_dateien_cloud.sql` | none |
| 3 | **Previews and the index blob on the computer.** The indexer writes the excerpt, the thumbnail into `blobs/` by hash (in place of `derived/m/…`) and the index blob (units, vectors, words). A one-time command converts the mounts indexed before; no second path for old rows | `mounts/mounts.ts` (indexing, `thumbKey`, `mountFileThumb`, `deleteMount`), `mounts/units.ts`, new `mounts/index-blob.ts`, `files/blobs.ts`, `cli/main.ts`, new `cli/mount-blobs.ts`, `test/dateien.test.ts` | none |
| 4 | **The sync kinds.** `mount` and `mountFile` after `file`; triggers on `space_mount` and `space_mount_file` (only where `cloud` is on); the cloud writes rows, units, vectors as they are and its word index from the blob; refuses pushes of both but Kategorien; sends neither to an install (D7); the delete when a mount leaves, and before `forgetCloud` (D9); `mountRules` writes `x` for opening (D2). On the computer: „Nur auf diesem Computer“, „Wer darf Dateien öffnen“ and the dialog's sentence on what reaches the cloud | `sync/records.ts`, `sync/hub.ts`, `sync/client.ts`, `sync/log.ts`, `db/migrations/tenant/00xx_dateien_cloud_sync.sql`, `services/space-index.ts`, `services/cloud.ts` (`forgetCloud`), `mounts/mounts.ts` (`mountRules`, `MountAccess`, `updateMount`), `apps/web/src/studio/space/DateienEdit.tsx`, `Dateien.tsx`, `test/dateien.test.ts`, a sync test | none |
| 5 | **Dateien and search in the cloud's studio.** The computer's mounts listed where `managed`, tree, thumbnails, excerpts, Kategorien; „Auf MacBook Pro · nicht erreichbar seit 14:02“ from `install_link.seen`; search and ⌘K over them with the excerpt as a hit's text | `routes/dateien.ts`, `mounts/mounts.ts` (`listMounts`, `mountView`, `usableMounts`), `services/space-index.ts` (`searchKnowledge`), `apps/web/src/studio/space/Dateien.tsx`, `dateien-data.ts`, `KnowledgePalette.tsx` | none |
| 6 | **Opening through the computer.** `askComputer` and `answerComputer` over `mount_call` in the shape of `engine/device.ts`; the routes `GET /dateien/live` and `POST /dateien/calls/:id`; `followDateien` started beside `followCloud`; the calls `units`, `text`, `bytes` for who may open; relay keys and their sweep; the studio opens a file and shows live passages | new `mounts/calls.ts`, new `mounts/follow.ts`, `routes/api.ts`, `index.ts`, `files/objects.ts`, `services/space-index.ts`, `apps/web/src/studio/space/Dateien.tsx`, new `test/dateien-cloud.test.ts` | none: the stream runs as `/sync/live` does. Measure a 25 MB file from the VPS to a home connection |
| 7 | **Wizards in the cloud.** `space_search` gives excerpts where a wizard may not open; `space_document` reads `dateien/<slug>/…` through the computer; the step stops while it is away (D3) | `elements/knowledge.ts`, `services/knowledge.ts`, the prompts of `tool.space_search` and `tool.space_document` | none |
| 8 | **Wissen's vectors travel too.** A Wissen file's index blob goes beside `textHash`; the cloud embeds only what it wrote itself | `sync/records.ts` (`file`), `services/space-index.ts` (`queueIndex`) | none |
| 9 | **Limits, docs, the switch.** 4 calls at once and 120 a minute per computer, 25 MB (D8); the measurement of §8; a page under `docs/content` with `version:` | `mounts/calls.ts`, `docs/content/…`, `CHANGELOG.md` through `pnpm release --changelog` | Manage: `dateienCloud` on in the `features` of Pro and Team (D6). Flipping it and the release are the user's call |
