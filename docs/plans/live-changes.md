# Live changes in the studio

A technical plan, 2026-10-21. No code changes yet. It builds on the change log of the two-way sync
([tenant-sync.md](tenant-sync.md)).

The goal: an open studio view shows a change soon after it is written, without a reload. That
holds whoever wrote it:

- another tab or another member in the cloud;
- a run in the runner process (shared lists);
- MCP or the API;
- a pull of the two-way sync on a computer;
- a push from a computer arriving at the cloud.

## Verdict

**Build it on our own database, with no new service.** Triggers fill a small numbered feed per
tenant (`live_change`). Each studio process watches the feed of the tenants that have a stream
open and sends the changed ids to the browser over one SSE stream per browser. The browser then
reloads the affected react-query keys. Phase 2 lets a computer follow the cloud's feed, so a
change made in the cloud reaches the computer in about a second instead of up to a minute.

**What engenty-pro does, and what we take from it.** Supabase Realtime announces row changes, and
the app reloads the affected data after a short wait. It does not patch the screen with the
change. Changes made while the connection was down are lost. We keep "announce, then reload",
since it keeps every read going through the normal API and its role checks. Because our changes
are numbered, a reconnect catches up on what it missed.

**libSQL and Turso have no change feed of their own.** Everything here is plain SQLite, so it
works the same on a file and on Turso.

## What exists today

| Piece | Where | Use for live changes |
| --- | --- | --- |
| `sync_change`, triggers on 13 tables | `migrations/tenant/0022_sync.sql`, `sync/log.ts` | The pattern to copy, but not the feed itself (see below) |
| Draft stream of one wizard | `routes/wizard-stream.ts`, `services/draft-events.ts`, web `studio/live.tsx` | Stays. It is in-process, wizards only, and keyed by wizard and not tenant |
| Run stream with a 1 s DB poll | `engine/events.ts` (`watchRun`) | The pattern for catching writes of other processes |
| Plugin events (local) | `routes/plugins.ts:164`, web `plugins/host.tsx:482` | Folds into the feed later |
| Pull before studio loads, push after writes | `app.ts` (`STUDIO_LOADS`), `sync/client.ts` | Stays. Live changes make the 5 s load pull less needed but don't replace it |
| `useSyncAction` invalidation | web `studio/CloudSync.tsx:52` | Becomes part of the feed's key map |
| `useCloudSync` polls every 20 s | web `studio/CloudSync.tsx:42` | Drops to 120 s once the feed says when sync state changes |

**Why not read `sync_change` directly:**

- On a computer, a pull writes `quietly()`, so pulled changes never reach `sync_change`. Those
  are exactly the changes the screen must show.
- On a computer, `dropPushed` deletes rows after a push, so a cursor into the log would break.
- The triggers skip wizard-owned pages and tables (`WHERE wizard_id IS NULL`). The studio still
  shows those rows, the shared lists.
- The two logs answer different questions. `sync_change` says what this side still has to send.
  The live feed says what changed here recently. Tying the two together would make each harder to
  change later.

**Processes that write a tenant database.**

- In the cloud, the studio (`runtime`), `doors` and `runner` processes all write the same files
  (`compose.cloud.yaml`).
- The runner writes shared-list rows (`store/shared-lists.ts`).
- With Turso, or with more studio replicas, more writers could join.

In-process events alone would miss these writes, so the feed has to come from the database.

## Design

```
 any writer (studio, runner, doors, sync pull/push, MCP)
        │ INSERT/UPDATE/DELETE
        ▼
 tenant db ── triggers ──► live_change (seq, project_id, kind, item, parent, at)
                                 ▲
             poll max(seq) 1 s ──┘  (one poller per tenant per process, only while streams are open)
             nudge: right after a write in this process
        │
        ▼
 LiveHub (runtime, per process) ── fan-out ──► GET /api/studio/live  (SSE, id = seq)
                                                     │
                                                     ▼
                                  browser leader tab (Web Locks) ── BroadcastChannel ──► other tabs
                                                     │
                                                     ▼
                                  key map: kind → react-query keys → invalidate (active refetch)
```

