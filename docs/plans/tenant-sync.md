# Two-way sync of an organization between a local install and the cloud

A feasibility study, 2026-10-21. No code changes yet. The question: can a runtime that runs
alone (the local install) and an organization (tenant) on the cloud runtime stay in step in
both directions? That covers the data and the studio: wizards, knowledge, brand, data and
files, across several spaces (projects). Runs do not sync (decided 2026-10-21). Model
settings stay on each machine.

## Verdict

**Feasible with limits.** Do not build it as a database-level sync of the tenant database.
Build it as an extension of the sync that exists ("Spaces of a local install",
`services/cloud.ts`), which runs in one direction today. The extension:

- Records changes per space in a change log that triggers fill.
- Exchanges the changes over the cloud runtime's `/api/v1`, with the cloud as the one hub that
  orders them.
- Applies them through the services, so roles, `asSync()` and the share links stay right.
- Lets both sides edit everything that syncs, wizards included.
- Merges by itself when both sides changed the same item since they last agreed and the merge
  is clean and passes the checks. The studio then says that a merge was needed. Only when it
  is not clean does it ask: keep the cloud's version, keep this computer's, or pick per place,
  with a model's proposal on request, checked and confirmed.

A wizard is JSON, and a merge matched by ids handles it well. A classic line merge does not:
see "Can a classic merge handle a wizard?" below.

The limits:

- **Conflicts are rare and show up on save.** Each load fetches the cloud's latest version, and
  each save (the studio's own, unchanged) is pushed right after. So a conflict needs someone to change the same item in the cloud's
  studio between your load and your save, or while you were offline. When it happens, your
  save is the one the cloud refuses, and the choice opens in your studio right there. People
  editing in the cloud's studio never meet a conflict, because their saves go straight into
  the cloud's database.
- **Publishing goes through the cloud.** Each side keeps its own versions: publishing on the
  install publishes there, pushes the draft and has the cloud publish it as the cloud's next
  version. A publish that could not reach the cloud is sent again by the minute loop.
- **Some data stays on the side where it was made.** Encrypted data, per-person data (the
  wizard's store, the studio assistant's chats) and the knowledge index stay put. The index is
  rebuilt on each side.
- **Runs never sync.** A run, its events and its results stay on the side where it ran. In the
  cloud, wizards run from the published version that arrived there, as today.
- **Both sides must run the same schema version.** Merging across versions is out of scope.
  The sync pauses until the side behind updates.

No libSQL/Turso sync feature carries this today:

- Embedded replicas are GA but forward every write to the primary.
- Offline writes and Turso Sync are beta. Turso Sync's engine has no FTS5, which the knowledge
  index and the assistant search use.
- The cloud's tenant databases are not on Turso yet (`TENANT_DB_PROVISIONER=none`).

## What is there today

### Databases

| Database | Where (alone) | Where (cloud) | Holds |
|---|---|---|---|
| Control (`control-schema.ts`) | `DATA_DIR/control.db` | Turso `wizards-control` (`DATABASE_URL`) | `tenant` (with `db_url`), `link` (share tokens → tenant and row), `run_index`, `runner`, `session`, `setting`, `ui_translation`, `marketplace_cache`, `plugin_job`, `plugin_address`, `plugin_claim` |
| Tenant (`schema.ts`), one per tenant | `DATA_DIR/tenants/local.db` | files under `/data/tenants/<id>.db` on the VPS volume (`TENANT_DB_PROVISIONER=none`); `wz-<tenant id>` on Turso once the provisioner is `turso` | every space's (`project`) wizards, versions, workspace (`wizard_file`), translations, runs and their events, assets, files (`project_file`), knowledge (`space_page`, `space_table`, rows, categories), the index (`project_chunk` and the FTS5 tables), assistant chats, the wizard's store, `plugin_connection`, and plugins' own tables |

- `db/client.ts` opens each tenant database once per process. It migrates the database with
  drizzle on first open (`migrations/tenant`, 21 files up to `0020_project_page`). Then it runs
  the `onTenantOpen` hooks, which include the plugins' SQL files (`plugins/migrations.ts`,
  recorded in `plugin_migration`).
- `tenantUrl()` takes `tenant.db_url`, else `TENANT_DB_URL_TEMPLATE`, else a file. The
  Manage-App answers `db: { url }` per tenant (`manage.ts`, `TenantInfo.db`). The runtime does
  not write it into `tenant.db_url` yet. One `TENANT_DB_AUTH_TOKEN`, a Turso **group** token,
  opens every tenant database (manage `docs/content/setup/turso.md`).
- Every tenant row keeps `tenant_id`, "so a tenant's rows can be moved or merged". On an
  install it is `local` (`LOCAL_TENANT`). "`local` as tenant and user id never leaves an
  install" (runner-process.md, "Ids across installs").
