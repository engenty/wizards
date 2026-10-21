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
- Gives each wizard a **home**, the one place where its draft is edited, as proposed in
  [cloud-first-onboarding.md](cloud-first-onboarding.md). Knowledge and data merge row by row.

The limits:

- **Wizard drafts are never merged.** One place edits a draft at a time. "Edit here" moves the
  home.
- **Some data stays on the side where it was made.** Encrypted data, per-person data (the
  wizard's store, the studio assistant's chats) and the knowledge index stay put. The index is
  rebuilt on each side.
- **Runs never sync.** A run, its events and its results stay on the side where it ran. In the
  cloud, wizards run from the published version that arrived there, as today.
- **Both sides must run compatible schema versions.** The sync refuses a schema that is too
  new.

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
  space data to every install, and runs up (this plan leaves runs out). Its decision 5 asks: `wizard.home` (no merge) or a
  true two-way sync of drafts? This study answers it: `wizard.home`.

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
  `SyncDataInput` today, with the schema version they were written under. Unknown fields are
  ignored and missing ones take their defaults. So an install one release behind keeps working.
- **Applied through the services.** The cloud applies a push in the tenant from the token,
  under `asRole(role)` and `asSync()`. It writes the `link` rows that the rows need (a
  wizard's share link and code, logos, fonts) and rewrites `tenant_id` and user ids (below). The install applies a pull the same way.
  Then each side runs its own jobs: the index (`reindexSpace`), the plugins' `spaceChanged`.
- **Files after rows.** A push first asks which blob hashes and asset ids the cloud lacks. It
  uploads those, then sends the rows (the order the one-way sync uses today). A pull fetches
  the blobs it lacks on demand, so large documents do not block a pull.
- **When.** Push after each change, debounced, plus the minute loop that exists
  (`retryFailedSends`). Pull on start, on sign-in, every few minutes while the studio is open,
  and when the studio shows a space. Offline, the log simply grows and is sent later.
- **State on the install.** The control database's `setting` holds `sync:<projectId>`: the last
  pushed local `seq`, the last pulled cloud `seq`, the schema version and the last error. It
  sits beside the `cloud:*` keys of today.

### What syncs and what stays

**Per space (synced in both directions):**

| Data | Tables | Rule |
|---|---|---|
| The space | `project`: `name`, `brand`, `facts`, `themes`, `page` | merge per field; `brand` per top-level key |
| Wizards: draft and workspace | `wizard`, `wizard_file` and their blobs | only the home edits; others receive |
| Wizards: published versions | `wizard_version` | published at the home; append-only by `version` |
| Wizards: sharing settings | `wizard`: `share_enabled`, `daily_run_limit`, `runners`, `translate` | the cloud's values count (the link is the cloud's) |
| Translations | `wizard_translation` | per (wizard, lang), the newer arrival wins |
| The wizard's build chat | `wizard_message` | append-only |
| Knowledge: pages | `space_page` | per row, conflict copy (below) |
| Data: tables and rows | `space_table`, `space_table_row` | table per field; rows per cell |
| Categories | `space_category`, `space_category_value`, `space_item_category` | matched by name and value, not by id |
| Files and documents | `project_file` (when `ready`), their assets, `text_hash` blobs | per row; bytes by hash |
| Connectors | `project_connector` | per (project, id) |
| Connected systems | `project.mcp_servers` | without `headers` (decision 4) |
| Stars | `marketplace_star` | a set |

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
- One install holds one linked organization, as today. A second client means a second data
  folder (`DATA_DIR`, `API_PORT`), which needs a check that the CLI and the desktop app handle
  it. Several organizations in one install need a tenant switch on a runtime that runs alone
  (`LOCAL_TENANT` appears 23 times in 7 files, and `local` as a user id more often). That is
  a later step (decision 6).

## Conflict rules

