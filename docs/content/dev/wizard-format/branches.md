---
title: Branches and loops
description: A step's next rules, the conditions they test, decisions in words, and loops back.
version: 0.7.10
---

Steps run from top to bottom. A step’s `next` sends the run elsewhere:

```json
"next": [
  { "when": { "field": "steps.check.refund", "op": "equals", "value": true }, "goto": "refund" },
  { "ask": "The person wants an exchange", "goto": "exchange" },
  { "goto": "done" }
]
```

| Rule | Holds when |
|---|---|
| `{ when, goto }` | The condition holds |
| `{ ask, goto }` | A decision finds the statement true of the run |
| `{ goto }` | No other rule holds: the step’s “otherwise”, one per step |

`goto` is a step id or `end`. The first `when` rule that holds wins. After that, all `ask` rules of
the step are decided together in one cheap call. When none holds, the otherwise rule sends the
run on, and without one the next step in the list follows.

A rule has `when` or `ask`, not both. Use `ask` where a rule on one field cannot say it.

## Conditions

```json
{ "field": "budget", "op": "gt", "value": 1000 }
```

`field` is a page field’s id, an output of an agent step as `steps.<id>.<field>`, or how many rows
a stored list has as `lists.<id>.count`. A list of conditions holds when every one holds.

| `op` | Holds when the value |
|---|---|
| `equals`, `notEquals` | Is, or is not, `value` |
| `in` | Is one of a list of values |
| `empty`, `notEmpty` | Is empty, or is not |
| `gt`, `lt` | Is greater or less than a number |
| `contains` | Holds `value`: a multiselect, a list output or a text |

A decision’s answer has a probability: `steps.<id>.<field>.p`, from 0 to 1. A rule can test it,
for example `{ "field": "steps.check.urgent.p", "op": "gt", "value": 0.8 }`.

The same conditions show or hide fields on a page. See
[Pages and fields](./pages-and-fields.md#fields-that-show-only-when-they-fit).

## A step only some runs take

Put it right after the step that branches to it. That step’s otherwise rule leads every other run
past it, and the step itself goes on as the next in the list.

## Loops

A rule that goes back to an earlier step is a loop, for example “improve it until the check
passes”. The step that runs again sees what it made last time.

`max` says how often a rule may send the run on in one run, up to 50. Afterwards it is skipped.
Without `max`, a loop is taken at most ten times.
