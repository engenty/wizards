# Plan: what a wizard takes and gives, as JSON Schema

Status: plan, written on 2026-11-09. Not built. Comes after the format's version-1 stack
(#577, #579, #580), which makes `form` the input step and step outputs JSON Schema.

## Why

Whoever starts a run without a person guesses. `run_wizard` over MCP takes `answers` as any record
and answers `refusedAnswers` afterwards; a start fills fields by id; the API is the same. What a run
gives back is files. Another app, an MCP client or a Mastra workflow wants to know beforehand what a
wizard takes, and to get data back, not only files.

A published wizard as an MCP tool (phase 4 of the modular roadmap) needs an `inputSchema`, and an
`outputSchema` lets it return structured content. The starts plan already asks the definition to
say what a run can be started with.

## Decisions

1. **Derived, never written by hand.** The forms already say what a wizard takes, and a second list
   beside them would drift. Both schemas are worked out from the definition by two functions in the
   shared package (MIT): `inputSchemaOf(def)` and `outputSchemaOf(def)`. Nothing new is stored, so
   no stored wizard changes.
2. **One authored addition: `data` on the result step.** It names the data a run gives back, as
   `key → path`, the same shape `widget` and `surface` take:

   ```json
   { "id": "done", "type": "result", "title": "Your reply",
     "deliverables": [{ "from": "reply", "label": "Reply", "formats": ["txt"] }],
     "data": { "reply": "steps.reply", "urgent": "steps.check.urgent" } }
   ```

   Optional. Without it the output is the files alone.

## The input schema

One property per form field the run's own person answers, under the field's id, with the field's
`label` as `title` and its `help` as `description`.

| Field kind | JSON Schema |
|---|---|
| `text`, `textarea` | `string` |
| `email`, `url`, `date` | `string` with `format` `email`, `uri`, `date` |
| `number` | `number` with `minimum`, `maximum` |
| `select` | `string` with `enum` from `options` (none with `optionsFrom`) |
| `multiselect` | `array` of those |
| `toggle` | `boolean` |
| `color` | `string`, a hex colour |
| `items` | `array` of objects with the field's `columns` |
| `location` | `string` (an address) or `{ lat, lng }` |
| `slot` | `string`, an ISO date-time from the offered slots |
| `image`, `file`, `audio`, `signature` | Left out at first; uploads from outside need their own way in |
| `connection` | Left out: a connection is made by a person |

- **Required:** a field marked `required` on a form every run reaches. A field on a branch or shown
  only when it fits is optional.
- **Left out:** fields that a decision picks (`groups`), and forms answered by `owner` or `team`.
  They are asked during the run, not given at the start.
- An answer that is missing waits for the person, as a start does today.

## The output schema

- `files`: the deliverables, by label and format.
- `data`: one property per key of the result's `data`, its schema taken from the named step's
  output (a json step's JSON Schema, `string` for text and markdown, the field's schema for a form
  field). A key that names a step some runs skip is optional.

## Where they show

| Place | What changes |
|---|---|
| MCP `run_wizard` | Its `answers` stay a record; `show_wizard` and `list_wizards` give each wizard's `inputSchema` |
| A published wizard as an MCP tool (phase 4) | The tool's `inputSchema` and `outputSchema`; the run's `data` as `structuredContent` |
| `/api/v1` | The wizard's two schemas; a finished run returns `data` beside its files |
| `wizards validate --json` | Prints both schemas |
| Studio | The share dialog shows what the wizard takes and gives |
| `runReport` | Carries `data` once the run is done |

`validate` checks `data`: its paths name steps that run before the result, as for a widget.

## Steps

1. `inputSchemaOf` and `outputSchemaOf` in `packages/shared`, with tests over the starters.
2. `data` on the result step: schema, `validate`, the runner fills it, `runReport` and the API
   return it. Docs: `review-and-result.md`, `authoring.md`.
3. The schemas in `show_wizard`, `list_wizards`, `/api/v1` and `validate --json`.
4. Phase 4 uses them for published wizards as tools.

## Open

- Uploads from outside: a URL, base64, or an upload first and its id. Decide with phase 4.
- Whether `run_wizard` refuses answers that don't fit the schema before the run starts, or keeps
  answering `refusedAnswers` after.
