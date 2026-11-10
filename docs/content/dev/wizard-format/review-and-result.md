---
title: Review and result
description: A review step shows earlier results to check, the result step ends the run with its downloads and its data.
version: 0.18.0
---

## Review

A `review` step shows what earlier steps made. The person accepts it, changes it or asks for a
new version.

```json
{
  "id": "check", "type": "review", "title": "Does this work?",
  "show": ["post", "visual"], "edit": true, "regenerate": true
}
```

| Key | What it does |
|---|---|
| `show` | The step ids whose results are shown, or `lists.<id>` for a stored list |
| `edit` | The person may change text results directly |
| `regenerate` | The person may ask for a new version, with a note |
| `approve`, `who`, `timeout`, `remind` | Asks someone else, for a decision, by a deadline. See [Runs that last days](./runs-that-last.md#a-persons-step) |

A shown list is edited in place. A list with `check` goes row by row on a split screen. See
[Lists and connections](./lists-and-connections.md#lists).

Put a review before anything expensive, such as video, and before anything written elsewhere,
such as a mail or a CRM.

## Result

The `result` step is always the last. It shows `message` and offers the downloads.

```json
{
  "id": "done", "type": "result", "title": "Ready to post",
  "message": "Copy the text and download the image.",
  "deliverables": [
    { "from": "post", "label": "Post", "formats": ["txt", "md"] },
    { "from": "visual", "label": "Image", "formats": ["png"] }
  ]
}
```

Each deliverable names a step id or `lists.<id>` in `from`, an optional `label` and its
`formats`.

### Data

`data` names what a finished run gives back besides its files: key → a field id, `steps.<id>`,
`steps.<id>.<key>`, `lists.<id>`, `brand.name` or `today`. It’s the shape `widget` and `surface`
take, and it reads only steps that run before the result.

```json
{
  "id": "done", "type": "result", "title": "Your reply",
  "deliverables": [{ "from": "reply", "label": "Reply", "formats": ["txt"] }],
  "data": { "reply": "steps.reply", "urgent": "steps.check.urgent" }
}
```

The run fills it when it reaches the result. An MCP client gets it from `get_run`, the API
from `GET /api/v1/runs/:id`, as `data` beside the files. Without `data` a run gives its files alone.

## What a wizard takes and gives

Nobody writes a wizard’s input or output schema by hand: both come from the definition, as
JSON Schema (draft 2020-12).

- **Input:** one property per field the run’s own person answers, under the field’s id, with
  its `label` as `title` and its `help` as `description`. A field is required when it’s marked
  `required` on a form every run reaches, with no `when`. Fields a decision picks, forms of the
  owner or the team, uploads, connections and lists are left out: they’re asked during the run.
- **Output:** `files`, the deliverables by `from` with their formats, and `data`, one property
  per key of the result’s `data` with the schema of what it names. A key whose step some runs
  skip is optional.

MCP `list_wizards` and `show_wizard` give both as `inputSchema` and `outputSchema`, as do the
wizards of `GET /api/v1/wizards` and `wizards validate --json`.

## Formats

| From | Formats |
|---|---|
| `generate` image | `png` |
| `generate` video | `mp4`, `zip` for several results |
| `generate` voice | `mp3` |
| `generate` document | `pdf`, `docx`, `html`, `md`, `png` |
| `generate` dashboard | `html`, `pdf`, `png` |
| `widget` | `html`, `png`, `pdf`, `json`, and `mp4` when the widget has a timeline |
| `widget` with `video` | `mp4`, `png` |
| `motion-graphics` | `mp4` |
| `agent` with `text` or `markdown` | `md`, `txt`, `docx`, `pdf`, `html` |
| `agent` with `json` | `json`, `csv`, `xlsx` (a sheet per table), `md`, and `pdf` with a `schema` |
| `agent`, any format | `zip`: the files the step kept |
| `lists.<id>` | `xlsx`, `csv`, `json`, `md`, and `zip` for a list with `check.file` |
