# Live changes in the studio

A technical plan, 2026-10-21. Built on 2026-10-22 in ten PRs, engenty/wizards#154 to the PR that
switches `liveChanges` on; see "As built" at the end for where it differs. It builds on the change log of the two-way sync
([tenant-sync.md](tenant-sync.md)).

The goal: an open studio view shows a change soon after it is written. The change is written into
what is on screen; nothing is fetched again and nothing flickers. That holds whoever wrote it:

- another tab or another member in the cloud;
- a run in the runner process (shared lists);
- MCP or the API;
- a pull of the two-way sync on a computer;
- a push from a computer arriving at the cloud.

## Verdict

**Build it on our own database, with no new service.** Triggers fill a small numbered feed per
tenant (`live_change`). Each studio process watches the feed of the tenants that have a stream
open. For every changed item it reads the item's current view, the same JSON the studio's GET
route returns, and sends it to the browser over one SSE stream per browser. The browser writes
that view straight into the TanStack Query cache (`setQueryData`), so the screen changes in place.
Phase 2 lets a computer follow the cloud's feed, so a change made in the cloud reaches the
computer in about a second instead of up to a minute.

**The studio already uses TanStack Query** (`@tanstack/react-query` 5, about 50 files). Writing
into its cache is how the wizard editor's draft stream (`studio/live.tsx`) and the table editor's
row saves (`TableEditor.tsx`) work today. Live changes do the same for every kind.

**engenty-pro has the same client half** (`@engenty/live-cache`); "Compared with engenty-pro"
below says what we take over as it is and what differs. In short, it announces and reloads; we
patch. Two things stay safe:

- **Reads keep their checks.** The view is built by the same service function as the GET route,
  with the subscriber's role, so a stream never shows more than a reload would.
- **Nothing is lost.** Changes are numbered, so a reconnect catches up on what it missed.

A reload is still the fallback, item by item, where a patch can't be made (see "When the stream
sends no view").

**libSQL and Turso have no change feed of their own.** Everything here is plain SQLite, so it
works the same on a file and on Turso.

## What exists today

| Piece | Where | Use for live changes |
| --- | --- | --- |
| `sync_change`, triggers on 13 tables | `migrations/tenant/0022_sync.sql`, `sync/log.ts` | The pattern to copy, but not the feed itself (see below) |
| Draft stream of one wizard | `routes/wizard-stream.ts`, `services/draft-events.ts`, web `studio/live.tsx` | Replaced by the feed in PR 6. It is in-process, wizards only, and keyed by wizard and not tenant |
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

## Compared with engenty-pro

engenty-pro solved the browser half already, on Supabase.

- **`packages/live-cache`** (about 700 lines without tests) is the main piece.
  - Each module declares a `ModuleLiveBinding` next to its queries: `id`, `queryRoot`, the tables
    it reads and the agent tools that write them (for example `modules/team/ui/team-live-binding.ts`).
  - One app-wide mount, `apps/ui/src/components/live-data-sync.tsx`, subscribes to all of them.
  - A registry maps each change to query keys.
  - `createDebouncedInvalidator` invalidates each key once per 150 ms.
- **`packages/query-client/src/optimistic/begin-optimistic-update.ts`** is the shared mutation
  lifecycle:
  1. Cancel the query in flight.
  2. Take a snapshot.
  3. Write the optimistic value.
  4. On an error, roll back only while that value is still the one in the cache; otherwise
     invalidate.

  `docs/content/dev/optimistic-ui.md` sets the rules around it, for example "don't suppress live
  invalidations while a local mutation is pending".

