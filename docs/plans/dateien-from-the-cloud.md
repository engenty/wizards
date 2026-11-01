# Plan: a computer's Dateien seen from its cloud space

Status: planned on 2026-11-01; nothing built. Step 9 of `docs/plans/media-and-files.md`, the part
„a computer's mount seen from a cloud space“. Page: the artifact “Dateien aus der Cloud”
(claude.ai/artifact/3n2eFataR8ktmPpHzXcgWD; source `dateien-from-the-cloud.html`).

A person mounts a folder of their computer in Dateien, say a Dropbox folder of 378 MB. Today the
cloud sees none of it: sync (`sync/records.ts`, `KIND_ORDER`) carries space, files, tables,
categories, rows, pages, connectors, skills and wizards, no mounts. Only what goes into Wissen
(„In Wissen übernehmen“, the source „Aus Dateien übernehmen“) arrives in the cloud, and is indexed
there again with the cloud's embedding model.

The goal: while the computer is on, the cloud space lists that folder, searches it and reads a file
of it, with nothing of the text kept in the cloud. Who uses it: the same person in the studio in a
browser or on the phone, wizards that run in the cloud (share links, starts), and members of the
space.

## Verdict

**The computer calls out; the cloud forwards over that call.** engenty wizards on the computer
keeps a streamed call to the cloud open (`GET /api/v1/dateien/live`, SSE, as the sync's live call),
signed in with the linked account's token. The cloud sends a request down that stream; the
computer answers it with a plain `POST /api/v1/dateien/calls/:id`. Across the cloud's processes a
request is a row in the tenant database, as `device_call` is for the phone (`engine/device.ts`).
The cloud keeps one row per offered mount (name, slug, which computer, access, last seen) and no
files, no units, no vectors. Search runs on the computer, on its own index with its own
EmbeddingGemma; the cloud fuses the computer's ranked hits with Wissen's.

No port is opened and no public tunnel runs:

| | A. Outbound call + rows (recommended) | B. A tunnel (Cloudflare Tunnel, frp, WireGuard) |
|---|---|---|
| New service | none | a tunnel service and its address per computer |
| What the cloud reaches | the calls listed below, nothing else | the computer's whole API |
| Auth | the account token the sync already uses | a second credential |
| Through NAT, proxies, hotel Wi-Fi | as the sync works today | depends on the tunnel |
| Across the cloud's processes | rows, as `device_call` | the runner would need the tunnel's address |

SSE plus POST and not a WebSocket: the sync's live call already runs this way behind Coolify's
Traefik (`x-accel-buffering: no`, a ping every 20 s, closed after 30 minutes and opened again).

## What exists

| Piece | Where | Use here |
|---|---|---|
| The live call of the sync | `routes/api.ts` `/sync/live`, `sync/client.ts` `followCloud` | The shape of the new stream and of its loop: token, `x-wizards-install`, ping, 30 min, back-off 2 s to 60 s. Its own route, since `followCloud` runs only with the two-way sync and `liveChanges` on |
| Calls to the cloud | `sync/client.ts` `call()` | Bearer `accountToken()`, `x-wizards-install`: the answers and the offer |
| The phone as a model | `engine/device.ts` | The request row, the 250 ms poll, the time-out, the delete in `finally`, the answer written only once and only by its owner (`answerDevice`) |
| Processes in the cloud | `docs/plans/runner-process.md` | `/api/v1` is served by the studio process, steps run on the runner: a row in the tenant database bridges them |
| Mount functions | `mounts/mounts.ts` | The computer answers with what exists: `mountFiles`, `mountFileContent`, `mountFileThumb`, `mountFileText`, `fileByPath`, `usableMounts` |
| Search with mounts | `services/space-index.ts` `searchKnowledge` | On the computer: the search over one mount. In the cloud: one more ranked list in the fusion |
| Access per mount | `mountRules(id, see, wizards, writable)`, broker kind `mount` | The cloud's row gets rules the same way, never `w` |
| Organization check | `refuseOtherOrganization`, `spaceSyncs` | A computer offers mounts only of spaces that sync with that organization |
| Plugin mount kinds | `readerOf`, `startMounts` | Not used: they would index the folder in the cloud. The kind `computer` is skipped there |

## How a call goes

```text
cloud                                                         computer
-----                                                         --------
studio or runner                                              engenty wizards
  askComputer(install, request)                                 followDateien()
    INSERT mount_call ──┐                                          │
    poll 250 ms         │   studio process holding the stream      │
                        └─► watches mount_call of its installs ──► SSE event "call"
                                                                   │ checks: mount offered, kind allowed
                                                                   │ runs mounts.ts / searchKnowledge
    answer read  ◄── mount_call.answer ◄── POST /dateien/calls/:id ◄┘
    DELETE row (finally)
```

## 1. The connection

- **Who opens it:** the computer, outbound, when an account is linked, the mount's space syncs with
  the cloud (`spaceSyncs`), the switch `dateienCloud` is on and at least one mount has „In der Cloud
  erreichbar“ on. Otherwise no stream is open.
- **Auth:** the linked account's token, as the sync. The person behind it needs build rights in the
  cloud space to offer a mount (`mayBuild`); a space of another organization is refused
  (`refuseOtherOrganization`).
- **The offer:** on each (re)connect the computer sends `POST /api/v1/dateien/offer` with the
  computer's name and, per synced space, its offered mounts (id, name, slug, file count, size,
  access). The cloud writes them as `space_mount` rows of kind `computer`, with `source =
  { install, mountId }` and the same id as on the computer; a mount no longer offered goes.
