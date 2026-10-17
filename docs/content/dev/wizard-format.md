---
title: The wizard format
description: A wizard as JSON and as a .wizard file, its JSON Schema, and checking it with wizards validate.
version: 0.5.13
---

A wizard is one JSON document, its **definition**. The studio exports it as a `.wizard` file
and imports one back. You can write either by hand or with a tool, check it in your editor
against a JSON Schema, and check it completely with `wizards validate`.

The code that defines the format and checks it is also under the
[MIT licence](https://github.com/engenty/wizards/blob/main/packages/shared/LICENSE-MIT), so any
tool may read and write wizards.

## The definition

```json
{
  "$schema": "https://engenty.ai/schema/v1/wizard.json",
  "version": 1,
  "title": "Create an invoice",
  "description": "A finished invoice from a few details.",
  "avatar": "round",
  "lang": "en",
  "steps": [ … ]
}
```

`steps` run from top to bottom, and the last one is always a `result` step. The schema below
lists the step types and their fields. The studio’s MCP tool `get_authoring_guide` explains them
with a complete example.

`lang` is the language the wizard speaks to people, as a two-letter code: `en`, `de`, `it`, `fr`
and so on. The schema checks the shape of the code; `wizards validate` and the studio check that
it names a real language. It sets the runner’s own words and how numbers and dates are written.
Without it, the language is read from the wizard’s own words, and English is the default where
they are not clearly German.

`version` is the definition’s version. It changes only with a breaking change; the schemas of
each version stay online in their own folder (`/schema/v1/`, `/schema/v2/`, …).

## The `.wizard` file

The file is a zip with two things in it:

| Path | What it holds |
|---|---|
| `wizard.json` | The manifest: the definition, plus what the wizard needs from its space |
| `files/…` | The wizard’s workspace: widget pages, templates, images. At most 200 files and 25 MB |
| `files/knowledge/…` | Only when the export was asked for it: the space’s Knowledge pages as Markdown files, one per page, with its title in front. A website runs the wizard with them, without the space |

```json
{
  "$schema": "https://engenty.ai/schema/v1/wizard-package.json",
  "format": "engenty-wizard",
  "version": 1,
  "definition": { … },
  "connectors": [{ "id": "billomat", "name": "Billomat", "domain": "billomat.com" }],
  "mcpServers": [{ "id": "notion", "name": "Notion" }]
}
```

`connectors` and `mcpServers` (the space’s connected systems) name what the wizard’s steps use
from its space, without addresses or credentials. When the space you import into lacks one, the
import says so.

`knowledge` (`{ "pages": 12, "truncated": false }`) is there when the export took the space’s
pages along. It says how many there are and whether the cap of about 2 MB left some out. The
share dialog’s website package does this with “Take the knowledge along”.

The import also takes a `wizard.json` on its own, or a definition on its own.
The file’s media type is `application/vnd.engenty.wizard+zip`.

## JSON Schema

| For | Schema |
|---|---|
| A definition | [`https://engenty.ai/schema/v1/wizard.json`](https://engenty.ai/schema/v1/wizard.json) |
| `wizard.json` in a package | [`https://engenty.ai/schema/v1/wizard-package.json`](https://engenty.ai/schema/v1/wizard-package.json) |

Put the address under `"$schema"`, and editors such as VS Code complete keys and mark mistakes
as you type. The studio’s export writes it into every `wizard.json`.

The schemas are written from the code that reads wizards, so they match it. They are stricter
in one way: a key the app does not know is an error. The app would drop such a key without a
word.

`wizards validate` checks what a JSON Schema cannot say: unique ids, steps and fields that refer
to each other, templates that name answers that exist by then, and files in the workspace.

## `wizards validate`

```bash
wizards validate invoice.wizard
```

It checks a wizard the way the studio’s import does, without a running studio and without an
account. It takes any number of paths:

| Path | Read as |
|---|---|
| `invoice.wizard` | A package |
| `invoice/` or `invoice/wizard.json` | An unpacked package, its workspace under `invoice/files/` |
| `invoice.json` | A definition on its own, or a `wizard.json` |

```text
✗ invoice.json 2 issues
  The last step must be a result step.
  "{{nope}}" refers to a field that is not asked before "g".
```

A wizard without issues gets a ✓ with its number of steps and files. `--json` prints the
results as JSON. The exit code is `0` when every wizard is fine, `1` when one has issues and `2`
when no path was given. That is enough for a check in CI:

```bash
npx wizards validate wizards/*.wizard
```

`npx wizards` installs engenty wizards into `~/.engenty/wizards` first, the first time. To check
without an install, on Node.js 24.11 or newer, run the runtime from npm directly:
`npx -p @engenty/wizards-runtime wizards validate wizards/*.wizard`.

The import checks what belongs to the space, because only the space has it: its connectors and
their actions, its connected systems (MCP servers) and its plugins’ tools.