| | engenty-pro | Here |
| --- | --- | --- |
| Where changes come from | Postgres logical replication, Supabase Realtime over a websocket | Triggers into `live_change`, polled per tenant; SQLite and Turso have no replication feed |
| What arrives | A signal, with the row as the database has it (not used, for security) | The item's view, built by the GET route's own function with the reader's role |
| Browser | Invalidate the module's `queryRoot`, debounced | Patch the cache; invalidate where no view came or the list is computed |
| A dropped connection | Changes in between are lost | Caught up from `Last-Event-ID` |
| Several tabs | One websocket each; websockets don't count against the 6 connections per site | One stream per browser, a leader tab passes it on |
| Open editors | No merge; the refetch replaces the cached value | Shown at once when nothing is unsaved; otherwise merged into the next autosave (6) |
| Isolation | One channel per binding, so one broken table can't drop every module's subscription | A patcher that throws falls back to invalidating its keys and never stops the stream |
| Writes by the AI | `agentToolIds`: invalidate when the tool call ends, before realtime arrives | Not needed: tools write on the server, and the write nudges the hub at once |
| Debugging | `useLiveCache` always logs why it doesn't subscribe | The same, for 404, 429 and missing Web Locks |

**What we take over.** The two repositories share no code: engenty-pro is private, this one is
open. So these are ports of the same ideas, under the same names, so the code reads alike in
both:

- **Bindings next to their queries.** Each area declares a `LiveBinding` beside its query keys:
  the kinds it shows, its patchers and its fallback keys. One mount, `useLiveFeed()` in
  `AppFrame`, reads them all, as `LiveDataSync` does. There is no central switch over all kinds
  that every feature has to edit.
- **`createDebouncedInvalidator`**, the same function, for the keys that are fetched again.
- **`beginOptimisticUpdate`**, the same lifecycle, as `apps/web/src/lib/optimistic.ts`. The live
  patcher uses the same steps (cancel, write, ownership check), so a live patch and a local save
  can't overwrite each other. The studio's current one-off `setQueryData` calls after saves move
  onto it as they are touched.
- **The rule from `optimistic-ui.md`:** a pending local save never holds back a change from
  elsewhere. Newer-wins decides, not a gate.
- **Always log why the feed is off.**

**What we don't take over.** Signals without data, and `agentToolIds`. The reasons are in the
table above.

**Later, both ways.** Once `live-patch.ts` has proven itself here, engenty-pro could patch too.
Its realtime payload already carries the row. It would still need the role check of a GET, so
the shape would be the same: the server sends a view, not a row.

## Not repeating ourselves here

- **One function per view.** `live/views.ts` holds a registry `kind → view(id)`. The studio's GET
  routes for those items call the same entries (`c.json(await views.page(id))`) instead of
  building the JSON themselves. The stream and the route can't drift apart, and the test of
  PR 3 shrinks to "every kind has a view".
- **Query keys from factories.** The studio writes keys inline today (`["space-table", id]` in
  several files). `apps/web/src/lib/keys.ts` gets one factory per area (`keys.table(id)`,
  `keys.knowledge(projectId)`), as engenty-pro does with `kbArticleKeys`. `useQuery`, the
  invalidations after saves and the live bindings all use them, so a renamed key can't miss a
  place. This moves the keys the feed touches; other keys move when their files are next
  changed.
- **One live editor hook.** The page, table and wizard editors share `useLiveEditor({ key,
  merge, save })`: the base, pending edits, a held patch merged at autosave or on a 409, and the chips.
  `useLiveDraft` becomes this hook with `mergeDrafts`; the page uses `mergeText`, a table header
  `mergeJson`.
- **One table list for the triggers** (1): a generator writes the `live_change` triggers, and a test keeps them on the same tables as `sync_change`'s.
- **One conflict card**, the two-way sync's, for every unclean merge.

## Design

```
 any writer (studio, runner, doors, sync pull/push, MCP)
        │ INSERT/UPDATE/DELETE
        ▼
 tenant db ── triggers ──► live_change (seq, project_id, kind, op, item, parent, at)
                                 ▲
             poll max(seq) 1 s ──┘  (one poller per tenant per process, only while streams are open)
             nudge: right after a write in this process
        │
        ▼
 LiveHub (runtime, per process)
   dedupe by item ──► views: read each item's current view, once per role ──► fan-out
        │
        ▼
 GET /api/studio/live  (SSE, id = seq; items carry their view)
        │
        ▼
 browser leader tab (Web Locks) ── BroadcastChannel ──► other tabs
        │
        ▼
 patchers: kind → setQueryData on detail and list keys (upsert, remove)
           newer-wins by updatedAt / revision; open editors merge
           no view, or a computed list → invalidate that one key
```