### 1. The feed table: `live_change`

Migration `0023_live_change` (tenant):

```sql
CREATE TABLE live_change (
  seq        integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  project_id text,               -- null for tenant-wide items (none today)
  kind       text NOT NULL,      -- LiveKind, see below
  item       text NOT NULL,      -- the changed row's id
  parent     text,               -- table id for a row, wizard id for a translation or message
  at         integer DEFAULT (unixepoch() * 1000) NOT NULL
);
CREATE INDEX live_change_at ON live_change (at);
```

- **`AUTOINCREMENT`** keeps `seq` rising even after old rows are pruned. A cursor stays valid,
  and a cursor from another database (a computer started over with `--fresh`) is spotted
  because it is higher than the newest `seq`.
- **Triggers.** It has the same 13 tables as 0022, `AFTER INSERT/UPDATE/DELETE`, and is
  generated by the same generator so both stay in step. The differences from 0022:
  - **No guard.** Pulled writes are logged, because they are changes on this side's screen.
  - **No `wizard_id IS NULL` filter.** Shared lists and wizard-owned pages count.
  - **`parent` is filled where the item alone does not name its view**: the table of a row,
    the wizard of a translation or message. For example `space_table_row`:
    `SELECT (SELECT project_id FROM space_table WHERE id = new.table_id), 'row', new.id, new.table_id`.
  - **`project` changes log as kind `space`**, with `item` the project id. They cover brand and
    theme, which live on the project.
- **Kinds.** The kinds and `item` ids are those of 0022: a wizard's files log as `wizard`,
  values and assignments of a category as `category`. `LiveKind` in `packages/shared/src/live.ts`
  starts equal to `SyncKind`. It is its own type so a kind can later be live without syncing.
- **Cost.** It adds one small insert per write to a synced table. Writes on these tables are
  saves (debounced in the studio) or row writes of runs. For a run that writes rows in bulk, see
  "Bursts" below.
- **Pruning.** Rows older than 15 minutes are deleted: by the hub at most once every 5 minutes
  per tenant while streams are open, and by the hourly purge (`index.ts`) for all tenants.
  15 minutes covers a laptop lid closed for a coffee. A longer gap ends in a reset (see the
  stream's `reset` event).

### 2. The hub: `apps/runtime/src/live/hub.ts`

There is one hub per process. It keeps a map `tenantId → TenantFeed` that holds only tenants with
at least one open stream.

```ts
interface LiveItem { kind: LiveKind; item: string; projectId: string | null; parent: string | null }
interface LiveBatch { seq: number; items: LiveItem[] }

export function subscribe(tenantId: string, since: number, send: (e: LiveEvent) => void): () => void;
export function nudge(tenantId: string): void;     // a write in this process: poll now
export function newestSeq(): Promise<number>;      // in the current tenant context
```

- **Polling.** A `TenantFeed` runs one loop inside `withTenant(id, …)`, so `db` resolves as in
  `watchRun`.
  - Each tick reads `SELECT seq, project_id, kind, item, parent FROM live_change WHERE seq > :last ORDER BY seq LIMIT 1001`.
    If nothing changed, that is one indexed read.
  - The tick is 1 s while anything changed in the last 60 s, then 3 s.
  - `nudge` starts a tick now; ticks never overlap.
  - On Turso, an idle open studio costs about 20 reads a minute per tenant per process.
- **Nudge sources.**
  - The studio and API middleware call it after every mutating request (next to
    `afterStudioWrite` in `app.ts`).
  - `applyItems` calls it at its end (`sync/apply.ts`), which covers pulls on a computer and
    pushes received in the cloud.
  - Writes of other processes are caught by the poll alone, within 1–3 s.
- **Fan-out.**
  - One read serves every stream of the tenant in this process.
  - Each subscriber gets the batch after its own cursor. A new subscriber with an old `since`
    reads its own catch-up once, then joins the shared tick.
- **Bursts.** A tick with more than 1000 rows, or a catch-up with more than 1000, sends `reset`
  instead of the items. The browser then reloads everything that is open. Batches are deduped by
  `(kind, item)` before they are sent.
- **End.** When the last subscriber of a tenant leaves, its loop stops and the feed is dropped.

### 3. The stream: `GET /api/studio/live`

- **Auth.** This route sits behind the `/api/studio/*` middleware: principal, suspended check,
  `withTenant`, `asRole`. Every member of a tenant may read every space (`services/access.ts` has
  roles, not per-space reads), so there is nothing to filter per person.
  - The feed carries ids only, never content. The reload goes through the normal routes and their
    checks.
  - If per-space access comes later, the hub filters by `projectId` here.
- **Cursor.** The cursor is the `Last-Event-ID` header (the browser's EventSource resends it
  after a drop) or `?since=`. With no cursor, the stream starts at the newest `seq` and sends no
  backlog.
- **Events** (`streamSSE`, `id:` set to the `seq` on `changes`):
  - `hello {seq}`: the newest `seq` at connect.
  - `changes {seq, items: LiveItem[]}`.
  - `reset {seq}`. It is sent when:
    - the cursor is older than the oldest row kept and more than 0 rows were pruned in between;
    - the cursor is higher than the newest `seq` (another database);
    - a burst exceeds 1000 rows.
  - `sync {}` (computer only): the two-way sync's view changed (a new conflict, a merge, a
    paused space). It is emitted in-process from `sync/client.ts`, since a computer runs one
    process.
  - `ping` every 20 s, as the other streams do.
