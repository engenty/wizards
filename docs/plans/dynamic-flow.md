# Plan: dynamic flow, fields and surfaces

Status: releases 1–4 built (rules, conditional fields, choices from data; decide(), decided
branches and fields, loops, `each` on agent steps, score; the surface catalog, surface steps
authored or decided, views agent steps compose of their result). From the review of 2026-10-06.

Built differently from the text below:

- A backward `goto` without `max` is not a validator issue (old wizards would stop publishing):
  it is taken at most ten times (`DEFAULT_LOOP_MAX`).
- `each` on agent steps hands on its table as `steps.<id>.rows`. `each` on document and voice
  steps is not built.
- The studio has no branch editor (branches are edited in the conversation), so there is no
  "decide" row; a field gets an "ask" input next to its condition. Groups are edited in the
  conversation.
- While a branch is decided the runner shows the page it came from as working.
- Releases 3 and 4 are one commit. A surface exports as JSON only; HTML, PNG and PDF need the
  runner's components rendered on the server and are not built.
- Charts take `labelKey` / `valueKey` to read the columns of bound rows. A surface's buttons:
  `regenerate` aims a review's note at the step, `open` opens an asset; `choose` is not built.
- The studio edits a surface step as JSON.

Scope: branches and loops a run decides at run time, fields and choices that depend on what came
before, and views composed from a catalog the way engenty-pro's `show_ui` composes A2UI surfaces.
Every decision goes through one function on the `classifier` class (Part 0): a decision model
where there is a way to one, otherwise the class's language model with structured output. A
local decision model (Clef in Ollama) is one more way to add later; this plan does not wait for it.

## What there is today

| Thing | How | Limit |
|---|---|---|
| Branch | `next: [{ when: { field, op, value }, goto }]` on a step, first match wins, else the next step in the list (`packages/shared/src/definition.ts`, `nextStepId`) | reads one field, five ops, no AND, no number compare |
| Loop | a `goto` to an earlier step re-runs it; a review's "regenerate" re-runs one producing step with a note | no guard: a backward branch that keeps matching never ends; the re-run overwrites the output |
| Fan-out | `each` on an image or video step: one result per entry, at most eight | not for agent, document or voice steps |
| Decision | a `classifier` agent step whose output is only `yesno` / `choice` fields: one structured-output call (`apps/runtime/src/engine/steps.ts`); manage's gateway turns it into a Jev call | the gateway keeps the answer and drops the probabilities |
| Relevance in Wissen | `judgeRelevance` (`apps/runtime/src/services/relevance.ts`) asks Jev through `systemOneAccess()` (`models.ts`: credits, AI Gateway key or TypeSafe key) | without a way to Jev it decides nothing; a second, separate path to a decision |
| Fields | static per page; `options` static; `prefill` brings a value from an earlier step | a page cannot hide a field or take its choices from data |
| Views | page (the field catalog), widget (HTML the architect writes once), review (text, Markdown, JSON table), result | a native view of the run's data needs a widget |

Why the architect copies a page ten times: "page 2 depends on the answer on page 1" has no
primitive, so it becomes ten pages and ten `equals` branches.

## Rules, taken from engenty-pro

1. **Code owns the flow; a model selects.** A model only picks among candidates the definition
   prepared. It never writes a field id, a label, an option or a `goto`. That is what keeps
   `{{templates}}`, the validator, the diagram and replay working (`compose-surface.ts`).
2. **One call per decision**, with every question of that moment in it; speculative questions
   are cheaper than a second round trip (the fast loop, `patterns/fan-out`).
3. **A decision is stored in the run.** Back, revisiting a page and reloading show what was
   decided; nothing is asked twice (the live inbox dashboard stores its kept block ids).
4. **The classifier function does the fallback, not the definition.** Every language model can
   answer a decision, only slower and dearer than a decision model, so the `classifier` class
   always answers where a run can start at all. A wizard therefore carries no "no model"
   defaults: no `fallback` marks on fields or candidates. A data source that comes back empty is
   a different case: `optionsFrom` falls back to the static `options`.
5. **Additive only.** Every addition is an optional property, so the definition version stays 1
   (see `definition-versions.md`). Ids stay declared up front, so the validator still checks
   every reference statically.
6. **One renderer.** The runner (`apps/web/src/runner`) is shared by the public runner, the MCP
   App and the mobile app's WebView; conditions are resolved on the server wherever the client
   does not need them live.

## Part 0 — one function that decides