### 1. The feed table: `live_change`

Migration `0023_live_change` (tenant):

```sql
CREATE TABLE live_change (
  seq        integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  project_id text,               -- null for tenant-wide items (none today)
  kind       text NOT NULL,      -- LiveKind, see below
  op         text NOT NULL,      -- 'put' (insert or update) or 'del'
  item       text NOT NULL,      -- the changed row's id
  parent     text,               -- table id for a row, wizard id for a translation or message
  at         integer DEFAULT (unixepoch() * 1000) NOT NULL
);
CREATE INDEX live_change_at ON live_change (at);
```

- **`AUTOINCREMENT`** keeps `seq` rising even after old rows are pruned. A cursor stays valid,
  and a cursor from another database (a computer started over with `--fresh`) is spotted
  because it is higher than the newest `seq`.
- **Triggers.** It has the same 13 tables as 0022, `AFTER INSERT/UPDATE/DELETE`. The 39
  triggers of 0022 are written out in its SQL file, with no generator behind them. PR 1 adds one,
  `apps/runtime/scripts/triggers.mjs`, from one table list with the item, project and `parent`
  per table, and writes the 0023 triggers with it. A test reads both migrations and fails when
  a table is in one and not the other, so the two stay in step. 0022 itself stays as it is,
  since a shipped migration is never rewritten. The differences from 0022:
  - **No guard.** Pulled writes are logged, because they are changes on this side's screen.
  - **No `wizard_id IS NULL` filter.** Shared lists and wizard-owned pages count.
  - **`parent` is filled where the item alone does not name its view**: the table of a row,
    the wizard of a translation or message. For example `space_table_row`:
    `SELECT (SELECT project_id FROM space_table WHERE id = new.table_id), 'row', new.id, new.table_id`.
  - **`project` changes log as kind `space`**, with `item` the project id. They cover brand and
    theme, which live on the project.
  - **`op` is `del`** only when the item itself is deleted. A delete of a wizard's file or a
    category's value logs a `put` of its wizard or category, since that item still exists and
    changed.
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
interface LiveItem {
  kind: LiveKind;
  op: "put" | "del";
  item: string;
  projectId: string | null;
  parent: string | null;
  view?: LiveView;   // the item's current view, for a put; see "Views" below
}
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
  `(kind, item)` before they are sent; the last `op` wins.
- **End.** When the last subscriber of a tenant leaves, its loop stops and the feed is dropped.

### 2a. Views: the change itself, `apps/runtime/src/live/views.ts`

After a batch is deduped, the hub reads the current view of every `put` item. A view is exactly
what the studio's GET route for that item returns, built by the same service function, so the
browser can put it into the cache unchanged.

| Kind | View | Built by |
| --- | --- | --- |
| `space` | `Project` (as in the `projects` list) | the function behind `GET /projects` |
| `wizard` | `WizardSummary` (lists) and, when it fits, `WizardDetail` | `listWizards` and the `GET /wizards/:id` handler |
| `translation` | the wizard's translations | the `GET /wizards/:id/translations` handler |
| `message` | none: the wizard's chat is fetched again when open | — |
| `page` | `SpacePage` | `getPage` |
| `table` | `SpaceTable` without `rows` (columns, title, settings) | `getTable`, split so the header reads without rows |
| `row` | `SpaceTableRow` plus `tableId` | a new `getRow`, the row half of `getTable` |
| `category` | the category with its values | the knowledge service |
| `file` | the file's entry (name, size, type, `updatedAt`), never its bytes | the `GET /projects/:id/files` handler |
| `connector` | `ConnectorView` | the `GET /projects/:id/connectors` handler |

