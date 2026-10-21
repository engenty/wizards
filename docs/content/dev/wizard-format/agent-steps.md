---
title: Agent steps
description: An AI step's instructions, tools, output, model class, decisions, and one run per entry.
version: 0.9.7
---

An `agent` step is an AI step. It reads its `instructions`, may call tools, and returns its
output.

```json
{
  "id": "research", "type": "agent", "title": "Look it up",
  "working": "Searching the web…",
  "instructions": "Find three current facts about {{topic}}, each with its source.",
  "tools": ["web_search", "web_fetch"],
  "output": { "format": "markdown" },
  "model": "standard"
}
```

`working` is the line the person sees while the step runs. `instructions` is a template. See
[Templates](./templates.md).

## Tools

| Key | What the step may use |
|---|---|
| `tools` | Built-in tools: `web_search`, `web_fetch`, `browser`, `sandbox`, `image`, `http`, `pages`, `code`. A plugin’s tool by its full id, `<plugin>.<tool>` |
| `mcp` | Ids of the space’s connected systems (MCP servers) |
| `connections` | Ids of the wizard’s connections. See [Lists and connections](./lists-and-connections.md) |

A wizard that names a plugin’s tool runs only where that plugin is installed. See
[Tools](../plugins/tools.md).

Every agent step also has a few tools without listing them: it reads and writes the wizard’s
lists, reads uploads and documents, and searches the space’s Knowledge.

## Output

`output.format` is `text`, `markdown` (the default) or `json`. A `json` step says what it returns
with `fields`, one level of keys:

```json
"output": {
  "format": "json",
  "fields": [
    { "id": "summary", "kind": "text", "description": "Two sentences" },
    { "id": "offers", "kind": "table", "columns": ["name", "price", "url"] },
    { "id": "urgent", "kind": "yesno", "description": "Is the request urgent?" }
  ]
}
```

| Kind | What it holds |
|---|---|
| `text`, `number` | A text, a number |
| `list` | A list of texts |
| `table` | Rows. `columns` fixes the keys every row has |
| `yesno` | `true` or `false`: the answer to the question in `description` |
| `choice` | One of `options` |
| `score` | One level of `options`, lowest first, at most ten |

For nested data, such as days that hold meals, use `schema` instead of `fields`. A step has one of
the two. `surface` gives the result a view of its own. Both are described on
[Views and widgets](./views-and-widgets.md#a-view-of-an-agent-steps-result).

Later steps read a `json` step’s keys as `steps.<id>.<key>`.

## Model class and effort

A step names the model class it needs in `model`, never a model. Which model serves a class is
set outside the wizard.

| `model` | For |
|---|---|
| `classifier` | Routing, yes or no, picking from options, a few values from a text |
| `low` | Short copy, calling an API, reformatting |
| `standard` | Research with tools, long documents, reasoning over many sources. The default |
| `high` | Hard reasoning or writing code. Several times the cost of `standard` |

`effort` (`low`, `medium`, `high`) is not a model class. It tells the step’s model how hard to
work, where the bound model can be told. `"model": "high"` picks the strongest model;
`"effort": "high"` lets any model take longer. Leave `effort` out unless a step is clearly simple
or clearly hard.

Version 1 of the format named these classes one step lower: its `standard`, `high` and `highest`
are `low`, `standard` and `high` now. A file without `version`, or with `"version": 1`, is read
that way and saved as version 2.

## Decisions

A `classifier` step with no tools whose `json` output holds only `yesno`, `choice` and `score`
fields is a decision. It is answered in one fast, cheap call. A branch reads its answer, and
`steps.<id>.<field>.p` is how sure it is, from 0 to 1. See [Branches and loops](./branches.md).

## A plugin tool without a model

`call` runs one tool of a plugin once, with these inputs and no model. Its answer is the step’s
`json` output, as it is. `instructions` stay empty.

```json
{
  "id": "free", "type": "agent", "title": "Free times",
  "call": { "tool": "appointments.availability", "input": { "duration_minutes": 30, "days": 14 } },
  "output": { "format": "json", "fields": [{ "id": "slots", "kind": "table", "columns": ["start", "end", "label"] }] }
}
```

Use it for data a later page shows unchanged. String inputs are templates.

## One run per entry

`each` runs the step once per entry, at most twenty times. It names a table or list output
(`steps.<id>.<key>`) or a stored list (`lists.<id>`). The instructions read the entry as
`{{item.<column>}}`, and `{{index}}` and `{{count}}` say where the run is.

The output is one table, `steps.<id>.rows`: the entry’s columns plus the step’s output fields,
one row per entry.