- **Headers.** `cache-control: no-cache, no-transform` and `x-accel-buffering: no`, so a proxy
  in front does not buffer. There is no compression middleware to avoid.
- **Lifetime.** The server closes the stream after 30 minutes. EventSource reconnects with
  `Last-Event-ID`, which checks the session again. A token that expired or a tenant that was
  suspended in the meantime ends there, not hours later.
- **Limits.** At most 20 open streams per person and 200 per tenant per process, counted in
  memory. Beyond that the route answers 429. The browser then waits 30 s and falls back to
  reloading on focus (see 5).

### 4. Browser: one stream per browser, not per tab

A computer serves the studio over plain HTTP/1.1 (`http://localhost:5181` or `:24368`).
Browsers allow 6 connections per origin there, shared by all tabs. Each tab already opens the
draft stream and the plugin events. Three tabs with one more stream each would leave requests
waiting.

- `apps/web/src/studio/live-feed.ts`:
  - The tab that gets `navigator.locks.request("wz-live:<tenant>", …)` is the leader. It opens
    the EventSource and posts every event on `BroadcastChannel("wz-live:<tenant>")`.
  - The other tabs only listen. When the leader tab closes, its lock passes to the next tab,
    which opens the stream with the last `seq` it heard.
  - Where Web Locks are missing, which no current browser lacks, every tab opens its own stream.
- **Reconnect.** It is EventSource's own retry, plus a watchdog like `useRun.ts`: no `ping` for
  45 s closes and reopens the stream. It also reopens on `online` and on `visibilitychange` to
  visible.
- **Mounting.** `useLiveFeed()` is mounted once in `AppFrame`. It is off when the feature is off
  or the stream answered 404 (an older runtime).

### 5. Browser: from ids to reloads

A key map in `apps/web/src/studio/live-keys.ts` lists the query keys per kind. A test fails when
a `LiveKind` has no entry.

| Kind | Invalidated keys |
| --- | --- |
| `space` | `["projects"]`, `["themes", projectId]`, `["knowledge", projectId]` |
| `wizard` (also its files, as in 0022) | `["wizards", projectId]`, `["project-wizards", projectId]`, `["wizard", item]` (see 6) |
| `translation`, `message` | `["wizard-translations", parent]`, `["wizard", parent]` (see 6) |
| `page` | `["space-page", item]`, `["knowledge", projectId]` |
| `table` | `["space-table", item]`, `["knowledge", projectId]`, `["space-data", projectId]` |
| `row` | `["space-table", parent]`, `["space-data", projectId]` |
| `category` (with values, assignments) | `["knowledge", projectId]` (prefix: category and value views), `["knowledge-value"]` |
| `file` (`project_file`) | `["project-files", projectId]`, `["project-file-text"]` |
| `connector` | `["connectors", projectId]` |
| event `sync` | `["cloud-sync"]` |
| event `reset` | every active query under `/api/studio` |