- **The reader's role.** Views differ by role only, for example `readOnly` on a page
  (`projectWritable`). The hub builds each view once per role among the open streams of the
  tenant, inside `asRole(role, …)`, so a batch costs at most four reads per item. A test checks
  that two people with the same role get the same view.
- **State, not history.** A view is read when the batch is sent, not when the write happened. An
  item that changed five times sends its newest state once. A catch-up after a reconnect sends
  the current state of everything that changed in the gap. That is what the screen needs.
- **Size.** A view over 64 KB of JSON is sent without `view` (a long page, a big wizard
  draft). A batch carries at most 512 KB of views; the items after that go without. Those items
  are fetched again by the browser, one key each.
- **Gone in between.** A `put` whose item was deleted before its view was read becomes a `del`.
- **Errors.** A view that fails to build is sent without `view` and logged. A stream never fails
  because of one item.

### 3. The stream: `GET /api/studio/live`

- **Auth.** This route sits behind the `/api/studio/*` middleware: principal, suspended check,
  `withTenant`, `asRole`. Every member of a tenant may read every space (`services/access.ts` has
  roles, not per-space reads), so there is nothing to filter per person.
  - The feed table holds ids only. The content a stream sends is the view of 2a, built with the
    reader's role by the same functions as the GET routes, so it passes the same checks.
  - If per-space access comes later, the hub filters by `projectId` here, before views are built.
- **Cursor.** The cursor is the `Last-Event-ID` header (the browser's EventSource resends it
  after a drop) or `?since=`. With no cursor, the stream starts at the newest `seq` and sends no
  backlog.
- **Events** (`streamSSE`, `id:` set to the `seq` on `changes`):
  - `hello {seq}`: the newest `seq` at connect.
  - `changes {seq, items: LiveItem[]}`, with `view` on the `put` items that have one.
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

### 5. Browser: patch the cache

Each area's `LiveBinding` (see "Compared with engenty-pro") holds the patchers of its kinds. A
patcher takes an item and writes it into every cached query that holds it.
`apps/web/src/studio/live-patch.ts` holds the shared steps: newer-wins, `cancelQueries`, the
write and the fallback. A test fails when a `LiveKind` has no binding.

| Kind | Patched in place | Fetched again (computed lists) |
| --- | --- | --- |
| `space` | `["projects"]`: replace the space; `del` removes it | `["themes", projectId]` |
| `wizard` | `["wizards", projectId]`, `["project-wizards", projectId]`: upsert the summary, `del` removes it. `["wizard", item]`: see 6 | — |
| `translation` | `["wizard-translations", parent]` | — |
| `message` | — | `["wizard", parent]` while its chat is open |
| `page` | `["space-page", item]` (see 6) | `["knowledge", projectId]` when the title or place changed |
| `table` | `["space-table", item]`: replace the header, keep `rows` | `["knowledge", projectId]`, `["space-data", projectId]` when the title changed |
| `row` | `["space-table", parent]`: upsert the row by id in its place, `del` removes it | `["space-data", projectId]` (row counts) |
| `category` | the category's own view | `["knowledge", projectId]`, `["knowledge-value"]` |
| `file` | `["project-files", projectId]`: upsert the entry | `["project-file-text", item]` |
| `connector` | `["connectors", projectId]`: upsert, `del` removes it | — |
| event `sync` | — | `["cloud-sync"]` |
| event `reset` | — | every active query under `/api/studio` |

- **Computed lists are fetched again.** The knowledge tree, the space's data overview and the
  themes are built by the server from many items (counts, order, nesting). Rebuilding them in the
  browser would copy server logic, so the patcher invalidates them instead, with `refetchType:
  "active"`. Only what is on screen is fetched; the rest is marked stale. This is one small GET,
  and the item views themselves are already patched.
