---
title: Starters
description: Wizards a plugin brings as templates – how to register one, where it shows, and what a wizard made from it gets.
version: 0.5.0
---

A starter is a wizard a plugin brings as a template. For the tenants that have the plugin, it
stands beside the marketplace’s templates wherever a wizard is made.

```ts
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(wizards.resolvePath(path), "utf8");

server.registerStarter({
  id: "follow-up",
  title: "Follow up a contact",
  description: "Looks the person up and drafts a follow-up email.",
  language: "en",
  definition: JSON.parse(read("starters/follow-up.json")),
  files: { "widget/card.html": read("starters/card.html") },
});
```

| Field | |
|---|---|
| `id` | Lower case, digits and `-`, starting with a letter, at most 40 characters. Unique in the plugin |
| `title` | What the list of templates calls it |
| `description` | What it makes, in one or two sentences. Shown under the title |
| `language` | `"de"` or `"en"`, the language its texts are in. Default: `"en"` |
| `definition` | A complete wizard definition: the JSON the studio keeps and `get_authoring_guide` describes |
| `files` | Files of the wizard’s workspace by path: widgets, sample data. A string is written as UTF-8, a `Uint8Array` as it is |

## Checked when it is registered

The definition is read as a wizard when `registerStarter` is called. A starter that is not a
valid wizard, an id that is not allowed and an id registered twice all throw, and the plugin does
not load. The error names the starter:

```
Starter "follow-up": steps.2.fields: …
```

## Where it shows

The starter is known as `<plugin id>.<starter id>`: `contacts.follow-up`. A marketplace entry’s id
has no dot, so the two never clash.

| Where | |
|---|---|
| New wizard in the studio | First among the gallery’s templates, and under “Similar wizards” when the wish someone types comes close to it. Its card shows the plugin’s name. It cannot be starred: it is always there, also without a connection |
| `GET /api/studio/marketplace` | First on the first page, with `plugin: { id, name }` |
| MCP `list_starters`, `get_starter`, `create_wizard` | Listed first with `plugin`; `starterId` takes its id |
| `GET /api/v1/templates`, for programs with a key | First, with `plugin`; `POST /api/v1/wizards` takes its id as `starterId` |

Only the tenants that have the plugin see it, by the same rule as its tools
([Which tenant has a plugin](./shipping.md#which-tenant-has-a-plugin)). A search finds it by its
title, its description and the plugin’s name.

A marketplace entry can stand for a plugin’s starter. Where the tenant has that plugin, the
entry is left out and the plugin’s own starter is listed. Where it doesn’t, the entry is marked
Pro with the plugins it needs, and a wizard cannot be made from it.

## A wizard made from it

- gets a copy of the definition and the files. Later changes to the starter do not reach it.
- keeps the starter’s id in `starter`. `starterRevision` stays empty: the starter changes with
  the plugin’s version, not with a revision of its own.
- is written in the starter’s `language`, whatever language the person asked for.
- is not counted at the marketplace.