- **Invalidation.** It runs with `refetchType: "active"`. Only what is on screen reloads now;
  the rest is marked stale and reloads when it is next shown.
- **Coalescing.** Items are collected for 250 ms and deduped by key. A run writing 200 rows into
  one table causes one reload of that table.
- **`useSyncAction`.** Its own invalidation list goes away; the feed does it.
- **`useCloudSync`.** Its `refetchInterval` goes from 20 s to 120 s, as a fallback only.
- **Fallback without a stream** (429, 404, an error): reload active queries on window focus,
  which react-query does already with `refetchOnWindowFocus`. Nothing else polls.

### 6. Open editors: don't overwrite what someone is typing

A reload must never replace local edits that are not saved yet.

- **Wizard editor.** `useLiveDraft` has a revision, a 3-way merge on 409 and its own stream. The
  feed does not invalidate `["wizard", id]` while an editor has it open. It calls the editor's
  `refresh()` instead, through a small registry (`registerLiveDraft(id, refresh)` in
  `live.tsx`). `refresh()` already keeps unsaved edits and does nothing when the revision is the
  same.
  - This also covers what the draft stream misses: a draft written by another studio replica.
  - The draft stream stays for now. Folding it into the feed is a later clean-up.
- **Page and table editors.** These are last-writer-wins today, with no revision.
  - When a change for the open item arrives and the editor has no unsaved edits, it reloads
    silently. When the server's `updated_at` equals the one the editor saved last, the change
    was its own save, and nothing happens.
  - With unsaved edits, the editor keeps them and shows the live chip of the wizard editor:
    "Changed elsewhere", with "Show the new version". The next save then sends
    `baseUpdatedAt`. A 409 merges:
    - a page body with `mergeText` (`packages/shared/src/text-merge.ts`);
    - a table's columns and settings with `mergeJson`;
    - rows one by one, since each row is its own record.
    When the merge is not clean, the editor asks, with the two-way sync's conflict card.
  - This closes the gap the two-way sync plan lists: "an open page or table does not refresh
    live".
- **Lists** (spaces, wizards, knowledge, files, connectors). These have no local edits and simply
  reload.

### 7. Phase 2: a computer follows the cloud

Today a computer pulls every 60 s and before studio loads (at most every 5 s). A change made in
the cloud's studio reaches an open screen on the computer only on the next load or within a
minute.

- **New call.** `GET /api/v1/sync/live` on the cloud: SSE, with the install's account token and
  the same checks as the other `/v1/sync` calls (role, `twoWaySync`). It sends
  `changes {seq, spaces: string[]}`, the space ids with changes, not the items.
- **The computer's side.**
  - `sync/client.ts` keeps one connection open while two-way sync is on, with the cursor in
    `state` (`sync:live-seq`).
  - On `changes` it runs `syncSpace(id, "pull")` for each listed space it syncs, at most once
    per 2 s per space (single-flight, as today).
  - The pull writes, the computer's own feed logs it, and the open screen reloads.
- **The cloud's side.** The call skips changes the install just pushed: the hub tags items
  written by a push with the pushing client. Without that, every push would come back as a pull
  of nothing.
  - This is the one place where the origin matters.
  - It is done in memory, in `pushChanges`, for 10 s: `(tenant, kind, item) → clientId`.
- **Limits.** Pulls set off by the feed count toward the existing 3600 per hour. The 2 s
  coalescing keeps a busy space far below it. There is one open connection per linked computer.
- **Fallbacks stay.** The 60 s loop and the pull before loads remain for when the connection is
  down. The pull before loads may later run less often (every 30 s) while the connection is up.
- **Docs.** `docs/manage-contract.md` gets the call in "Two-way sync of a space".

### 8. Feature switch and rollout

