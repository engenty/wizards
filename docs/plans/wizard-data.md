# Plan: a wizard's own data, kept by the runtime

Status: plan, written on 2026-11-09. Not built. Comes after the version-1 stack (#577, #579, #580
and what follows), which brings the root `requires`.

## Why

Function tools, sandbox tools and skills (`wizard-code.md`) keep things between runs: a cache,
the items already seen, an index. That doesn't fit twelve typed lists, and code wants SQL. A
wizard is a recipe the shared runtime follows, not a program of its own, so it never brings
storage: the runtime provides it, scoped like lists, and the broker stands in front of it.

## What exists

`store/index.ts`: a store per wizard and holder (`StoreScope`: `wizardId`, `holder`,
`clientSpaceId`). It holds the wizard's lists, one per person or `shared`, and the files a run
keeps (`files_keep`, `files_list`). Stores nobody came back to are cleaned up (`touchStore`).

| Scope | Lasts | Holds today |
|---|---|---|
| Run | Until the run's results expire | Answers, step results, uploads, files the run makes, the sandbox VM's disk |
| Person (`holder`) | Between runs | Lists, kept files |
| Shared | Between runs | `shared` lists |
| Space | Always | Knowledge, the space's data, pages |

## Decisions

1. **A database per scope, from the runtime.** A wizard declares it:

   ```json
   "data": { "scope": "person", "schema": "data/schema.sql" }
   ```

   `scope` is `person` (the default, like lists) or `shared`, which gives one database for every
   run plus one per person. `schema` is a SQL file in the wizard's `files/`, run when a database
   is created. A later version of the wizard adds `data/migrations/*.sql`, run in order.
2. **A database, not a file.** It is libSQL, created on first use: a database on the tenant
   database server where it serves several (as tenant databases are made from
   `TENANT_DB_URL_TEMPLATE`), a file under the tenant's data folder on a local install. Two runs,
   two runners and the sandbox container can use it at once; nothing is copied in and out.
3. **Reached only through tools,** never as a file in a step or in the sandbox, so the broker
   decides every read and write and logs it.
4. **Guests stay apart.** In a guest's run an AI step reads and writes only that person's
   database. The shared database is reached in a guest's run only by fixed steps (`tool`, `code`)
   with SQL the wizard wrote: a sign-up can be saved, and no guest's data reaches another guest's
   model.
5. **`requires` names it:** `"data": "person"` or `"shared"`. A runtime that can't provide it
   refuses before the start.
6. **Files follow the same scopes.** Kept files stay per person. `files_keep` takes `shared: true`
   for the shelf when the wizard declares shared data, with the same rule for guests as 4.
7. **People's data, not the recipe's.** A `.wizard` export never carries it. Deleting a person's
   data deletes their database with their lists and files. Sync between a local install and its
   organization carries it like lists, by rows.

## Access

| Who | How |
|---|---|
| Agent steps | `data_query` (read) and `data_exec` (write), given when the wizard has `data`. The tool names its scope; `r`/`w` checked by the broker, one log line per call |
| Fixed steps | `tool` / `code` with `"data": { "sql": "insert into signups …", "params": { "email": "{{email}}" } }`, parameters bound, never spliced |
| Function tools (`wizard-code.md`) | `db.query()` / `db.exec()` handed into QuickJS, through the broker |
| Sandbox tools and skill scripts | Queries through the sandbox container's API, once it exists. No database file inside the VM |
| Templates, conditions | No SQL. A fixed step reads what a later step needs into its output |
| People | Space → Data shows a wizard's databases beside its lists, read-only, with export as CSV |

Limits: size per database (an env var, refused with a clear error when full), rows and time per
query, no `ATTACH`, no extensions, no `PRAGMA` that changes the file.

## Run state

A run's state stays its answers and step results, only ever added to. An accumulator across loop
rounds comes only if a real wizard needs it: a `state` declared with JSON Schema at the root,
written only by `code` steps, every change recorded with its step so back and "make again"
rewind it. Not part of this build.

## Steps

1. The data store: `data` in the definition, `requires.data`, `validate` (schema file exists and
   parses as SQL statements), databases created on first use per scope, cleanup with the store,
   deletion with the person.
2. `data_query` / `data_exec` for agent steps, and `data` on fixed steps, under the broker; the guest
   rule of decision 4.
3. Space → Data: a wizard's databases, read-only, CSV export.
4. `db` for function tools, once `wizard-code.md` step 1 is in.
5. Sandbox access, once the agentOS container is in.
6. Sync, by rows like lists.

## Open

- How many databases the tenant database server holds well, with many guests each getting one.
  Fallback: person data as rows of one shared database per wizard, only through fixed SQL.
- Sizes and how they are counted against a plan.