- **Online:** a row `install_link` per computer in the tenant database (install id, person, name,
  `seen`). The process holding the stream writes `seen` at every ping. Online means `seen` is under
  45 s old.
- **Reconnects:** a loop `followDateien` in the shape of `followCloud`: the stream ends after
  30 minutes and opens again, back-off from 2 s to 60 s, a sleeping computer drops it and its wake
  opens it with a new offer.
- **Several computers:** each offers its own mounts, named by the computer („auf MacBook Pro“).

## 2. The calls

`askComputer(install, request, timeoutMs)` in the cloud, `answerComputer(id, install, answer)` on
the route: `device.ts` with a table `mount_call` (id, install, request, answer, `relay`, created).
The studio process holding a computer's stream polls the open calls of its installs every 250 ms
and sends each once.

| Call | Asks | Answers | Limit | Waits |
|---|---|---|---|---|
| `tree` | a mount, a folder | entries: path, size, time, kind, thumbnail yes/no, Kategorien | 5 000 per page | 10 s |
| `search` | the words, the mounts, Kategorien | ranked hits: file, path, unit, rank, snippet | 24 hits, 300 characters each | 3 s, then the search goes on without |
| `text` | a file | its text, from the computer's cache (`ownText`) | 200 000 characters | 20 s |
| `bytes` | a file | the original | 25 MB | 60 s |
| `thumb` | files | 320 px JPEGs | 50 per call | 10 s |
| `stat` | a path | one entry | | 5 s |

- **On the computer** a call runs in its own tenant as the linked person, through the existing
  functions. It answers only for a mount it offered and still offers, only these kinds, and only
  paths inside the mount (as `folder.ts` checks).
- **Answers up to 256 KB** go into the row. Bigger ones (`bytes`, a page of thumbnails) go to the
  object store under `t/<tenant>/relay/<callId>`: the waiter reads the key and deletes it at once,
  a sweep removes keys older than 10 minutes. Where the waiter and the stream are the same process
  (opening a file in the studio) the bytes are handed over in memory and touch no store.
- **Search:** the cloud embeds with another model (`text-embedding-3-small` today), so its vectors
  can't be compared with the computer's. The computer gets the words, runs `searchKnowledge` over
  that mount (words, trigrams, its EmbeddingGemma) and returns ranks. The cloud fuses those ranks
  with Wissen's. The snippets go to the cloud's decision model as Wissen's snippets do.

## 3. While the computer is away

| | A. Only the mount (recommended) | B. Its last tree |
|---|---|---|
| Dateien in the cloud | the mount greyed: „Auf MacBook Pro · nicht erreichbar seit 14:02“ | the tree, browsable, nothing opens |
| Search | „1 Ordner nicht erreichbar“ under the hits | file names found, nothing opens |
| Kept in the cloud | name, file count, size, last seen | every path, size, time, Kategorie |
| Work | none | a second index of file rows kept current in the cloud |

File names are content too (customers, diagnoses, contracts). A keeps none of them in the cloud.

A step that needs a file of an away computer: see D3. A start in the cloud at night (a schedule, a
webhook) meets a sleeping laptop, so the mount dialog says that a computer folder answers only
while the computer is on.

## 4. Access

- **Off by default, per mount:** „In der Cloud erreichbar“ in the mount's settings on the computer.
  Only someone who may change the mount there turns it on.