`decide({ state, questions, call, signal })` in `apps/runtime/src/engine/decide.ts`. Questions are
System One's three shapes: `noul` (yes/no), `choice` (one of named options, each with a
description), `score` (ordered levels). Every caller in this plan uses it, and so do the decision
step and `judgeRelevance`.

| Way, in this order | When | Answer |
|---|---|---|
| Decision model | `systemOneAccess()` finds a way: the credits (the gateway's evaluation model), an AI Gateway key, a TypeSafe key; later a local one (Clef in Ollama) | probabilities per option, P(yes), confidence |
| The class's language model | no way to a decision model, or it failed or left a question open | the questions as a structured-output schema (noul → boolean, choice and score → enum), what decision steps send today; same answer shape, P = 1 or 0, no confidence |
| Error | both failed | the step fails like any other step and can be retried |

- The answer says which way answered (`source: "systemone" | "llm"`). Gates that need
  probabilities (the margin in 1b) apply only to `systemone`; an `llm` answer stands as given.
- The question mapping lives in `packages/shared/src/decision.ts`: question types, schema for the
  language-model way, reading its object back, validating a choice against the offered ids
  (engenty-pro's `validateChoiceAnswer`). manage's `gateway/decide.ts` maps the other way and
  can use the same types.
- Requirements and estimate: whatever calls `decide()` needs the `classifier` class in
  `stepClasses` (`requirements.ts`) and one decision in the estimate (`estimate.ts`), as a
  decision step does today. A runtime with any text model can serve it, so no run is refused
  for want of a decision model.
- `judgeRelevance` keeps its four-second budget: a person waits for the search. It passes a
  deadline, and a language model that does not answer in time leaves the order the index gave,
  as today.

## Part 1 — flow control

### 1a. Richer rules (deterministic)

- `op` gains `gt`, `lt` (number fields, number outputs) and `contains` (multiselect, list
  outputs, text).
- `when` may be a list: every condition must hold. Several rules stay OR, as today.
- A rule may read `steps.<id>.<field>` of any earlier agent step, as today, and
  `lists.<id>.count`.

### 1b. Decided branches

```json
"next": [
  { "when": { "field": "amount", "op": "gt", "value": 500 }, "goto": "approval" },
  { "ask": "The person wants a refund, not an exchange.", "goto": "refund" },
  { "ask": "The person wants to exchange the article.", "goto": "exchange" }
]
```

- `when` rules are evaluated first, in order. If none matches and `ask` rules exist, one
  `decide()` call answers a `choice` whose criteria are the `ask` texts plus `none` ("none of
  these; go on"), its state the person's answers and the outputs so far (what a decision step
  already gets as its prompt, bounded to the gateway's 60k tokens).
- `none` is an answer, not a fallback: it means the next step in the list.
- The answer is kept in `state.decisions[stepId]` (rule index, source, and the probabilities
  when a decision model answered). With probabilities the branch is taken only when the winner
  leads the runner-up by a margin (0.1, the fast loop's gate), else `none`; a language model's
  answer stands.
- Requirements: a step behind an `ask` rule only warns when its class is missing, as a step
  behind a `when` rule does today; the locked choices of v0.2.16 have no equivalent, since the
  person picks nothing.
- Diagram: a dashed edge labelled with the `ask` text. Inspector: the branch editor gets a
  "decide" row next to "when".
- Cost: one classifier call per branch point, booked under `classifier` like a decision step.

### 1c. Loops

Two shapes, both on the flat step list. Step groups (several steps per entry) would change the
diagram, the validator and the state model; they are not in this plan.

- **Repeat until** — a backward `goto` takes `max`: how often this rule may fire in one run,
  counted in `state.loops["<step>→<goto>"]`; afterwards the rule is skipped. The validator
  reports a backward `goto` without `max`. The re-run step gets its earlier result the way a
  regenerate does (`revisionBlock`), so "improve until the check passes" works: a check step
  (a decision) branches back with `max: 3`.
- **For each** — `each` extends to agent steps and to document and voice generation: one result
  per entry (eight for media as today, twenty for agent steps), the prompt reads `{{item.*}}`,
  `{{index}}`, `{{count}}`. The output of an agent step with `each` is a table: the entry's
  columns plus the step's output fields; its text is the results joined with headings. "For
  each supplier the research step found, read its site" becomes one step.

### 1d. Decision steps

- Gain `score` output fields (ordered levels, "how urgent: low / medium / high") so a branch
  can read a rubric.
- Answered through `decide()`, so they get probabilities wherever a decision model answers.
  `steps.<id>.<field>.p` lets a rule read them (`gt 0.8`); an answer of the language model
  gives 1 or 0.

## Part 2 — dynamic fields and choices

### 2a. Conditional fields: `when` on a field

```json
{ "id": "street", "label": "Street", "kind": "text", "when": { "field": "delivery", "op": "equals", "value": "ship" } }
```

- Same rule shape as a branch. A condition may read a field of the same page (evaluated live
  in the runner as the person types) or anything earlier (resolved on the server, delivered in
  the RunView).
- A hidden field is not required, is cleared on submit (`readPageInput`), and its template
  is empty.
- Validator: `when` reads a field asked on this page or before, or an output of an earlier step.
- Studio: a "shown when" row per field in the Inspector.
- Authoring guide: "A page whose fields depend on an earlier answer uses `when` on the fields,
  never one copy of the page per answer."

This alone removes the ten-copies pattern.

### 2b. Choices from data: `optionsFrom`

```json
{ "id": "supplier", "label": "Supplier", "kind": "select", "optionsFrom": "steps.research.suppliers.name" }
```

- Names a `list` output, a column of a `table` output, or `lists.<id>.<column>`.
- Resolved on the server when the page is shown (next to `prefillOf` in the runner's view) and
  again on submit, delivered as `options` in the RunView. Built without `state.pages`: outputs
  do not change while the page waits; a stored list someone else edits in between is the one
  case where the two can differ.
- Static `options` stay the fallback when the source is empty.

### 2c. Decided fields

```json
{
  "type": "page", "id": "details",
  "groups": [{ "id": "contact", "instructions": "How should we reach the person?", "optional": true }],
  "fields": [
    { "id": "phone", "kind": "text", "label": "Phone", "group": "contact" },
    { "id": "mail",  "kind": "email", "label": "E-mail", "group": "contact" },
    { "id": "photo", "kind": "image", "label": "A photo of the damage", "ask": "The complaint is about a damaged article." }
  ]
}
```

- The `composeSurface` pattern with fields as candidates: `ask` is a yes/no per field, a
  `group` is one choice per group (`optional` adds "none"). One `decide()` call when the run
  reaches the page, before `waiting_input`; the kept ids go to `state.pages[stepId].shown` and
  are not asked again on back.
- A field with `when` and `ask`: `when` first; a hidden field is not asked about.
- A field with neither is always shown.
- Validator: a page keeps its limit of five shown fields; candidates up to twelve; every group
  has at least one member.

### 2d. Generated fields — later

A page with `generate: { instructions, kinds, max }` and a declared `collect: [{ id, kind }]`
so later steps have known ids. Costs a `standard` call per run, cannot be checked statically,
and the architect already covers most of it at build time. Not before 2a–2c are in use.

## Part 3 — surfaces: views from a catalog

A **surface** is a view composed from a small catalog of native components, bound to the run's
data, rendered by the runner without an iframe: themed, mobile, and free per run. It sits
between the JSON table a review shows today and a widget.

### 3a. The catalog

`packages/shared/src/surface.ts`, modelled on engenty-pro's `engenty:core/v1`:

| Component | Props |
|---|---|
| `Text` | `text`, `variant: h3 \| h4 \| body \| muted` |
| `List` / `Row` | `title`, `subtitle?`, `meta?`, `badge?`, `image?`; a `Row` may repeat over a table (`children: { path }`) |
| `DetailGrid` | `rows: [{ label, value }]` |
| `Badge` | `label`, `tone` |
| `Grid` / `Metric` | `columns`, `label`, `value`, `caption?` |
| `Table` | `columns`, `rows` |
| `Image` | an asset of the run |
| `BarChart` / `LineChart` / `DonutChart` | `title?`, `points` or `slices` |
| `Actions` / `Button` | `label`, `action: regenerate \| open \| choose` |

- Bindable props take `{ "path": "/steps/research/suppliers" }` into a data model built from
  the run (answers, outputs, lists; JSON pointers), so the same surface shows new data every run.
- `validateSurface` in shared: unknown component, missing root, dangling child, duplicate id,
  path that nothing in the definition provides. The validator runs it for authored surfaces;
  the runtime runs it on generated ones.
- Rendering: `apps/web/src/runner/surface.tsx` on the runner's own ui kit. Charts need a small
  library or hand-drawn SVG; the web app has none today. Widgets stay for anything beyond the
  catalog.

### 3b. Three ways a surface comes about, cheapest first

1. **Authored** — a `surface` step: `{ type: "surface", components, data: { key: ref } }`,
   written by the architect at build time like a widget, but JSON instead of HTML. Covers facts
   grids, result lists, KPIs, one chart. No model, no credits per run.
2. **Decided** — the step lists candidates (`candidates: [{ id, components, description,
   group?, required? }]`) and one `decide()` call keeps some: no chart when there is nothing to
   chart. The port of `composeSurface`, without its `fallback` marks.
3. **Generated** — an agent step with `output.surface: true` gets the catalog's prompt guide and
   emits components bound to its own output fields; validated before it is stored
   (`output.surface`), one retry with the issues, otherwise the plain output shows. This is the
   `show_ui` case: the model shapes the view, the catalog bounds it.

### 3c. Where surfaces appear

- A review `show` and a result deliverable render a step's surface instead of its JSON table.
- Actions: `regenerate` (in a review, with a note), `open` (a deliverable or asset), `choose`
  (writes a value into the answers, for a surface on a page). First release: `regenerate` and
  `open`.
- Export: JSON always; HTML, PNG and PDF through the widget render pipeline once the surface
  components can be rendered to static HTML on the server. Second release.

## Order

| Release | Builds | Needs a model |
|---|---|---|
| 1 | 1a rules, 2a `when` on fields, 2b `optionsFrom`; validator, Inspector, diagram labels, authoring guide | no |
| 2 | Part 0 `decide()`, decision steps and `judgeRelevance` moved onto it; 1b `ask` branches, 1c loop `max` and `each` on agent steps, 1d `score` and `.p`, 2c decided fields; `state.decisions`, `state.pages`, `state.loops` | the classifier class |
| 3 | 3a catalog and renderer, 3b authored `surface` step, reviews and results show it | no |
| 4 | 3b generated and decided surfaces, 3c actions and export | agent steps as they are |
| later | a local decision model (Clef in Ollama) as one more way in `decide()` | a later plan |

## Changes by file

| File | Change |
|---|---|
| `packages/shared/src/definition.ts` | rule ops and list form; `ask`, `max` on rules; `when`, `optionsFrom`, `ask`, `group` on fields; `groups` on pages; `each` on agent steps; `score` output kind; `surfaceStepSchema`; validator cases |
| `packages/shared/src/decision.ts` | question and answer types, the language-model schema and reading it back, choice validation |
| `apps/runtime/src/engine/decide.ts` | `decide()`: decision model through `systemOneAccess()`, else the class's language model; deadline; booking under `classifier` |
| `apps/runtime/src/services/relevance.ts` | calls `decide()` with its deadline |
| `apps/runtime/src/engine/requirements.ts`, `credits/estimate.ts` | `classifier` for `ask` rules, decided fields and decided surfaces |
| `packages/shared/src/surface.ts` | catalog, schema, `validateSurface`, prompt guide |
| `packages/shared/src/run.ts` | `decisions`, `pages`, `loops` in `RunState`; `options`, `fields` in `RunView`; `surface` in `StepOutput` |
| `apps/runtime/src/engine/runner.ts` | resolve `when`, `optionsFrom` and decided fields before `waiting_input`; loop counters; decided branches in `nextStepId`'s place |
| `apps/runtime/src/engine/steps.ts` | decision steps through `decide()`; `each` for agent steps; surface emission and validation |
| `apps/runtime/src/authoring/guide.ts`, `example.ts` | the new properties and the rule against page copies |
| `apps/web/src/runner/RunnerView.tsx`, `fields.tsx` | live `when` for same-page conditions, resolved options |
| `apps/web/src/runner/surface.tsx`, `outputs.tsx` | render surfaces in reviews and results |
| `apps/web/src/studio/editor/Inspector.tsx`, `FlowDiagram.tsx` | "shown when", "decide" rows; dashed decided edges; loop edges with their `max` |
| `docs/content/user-guide/steps.md` | branches, loops, conditional fields, surfaces |
| `engenty-wizards-manage` `gateway/decide.ts` | `score` questions; the `/v4/ai/systemone` route answers with probabilities as given |

## Open questions

- AND in `when`: decided for release 1 — `when` is one condition or a list that must all hold.
- Decided fields and the five-field limit: five shown, or five candidates.
- Charts in the runner: a small library (adds to the bundle every runner loads) or SVG for bar,
  line and donut only.
- Surface export needs the runner's components rendered to static HTML on the server; the
  alternative is a second, HTML-only renderer, which drifts.
- In the cloud the gateway already answers a decision the evaluation model leaves open with the
  `standard` class; `decide()` adds the same fallback in the runtime. Whether the gateway's
  `/v4/ai/systemone` should fall back itself, or answer "open" and leave it to the runtime.
- Whether a decided branch should show the person what was decided ("We assume you want a
  refund") with a way to change it, or decide silently.
