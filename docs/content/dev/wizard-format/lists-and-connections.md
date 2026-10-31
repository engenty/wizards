---
title: Lists and connections
description: Tables a wizard keeps between runs, and accounts the person connects.
version: 0.13.0
---

## Lists

A list is a table the wizard keeps between runs, one for each person who runs it. A wizard has up
to 12.

```json
"lists": [{
  "id": "contacts", "title": "Contacts", "key": "email",
  "columns": [
    { "id": "name", "name": "Name", "type": "text" },
    { "id": "email", "name": "Email", "type": "text" },
    { "id": "since", "name": "Since", "type": "date", "format": { "kind": "date" } }
  ]
}]
```

| Key | What it does |
|---|---|
| `columns` | `id`, `name` (what people read), `type` and `format` |
| `key` | The column that identifies a row. Saving a row with a known key updates it |
| `shared` | One list for every run, such as leads or sign-ups |
| `check` | The person goes through the rows one by one in a review |

Column types are `text`, `number` (`integer`, `decimal`, `percent` or `currency`), `date`
(`date` or `datetime`), `select` (with `options`) and `boolean`.

Agent steps read and write lists with their own tools. Templates read a list as
`{{lists.<id>}}`, conditions as `lists.<id>.count`. A `list` field shows it on a page, a review
shows it with `lists.<id>` in `show`.

A `shared` list is never shown to the person running the wizard, who would see what others gave.
It shows in the studio under Space → Data.

`check` has `file`, a text column holding the path of a kept file, which shows beside the row. It
has `status`, a select column whose options are the answers. Its first option means “not looked
at yet”.

## Connections

A connection is an account the person connects during a run. It is kept for their next run. A
wizard has up to 12.

```json
"connections": [
  { "id": "inbox", "kind": "mail", "title": "Your mailbox" },
  { "id": "crm", "connector": "hubspot", "actions": ["search_contacts", "create_note"],
    "policy": { "create_note": "ask" } }
]
```

| Key | What it does |
|---|---|
| `kind` | `mail`: any mailbox, over Gmail, Outlook or IMAP. Steps only read it |
| `connector` | Instead of `kind`: a built-in connector or one imported into the space |
| `spaceConnection` | Instead of both: a connection of the space, by its id. The space’s admins set it up and chose how it signs in, who may use it and what each kind of action may do; the wizard holds no account of its own then, and `policy` has no say. Where it signs in as the space, AI steps read and fixed steps write (below) |
| `actions` | The connector’s actions steps may use. By default those that only read |
| `policy` | Per action: `allow` runs it, `ask` asks the person first. By default reading is allowed and writing asks |

A page field of kind `connection` asks the person to connect. The agent step lists the connection
in `connections` and gets its actions as tools.

### Reading and writing as the space

A connection of the space that signs in as the space is the space’s account, not the person’s.
An AI step that lists it gets its read actions only, whatever `actions` says; a write it tries is
refused and logged. A write goes in a fixed step: an agent step with `call` naming the connection,
the action and the input, with fields from the run’s values (see
[Agent steps](./agent-steps.md)). The step runs as the wizard, so the person running is not asked,
and the connection’s rules decide. The validator refuses a wizard whose AI step lists a write
action on such a connection.

Where each person signs in to the connection, and on the wizard’s own connections, an AI step may
write and the person is asked first, as before. A fixed step on the person’s own connection asks
them too.
