---
title: Pages and fields
description: A page step and its fields, the field kinds, and fields that show only when they fit.
version: 0.7.10
---

A `page` step asks the person. It holds at least one field, and a good page has at most five.
`cta` is the button’s label.

```json
{
  "id": "about", "type": "page", "title": "What is it about?", "cta": "Write it",
  "fields": [
    { "id": "topic", "label": "Topic", "kind": "textarea", "required": true,
      "placeholder": "e.g. We open our new studio on Friday", "help": "For the first line" },
    { "id": "tone", "label": "Tone", "kind": "select",
      "options": ["Casual", "Professional"], "default": "Casual" }
  ]
}
```

A field’s `id` is unique in the whole wizard, because later steps read the answer by it. Every
field has a `label` and a `kind`, and may have `required`, `placeholder`, `help` and `default`.

## Field kinds

| Kind | What the person gives | Keys of its own |
|---|---|---|
| `text`, `textarea` | A line, or a few paragraphs | `scan` (text): fill it from a QR code or barcode |
| `number`, `date`, `email`, `url` | A number, a date, an address, a link | |
| `select`, `multiselect` | One or several of `options` | `optionsFrom`, `cards` |
| `toggle` | Yes or no | |
| `color` | A colour | |
| `image` | Photos, taken or uploaded | `multiple`, `min`, `max` (up to 30) |
| `file` | Documents, photos, recordings | `multiple`, `min`, `max`, `camera`, `video`, `listen` |
| `items` | Line items with totals | `columns`, `vat`, `currency` |
| `location` | Where they are, or an address they type | |
| `audio` | A voice note of up to 5 minutes, written down before the next step | |
| `signature` | A signature drawn with the finger | |
| `slot` | One appointment time, shown by day | `options` or `optionsFrom`, as ISO 8601 date-times |
| `connection` | Connects one of their accounts | `connection`: the id of a wizard connection |
| `list` | Checks and corrects a stored list | `list`: the id of a wizard list |

## Line items

An `items` field takes positions and computes the totals itself:

```json
{ "id": "positions", "label": "Positions", "kind": "items", "currency": "EUR",
  "vat": { "rate": 20 },
  "columns": [
    { "id": "what", "label": "Service", "kind": "text" },
    { "id": "hours", "label": "Hours", "kind": "number" },
    { "id": "rate", "label": "Rate", "kind": "money" }
  ] }
```

A row’s amount is the product of its `number` and `money` columns. `vat.field` reads the rate
from another field instead. Documents take the table with its totals from `{{positions}}`. See
[Templates](./templates.md).

## Answers from earlier steps

- `prefill` (`"steps.<id>.<key>"`): what the field starts with. An `items` field takes a table
  whose columns are its column ids, and the person corrects the rows.
- `optionsFrom`: the choices of a `select`, `multiselect` or `slot` come from earlier data. It
  names a list output (`steps.<id>.<key>`), a column of a table output
  (`steps.<id>.<key>.<column>`) or a column of a stored list (`lists.<id>.<column>`). `options`
  stand in while that data is empty.
- `cards`: with `optionsFrom` naming a table output, each row is a card. Its keys name the
  table’s columns: `label`, `value` (default: the label), `image`, `subtitle`, `meta` and `link`.

## Fields that show only when they fit

`when` shows a field only while a condition holds. It reads a field of the same page, decided as
the person types, or anything known before the page:

```json
{ "id": "company", "label": "Company", "kind": "text",
  "when": { "field": "customerType", "op": "equals", "value": "Business" } }
```

A hidden field is not asked and not kept. Its template is empty. Conditions are described on
[Branches and loops](./branches.md#conditions).

Where no rule on one field can say it, a decision picks the fields as the run reaches the page:

- `ask` on a field: a statement. The field shows when the decision finds it true of the run,
  for example “The complaint is about a damaged article”.
- `groups` on the page and `group` on fields: of a group’s fields the decision shows one. With
  `optional`, it may show none.

```json
"groups": [{ "id": "reach", "instructions": "How should we reach the person?" }],
"fields": [
  { "id": "phone", "label": "Phone", "kind": "text", "group": "reach" },
  { "id": "mail", "label": "Email", "kind": "email", "group": "reach" }
]
```

A page with decided fields holds up to 12 fields and shows at most 5. A field has `ask` or
`group`, not both.
