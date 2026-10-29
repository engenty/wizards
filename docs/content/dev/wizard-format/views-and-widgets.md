---
title: Views and widgets
description: Surfaces built from the catalog, a view of an agent step's result, nested output, and HTML widgets.
version: 0.12.0
---

A result can show as a view instead of a plain table. There are three ways:

| Way | What it is | Costs per run |
|---|---|---|
| A `surface` step | A view built from the surface catalog, written once | Nothing |
| `output.surface` on an agent step | The same, bound to that step’s own result | Nothing |
| A `widget` step | An HTML app in the wizard’s workspace, written once | Nothing |

Choose a surface for facts, a list of results, key figures or a chart. Choose a widget for what
the catalog cannot show, such as a map or an animation.

## Surfaces

A surface is a flat array of components. The one with id `root` is drawn, and containers list
their children by id. A prop is a value, or `{ "path": "/key/…" }` into the data.

```json
{
  "id": "show", "type": "surface", "title": "Your offers",
  "data": { "offers": "steps.research.offers" },
  "components": [
    { "id": "root", "component": "Column", "children": ["head", "list"] },
    { "id": "head", "component": "Text", "text": "Three offers for you", "variant": "lead" },
    { "id": "list", "component": "List", "children": { "path": "/offers", "componentId": "row" } },
    { "id": "row", "component": "Row", "title": { "path": "name" }, "meta": { "path": "price" } }
  ]
}
```

`data` maps keys to what the surface reads: a field id, `steps.<id>`, `steps.<id>.<key>`,
`lists.<id>`, `brand.name` or `today`.

| Components | For |
|---|---|
| `Column`, `Grid`, `Tabs`, `Fold`, `Group` | Layout: stacks, tiles, two to four views, details on a tap, entries under a heading per value |
| `Text`, `Callout`, `Badge`, `DetailGrid`, `Metric` | Words, a tip or warning, a label, facts, a key figure |
| `Card`, `List`, `Row`, `Link` | Things: one card per thing, rows, an entry that opens in a sheet |
| `Chips`, `Checklist`, `Steps` | Short things, things to get or do, ordered work |
| `Table`, `BarChart`, `LineChart`, `DonutChart` | Figures compared across columns, charts |
| `Markdown`, `Sources` | Formatted text, and where it was found as small chips |
| `Image`, `Gallery`, `Video`, `Audio`, `File` | A picture, pictures side by side, a clip, a recording, a file with its name (a PDF or picture shows itself) |
| `Actions`, `Button` | Buttons that make the result again or open a file |

A view in a [Work chat](#views-in-a-work-chat) has three more components and one more button.

`candidates` replaces `components` when the view should change per run. Each candidate is a piece
with a `description`, and a decision picks the pieces that fit: no chart when there is nothing to
chart. `group` and `groups` work as on [pages](./pages-and-fields.md#fields-that-show-only-when-they-fit),
and `required` pieces always show.

The MCP tool `get_authoring_guide` lists every component with its props.

### Views in a Work chat

In a Work chat, the space’s AI shows a view with its tool `show_view`. It uses the same catalog,
and the data is what the AI found. Everyone in the chat sees the view. A chat’s view can also ask
the team, which a wizard’s view never does, because a wizard asks on its pages:

| Component | For |
|---|---|
| `Form` with `Field`s | Questions to the team. A Field is one of the wizard’s field kinds that needs no run: text, number, choices, a date, a picture or the camera, a file, the place, a recording, a signature. Whoever is in the chat sends it, and the answers become their message. |
| `Ref` | A thing of the space that opens in the studio: a page, table or file of Knowledge, a chat, a wizard |
| `Button` with `"action": "ask"` | The person who taps it asks the AI the button’s `prompt`, or its label |

A chat’s view shows the space’s own files only, never a picture from an address on the web.
`show_view` checks a view before the chat draws it. When the check fails, the AI gets the
problems back and tries again.

## A view of an agent step’s result

An agent step with `output.format` `json` can carry its own view in `output.surface`, bound to
its keys by path. Reviews and the result show it in place of a table. `output.surface: true` has
a model compose a view on every run instead, which costs a model call.

For nested data, `output.schema` replaces `output.fields`. Its root is an object:

```json
"schema": { "kind": "object", "label": "Menu plan", "fields": {
  "days": { "kind": "list", "label": "Days", "of": { "kind": "object", "label": "Day", "fields": {
    "label": { "kind": "text", "label": "Day" },
    "recipe": { "kind": "ref", "label": "Recipe", "to": "recipes" } } } },
  "recipes": { "kind": "list", "label": "Recipes", "of": { "kind": "object", "label": "Recipe", "fields": {
    "id": { "kind": "text", "label": "ID" },
    "minutes": { "kind": "number", "label": "Time", "unit": "min" } } } } } }
```

Kinds are `text` (with `long` for paragraphs), `number` (with `unit`), `yesno` (with `yes` and
`no`, the words people read), `choice`, `ref` (the id of an entry of a top-level list) and `list`.
Objects nest at most four deep, with a hundred keys in all. Labels are in the wizard’s language.
The view is checked against the schema.

## Widgets

A `widget` step shows an HTML page from the wizard’s workspace. It is written once, and every run
only brings new data.

```json
{
  "id": "map", "type": "widget", "title": "The route",
  "entry": "route/index.html", "sample": "route/sample.json",
  "data": { "stops": "steps.plan.stops" },
  "size": { "width": 1280, "height": 720 }
}
```

| Key | What it does |
|---|---|
| `entry` | The workspace path of the HTML |
| `data` | What the page gets as `wizard.data`: key → a field id, `steps.<id>`, `steps.<id>.<key>`, `brand.name` or `today` |
| `sample` | Example data in the same shape, for previews before any run |
| `layout` | `fixed` (the default): drawn at `size` and scaled to the page. `page`: part of the page, as tall as its content |
| `size` | The design size, 200 to 3840 px. The default is 1280 × 720. PNG, PDF and MP4 render at it |
| `video` | The result is a video: the timeline is rendered to an MP4 with sound |

The page loads nothing from the network when it runs. Libraries and reference data are files in
the workspace. It talks to the runner through `window.wizard`: `data`, `brand`, `ready()`,
`timeline()`, `state` and `save()`, among others.
