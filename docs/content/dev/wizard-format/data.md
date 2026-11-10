---
title: A wizard’s own data
description: A SQL database the runtime keeps for each person who runs a wizard, or for every run, and the steps that read and write it.
version: 0.18.0
---

A wizard can keep a database of its own: SQLite tables it reads and writes in every run. The
runtime keeps the database. The wizard brings only the SQL that makes it.

```json
"data": { "scope": "person", "schema": "data/schema.sql" }
```

| Key | What it does |
|---|---|
| `scope` | `person`, the default: one database for each person who runs the wizard. `shared`: one more that every run reads and writes |
| `schema` | A `.sql` file of the wizard’s files. It runs when a database is made |

```sql
-- data/schema.sql
CREATE TABLE seen (url TEXT PRIMARY KEY, title TEXT, seen_at TEXT);
CREATE TABLE signups (email TEXT PRIMARY KEY, name TEXT, at TEXT DEFAULT CURRENT_TIMESTAMP);
```

A database is made the first time a step writes to it. A read before that sees the empty tables of
the schema, and no database is made for it.

## Migrations

A later version of the wizard changes its tables with migrations: `.sql` files in
`data/migrations/`, run in the order of their names. Name them `001_add_column.sql`,
`002_index.sql` and so on. A database runs each migration once, before the next statement. A
new database runs the schema, then every migration. So keep the schema as it was, and change
the tables in migrations only.

## Agent steps

When the wizard has `data`, every agent step gets two tools:

| Tool | What it does |
|---|---|
| `data_query` | Runs one statement that reads: `SELECT`, `WITH`, `PRAGMA table_info` |
| `data_exec` | Runs one statement that writes: `INSERT`, `UPDATE`, `DELETE`, `CREATE` |

Each call names its `scope`, `person` or `shared`, and passes values as `params`. A statement
names them as `:email` and the runtime binds them. They are never written into the SQL.

## Fixed steps

A [tool step](./agent-steps.md#tool-steps) with `data` instead of `call` runs one statement the
wizard wrote. No model is involved.

```json
{
  "id": "signup", "type": "tool", "title": "Save the sign-up",
  "data": {
    "scope": "shared",
    "sql": "INSERT INTO signups (email, name) VALUES (:email, :name)",
    "params": { "email": "email", "name": "{{first}} {{last}}" }
  }
}
```

A parameter is a path for its raw value (`email`, `steps.find.total`) or a template for text.
The step’s output is `rows`, `count`, `changes` and `lastId`. A later step reads them by name,
when `output.fields` names them.

A [code step](./agent-steps.md#code-steps) can have `data` too. It runs the statement first, and
`run` gets what it gave as `input.data`.

## Guests

On a shared link, a guest’s AI steps reach only that guest’s own database. The shared database
is reached in a guest’s run only by fixed steps, with SQL the wizard wrote. So a sign-up can be
saved, and what one guest gave never reaches another guest’s model.

The same holds for files. `files_keep` takes `shared: true` when the wizard has shared data, and
a guest’s AI step doesn’t get it.

## Limits

| Limit | Default | Set with |
|---|---|---|
| Size of one database | 50 MB | `WIZARD_DATA_MAX_MB` |
| Rows a read hands back | 500 | `WIZARD_DATA_MAX_ROWS` |
| Rows one write changes | 1000 | `WIZARD_DATA_MAX_CHANGES` |
| Time of one statement | 5 seconds | `WIZARD_DATA_TIMEOUT_MS` |

A write that would pass a limit writes nothing. The runtime refuses `ATTACH`, `DETACH`,
`VACUUM`, extensions, a `PRAGMA` that changes the file, and transactions of a statement’s own.
`wizards validate` checks the schema and every migration for these too.

`WIZARD_DATA` sets what a runtime offers: `off` for no database, `person` for a person’s only.
The wizard’s [`requires`](./index.md#what-a-wizard-needs) names its `data`, and such a runtime
refuses to start a wizard that needs more.

## Where the data is

Each database belongs to the people who ran the wizard, not to the wizard. A `.wizard` file never
carries it. On your computer a database is a file in the data folder. On a server whose tenant
databases are on a database server, it is a database there. Each call is decided by the space’s
rights on the wizard’s data, and is a line of the audit.

A person’s database goes with the rest of what the wizard keeps for them: when they delete it,
and when nobody used it for `STORE_TTL_DAYS`. Deleting the wizard deletes all of its databases.