- **Who sees it in the cloud:** on the computer one person sees the space; in the cloud the whole
  team may. `MountSee` gains a third value, `owner` (only the person whose computer it is), and
  the dialog asks again when the switch goes on (D2).
- **Which wizards:** the computer's `wizards` setting, written for the cloud row by `mountRules`.
  A wizard a visitor runs through a share link reads the mount only if that wizard may use it, as
  with Wissen; the dialog says so in one line.
- **Writing:** no writing from the cloud (D4). Drafts and „Veröffentlichen“ stay on the computer.
- **Checked twice:** the cloud checks the broker before it asks; the computer checks its offer
  before it answers. A mistake on one side does not reach another mount or a path outside one.

## 5. Privacy

| Passes through the cloud, kept nowhere | Kept in the cloud |
|---|---|
| A folder's entries when someone browses | The mount row: name, slug, computer, file count, size, access, last seen |
| The search words and up to 24 snippets | `install_link`: the computer's name and when it was last online |
| A file's text or bytes when it is opened | A run file, when a step reads a file (as long as the run, as every file a step uses) |
| Thumbnails | A log line per call: kind, mount, file id, size, who. No path, no name |

- Never kept: the tree, text, units, vectors, thumbnails. Responses carry `cache-control:
  private, no-store`; nothing lands in `derived/`.
- What a step reads goes to that step's model, under the organization's model tier, as Wissen does.
- Relay keys live for seconds; the sweep is the safety net.

## 6. Costs and limits

- **Models:** the mount's index and its search run on the computer, free on its Ollama. The cloud
  pays only what a Wissen search costs today (fusion, the decision model).
- **Traffic:** the computer's upload. A 25 MB file over 10 Mbit/s takes about 20 s; a grid of 60
  thumbnails (20–40 KB each) about 2 MB. The VPS passes each byte once.
- **Per computer:** 4 calls at once, 120 per minute; more wait in the row queue. Answer route body
  up to 26 MB (D6).
- **Plan:** the switch `dateienCloud` per plan in Manage (everyone → plan → team, as the other
  switches) (D5).
- **Measure before the switch flips:** from the VPS to a home connection, the 378 MB Dropbox folder:
  its tree, a search round trip, a 25 MB file.

## 7. Steps

Behind the switch `dateienCloud` (off), which needs `dateien`, in small PRs. The tables land in one
tenant migration on both sides in one release, since the sync refuses mismatched schemas
(`requireSchema`).

1. **The pipe in the cloud.** Tenant migration: `mount_call`, `install_link`, `space_mount.cloud`.
   `askComputer`/`answerComputer`; routes `GET /api/v1/dateien/live`, `POST /api/v1/dateien/offer`,
   `POST /api/v1/dateien/calls/:id`; the relay keys and their sweep; the kind `computer` skipped by
   `startMounts` and `readerOf`. Tests with a played computer.
2. **The computer's half.** `followDateien`, the offer, answers for `tree`, `stat`, `text`, `bytes`,
   `thumb` through `mounts.ts`; the path and offer checks.
3. **The studio.** On the computer: „In der Cloud erreichbar“ with its access choices. In the cloud:
   the computer's mounts in Dateien with online/away, the tree, opening a file, thumbnails.
4. **Search.** The `search` call; the cloud's `searchKnowledge` fuses the computer's ranks; ⌘K and
   `space_search` say „auf MacBook Pro“; the 3 s cut.
5. **Wizards in the cloud.** `fileByPath` and `space_document` read `dateien/<slug>/…` of a computer
   mount into the run; the message when it is away.
6. **Limits and the switch.** Rates, sizes, log lines, the switch per plan in Manage, the
   measurement; a docs page under `docs/content` when the switch flips.

## Decisions (the user)

1. **D1 While away:** only the mount with „nicht erreichbar seit …“ (recommended), or its last tree.
2. **D2 Who in the cloud sees a computer's folder:** asked when it goes on, default „Nur ich“
   (recommended; new value `owner`), or the computer's setting as it is.
3. **D3 A step and an away computer:** the step stops with „MacBook Pro ist nicht erreichbar“
   (recommended), waits up to 15 minutes for it, or reads a Wissen copy where one exists.
4. **D4 Writing from the cloud:** none, read only (recommended), or drafts in the cloud that the
   computer publishes when it is back.
5. **D5 Plans:** Pro and Team (recommended), or every plan.
6. **D6 Largest file through the link:** 25 MB (recommended), or 100 MB.
7. **D7 The words:** „In der Cloud erreichbar“ for the switch, „nicht erreichbar“ for the chip.
