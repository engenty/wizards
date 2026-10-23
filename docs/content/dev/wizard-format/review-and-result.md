---
title: Review and result
description: A review step shows earlier results to check, the result step ends the run with its downloads.
version: 0.11.1
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