- `db/adopt.ts` is a one-off. It moves a data folder from before tenants had their own
  database: the rows of `wizards.db` go into `tenants/local.db`. It rewrites `owner_id` to
  `tenant_id = local`, user holders to `u:local` and old model speeds to classes. It writes the
  `link` and `run_index` rows into the control database and copies `assets/` and `blobs/` under
  `objects/t/local/`. It shows the two things any sync has to do as well: tenant rows need their
  control-database rows, and their files travel apart from them.
- `debug.ts` reports `database: file | libsql`, `tenantDatabases: files | libsql` and
  `files: data folder | s3`.

### Files

- `files/objects.ts` puts every key under `t/<tenant>/`: in `DATA_DIR/objects` when alone, in
  the S3 bucket (R2) in the cloud.
- **Blobs** (`files/blobs.ts`) are content-addressed: `blobs/<2>/<sha256>`. Workspace files,
  versions' files, store files and document text (`project_file.text_hash`) point to them by
  hash. A blob never changes, so the sync sends only the hashes the other side lacks.
- **Assets** (`files/storage.ts`) live under `assets/<id>.<ext>`, with a row in `asset`. Run
  results, logos and project files (`project_file.id` is the asset) use them.
  `replaceAsset()` keeps the id and changes the path.
- Not in the object store: `DATA_DIR/films/<runId>` (working folders), sandbox engines, the
  vault.

### Ids

- Rows that sync have text ids from `nanoid` (6 to 24 characters; runs `nanoid(18)`, assets
  `nanoid(16)`).
- Integer `AUTOINCREMENT` ids: `run_event`, `device_call`, `project_chunk`,
  `space_item_category`. Plugins' tables use them too (the docs' example, `tables.md`). They
  collide across databases.
- Unique keys that two sides can each fill with a different id:
  - `space_category_name (project_id, name)`
  - `space_category_value_value (category_id, value)`
  - `space_table_list (wizard_id, list)`
  - `space_table_origin` and `space_page_origin (project_id, origin, origin_key)`
  - `project_file_origin`
  - `wizard_share_token`
  - `run_share_token`
- The one-way sync keeps the install's ids in the cloud tenant. It refuses an id the tenant
  made itself (`id_taken`).

### The sync that exists (one way)

`services/cloud.ts` and the contract's "Spaces of a local install":

- What goes up:
  - On publish, the published version: definition, files (base64), sharing and themes.
  - The space's name, brand (name, about, colours), facts and main logo.
  - After a wizard, the space's own tables, pages and categories (`PUT /spaces/:id/data`).
    These go only when their hash changed, and they replace what came before.
- What stays on the install: drafts, runs, connected accounts and documents.
- In the cloud, the project carries `origin = "local"` and is read-only (`services/access.ts`,
  `403 read_only`). The cloud makes the share link.
- Failed sends retry by themselves. The first retry comes after a minute, then the wait doubles
  up to an hour (`retryFailedSends`). The state is kept in the control database's `setting`
  (`cloud:<wizardId>`, `cloud-data:<projectId>`).
- `cloud-first-onboarding.md` already plans the next step: `wizard.home`, the pull on sign-in,
  space data to every install, and runs up (this plan leaves runs out). Its decision 5 asks:
  `wizard.home` (no merge) or a true two-way sync of drafts? Decided on 2026-10-21: a true
  two-way sync, editable on both sides, with the person choosing in a conflict.
- The studio already merges drafts three ways: `mergeDrafts` (`packages/shared/src/merge.ts`)
  in `apps/web/src/studio/live.tsx`, when a draft was written elsewhere while the studio
  edited it. It merges step by step and lets the studio's side win without saying so. The sync
  builds on it, but it must report conflicts instead of settling them.

### Accounts and organizations

- The install links an account at the Manage-App (`auth/account.ts`). It uses the client
  `wizards-desktop` with PKCE on the loopback, or the device code (`auth/device.ts`). The scopes
  are `wizards:read wizards:write wizards:publish` and the resource is `CLOUD_URL`. The refresh
  token lives in the vault: the Keychain in the desktop app, else the encrypted `DATA_DIR/vault`.
- An access token names exactly one tenant (manage `auth.ts`, `customAccessTokenClaims`). A
  person in several organizations picks one at `/select-tenant` after the browser sign-in. A
  device-code grant carries no pick, so it gets the person's own tenant.
- To work on a client's organization (sfg.at), Matthias is a member of it and picks it in the
  browser sign-in. The token's `role` (owner, admin, member) then applies to what he may change.
- The install never receives database credentials, and the plan keeps it that way.

## libSQL and Turso: what is offered, what is ready

Checked on 2026-10-21. Sources: the docs' source repository (`tursodatabase/turso-docs`), the
`tursodatabase/turso` and `libsql` repositories, and the npm packages. docs.turso.tech itself
was not reachable from here.

