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

## Function tools

A [function tool](./tools-skills-agents.md#function-tools) gets `db` beside `fetch` and `tools`
when the wizard has `data`:

```ts
// tools/remember.ts
export async function run({ url, title }, { db }) {
  const seen = await db.query("SELECT 1 FROM seen WHERE url = :url", { url });
  if (seen.rows.length) return { new: false };
  await db.exec("INSERT INTO seen (url, title, seen_at) VALUES (:url, :title, datetime())", {
    url,
    title,
  });
  return { new: true };
}
```

| Call | What it does |
|---|---|
| `db.query(sql, params, { scope })` | Runs one statement that reads. It answers with `columns`, `rows` and `truncated` |
| `db.exec(sql, params, { scope })` | Runs one statement that writes. It answers with `changes` and `lastId` |

`params` and the options can be left out. `scope` is `person` by default. Each call counts toward
the tool’s 20 requests and calls, and each is a line in the audit. A wizard without `data` gets
no `db`.

## The sandbox

A command in the run’s sandbox reaches the database through engenty wizards, never as a file. A
sandbox tool, a skill’s script and a command the model runs find two variables in their
environment:

| Variable | What it holds |
|---|---|
| `WIZARD_DATA_URL` | The address to send statements to |
| `WIZARD_DATA_TOKEN` | The run’s token. It works only while the run is running |

`POST $WIZARD_DATA_URL/query` reads and `POST $WIZARD_DATA_URL/exec` writes. The body is JSON
with `sql`, `params` and `scope`, as with `db`:

```bash
curl -s "$WIZARD_DATA_URL/query" \
  -H "authorization: Bearer $WIZARD_DATA_TOKEN" \
  -H "content-type: application/json" \
  -d '{"sql": "SELECT url, title FROM seen WHERE seen_at > :since", "params": {"since": "2026-11-01"}}'
```

```python
import json, os, urllib.request

def data(action, sql, params=None, scope="person"):
    body = json.dumps({"sql": sql, "params": params or {}, "scope": scope}).encode()
    request = urllib.request.Request(
        f"{os.environ['WIZARD_DATA_URL']}/{action}",
        data=body,
        headers={
            "authorization": f"Bearer {os.environ['WIZARD_DATA_TOKEN']}",
            "content-type": "application/json",
        },
    )
    with urllib.request.urlopen(request) as answer:
        return json.load(answer)

rows = data("query", "SELECT url FROM seen")["rows"]
```

A refused statement answers with an error status and `{ "error": "…" }`: 403 where the space’s
rights or the guest rule refuse it, 400 where the statement breaks a limit.

The sandbox reaches engenty wizards at `SANDBOX_DATA_URL`, or at `PUBLIC_URL` when that is an
HTTPS address. Without either, the variables are missing and only the steps’ own tools reach the
database. A sandbox on your computer has none: it reaches only public HTTPS addresses, and engenty wizards answers on `localhost`.

## Guests

On a shared link, a guest’s AI steps reach only that guest’s own database. The shared database
is reached in a guest’s run only by fixed steps, with SQL the wizard wrote. So a sign-up can be
saved, and what one guest gave never reaches another guest’s model.

A function tool and the sandbox count as the AI’s: the model decides when they run. In a guest’s
run they reach only the guest’s own database.

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
