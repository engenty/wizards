---
title: The .wizard file
description: The zip a wizard travels in, its folders and manifest, how to make one by hand, and what the import does with it.
version: 0.7.10
---

A `.wizard` file is a zip with the wizard’s definition and its workspace. The studio exports
one, imports one back, and `wizards validate` checks one. Its media type is
`application/vnd.engenty.wizard+zip`. The file is named after the wizard’s title, such as
`create-an-invoice.wizard`.

## What is in the zip

```text
create-an-invoice.wizard
├── wizard.json                 the manifest, with the definition in it
└── files/                      the wizard's workspace
    ├── invoice/
    │   ├── index.html          a widget step's entry
    │   ├── app.js
    │   └── sample.json         its example data
    ├── lib/
    │   └── chart.min.js        libraries the widgets load
    ├── prices.csv              reference data AI steps read
    ├── kits/explainer.zip      a film step's style kit
    ├── skills/brand/SKILL.md   a skill package a film step reads
    └── knowledge/              only in a website package
        └── services/pricing.md
```

| Path | What it holds |
|---|---|
| `wizard.json` | The manifest. See [The manifest](#the-manifest) |
| `files/` | The workspace: every file the wizard’s steps name by path |
| `files/knowledge/` | The space’s Knowledge pages, only when the export was asked for them. See [Knowledge](#knowledge) |

Only `wizard.json` is required. A wizard without widgets, kits or files has an empty `files/`
or none.

## The workspace

The paths under `files/` are the paths the definition uses. A widget step with
`"entry": "invoice/index.html"` reads `files/invoice/index.html`, and a film step with
`"kit": "kits/explainer.zip"` reads `files/kits/explainer.zip`. Apart from `knowledge/`, no
folder has a fixed meaning. The ones above are what the studio and its assistant write.

| Limit | Value |
|---|---|
| Files | 200 |
| One file | 5 MB |
| All files | 25 MB |
| The whole zip | 30 MB, with room for the manifest |
| A path | 200 characters: letters, digits, `_`, `-` and `.`, with `/` between folders |

A path starts with a letter, a digit, `_` or `-`. So hidden files such as `.env` and paths with
`..` are not allowed. The import refuses a file that breaks a limit, and names it.

## The manifest

```json
{
  "$schema": "https://engenty.ai/schema/v1/wizard-package.json",
  "format": "engenty-wizard",
  "version": 1,
  "exportedAt": "2026-10-18T09:12:00.000Z",
  "definition": { "version": 1, "title": "Create an invoice", "steps": [ … ] },
  "connectors": [
    { "id": "billomat", "name": "Billomat", "domain": "billomat.com", "sourceKind": "openapi" }
  ],
  "mcpServers": [{ "id": "notion", "name": "Notion" }],
  "knowledge": { "pages": 12, "truncated": false }
}
```

| Key | What it holds |
|---|---|
| `$schema` | The JSON Schema for editors. The app does not read it |
| `format` | Always `engenty-wizard`. It tells a manifest from a bare definition |
| `version` | The manifest’s version, `1` |
| `exportedAt` | When the file was made |
| `definition` | The wizard. See [The wizard format](./index.md) |
| `connectors` | Imported connectors the wizard’s connections name: `id`, `name`, `domain` and `sourceKind` (`openapi` or `mcp`), at most 50 |
| `mcpServers` | The space’s connected systems its agent steps name: `id` and `name`, at most 10 |
| `knowledge` | Only with Knowledge: how many pages, and whether the cap left some out |

`connectors` and `mcpServers` hold names, never addresses, headers or credentials. They let the
import tell you what the space you import into still needs.

## Knowledge

A website runs a wizard without its space. For that, the share dialog’s website package has
“Take the knowledge along”. The space’s Knowledge pages then come along as Markdown, one file per
page, at their path under `files/knowledge/`:

```markdown
---
title: "Pricing"
path: pages/services/pricing
---

Our hourly rate is …
```

A page is cut after 60,000 characters. The pages stop at about 2 MB in all, and `truncated` in the
manifest then says so.

## What stays out

A `.wizard` file holds the wizard, not what it collected or what the space owns:

- runs, results and uploads
- the rows of its lists and the accounts people connected
- the space’s brand, facts and Knowledge, unless Knowledge was asked for
- the addresses and credentials of connectors and connected systems
- translations and the wizard’s published versions

The studio’s export holds the draft. The website package and the export over the API hold the
published version.

## Making one by hand

Zip a folder that holds `wizard.json` and `files/`:

```bash
cd create-an-invoice && zip -r ../create-an-invoice.wizard wizard.json files
```

The zip may also hold that folder itself, as a zip made in the Finder does. The import takes the
`wizard.json` closest to the top, and the `files/` beside it. It leaves out folders, `__MACOSX/`
and `.DS_Store`.

`wizards validate` reads the unpacked folder as it is, without zipping it. See
[JSON Schema and validation](./validate.md).

## What the import does

The import takes a `.wizard` file, a `wizard.json` on its own, or a definition on its own. A JSON
file without `"format": "engenty-wizard"` is read as a definition.

1. It checks the zip against the limits before it unpacks anything.
2. It checks the definition and that every path it names is in the workspace.
3. It makes a new wizard in the space: a draft, not published, with the workspace’s files.
4. It tells you which connectors and connected systems the space still lacks.

What belongs to the space is checked only here, because only the space has it: its connectors
and their actions, its connected systems and its plugins’ tools. A manifest of a newer version
is refused, with a note that the file comes from a newer version of engenty wizards.