| Feature | What it does | Status | Fits here? |
|---|---|---|---|
| libSQL files and `libsql://` remotes through `@libsql/client` | what the runtime uses today; `^0.18.0` = latest 0.18.0 (2026-09-02, adds a connection pool for `file:` databases) | GA | yes, unchanged |
| Database per tenant through the Platform API, groups, tokens per database or group (`expiration`, `full-access` / `read-only`) | the Manage-App's `turso` provisioner (`wz-<tenant id>`) | GA; the Platform API needs a paid plan, which is why the provisioner is `none` | yes, independent of the sync |
| Fine-grained token permissions (per table and action) | narrower tokens | no label; the Platform API's token call shows no per-table body (unverified) | not relied on |
| Embedded replicas (`url: file:…`, `syncUrl`, `authToken`, `sync()`, `syncInterval`) | reads from a local file; writes go to the primary; page-level replication of the whole database | GA ("fully supported in production"); Turso points new projects that need sync to Turso Sync | no: see below |
| `offline: true` in `@libsql/client` | writes into the local replica, pushed later | still in the 0.18 types; Turso calls Turso Sync "the modern equivalent"; needs Turso Cloud (libsql-server has no route for it, inferred from code) | no |
| Turso Sync (`@tursodatabase/sync` 0.8.3, next 0.9.0-pre.1) | local-first; `push()` and `pull()`; logical CDC; "last push wins"; a `transform(mutation)` hook to skip or rewrite a change | the Turso engine is "in beta" / "not yet 1.0"; partial sync is experimental | not now: no FTS5 or virtual tables (`project_chunk_fts`, `project_chunk_tri`, `assistant_search`), drizzle support only in drizzle-orm 1.0 beta/rc (the runtime is on 0.45) |

**Why not an embedded replica of the cloud tenant database?** It looks like the shortest path.
The install would open `wz-<org>` as a replica: reads stay local and writes are consistent at
the primary. But:

1. **No offline writes.** Every write needs the network, so it is "the cloud with a local
   cache", not work on your computer.
2. **It replicates the whole database.** Visitors' runs and answers would land on a laptop.
   `store_secret` and `plugin_connection` are sealed with the cloud's key (`secrets/crypto.ts`,
   `STORE_ENC_KEY` or `APP_SECRET`), so the install cannot read them, and it must not write
   them.
3. **It skips the control database.** A wizard made on the install needs its `link` row in the
   cloud's control database, and a run needs its `run_index` row. Without them `/w/<token>`
   answers nothing. The install may not reach the control database, which holds every tenant.
4. **It skips the services.** Roles (`access.ts`), `asSync()`, `wizard.revision`, `spaceChanged`
   events and the index jobs would not see the writes.
5. **Migrations go to the primary.** An install on another release would migrate the cloud's
   database, plugins' SQL files included.
6. **It needs a credential the install should not hold.** The runtime opens tenant databases
   with a group token. A per-database token would have to be minted for the install, and it
   would be full access below every role.
7. **It needs Turso first.** The cloud's tenant databases are files today.

Turso Sync solves (1) only, and only in beta. It has the same issues (2) to (7), and it adds the
FTS5 gap.

## Recommended mechanism: a change log per space, through the cloud runtime

### Shape

```
install (tenant "local")                     cloud runtime (tenant <org>)
  tenant db ── triggers ──► sync_change          sync_change ◄── triggers ── tenant db
        │                        │                     ▲              │
        │   push: POST /api/v1/spaces/:id/changes ─────┘              │
        │   pull: GET  /api/v1/spaces/:id/changes?since=<seq> ◄───────┘
        │   blobs: HEAD/GET/PUT /api/v1/spaces/:id/blobs/:hash
        └── applies pulled changes through the services, asSync()
```

- **A change log in the tenant database.** One tenant migration adds a table `sync_change`:
  `seq INTEGER PRIMARY KEY`, `project_id`, `tbl`, `row_key`, `op` (insert, update or delete),
  `at`. `AFTER INSERT/UPDATE/DELETE` triggers on the synced tables fill it, which is plain
  SQLite and works on files and on Turso. A one-row guard table makes the triggers skip changes
  that a pull applies. The rows themselves are not copied into the log. A push reads the row
  as it stands, so many edits of one page send it once. This is the idea of Turso's CDC,
  limited to the tables and spaces we choose and compatible with FTS5.
- **The cloud is the hub.** Each change that arrives in the cloud gets the cloud's `seq`, and a
  pull asks for everything after the last `seq` it saw. Installs never talk to each other.
  Wall clocks never decide, so clock skew does not matter.
- **A JSON contract, not raw rows.** Changes travel as typed records per table, like
  `SyncDataInput` today, with the schema version they were written under. Both sides must have
  the same schema version (see "Migrations and releases").