- **Newer wins.** A patch is skipped when the cached item is as new or newer: by `updatedAt` for
  pages, tables, rows, files, spaces and connectors, by `revision` for a wizard. That turns the
  echo of one's own save into nothing. A GET that was already running when a patch arrives can't
  bring an older state back: the patcher calls `cancelQueries` on the detail key first and starts
  the GET again if it was running.
- **Order in lists.** Upserts keep an item where it was. A new item goes where the server sorts
  it, using the same comparator as the route (`packages/shared`), or the list is fetched again
  when the route's order can't be known in the browser.
- **No view** (too big, failed, or `message`): the patcher invalidates that item's detail key.
  Only this item is fetched again.
- **Coalescing.** Items are collected for 100 ms and the last state per item is applied in one go,
  inside one React batch. A run writing 200 rows into one table updates the open table once, with
  no request.
- **Seeing it.** A row, card or list entry that a patch changed gets a short highlight (a 1.5 s
  background fade, none with `prefers-reduced-motion`), so a change made elsewhere is noticed.
- **`useSyncAction`.** Its own invalidation list goes away; the feed does it.
- **`useCloudSync`.** Its `refetchInterval` goes from 20 s to 120 s, as a fallback only.
- **Fallback without a stream** (429, 404, an error): reload active queries on window focus,
  which TanStack Query does already with `refetchOnWindowFocus`. Nothing else polls.

### 6. Open editors: don't overwrite what someone is typing

A patch must never replace local edits that are not saved yet, and text must never move under
the caret while someone types. The editors keep their autosave rhythm: a save 600 ms (wizard) or
700 ms (page, table, `useAutosave`) after the last keystroke. A change from elsewhere fits into
that rhythm.

Every editor registers with the feed (`registerLiveEditor(kind, id, onPatch)`). For a registered
item the patcher hands the view to the editor instead of writing the cache itself.

- **No unsaved edits** (nothing typed since the last save): the patch is shown at once. The
  caret stays in its paragraph, and the scroll position is kept.
- **Unsaved edits:** the patch is held, and nothing on screen changes. When the autosave fires,
  the editor merges first, `merge(base, mine, theirs)` with the held view as `theirs`, and saves
  the result. That is the merge a 409 does today, minus the 409 and the extra GET, since the
  new version is already here. Several patches while typing keep only the newest.
- **A save that meets a newer version anyway** (a change still on its way) gets a 409, as
  today, and merges the same way.

- **Page editor** (`PageEditor.tsx`). It keeps the version it loaded or saved last as the base.
  - It works on its text through a small `TextSurface` interface (`get()`, `apply(nextText)`,
    `hasUnsavedEdits()`), with the textarea as the first version. CodeMirror then adds its own
    ([page-editor-codemirror.md](page-editor-codemirror.md)), with no change to the live code.
  - It merges with `mergeText` (`packages/shared/src/text-merge.ts`). A clean merge shows the
    merged text with the chip "Merged with a change from elsewhere".
  - When the merge isn't clean, the person's text stays and is not saved over the other
    version. The chip says "Changed elsewhere", with "Show the new version" and the two-way
    sync's conflict card.
  - Saves send `baseUpdatedAt`, so the server can answer 409.
- **Table editor** (`TableEditor.tsx`).
  - Rows patch one by one, so a run filling a table shows each row as it lands.
  - A cell being edited keeps what is typed in it; the other cells of that row update. When the
    edit is saved, the server's version of the row comes back and wins for the other cells.
  - Columns and settings merge with `mergeJson` against the editor's base; a clash on the same
    column asks, as for a page.
  - Row saves send `baseUpdatedAt` per row, with 409 and a cell-level merge, as for a page.