| Case | Rule |
|---|---|
| The same wizard edited on both sides | Cannot happen: only the home edits. Elsewhere the wizard is read-only ("edited on <device>") with "Edit here". Moving the home pushes the old home's unsent changes first. If the old home is offline, the person confirms a takeover, and the old home's draft comes back there as a copy of the wizard. `wizard.revision` still refuses stale writes within one side. |
| Publishing | Only the home publishes. `wizard_version.version` is unique per wizard (`wizard_version_n`), so two sides cannot both make version 4. |
| A page edited on both sides since the last sync | The first arrival in the cloud stays the page. The second becomes a sibling page "<title> (<device>)" with `review` set, so a person looks at it. Markdown is never merged by machine. |
| A table row edited on both sides | Merge per cell (`cells` is keyed by column id). For the same cell, the later arrival in the cloud wins, which is Turso Sync's "last push wins" too. The table gets `review` naming the rows. |
| `project.brand`, `facts`, `themes`, `page` | Per top-level field, the later arrival wins. |
| Edit against delete | The edit wins and the row comes back. A space is deleted only by an owner or admin, in the cloud, and the install then moves its copy aside instead of erasing it. |
| Two sides create the same category, value or list | Matched by `space_category_name`, `space_category_value_value` and `space_table_list`. The arriving id is remapped to the existing one. |
| Plugin-written items (`origin`, `origin_key`) | A plugin's jobs for a synced space run in the cloud only. The install receives their pages and tables. `kept` and `review` work as today. |
| Id collisions | Text ids: `nanoid` is long enough. The cloud refuses an id it already has with a different owner (`id_taken`), as today. Integer ids never travel as ids: `space_item_category` rows are matched by (category, item, value), and `run_event`, `device_call` and `project_chunk` do not sync at all. |
| Share tokens | The cloud's link is the wizard's link. `wizard.share_token` comes down from the cloud. A token the install made for itself does not go up, and the cloud makes its own (`rotate-link` exists). |

## Migrations and releases

- Every push and pull carries the runtime version and the tenant schema version (the last
  drizzle migration's tag, today `0020_project_page`).
- The cloud accepts changes written under its own schema or an older one within a window it
  names. It refuses a newer one with `reason: "update_cloud"`, which only happens between a
  release and its deploy.
- The install refuses a pull from a newer schema. It tells the person to update
  (`wizards update`) and keeps pushing nothing that would lose fields.
- Neither side ever migrates the other's database. Each runs its own drizzle migrations and its
  plugins' SQL files as today.
- Definitions with step kinds the other side does not know go through the check that exists
  (`POST /spaces/check`, `problems`, `runnable`).

## Files and blobs

- Blobs: `HEAD` per hash before upload, and upload only what is missing. The contract (step 1)
  sets the size limits; today it is 48 MB per wizard. Downloads happen lazily on first read on
  the install: `getBlob` would fall back to the cloud for a space that syncs.
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
7. **Wizard home.** The `wizard.home` column, read-only elsewhere, "Edit here", takeover and the
   copy. It replaces `project.origin = "local"` for the spaces it covers. Medium.
8. **Merges.** Page conflict copies with `review`, per-cell rows, brand per field. Small to
   medium.
9. **Several spaces.** On the install, `projectLimit()` reads the linked organization's
   `limits.projects`. The pull on sign-in brings every space the person may see, and a choice
   says which ones this computer keeps. Small.
10. **Move over.** Spaces synced one way today (`origin = "local"`) become two-way. `FromLocal`
    goes, then the switch flips and the user guide follows. Small.

Before step 4 reaches a client's data: turn on the `turso` provisioner (a paid plan) so the
cloud's tenant databases are no longer files on one volume. This is independent of the sync,
but the sync makes the cloud copy the one that counts.

## Risks

- **Client data on laptops.** A client's knowledge and data on Matthias's computer is still a
  data processing question for sfg.at. End users' runs and answers never leave the side where
  they ran.
- **Plain-text secrets in `project.mcp_servers.headers`.** They would travel if not excluded.
- **Plugins with jobs on both sides** write the same `origin_key` twice. The rule "jobs of a
  synced space run in the cloud" needs enforcing in `plugins/jobs.ts`.
- **Live updates.** The studio's draft events are per process (`services/draft-events.ts`). An
  arrival needs its own notice in the open studio, else people see changes only after a reload.
- **Size of the work.** About 10 pull requests. The triggers and appliers touch about 15 tables,
  and every new table later has to choose: synced or not.
- **Turso Sync matures.** If it reaches 1.0 with FTS, the change log could move onto it. The
  JSON contract would stay, so the choice is reversible.

## Decisions for Matthias

1. **A home per wizard instead of merging drafts** (closes decision 5 of
   cloud-first-onboarding.md). Recommended: the home.
2. **Assistant chats.** Recommended: they stay where they were written.
3. **Connected systems' headers.** Recommended: sync the servers without `headers`, and enter
   the headers on each side like API keys.
4. **Offline edits.** Recommended: knowledge and data take edits offline, and they wait in the
   log. Wizards are edited offline only at their home.
5. **One organization per install** (a second data folder for a second client) or a tenant
   switch in one install. Recommended: one per install first.
6. **The Turso paid plan and the `turso` provisioner** before a client's data lives in the
   cloud.
7. **Who may push.** Recommended: the same roles as editing in the studio. Members edit, and
   owners and admins make and delete.
