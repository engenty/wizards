# Plan: a code step — a function of the wizard, no model

Status: plan, written on 2026-11-09 against v0.18.0. Built behind the `codeSteps` switch, off by
default.

## Why

A look at Mastra's dynamic workflows: their graphs only compare and copy, and all logic sits in
registered code. The wizard JSON should stay the same: a simple graph, with hard logic (maths,
reshaping, scoring) in a node. `calc` stays one line, conditions stay conditions, and no loops or
new `each` forms come into the format for it.

A fixed step with `call` already runs logic without a model, but only a plugin's tool. A code step
runs a function the wizard brings itself, in its own workspace, like a widget's HTML.

## Shape

An agent step with a `code` key next to `call`:

```json
{
  "id": "score", "type": "agent", "title": "Score the offers",
  "code": {
    "entry": "code/score.ts",
    "input": { "budget": "budget", "offers": "steps.find.offers", "note": "{{name}} in {{city}}" }
  },
  "output": {
    "format": "json",
    "fields": [
      { "id": "best", "kind": "text" },
      { "id": "ranked", "kind": "table", "columns": ["name", "price", "score"] }
    ]
  }
}
```

```ts
// code/score.ts
type Offer = { name: string; price: number; stars: number };

export function run(input: { budget: number; offers: Offer[] }) {
  const ranked = input.offers
    .map((o) => ({ name: o.name, price: o.price, score: o.stars * 20 - o.price / input.budget }))
    .sort((a, b) => b.score - a.score);
  return { best: ranked[0]?.name ?? "", ranked };
}
```

- `entry`: a workspace path, `.ts` or `.js`. The file defines `function run(input)` (`export` in
  front is allowed). What `run` returns is the step's output.
- `input`: key → a path or a template. A path alone (`budget`, `{{budget}}`, `steps.find.offers`,
  `lists.prices`, `brand.name`, `today`) gives the raw value, as a widget's `data` does: a table
  as rows, a number as a number, a stored list as its rows. A string with more than one `{{…}}`
  or with text around it is a template and gives text.
- `output`: format `json`, with `fields` or `schema`, as on any agent step. The result is fitted
  to that shape and checked against it; a result that does not fit fails the step. `next` rules,
  templates, views and reviews read it like any agent step's json.

### `type: "agent"` with `code`, not a type of its own

- It is the same kind of step as `call`: a fixed step with input and json output, no model. The
  format has one way to say "a step that returns json", and `call` already lives there.
- Everything that reads an agent step's json works unchanged: `steps.<id>.<key>`, `output.fields`
  and `output.schema`, `output.surface` with components, reviews that edit json, the flow
  diagram, `transition()`.
- Every place that asks "does this step need a model" already asks `step.call`. Both go through
  one helper, `runsWithoutModel(step)`, so no place forgets one.
- A new type would need its own case in the validator, the runner, the studio, the fit check,
  the marketplace entry, the credit estimate and the requirements, all copying agent's json
  handling.

What does not fit on a code step is refused by the validator: `call`, `each`, `durable`, `tools`,
`connections`, a format other than `json`, an output without `fields` or `schema`,
`surface: true` (that needs a model).

## How it runs

In QuickJS, through `@mastra/quickjs`'s transport, as the `code` tool's programs do
(`apps/runtime/src/tools/code.ts`), but with no tools at all:

- No network, no files, no modules, no tools. `import` fails.
- 10 seconds of wall time, 32 MB of heap. Input at most 1 MB as JSON, output at most 200,000
  characters.
- The same answer every run for the same input: `Math.random` is seeded the same way each run,
  and `Date` without an argument (`new Date()`, `Date.now()`) throws. Today comes in as an input.
- No credits: the estimate counts 0, and no model class is required.
- Allowed in a guest's run: it reaches nothing a guest could misuse. A guest's answers and the
  step's result are checked as for every automatic step.
- It did nothing outside, so a failed try may run again (`acted` stays false).
- `console.log` lines go nowhere on success, and into the error when the step fails.

## Where it shows

- `packages/shared/src/definition.ts`: the `code` key, the checks in `validateWizard` (entry in
  the workspace, its inputs read only what came earlier), `runsWithoutModel`.
- `apps/runtime/src/engine/steps.ts` → `runCodeStep` in `apps/runtime/src/engine/code-step.ts`.
- Requirements, the credit estimate, `fit.ts`, the marketplace entry: through `runsWithoutModel`.
- `apps/runtime/src/engine/runner.ts`: a run with a code step does not start while the switch is
  off, as with a wait step.
- `wizards validate`: comes with `validateWizard`.
- The studio: the step's icon and summary, "Code" as its type, and a body that shows the file, its
  inputs and the output. The code is changed in the chat or the workspace, as a call is.
- The architect and the authoring guide: a `code` section, only while the switch is on, saying
  when to use it (maths, reshaping, scoring, anything `calc` cannot say in one line) instead of
  stretching `calc`.
- Docs: a section in `docs/content/dev/wizard-format/agent-steps.md`.

## `transition()`

No change. The flow sees an agent step: it is not a person's step, so `enter` sends
`{ kind: "run", step }`, the host runs it like any automatic step and sends `stepDone` or
`stepFailed`. A failure with `acted: false` is tried again like any step that did nothing outside.

## Format version

The key is optional and additive: a wizard without it reads as before. No version change.

## Not now

- Editing the code in the studio's inspector (the workspace's file editor and the chat do it).
- A code step per entry (`each`): `run` gets the whole table and loops itself.
- Calling tools from the code. That is the `code` tool of an AI step.