- **Applied through the services.** The cloud applies a push in the tenant from the token,
  under `asRole(role)` and `asSync()`. It writes the `link` rows that the rows need (a
  wizard's share link and code, logos, fonts) and rewrites `tenant_id` and user ids (below). The install applies a pull the same way.
  Then each side runs its own jobs: the index (`reindexSpace`), the plugins' `spaceChanged`.
- **Files after rows.** A push first asks which blob hashes and asset ids the cloud lacks. It
  uploads those, then sends the rows (the order the one-way sync uses today). A pull fetches
  the blobs it lacks on demand, so large documents do not block a pull.
- **When: the save and load events that exist.** The main case is editing on the install and
  pushing to the cloud. The sync hooks into what the studio already does and changes nothing
  in how or when it saves:
  - **Save.** The studio keeps saving as it does: a draft 600 ms after an edit
    (`useLiveDraft`, `live.tsx`), pages, tables and the space's details through their routes.
    Each save writes the tenant database, and the triggers note it in `sync_change`. The
    events that exist then start a push of the space: `emitDraftChanged` (draft and
    workspace, `services/wizards.ts`, `services/files.ts`), `spaceChanged` (the space's
    details and themes), `spaceFileChanged` (files). Pages, tables and categories have no
    event today. For them the push starts from the change log after the write, so their
    services stay as they are.
  - **Publish.** `publishAndSync()` already hooks the publish. It pushes the draft, then asks
    the cloud to publish it.
  - **Load.** The studio's routes that answer a wizard, a page, a table or the space's details
    pull that item from the cloud before they answer. The wait is a few seconds at most;
    offline or slow, the local copy answers. The studio's requests stay as they are.
  - **One push at a time per space.** A push carries everything in the log since the last
    one. Saves made while it runs go with the next push. So steady typing makes about one push
    every few seconds, never one per keystroke. The new call gets a limit of its own sized for
    that, e.g. 1,200 an hour per organization. Today's 240 an hour stays on the one-way calls.
  - **Background.** A pull of the whole space runs on start and on sign-in. The minute loop
    that exists (`retryFailedSends`) sends what failed. Offline, the log grows and goes up
    later.
- **State on the install.** The control database's `setting` holds `sync:<projectId>`: the last
  pushed local `seq`, the last pulled cloud `seq`, the schema version and the last error. It
  sits beside the `cloud:*` keys of today.
- **The base of each item.** A table `sync_base` in the install's tenant database keeps, per
  synced row, the version both sides last agreed on, with the cloud `seq` it had. This is the
  common ancestor every three-way merge needs. Files are kept by hash, so a base costs a row,
  not a copy of the bytes.
- **Conflicts are found at the hub.** A push names, per row, the cloud `seq` its base had. The
  cloud takes the row when its own copy has not changed since. Otherwise it answers `conflict`
  with its current row. That one item then waits for the person, and the rest of the space
  goes on syncing.

### What syncs and what stays

**Per space (synced in both directions):**

| Data | Tables | Rule |
|---|---|---|
| The space | `project`: `name`, `brand`, `facts`, `themes`, `page` | editable on both sides; a conflict asks (below) |
| Wizards: draft and workspace | `wizard` (`title`, `draft`), `wizard_file` and their blobs | editable on both sides; a conflict asks |
| Wizards: published versions | `wizard_version` | do not travel: each side numbers its own; publishing on the install has the cloud publish the pushed draft |
| Wizards: sharing settings | `wizard`: `share_enabled`, `daily_run_limit`, `runners`, `translate` | editable on both sides; the link itself is the cloud's |
| Translations | `wizard_translation` | editable on both sides; a conflict asks per text |
| The wizard's build chat | `wizard_message` | append-only, never in conflict |
| Knowledge: pages | `space_page` | editable on both sides; a conflict asks |
| Data: tables and rows | `space_table`, `space_table_row` | editable on both sides; a conflict asks |
| Categories | `space_category`, `space_category_value`, `space_item_category` | matched by name and value, not by id |
| Files and documents | `project_file` (when `ready`), their assets, `text_hash` blobs | per row; bytes by hash |
| Connectors | `project_connector` | per (project, id) |
| Connected systems | `project.mcp_servers` | without `headers` (decided) |

**Stays on the side where it is (not synced):**

| Data | Where | Why |
|---|---|---|
| Model settings: source, harness choice (Claude Code, Codex, Antigravity, Cursor Agent), bindings, `creditFallback`, Ollama, Apple | install: control `setting` `models`; cloud: `models:<tenant>` | per machine; steps name a class, never a model, so a wizard runs on either side with that side's bindings |
| API keys | install: vault `key.<name>`, env; cloud: sealed in `models:<tenant>` | secrets, per machine |
| The linked account's refresh token, `LOCAL_ACCESS_KEY`, `APP_SECRET`, `STORE_ENC_KEY` | vault, env, `DATA_DIR/secret` | per install |
| `.features` | the install's file | it has the last word over the account's switches, on purpose |
| Sandbox, browser, `CHROME_PATH`, `FFMPEG_PATH`, `PLUGINS_DIR`, local plugins | env, `DATA_DIR` | per machine |
| The knowledge index | `project_chunk`, `project_chunk_fts`, `project_chunk_tri` | derived; vectors depend on the side's embedding model (`project_chunk.model`); each side re-indexes |
| Assistant chats | `assistant_chat`, `assistant_message`, `assistant_search` | per person, and `user_id` is `local` on the install |
| The wizard's store | `store_holder`, `store_row`, `store_file`, `store_secret` | per person (`u:local` and `v:<visitor>`), and secrets are sealed per side |
| A space's connected accounts | `plugin_connection` | sealed per side; connect again on each side |
| Plugins' own tables | `plugin_migration` and the tables of the plugins' SQL files | unknown meaning and integer ids; a later opt-in per plugin |
| Runs and results, test and live, on both sides | `run`, `run_event`, `run_cost`, `share_job`, `device_call`, the assets with a `run_id`, `DATA_DIR/films`; `run_index` and the `result` links in the control database | decided: runs stay where they ran; they hold end users' answers, and their working state belongs to the process that holds the run |
| Control database | `link`, `run_index`, `session`, `runner`, `ui_translation`, `marketplace_cache`, `plugin_*` | each side writes its own when it applies rows |

**Per organization (Manage-App, read on both sides, never synced):** plan, `limits` (`projects`,
`build`, `members`, `concurrentRuns`), `modules`, `features`, credits, members and roles,
channels, the name, `slug` and `pagesHost`. On the install `accountOverview()` and `tenantInfo`
read them.

### Tenant and user ids

- On the install `tenant_id` stays `local`. The cloud writes the organization's id when it
  applies, and the install writes `local` when it pulls. The ids of rows (wizards, pages, files)
  are the same on both sides, as the one-way sync has it.
- User ids: `local`, `u:local` and `created_by` on the install map to the linked account's
  `userId` on the way up, and back on the way down. Other members' ids arrive as they are.
- One install holds one linked organization, as today (decided 2026-10-21). Several
  organizations in one install would need a tenant switch on a runtime that runs alone
  (`LOCAL_TENANT` appears 23 times in 7 files, and `local` as a user id more often). That is
  not part of this plan.

## Conflicts: the person chooses

### When an item is in conflict

Only when both sides changed it since its base. A change on one side applies with no question,
however large. "Item" means one row: a wizard (its draft and workspace together), a page, a
table row, the space's details, one translation.

### A clean merge applies by itself

The merge for the item's kind runs first (table below), then the checks. When it is clean and
the checks pass, it applies and goes up with no question (decided 2026-10-21). The studio
notes on the item that a merge was needed ("Merged with changes from the cloud"). It lists
what each side changed, as the studio's "Änderungen live schalten" list does today
(`versionChanges`, `packages/shared/src/changes.ts`). The base before the merge is kept until
the next sync, so "Undo the merge" can bring back either side.

### When the merge is not clean: the choice

The choice opens where the save was made: in the studio on the install, on the item being
edited ("Changed here and in the cloud"). One that arrives while offline waits on its item and
in the space's count. A merge that is clean but fails a check counts as not clean. The choices:

1. **Keep the cloud's version.** This computer's change is set aside, and it can be restored
   from the conflict until the next sync.
2. **Keep this computer's version.** It goes up on top of the cloud's version.
3. **Pick per place.** The studio lists the places where both sides changed the same thing,
   such as "step 'File the report' › title" or "row 12 › Status". It shows them side by side.
   For each place the person picks a side or writes the value. "Solve with AI" offers a
   proposal (below). The result goes through the same checks, and the person confirms.

Until the person decides, each side keeps its own version, the cloud's version stays live for
runs, and the rest of the space goes on syncing. The studio counts open conflicts per space.

### How each kind merges

| Item | Merge | Checks after it |
|---|---|---|
| Wizard definition (`draft`) | structural three-way merge of the JSON: objects by key, arrays of items with an `id` (steps, fields, columns) by id, their order kept from the side that changed it. It extends `mergeDrafts` to go into the steps and to report conflicts instead of settling them. | `wizardSchema` (zod) and `validateWizard` (ids, references between steps, templates) |
| Workspace files (`wizard_file`) | per path: text (widget code, libraries, reference data) by a classic line merge (diff3); other files: pick a side | the widget build, where one exists |
| Pages (`space_page`) | `title` per field; `markdown` by a classic line merge (diff3), which suits prose | none |
| Table rows (`space_table_row`) | `cells` per column id | the columns' types (`TableColumn`) |
| Tables (`space_table`) | per field; `columns` by id | the rows still fit the columns |
| The space (`project`) | `brand`, `facts`, `themes`, `page` as JSON, like the definition | `themes` and `page` by their schemas |
| Translations | per original text | none |
| Files (`project_file`) | pick a side | none |

### Help from a model

"Solve with AI" hands a model the base, both versions, the places in conflict and, for a
wizard, the issues `validateWizard` found. The model answers with the merged item as JSON.

- The runtime parses the answer with the item's schema and runs the checks. An answer that
  fails goes back to the model with the issues, up to three times.
- The studio shows the proposal as a change list against both sides. The person confirms or
  edits it.
- The model is the class `high`, the top text class. On the install it runs on what
  Settings → "Modelle & Konto" binds: Matthias's own subscription (Claude Code, Codex …), else
  credits. The model sees only what the studio chat may already read, the space's own content.
- Without a model the choice and the manual merge still work.

### Further rules

| Case | Rule |
|---|---|
| The same wizard edited at the same moment within one side | As today: `wizard.revision` refuses a stale write, and the studio merges with `mergeDrafts` (`live.tsx`). |
| Publishing | Publishing on the install pushes the draft, then asks the cloud to publish it. The cloud numbers the version (`wizard_version_n` is unique per wizard), and the version comes down. A draft in conflict is published only after the conflict is settled. |
| Edit against delete | A conflict like the others: "Deleted in the cloud, changed here" with "Delete it" and "Keep it". A space is deleted only by an owner or admin, in the cloud, and the install then moves its copy aside instead of erasing it. |
| Two sides create the same category, value or list | Matched by `space_category_name`, `space_category_value_value` and `space_table_list`. The arriving id is remapped to the existing one. |
| Plugin-written items (`origin`, `origin_key`) | A plugin's jobs for a synced space run in the cloud only. The install receives their pages and tables. `kept` and `review` work as today. |
| Id collisions | Text ids: `nanoid` is long enough. The cloud refuses an id it already has with a different owner (`id_taken`), as today. Integer ids never travel as ids: `space_item_category` rows are matched by (category, item, value), and `run_event`, `device_call` and `project_chunk` do not sync at all. |
| Share tokens | The cloud's link is the wizard's link. `wizard.share_token` comes down from the cloud. A token the install made for itself does not go up, and the cloud makes its own (`rotate-link` exists). |

## Can a classic merge handle a wizard?

Tried on 2026-10-21 with a real definition: `examples/wizards/alderbrook/report-a-problem.wizard`,
with five steps (page, agent, two generate steps, result). Two edits were made to copies of it,
and each pair was merged two ways:

- **Classic:** `git merge-file` on the definition as indented JSON (`JSON.stringify(def, null, 2)`).
- **Structural:** a three-way merge of the JSON that matches steps and fields by `id`, as
  described above.

Both results then went through a reference check like `validateWizard`'s.

| Edits on the two sides | Classic line merge | Structural merge |
|---|---|---|
| Different steps edited | clean | clean |
| Same step, keys far apart (`instructions`, `title` and `model`) | clean | clean |
| Same step, neighbouring keys (`instructions`, `tools`) | **conflict** | clean |
| Both add a step at the same place | **conflict** | clean, both steps in |
| Both add a field at the end of one page | **conflict** (the comma on the line before) | clean |
| One moves a step, the other edits another one | clean | clean |
| One moves a step, the other edits that step | **conflict** | clean |
| Same key, different values (both rename one step) | conflict | conflict, named: `steps[file].title` |
| One deletes a step, the other edits it | conflict | conflict, named: `steps[located]` |
| One renames the field `email` to `mail` and its uses; the other adds `{{email}}` to a prompt | clean, but the wizard is broken | clean, but the wizard is broken |

What this shows:

- A classic merge raises false conflicts in four of the ten cases. In those, the two sides
  touched neighbouring lines or the end of a list, not the same thing. It also cannot say
  where a conflict is in terms a person reads.
- Drafts are stored as compact JSON on one line (`text(..., { mode: "json" })`). On the stored
  form a line merge would call every pair of edits a conflict. It works only on an indented
  form with a fixed key order.
- The structural merge raised only the two real conflicts, and it names the step and the key.
- Neither merge catches a broken reference (the last row). So the checks run after every
  merge, `validateWizard` included, and a failed check counts as a conflict.
- The classic merge stays the right tool for text: page Markdown and the text files of a
  wizard's workspace.

## Migrations and releases

Out of scope (decided 2026-10-21): syncing or merging between different schema versions. Both
sides sync only when their tenant schema is the same.

- Every push and pull carries the tenant schema version: the last drizzle migration's tag
  (`0022_sync` as built), plus the plugins' SQL files of the synced tables, if any ever
  sync. The runtime version travels too, for the log only. A release that brings a tenant
  migration changes the tag, so the sync pauses until the other side has that release too; a
  release without one keeps the tag and never pauses it.
- When the versions differ, the sync pauses and nothing is converted. The side that is behind
  says so: "Update engenty wizards to sync again" (`wizards update`) on the install, or
  `reason: "schema_mismatch"` from the cloud between a release and its deploy.
- Edits go on during the pause. They wait in the log, and the push reads the rows as they
  stand, so after the install updates its own migration has already brought them to the new
  schema.
- A migration that changes a synced table's shape also converts that table's `sync_base`
  rows. Otherwise a conflict on such an item can only keep one side, not merge.
- Neither side ever migrates the other's database. Each runs its own drizzle migrations and its
  plugins' SQL files as today.
- Definitions with step kinds the other side does not know go through the check that exists
  (`POST /spaces/check`, `problems`, `runnable`).

## Files and blobs

- Blobs: `HEAD` per hash before upload, and upload only what is missing. The contract (step 1)
  sets the size limits; today it is 48 MB per wizard. A pull fetches the bytes it lacks before
  it writes the records that point to them.
- Assets: by id. A replaced asset (`replaceAsset`) keeps its id and syncs as a changed row with
  a new path. Only assets that a synced row points to travel (project files, logos). An asset
  with a `run_id` is a run's and stays.
- Keys map from `t/local/…` to `t/<org>/…`. Bytes are copied, never shared across tenants.
- Binary content travels as a stream, not base64 in JSON as `PUT /spaces/:id/wizards/:id` does
  today.
- `films/`, sandbox folders and browser profiles never travel.

## Auth flow

1. The person links the install to the account in the browser (PKCE, `wizards-desktop`) and
   picks the client's organization at `/select-tenant`. The device code gets the person's own
   tenant only, so the Manage-App needs a tenant pick there too (manage repository).
2. The access token (resource `CLOUD_URL`) names that tenant and the person's role. A new scope
   `wizards:sync`, or `wizards:read wizards:write`, covers the new calls.
3. The cloud runtime checks the token as for every `/api/v1` call. It applies under the token's
   role: a member edits, and an owner or admin makes and deletes (`access.ts`).
4. The install never holds a database URL or a Turso token. If the alternative with embedded
   replicas is chosen one day, the Manage-App would mint a per-database token with an
   `expiration`. That is not part of this plan.
5. Unlinking stops the sync and keeps the data on the computer. `forgetCloud()` clears the
   `sync:*` state too.

## Steps, each a pull request

Behind a switch in `.features` until the last step. The sizes are relative.

1. **Contract** (docs only, both repositories). Add "Two-way sync of a space" to
   `manage-contract.md`: the calls, records, schema handshake, limits and refusals. Manage:
   a tenant pick for the device code, and the scope. Small.
2. **Change log.** A tenant migration for `sync_change` and the guard table, triggers on the
   synced tables, and tests that applying does not echo. Small.
3. **Records.** Readers and appliers per table, the id mapping and the category matching, with
   unit tests on two file databases in one process. Medium.
4. **Cloud: push.** `POST /api/v1/spaces/:id/changes` and the blob calls. It applies through
   the services, writes `link`, and lifts `read_only` for spaces that sync both ways. Medium.
5. **Cloud: pull.** `GET /api/v1/spaces/:id/changes?since=` with paging. Small.
6. **Install: loop.** Push, pull and blobs on demand, the `sync:<projectId>` state, and the
   status line in the studio, building on the retry loop. Medium.
7. **Conflicts.** `sync_base`, the `conflict` answer of the push, the clean merge applied by
   itself with its notice and undo, and in the studio the choice for the rest with the count
   per space. Publishing through the cloud. Medium.
8. **Merge and check.** The structural JSON merge (`mergeDrafts` widened, reporting conflicts
   per place), diff3 for pages and workspace text files, cells per column, and the checks after
   each merge. The cases of the experiment above become its tests. Medium.
9. **Help from a model.** "Solve with AI": the prompt, schema parsing, the checks with retries,
   and the proposal shown for confirmation. Small to medium.
10. **Several spaces.** On the install, `projectLimit()` reads the linked organization's
    `limits.projects`. The pull on sign-in brings every space the person may see, and a choice
    says which ones this computer keeps. Small.
11. **Move over.** Spaces synced one way today (`origin = "local"`) become two-way. `FromLocal`
    goes, then the switch flips and the user guide follows. Small.

The sync needs no Turso plan. It goes through the cloud runtime's API and works the same on
tenant databases that are files under `/data` (`TENANT_DB_PROVISIONER=none`, today) or on
Turso. What it changes: the cloud's copy becomes the one that counts, so the `/data` volume
needs a backup (decided 2026-10-21). That is set up on the server (Coolify) before a client's
data syncs, outside these pull requests. Moving the tenant databases to Turso (the paid plan,
for the Platform API and for more than 100 databases) stays a later, separate choice.

## Built on 2026-10-21

All eleven steps, behind the switch `twoWaySync` (off by default, `.features`). Contract:
docs/manage-contract.md, "Two-way sync of a space".

| Step | Where |
|---|---|
| 1. Contract | `docs/manage-contract.md`; `packages/shared/src/sync.ts` (records, push and pull) |
| 2. Change log | tenant migration `0022_sync` (`sync_change`, `sync_guard`, `sync_base`, `sync_conflict`, `sync_merge`, three triggers per synced table) |
| 3. Records | `apps/runtime/src/sync/records.ts`, `apply.ts` (one transaction, foreign keys checked at the commit, dangling points let go) |
| 4.–5. Cloud: push and pull | `apps/runtime/src/sync/hub.ts`, routes in `routes/api.ts` |
| 6. Install: loop | `apps/runtime/src/sync/client.ts`; the minute loop in `index.ts`; the studio's hooks in `app.ts` (pull before a load, push after a save) |
| 7. Conflicts | `client.ts` (`reconcile`, `resolveConflict`, `undoMerge`); studio routes `/api/studio/sync/*` |
| 8. Merge and check | `packages/shared/src/sync-merge.ts` (JSON by ids), `text-merge.ts` (diff3); the records' checks |
| 9. Help from a model | `proposeMerge` (class `high`, three tries, the checks) |
| 10. Several spaces | `projectLimit()` reads the organization's number (`sync/state.ts`); spaces of either side join by themselves, a switch per space turns one off |
| 11. Move over | `POST /sync/spaces/:id/adopt` when a space starts to sync; the one-way sync stays for installs without the switch |
| Studio | `apps/web/src/studio/CloudSync.tsx`: Settings › Spaces in the cloud, the notice on a wizard, page or table, the bar above every page |

Tested: `test/sync-merge.test.ts` (the cases of the study), `test/sync.test.ts` (both sides in
one process: first sync, push, pull, deletes, merges with their notice and undo, conflicts and
choices, files, categories of the same name, a space made in the cloud, the model's proposal,
the schema), `test/sync-api.test.ts` (the cloud's calls on a managed runtime: roles, scopes,
bytes, the schema). Walked through on 2026-10-21 with two processes (a managed cloud runtime and a
local install linked through the sign-in) and the studio in a browser.

Different from the plan above:

- Versions do not travel (see the table). Marketplace stars do not either: they are the
  tenant's, not a space's.
- A pull fetches the bytes it lacks at once, not on the first read.
- Two categories of the same name made on both sides become one: the id that arrives first wins
  on both, and what pointed to the other moves to it.
- An install where the two-way sync runs leaves every plugin job to the cloud, not only those of
  synced spaces: a job works on the tenant, not on one space.

Not built yet:

- An open page or table does not show what a pull wrote while it is open; it does after it is
  opened again (an open wizard does, through its draft events).
- The device code at the Manage-App picks no organization (manage repository); the browser
  sign-in does.
- The user guide: it follows when the switch flips.

## Risks

- **Client data on laptops.** A client's knowledge and data on Matthias's computer is still a
  data processing question for sfg.at. End users' runs and answers never leave the side where
  they ran.
- **Plain-text secrets in `project.mcp_servers.headers`.** They would travel if not excluded.
- **Plugins with jobs on both sides** write the same `origin_key` twice. The rule "jobs of a
  synced space run in the cloud" needs enforcing in `plugins/jobs.ts`.
- **Live updates.** The studio's draft events are per process (`services/draft-events.ts`). An
  arrival needs its own notice in the open studio, else people see changes only after a reload.
- **A clean merge can still be wrong.** The checks catch broken ids and references, not
  meaning. Two sides can each tighten a prompt in ways that contradict each other. The notice
  on the item and "Undo the merge" are the answer to that.
- **Many conflicts after a long time offline.** Clean ones apply by themselves. The rest ask
  each, with the count per space and a "keep the cloud's version for all".
- **Size of the work.** About 11 pull requests. The triggers and appliers touch about 15 tables,
  and every new table later has to choose: synced or not.
- **Turso Sync matures.** If it reaches 1.0 with FTS, the change log could move onto it. The
  JSON contract would stay, so the choice is reversible.

## Decisions

Decided on 2026-10-21:

- Runs do not sync.
- Wizards are editable on both sides.
- Different schema versions do not sync; the sync pauses until both match.
- The sync hooks into the save, publish and load events that exist; saving stays as it is.
- A clean merge that passes the checks applies by itself, with a notice that a merge was
  needed. Only a merge that is not clean asks: keep either side or pick per place, with a
  model's proposal on request.
- No locks.
- Assistant chats do not sync: they belong to a person.
- One organization per install.
- Who may push: the person signed in to the cloud on the install, with their role in the
  organization. The cloud applies a push only with a valid token and under that role
  (`access.ts`), as for every edit in the cloud's studio.
- The sync needs no Turso plan (see "Steps").
- Connected systems sync without their `headers`. The headers are entered on each side, like
  API keys.
- Offline edits: everything that syncs takes edits offline, and they wait in the log. A
  conflict found when the computer is online again applies by itself when it is clean, and
  waits on its item when it is not.
- The cloud's `/data` volume gets a backup. The tenant databases stay files there for now.

Nothing is open.