- **Wizard editor** (`useLiveDraft` in `live.tsx`). It has a revision and a 3-way merge
  (`mergeDrafts`) already.
  - With the draft in the view, the patch follows the rule above. Not busy: the draft is
    replaced. Busy (`timer`, `inflight` or `pending`): the view is held, and `flush()` runs
    `mergeDrafts(base, pending, theirs)` before it saves.
  - A draft too big for the stream arrives without a view; the editor calls `refresh()`, as the
    draft stream does today.
  - The wizard's draft stream (`routes/wizard-stream.ts`) becomes redundant and is removed in the
    same PR. It is in-process only and so misses drafts written by another process; the feed
    doesn't.
- This closes the gap the two-way sync plan lists: "an open page or table does not refresh
  live".
- **Lists** (spaces, wizards, knowledge, files, connectors). These have no local edits and are
  patched or fetched again as in 5.

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
  - The pull writes, the computer's own feed logs it, and the open screen is patched like any
    other change.
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

### 8. Who else is here: presence, for people and for AI

A signal, not a lock. Anyone may edit at the same time, as today; the merges of 6 keep both
changes. Presence only makes it visible who else is in the same wizard, page or table, and
where, so nobody is surprised by a change, and an AI can hold back or say so.

**What counts as being there.**

| Who | Present while | Shown as |
| --- | --- | --- |
| A person in the studio | An editor of the item is open in a visible tab | "Anna" (viewing), "Anna is editing" (typed in the last 10 s) |
| The studio assistant | One of its turns is changing the item, from the first change to the end of the turn | "Studio assistant, for Anna, is editing" |
| An MCP client or API key | 60 s after each read or write of the item | "Claude Code (MCP) edited 5 s ago". The name comes from the `Writer` the write already records (`services/wizards.ts`) or the key's name |
| A run | Only for a table it writes rows to | "A run of 'Leads' is adding rows" |

**Where in the item** (optional): a wizard's step and field (`steps.contact.fields.email`), a
page's paragraph (the heading above the caret), a table's row and column. It is a coarse place,
not a live cursor.

**How it is stored and spread.**

- **One small table, no new channel.** `live_presence (tenant, kind, item, who_id, who_kind,
  who_name, client, place, state, seen_at)`, with one row per person or agent per item. Its
  trigger logs into `live_change` as kind `presence`, so it travels on the same stream, through
  the same hub, to every process and replica, with nothing new to build.
- **From a browser.** `PUT /api/studio/presence {kind, item, place, state}` from each open
  editor:
  - when it opens;
  - when the state or place changes, debounced by 1 s;
  - every 20 s while open.

  `DELETE` (or `navigator.sendBeacon`) runs on close. Each tab reports its own editors; the
  leader tab of 4 only carries the stream.
- **From AI, on the server.**
  - Every MCP and API read or write of a wizard, page or table upserts the client's row, in the
    services, next to where the `Writer` is passed. No client has to do anything for this.
  - The studio assistant's turn upserts its row and deletes it at the end of the turn.
- **Gone.** A row unseen for 45 s counts as gone. The hub drops it while streaming, and the
  purge deletes it. Writes are one upsert per editor per 20 s, at most two per item per second
  while typing. That is small next to the saves themselves.
- **Not synced.** Presence stays on the side where it happened, as chats do. Phase 2 can carry
  it later: the cloud's `sync/live` call could send presence for spaces a computer has open,
  and the other way round.

**What people see.**

- **Editor header.** Small avatars or initials of who else is there, with a colour each. An AI
  shows a robot mark and its client name. On hover: what they're doing and since when.
- **At the place.** A thin bar in that colour next to the field, paragraph or cell someone else
  is editing, with their name on hover.
- **When you start typing where someone else types** (same place, within 10 s): a quiet hint
  above the field, "Anna is editing this too". It blocks nothing.
- **Lists.** A dot on the wizard card, page or table in the lists when someone is editing it.
- **Merge chips name the other side.** "Merged with a change from Anna", or "from Claude Code
  (MCP)". It's the same name as in presence.

**What AI sees.** Presence goes into what agents already read, so they don't need to ask:

- **`present` in the results of MCP tools that read or write a wizard, page or table:** who else
  is there, where, and how long ago, without the agent itself.
