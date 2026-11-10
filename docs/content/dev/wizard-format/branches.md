---
title: Branches and loops
description: A step's next rules, the conditions they test, decisions in words, and loops back.
version: 0.18.0
---

Steps run from top to bottom. A step’s `next` sends the run elsewhere:

```json
"next": [
  { "when": { "field": "steps.check.refund", "op": "eq", "value": true }, "goto": "refund" },
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

A [wait](./runs-that-last.md) branches on what ended it, a [person’s step](./runs-that-last.md#a-persons-step) on
`timedOut` or `approved`, and `onFail` [sends a failed step’s run on](./runs-that-last.md#when-a-step-fails).

## Conditions

```json
{ "field": "budget", "op": "gt", "value": 1000 }
```

`field` is a page field’s id, an output of an agent step or a decision as `steps.<id>.<field>`, or
how many rows a stored list has as `lists.<id>.count`.

| `op` | Holds when the value |
|---|---|
| `eq`, `ne` | Is, or is not, `value` |
| `gt`, `gte` | Is greater than a number, or at least that number |
| `lt`, `lte` | Is less than a number, or at most that number |
| `in`, `notIn` | Is one of a list of values, or none of them |
| `contains` | Holds `value`: a multiselect, a list output or a text |
| `exists`, `notExists` | Is filled in, or is empty. These take no `value` |

### Several conditions

A list of conditions holds when every one holds. `{ "any": [ … ] }` holds when one of its parts
holds, and `{ "not": … }` holds when its condition does not:

```json
"when": [
  { "field": "country", "op": "eq", "value": "AT" },
  { "any": [
    { "field": "budget", "op": "gte", "value": 5000 },
    [{ "field": "urgent", "op": "eq", "value": true }, { "not": { "field": "phone", "op": "notExists" } }]
  ] }
]
```

A part of `any` is a condition, a `not`, or a list that holds when all of it holds. Nothing nests
deeper than that. The studio edits a plain list of conditions and shows the others as text.

A decision’s answer has a probability: `steps.<id>.<field>.p`, from 0 to 1. A rule can test it,
for example `{ "field": "steps.check.urgent.p", "op": "gt", "value": 0.8 }`.

The same conditions show or hide fields on a page. See
[Forms and fields](./forms-and-fields.md#fields-that-show-only-when-they-fit).

## A test conditions cannot write

Where conditions can say it, use conditions. For the rest, `when` takes a calculation, on a branch
and on a field:

```json
{ "when": { "calc": "budget > steps.estimate.total * 2" }, "goto": "large" }
```

Names read the same as `field` in a condition: an answer by field id, `steps.<id>.<key>` and
`lists.<id>.count`. The language is in [Calculated values](./views-and-widgets.md#calculated-values).
A test that cannot be worked out, such as one on an empty answer, does not hold. The studio shows
such a test as its text.

## A step only some runs take

Put it right after the step that branches to it. That step’s otherwise rule leads every other run
past it, and the step itself goes on as the next in the list.

## Loops

A rule that goes back to an earlier step is a loop, for example “improve it until the check
passes”. The step that runs again sees what it made last time.

`max` says how often a rule may send the run on in one run, up to 50. Afterwards it is skipped.
Without `max`, a loop is taken at most ten times.
