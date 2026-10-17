---
title: Tables
description: A plugin's own tables in every tenant's database – SQL files that run once, and Drizzle to read and write.
version: 0.5.0
---

Every tenant has a database of its own (libSQL, the SQLite dialect). The runtime makes a plugin’s
tables in each of them, from `.sql` files the plugin brings.

## 1. The table, as SQL

`migrations/0001_init.sql`:

```sql
CREATE TABLE contacts_person (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  wizard TEXT NOT NULL,
  seen_at INTEGER NOT NULL
);
```

Register the folder when the plugin loads:

```ts
server.registerMigrations("migrations");
```

## 2. The table, for Drizzle

`src/schema.ts` describes the same table, so queries are typed:

```ts
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const person = sqliteTable("contacts_person", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull().unique(),
  name: text("name"),
  wizard: text("wizard").notNull(),
  seenAt: integer("seen_at", { mode: "timestamp_ms" }).notNull(),
});
```

The runtime does not read this file. It is yours: keep it in step with the SQL by hand.

## 3. Read and write

`server.getTenantDb()` is the database of the tenant the current request, step or event belongs
to, as a Drizzle database:

```ts
import { desc, eq } from "drizzle-orm";
import { person } from "./schema";

const db = () => server.getTenantDb();

const newest = await db().select().from(person).orderBy(desc(person.seenAt)).limit(200);

await db()
  .insert(person)
  .values({ email, name, wizard, seenAt: new Date() })
  .onConflictDoUpdate({ target: person.email, set: { name, wizard, seenAt: new Date() } });

await db().delete(person).where(eq(person.id, id));
```

Call `getTenantDb()` inside the handler, the tool, the listener or the job. Outside of them
there is no tenant.

## How the files run

| | |
|---|---|
| Once | Each `.sql` file runs once per tenant database. The table `plugin_migration` records which ran |
| In order | By file name: `0001_init.sql`, `0002_note.sql` |
| Whole or not | A file and its record go in together or not at all. A file may hold several statements |
| When | A database gets the files when it opens. The open ones get them when the plugin loads, also when it loads again with a new file |
| Never back | Nothing is taken back. Unloading or removing a plugin leaves its tables and rows |

A file that fails is logged with the plugin’s id and the file’s name. The files after it, other
plugins’ included, wait for that database until the file is fixed. The tenant’s database still
opens.

## Rules

- **Begin table names with the plugin’s id**: `contacts_person`. All plugins and the runtime
  share the database. A `-` in the id becomes `_`.
- **Never change a file that ran.** It will not run again. Add a new file:

  ```sql
  ALTER TABLE contacts_person ADD COLUMN phone TEXT;
  ```

- **Do not touch the runtime’s own tables** in a migration. Their shape changes with releases.
- **Dates** are integers in milliseconds (`mode: "timestamp_ms"`); they leave a route as ISO
  strings.

## The runtime’s own data

`getTenantDb()` reaches the whole tenant database, the runtime’s tables included. They are not
a public interface: a release can rename a column. A plugin that must know about runs listens
to [run events](./events.md) and keeps what it needs in its own table.