- **A note in the tool result, when a person is editing the same place an agent writes:** "Anna
  is editing the step 'Contact' right now. Your change was merged with hers." The write still
  happens, and the agent can tell its user.
- **A line in the tool descriptions:** "If `present` lists people editing, tell the user before
  large changes." The tools decide nothing themselves.
- **The studio assistant's context** gets the same `present` list for the wizard it works on.
- **The REST API:** the GET of a wizard, page or table answers with the header
  `x-wizards-present` (a count) and the list under `?present=1`.

**Rights.** Every member of a tenant sees who is in which item, the same as they see the items.
Names are the ones the organization already shows. A person can't hide, as in a shared doc.

### 9. Feature switch and rollout

- `liveChanges` in `packages/shared/src/feature-flags.ts`: a release flag, default off. The route
  answers 404 while the flag is off, and the browser hook then stays quiet. Presence comes with
  the same switch.
- The migration and triggers ship before the flag flips. An unread feed only costs the inserts
  and is pruned hourly.
- Phase 2 needs `twoWaySync` too.

## Work in small PRs

| # | PR | Contents | Tests |
| --- | --- | --- | --- |
| 1 | `feat(runtime): live change feed in the tenant database` | `0023_live_change`, `scripts/triggers.mjs` and the triggers it writes, `op`, `parent`, pruning in the purge, `LiveKind` in shared | Triggers log every table and op with the right `parent` and `op`. 0022 and 0023 cover the same tables. `quietly()` writes are still logged. Pruning keeps 15 minutes |
| 2 | `feat(runtime): live hub and studio stream` | `live/hub.ts`, `GET /api/studio/live`, nudges in `app.ts` and `applyItems`, limits, 30 min lifetime, flag. Items without views yet | A write through a second libSQL client on the same file (another process) arrives within 1.5 s. A nudge arrives at once. Catch-up from `Last-Event-ID`. `reset` on a pruned gap, on a foreign cursor and on a burst over 1000 rows. 429 beyond the limit. 404 with the flag off |
| 3 | `feat(runtime): live changes carry the item's view` | `live/views.ts` registry, the GET routes of those items moved onto it, `getRow`, the table header without rows, views per role, size limits, put-to-del when gone | Every `LiveKind` has a view. The routes' existing tests pass unchanged. A member and an admin get their own `readOnly`. A view over 64 KB goes without. A batch stays under 512 KB |
| 4 | `feat(web): studio patches what changed elsewhere` | `lib/keys.ts` factories for the keys the feed touches, `lib/optimistic.ts` (`beginOptimisticUpdate`), `LiveBinding` per area, `live-feed.ts` (leader tab, BroadcastChannel, watchdog), `live-patch.ts`, `createDebouncedInvalidator`, newer-wins, highlight, mount in `AppFrame`, `useSyncAction` and `useCloudSync` changes | Every `LiveKind` has a binding. A patched list sends no request. An older view never replaces a newer cache entry, also against a GET in flight. A patcher that throws falls back to invalidating. 200 rows arrive as one update. One stream for two tabs (Playwright) |
| 5 | `feat(web): page and table editors take changes from elsewhere while open` | `useLiveEditor`, `registerLiveEditor`, held patches merged at autosave with `mergeText` and `mergeJson`, `baseUpdatedAt` and 409 on page, table and row saves, chips | An own save changes nothing on screen. A change elsewhere with no edits here shows at once, caret kept. With edits here nothing moves while typing; the change is merged into the next autosave. An unclean merge keeps mine and asks. A cell being typed in is never overwritten |
| 6 | `refactor(studio): the wizard editor follows the live feed` | `useLiveDraft` rebuilt on `useLiveEditor` with `mergeDrafts`, `refresh()` for drafts without a view, the draft stream removed | Existing `live.tsx` tests pass on the feed. A draft written by a second process reaches the open editor |
| 7 | `feat(runtime): a computer follows the cloud's changes` | `GET /api/v1/sync/live`, the computer's connection and coalesced pulls, origin skip, contract doc | A cloud edit reaches the computer's open page within 2 s (two processes, as in `sync.test.ts`). A computer's own push is not pulled back. After a drop the connection resumes from its cursor |
| 8 | `feat(runtime): presence of people and AI in wizards, pages and tables` | `live_presence` and its trigger into the feed, `PUT`/`DELETE /api/studio/presence`, upserts on MCP and API reads and writes and in the assistant's turn, `present` in MCP results and the note on a shared place, `x-wizards-present`, the 45 s expiry | An MCP write shows up as present within 1.5 s, under its client's name. A tab that closes is gone within 45 s. An agent's write to a field a person edits gets the note; the write still happens. An agent is never listed to itself |
| 9 | `feat(web): show who else is editing` | Presence reports from each editor, avatars in the editor header, bars at the place, the "editing this too" hint, dots in lists, names in merge chips | Two people in one wizard see each other. An MCP client appears with its name and disappears after 60 s. Nothing blocks typing |
| 10 | `feat(studio): live changes` | Flips `liveChanges`, user guide section | Run end to end with `node apps/runtime/scripts/dev-two-way.mjs`: a page edited in the cloud's studio shows up in the computer's open page without a request, and the other way round |