- `liveChanges` in `packages/shared/src/feature-flags.ts`: a release flag, default off. The route
  answers 404 while the flag is off, and the browser hook then stays quiet.
- The migration and triggers ship before the flag flips. An unread feed only costs the inserts
  and is pruned hourly.
- Phase 2 needs `twoWaySync` too.

## Work in small PRs

| # | PR | Contents | Tests |
| --- | --- | --- | --- |
| 1 | `feat(runtime): live change feed in the tenant database` | `0023_live_change`, generated triggers, `parent`, pruning in the purge, `LiveKind` in shared | Triggers log every table and op with the right `parent`. `quietly()` writes are still logged. Pruning keeps 15 minutes |
| 2 | `feat(runtime): live hub and studio stream` | `live/hub.ts`, `GET /api/studio/live`, nudges in `app.ts` and `applyItems`, limits, 30 min lifetime, flag | A write through a second libSQL client on the same file (another process) arrives within 1.5 s. A nudge arrives at once. Catch-up from `Last-Event-ID`. `reset` on a pruned gap, on a foreign cursor and on a burst over 1000 rows. 429 beyond the limit. 404 with the flag off |
| 3 | `feat(web): studio reloads what changed elsewhere` | `live-feed.ts` (leader tab, BroadcastChannel, watchdog), `live-keys.ts`, mount in `AppFrame`, `useSyncAction` and `useCloudSync` changes | Every `LiveKind` has keys. Coalescing turns 200 rows into one reload. One stream for two tabs (Playwright) |
| 4 | `feat(web): page and table editors keep edits when the item changes elsewhere` | `baseUpdatedAt` and 409 on page and table saves, merge with `mergeText` and `mergeJson`, live chip, wizard editor bridge | An own save causes no reload. A change elsewhere with no edits here reloads. With edits here it shows the chip and merges on save. An unclean merge asks |
| 5 | `feat(runtime): a computer follows the cloud's changes` | `GET /api/v1/sync/live`, the computer's connection and coalesced pulls, origin skip, contract doc | A cloud edit reaches the computer's open page within 2 s (two processes, as in `sync.test.ts`). A computer's own push is not pulled back. After a drop the connection resumes from its cursor |
| 6 | `feat(studio): live changes` | Flips `liveChanges`, user guide section | Run end to end with `node apps/runtime/scripts/dev-two-way.mjs`: a page edited in the cloud's studio shows up in the computer's open page, and the other way round |

PRs 1–3 are useful on their own, without the two-way sync. Several members in the cloud, and runs
filling shared lists, see each other's changes.

## Risks and answers

- **Turso reads.** It costs one indexed read per tick per tenant per process, and only while a
  stream is open: about 20 a minute idle, 60 while busy. If that ever matters, a
  `live_head(seq)` single row updated by the triggers would make the tick a one-row read. That
  doubles the writes, so not now.
- **More studio replicas.** Each polls on its own; no shared bus is needed. Nudges only shorten
  the wait in the process that wrote.
- **Write load from runs.** A run inserting thousands of rows adds thousands of small feed rows.
  The hub sends `reset` past 1000, and pruning removes them after 15 minutes. If a wizard writes
  rows in bulk often, the row trigger can log the table once per statement instead (a
  `parent`-only row with `item = parent`). That is the same key for the browser.
- **Proxies.** Coolify's Traefik doesn't buffer SSE. The headers above cover nginx in front of a
  self-hosted runtime. Pings every 20 s keep idle timeouts away.
- **Old browsers and private windows.** BroadcastChannel and Web Locks are in every current
  browser. Without them every tab streams, and that works on HTTP/2.
- **A tenant migration in between.** A runtime update that adds a migration restarts the
  process. Streams reconnect with their cursor; the table is unchanged by later migrations.

## Not in scope

- **Patching the screen with the change itself** (no reload). The reload is one GET of what is
  open, and it keeps the checks in one place.
- **Presence**, such as who else is editing this page, and **live cursors**.
- **Runs.** Their stream exists and stays as it is.
- **Chats.** These are per person and don't sync. The studio assistant's own stream covers the
  open chat.