PRs 1–4 are useful on their own, without the two-way sync. Several members in the cloud, and runs
filling shared lists, see each other's changes. PR 2 can ship with the browser invalidating keys,
as a first step, until PR 3 adds the views; the patchers of PR 4 then fall back to that for any
item without a view.

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
- **A view that drifts from its route.** If a GET route added a field and its view didn't, the
  cache would hold a mix. The route and the stream call the same entry of `live/views.ts`, so
  there is nothing to drift.
- **Reads per batch.** Building views costs one read per changed item and role, only while
  streams are open, and only for items that changed. A burst over 1000 rows sends `reset`
  instead, without views.
- **Bandwidth.** The 64 KB and 512 KB limits keep a batch small; a big page or draft goes as an
  id and is fetched once.
- **Order of a patch and a GET.** Newer-wins and `cancelQueries` keep an older answer from
  replacing a newer patch (see 5).

## Follow-ups

- **Pages in CodeMirror** ([page-editor-codemirror.md](page-editor-codemirror.md)). Changes from
  elsewhere keep the caret and stay out of undo, and presence shows beside a section.
- **Editing together in real time.** Once presence shows two or more people in one page, a room
  (Yjs over a websocket) could take over until they leave. Agents, runs and sync pulls take part
  through the server: their saves go into the room as edits. This is its own plan, after the
  two above.

## Not in scope

- **Locks.** Presence (8) shows who is there; it never stops anyone from editing.
- **Live cursors** and live selections. Presence names the place (a field, a paragraph, a
  cell), not the caret.
- **Runs.** Their stream exists and stays as it is.
- **Chats.** These are per person and don't sync. The studio assistant's own stream covers the
  open chat.

## As built

- **The wizard's draft stream stays** (`routes/wizard-stream.ts`). With live changes on it only
  names the MCP client for the editor's "Changed via …" chip; the feed doesn't say who wrote. It can
  go once the switch is removed and the chip reads the writer from presence.
- **No REST `x-wizards-present` header.** The API's wizard calls don't edit drafts; agents edit
  over MCP, whose results carry `present`.
- **A computer's own pushes** are left out of the cloud's live call by the feed numbers each push
  wrote, not by item for 10 seconds: a change by someone else to an item just pushed still goes
  through.
- **Messages of the build chat** go to an open editor with the wizard's next view; the kind
  `message` patches nothing by itself.
- **End to end** with `node apps/runtime/scripts/dev-two-way.mjs`: a page edited in the cloud's
  studio showed in the computer's open page after 0.2 s, and the other way round after about 1 s
  (the computer pushes 0.8 s after a save).
