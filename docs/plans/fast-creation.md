# Plan: fast creation and pages without waiting

Status: Part 1 is built on `claude/durable-runs-combined` (`a719337c` to `fe9b26d3`, on GitHub, no
PR) and is not on `main`. Parts 2 to 5 are a plan. From the review of ChatGPT's Intelligent UI on
2026-10-29, checked against `feat/work-mode` (v0.13.0, Work mode, spaces, model tiers) on
2026-10-30. Part 4, the order and the fit with durable runs corrected on 2026-11-06, against `main`
and that branch at 6bac6ed0, by reading the code. Part 1 brought in line with what was built the
same day, against `fe9b26d3`. Page to page is measured once, on a laptop (Order, step 1). An
architect turn is not measured yet.

Scope: a new wizard shows its first page about two seconds after the wish, and a run moves from
page to page without waiting on the server. The definition stays JSON and stays at version 2:
every format change below is additive. Five parts: the format (Part 1), a text form the model
writes (Part 2), a fast first pass that writes it (Part 3), state in the browser and on the
server (Part 4), and an export for ChatGPT (Part 5).

The server stays the record of every run. The browser may run ahead of it for a moment, and it
always catches up.

Sources: a ChatGPT conversation that built a stepped project configurator and explained it
(shared 2026-10-29), and Thesys' reverse engineering
[How ChatGPT's Intelligent UI works](https://www.openui.com/blog/how-chatgpt-intelligent-ui-works)
(2026-10-08). Neither is an OpenAI specification.

## Why

ChatGPT makes a stepped interface from one prompt and shows its first part after about a
second and a half. The studio takes about twenty seconds before it shows anything. Once the
interface is there, ChatGPT moves between its pages, sliders and choices with no model call and
no server call. A run here waits on the server after every page.

ChatGPT is not faster at writing: one captured answer streamed for 18.7 seconds. It shows the
first part early and builds the rest in front of the person. The goal here is the same: the
first page early, the whole flow while the person already reads.

### Where the twenty seconds go

| Cost | Where |
|---|---|
| The High class with reasoning unless the person turned extra effort off (`extra === false` → Standard): it thinks before it writes | `runArchitect` in `apps/runtime/src/agents/architect.ts`, through `chatModel` and the space's model tier |
| A system prompt of about 60 KB (about 15k tokens): the whole authoring guide, the surface catalog, an example wizard | `systemPrompt()` in `agents/architect.ts`, `apps/runtime/src/prompts/authoring.md` (56 KB) |
| An agent loop of up to 45 steps: write, read the validator's issues, write again; widget, download and `check_widget` rounds | `MAX_STEPS` in `agents/architect.ts`, `how_you_work` in `apps/runtime/src/prompts/architect.md` |
| Nothing on screen before `replace_wizard` is complete: the editor refetches on `change` | `apps/runtime/src/routes/wizard-stream.ts` |
| On a computer with an AI client: the CLI starts per turn, then `get_authoring_guide`, `get_wizard`, then the write | `subscriptionTurn` in `apps/runtime/src/agents/subscription.ts`, called from `apps/runtime/src/services/architect.ts` |

The definition itself is small: 3 to 10 KB in `examples/wizards`, about 1k to 3k tokens.

### What ChatGPT does

| Layer | ChatGPT | Here today |
|---|---|---|
| What the model writes | DIL: Markdown, JSX-like tags from a catalog, JavaScript in `{@body …}` and `{…}`, `{#if}` and `{#each}` blocks | JSON through a tool call |
| Server | Recompiles everything written so far every ~290 ms from the first token; cuts at the last complete construct, closes open elements, drops invalid properties | Validates the finished definition |
| Browser | A sandboxed worker runs the compiled program, keeps state in keyed slots, sends UI operations | The runner draws what the server sends |
| Catalog | About 70 native components, design tokens, composites written by OpenAI | 33 surface components (`packages/shared/src/surface.ts`, after engenty-pro's `engenty:core/v1`), 19 field kinds; pages have their own fields, views the catalog; a Work chat's view (`show_view`) also has `Form`, `Field` and `Ref` |
| State | `useState` per answer; lost on reload | On the run: `values`, `outputs`, `view`; kept |
| Events | Local (no call), `GenUI.issueNewTurn` (a new message built from state), `copy`, `openUrl` | Every page goes to the server; buttons `regenerate`, `open`, and `ask` in a chat's view |
| Tool data | Bound by reference (`{turn…product0.price}`) or resolved by the server (`AsyncImage query`); the model never retypes it | Bound by `{ path }` ("Never invent numbers") |
| Escape hatch | AppBlock: HTML in an iframe with theme variables | Widgets |

Its rough edges, from the same analysis, are where we already stand better: state resets on
reload, the model never sees the interface's state, a follow-up regenerates the whole interface,
a wrong expression silently shows wrong numbers, and the compiler's diagnostics do not reach the
model.

## Rules

- **The stored definition stays JSON**, `DEFINITION_VERSION` stays 2. Everything new is
  optional; an existing wizard parses and draws as before. The JSON Schema
  (`apps/docs/public/schema/v2/wizard.json`) is regenerated.
- **The catalog stays data.** Only catalog components draw. Calculations are a closed
  expression language our own parser evaluates, never `eval`, never a sandbox. This is the one
  thing we deliberately do not copy.
- **Ids never change while a definition streams in.** Answers are kept by field id, so what the
  person typed survives every recompile, as ChatGPT keeps state by key.
- **Wizards are durable: the server is the source of truth.** Everything the person does is on
  the server within a second or two: answers, answers still being typed, view state. The browser
  may run ahead and sync after; it holds a faster copy, never the only one. A run opened on another device, after a reload or days later shows the same page
  with the same answers. The server stays in charge of the run and checks every answer again;
  when it disagrees, its state wins. Nothing that needs the server (an AI step, a decision, the
  result) starts from answers the server has not saved.
- **Issues reach the model.** What the parser repairs or drops goes to the architect, unlike
  ChatGPT's diagnostics.
- **The model selects, never writes, at run time**, as in `dynamic-flow.md`: decisions pick
  among prepared candidates. Unchanged.

## Part 1 — the format

Built on 2026-11-06 on `claude/durable-runs-combined`, ahead of the order below, because Matthias
asked for it there. The sections below say what was built. The files are in "Changes by file".

| Part | Commits |
|---|---|
| 1a fields | `a719337c`, `bfb305fd` (the round buttons of `look: "list"`) |
| 1b sections | `497c64bd` |
| 1c `calc` | `145a5399` |
| 1d page components, with `Field` on a page | `f7f13ab6`, `fe9b26d3` (a page that reads a stored list needs one) |
| 1e `Choice`, `Toggle`, `Slider` | `b51fc215` |

Tested, as the session that built it reported; not run again for this note:

- Runtime suite at `fe9b26d3`, switches on: 1831 pass, 2 fail (`knowledge`, `plugin-hooks`, which
  also fail on clean `main`). Switches off at `bfb305fd`: 1830 pass, the same 2 fail.
- Web at `bfb305fd`: 43 pass, 1 skipped.
- In the browser, on a test wizard in the studio's preview: the section bar, unit, list, stepper,
  slider, live `calc` on a page, `Choice` and `detail` in a view. A `Choice` survives opening the
  run fresh.
- Not tried in a browser: phone width, a translated run, page `data` reading a real AI step, a run
  with `calc` on a branch (unit tests only).

Not built:

- Text written into a page's `components` is not translated. Surface steps have the same gap today.
- Only the run page draws `components`. Chat, calls and AI clients ask the fields in order.
- The studio has no controls for `look`, `section`, `components` or view inputs. They go through
  the chat or JSON.
- The mobile app's copies of the definition were not looked at.

### 1a. Fields: numbers with a range, and how a field looks

`min` and `max` exist today for file counts only. They now also bound a number field.
The file limits (whole numbers, 1 to 30) move from the schema into `validateWizard`, so every
old definition stays valid.

```diff
   /** image / file: several files; the value is then a list, in the order the person put them. */
   multiple: z.boolean().optional(),
-  /** image / file with `multiple`: how many files at least and at most (up to 30). */
-  min: z.number().int().min(1).max(MAX_FILES).optional(),
-  max: z.number().int().min(1).max(MAX_FILES).optional(),
+  /**
+   * image / file with `multiple`: how many files at least and at most (whole numbers, 1 to 30).
+   * number: the lowest and the highest value the person may give.
+   */
+  min: z.number().optional(),
+  max: z.number().optional(),
+  /** number: the value moves in steps of this size (500: 2000, 2500, 3000 …). */
+  increment: z.number().positive().optional(),
+  /** number: the sign or word after the value ("€", "Personen", "m²"). */
+  unit: z.string().max(16).optional(),
+  /**
+   * How the field is drawn, where its kind has more than one way; without it the runner picks
+   * as today. number: "slider" (needs min and max; the value stands large above it) or
+   * "stepper" (minus and plus). select: "list" (one row with a round button per choice, for
+   * choices that need a line of text).
+   */
+  look: z.enum(["slider", "stepper", "list"]).optional(),
```

Today a select with up to five short choices draws as a segmented control and a longer one as a
dropdown (`packages/runner/src/fields.tsx`); that stays the default. ChatGPT's "Wie groß ist dein
Shop?" is `look: "list"`.

`increment` and not `step`: a step is a node of the wizard.

Validator, new issues:
- `look: "slider"` without `min` and `max`.
- `look` on a kind it does not fit ("slider" on a text field).
- `min` greater than `max`; `increment` larger than `max - min`.
- `min` / `max` on an image or file field that are not whole numbers from 1 to 30 (moved from
  the schema).
- `unit` or `increment` on a field that is not a number.

The server refuses a number outside `min` and `max` (`engine/input.ts`, with the new texts
`numberAtLeast` and `numberAtMost`). It does not check `increment`, which only sets how the field
moves (see Open questions).

A slider with no answer and no `default` shows "–" and holds nothing, so what is drawn is never an
answer nobody gave. The looks are in a new `packages/runner/src/field-looks.tsx`. `unit` is
translated, cut to its 16 characters so a long word does not cost the wizard its translation.

### 1b. Sections: a progress bar that stays put

```diff
 const stepBase = {
   id,
   title: z.string().min(1),
   description: z.string().optional(),
+  /**
+   * The part of the wizard the step belongs to, as the progress bar names it ("Budget"). A step
+   * without one belongs to the part before it. Steps on different branches share a name, so
+   * the bar stays the same whichever way the run goes.
+   */
+  section: z.string().min(1).max(24).optional(),
   next: z.array(nextRuleSchema).optional(),
 };
```

The progress bar shows each section once, in the order of the steps, the current one marked.
A wizard without sections shows progress as today (`view.progress` in
`packages/runner/src/RunnerView.tsx`). Validator: a section name that comes back after another
one ("A", "B", "A") is an issue, since the bar could not show it in order.

The server sends the bar as `view.progress.sections`: `{ names, current }`, with `current` -1 before
the first. `section` is translated, cut to its 24 characters.

### 1c. Calculated values: `calc`

A new file `packages/shared/src/calc.ts`, read by the runner, the runtime and the validator:

```ts
/** A value worked out from what the place knows: `demo / budget`, `servings * 100`. */
export const calcSchema = z.object({ calc: z.string().min(1).max(200) });

export type CalcScope = (name: string) => unknown;

export function parseCalc(source: string): CalcNode | { error: string };
export function evalCalc(node: CalcNode, scope: CalcScope): unknown; // undefined when it can't
export function calcNames(node: CalcNode): string[]; // for the validator
export function calcScope(...records: unknown[]): CalcScope; // the first record that has the name
```

A scope is a function, not a `{ data, row }`. `calcScope(row, data)` reads the row first, then the
data, own properties only.

The language, and nothing more:

| | |
|---|---|
| Values | numbers, `"text"`, `true`, `false` |
| Names | a field id, a key of the place's `data`, a view state name (1e), a column of the row inside a repeat; `steps.<id>.<key>` and `lists.<id>.count` as in conditions |
| Operators | `+ - * / %`, `== != < <= > >=`, `and or not`, `( )` |
| Functions | `round(x, digits)`, `min(…)`, `max(…)`, `sum(list, column)`, `count(list)`, `if(test, a, b)` |

No assignment, no other calls, no property access but dotted names. `+` adds numbers and does not
join text; `format` does that. A value that cannot be worked out (an empty answer, a division by
zero) is empty and draws as "–". The validator checks that every name exists at that place, as it
checks condition fields today.

**Where `calc` goes.** Next to `{ path }` as a component prop, with the same `map` and `format`,
and a new `as` for numbers in the viewer's language, so a translated run writes numbers its way:

```diff
 // packages/shared/src/surface.ts
 const isPath = (v: unknown): v is { path: string } => …
+const isCalc = (v: unknown): v is { calc: string } => …

-export function bound(value: unknown, data: unknown, row?: unknown): unknown {
+export function bound(value: unknown, data: unknown, row?: unknown, locale?: string): unknown {
+  if (isCalc(value)) {
+    const node = parsedCalc(value.calc);
+    const raw = "error" in node ? undefined : evalCalc(node, calcScope(row, data));
+    // What cannot be worked out is empty, and says so.
+    return raw === undefined ? "–" : worded(raw, value, { row, locale });
+  }
   if (!isPath(value)) {
     return value;
   }
```

```diff
-/** A value turned into words as its path says: looked up in `map`, set into `format`. */
-export function worded(raw: unknown, spec: { map?: unknown; format?: unknown }): unknown {
+/**
+ * A value turned into words as its path or calc says: written as `as` says ("number" with the
+ * locale's separators, "percent"), looked up in `map`, set into `format`, whose `{}` is the value
+ * and `{column}` a column of the row it is drawn in.
+ */
+export function worded(
+  raw: unknown,
+  spec: { as?: unknown; map?: unknown; format?: unknown },
+  at: { row?: unknown; locale?: string } = {},
+): unknown {
```

And as a third form of `when`, for what conditions cannot say:

```diff
 /** One condition, or several that must all hold. */
-export const whenSchema = z.union([conditionSchema, z.array(conditionSchema).min(1)]);
+export const whenSchema = z.union([
+  conditionSchema,
+  z.array(conditionSchema).min(1),
+  /** A test conditions cannot write: `budget > demo * 2`, `size == "Groß" or count(items) > 50`. */
+  calcSchema,
+]);
```

`whenHolds` and `followRules` evaluate it the same way in the browser and on the server. The
studio's condition editor shows a `calc` test as editable text, and the flow diagram shows its text.
Anything conditions can say stays a condition (the text form compiles to conditions where it can,
Part 2).

`conditionsOf` returns nothing for a `calc`. `whenCalc` gives its text and `whenNames` the names a
`when` reads, in either form. `engine/requirements.ts` treats a `calc` branch as one that could go
either way, like `ask`. `fit.ts` treats it as unknown until its names are known.

### 1d. Page layout: `components` on a page

```diff
 export const pageStepSchema = z.object({
   ...stepBase,
   type: z.literal("page"),
   fields: z.array(fieldSchema).min(1),
   /** Fields of which a decision shows one: see `group` on a field. */
   groups: z.array(fieldGroupSchema).max(6).optional(),
   cta: z.string().optional(),
+  /**
+   * How the page is laid out, from the surface catalog: its fields placed with `Field`, with
+   * text, figures, images and callouts between them. Without it the fields stand one under the
+   * other, as today. Paths and calc read the page's answers by field id, as the person types,
+   * and the keys of `data`.
+   */
+  components: surfaceComponentsSchema.optional(),
+  /** What the components read besides the answers: key → steps.id.key, lists.id, brand.name or today. */
+  data: z.record(z.string(), z.string()).optional(),
 });
```

`data` reads what a surface step's `data` reads; the key names are the same. The server fills it for
the current page and sends it as `RunView.pageData`. A page whose `data` reads a stored list needs
that list where it runs (`fit.ts`).

Validator, with `components`:
- every field of the page is placed by exactly one `Field`, and a `Field` names a field of this
  page;
- a field's `when`, `ask` and `group` still decide whether it shows; its `Field` then draws
  nothing;
- the usual surface checks (a `root`, children that exist, required props).

Validator, on `data`: `data` on a page without `components`, and a key of `data` that is also a
field of the page, since they would read the same name.

`Field` on a page and the change to `CHAT_ONLY` (1e) came with this part, which cannot work without
them.

### 1e. One catalog: input components in it

Since Work mode the catalog already has `Field` and `Form`, for a chat's view only
(`CHAT_ONLY` in `surface.ts`): a `Field` there defines a question inline (`name`, `kind`,
`label`) and a `Form` sends them to the chat. A page reuses `Field`, with one difference: on a
page it only places a field the page already defines, so it carries `name` and nothing else; the
kind, label, `look` and checks come from the field. Views get three inputs that keep view state.

```diff
 export const SURFACE_COMPONENTS = [
   "Column",
   …
   "Form",
   "Field",
+  /** Views of a wizard only: a choice the person makes in the view, kept with the run. */
+  "Choice",
+  "Toggle",
+  "Slider",
 ] as const;

-/** Only a chat's view has these: a wizard asks on its pages, and its run has no space to open. */
-const CHAT_ONLY: ReadonlySet<string> = new Set(["Form", "Field", "Ref"]);
+/**
+ * Only a chat's view has these: a wizard asks on its pages, and its run has no space to open. A
+ * page has `Field` too, as a place for one of its own fields (`name` only).
+ */
+const CHAT_ONLY: ReadonlySet<string> = new Set(["Form", "Ref"]);

 const REQUIRED: Partial<Record<SurfaceComponentName, string[]>> = {
   …
-  Field: ["name", "kind", "label"],
+  Field: ["name"], // kind and label as well in a chat's view (validateSurface checks by place)
+  Choice: ["state", "options"],
+  Toggle: ["state", "label"],
+  Slider: ["state", "min", "max"],
 };
```

| Component | Props | Where |
|---|---|---|
| `Field` | `name` (a field id of the page) | pages; in a chat's view as today, with `kind` and `label` inside a `Form` |
| `Choice` | `state`, `options` (values, or `{ label, value }`), `default?`, `look?: "list"` | a wizard's views: surface steps, `output.surface`, reviews, the result |
| `Toggle` | `state`, `label`, `default?` | a wizard's views |
| `Slider` | `state`, `min`, `max`, `increment?`, `unit?`, `label?`, `default?` | a wizard's views |

`state` names a value of the view: `calc` and paths read it by that name, like a data key.

Validator:
- `Field` on a page names a field of that page and has no `kind` or `label`; outside a chat's
  view and a page there is no `Field`.
- `Choice`, `Toggle`, `Slider` never on pages and never in a chat's view. A page's inputs are
  fields: they are answers and are kept as `values`. A view's inputs are view state.
- a `state` name is letters, digits and `_`, is unique in its view and is not also a data key or
  the id of a `Checklist`, whose ticks are kept in the same place.
- `Field`, `Choice`, `Toggle` and `Slider` do not stand in a repeat: each has one value.
- `Choice` has `options` as values or `{ label, value }`, and `look` is `"list"`.

View state is kept where checklist ticks are kept today. The endpoint
`PUT /api/runs/:id/views/:stepId` (`apps/runtime/src/routes/runs.ts`) already stores it; only
the comment changes:

```diff
   /**
-   * What the person did in the step's view, kept with the run: a checklist's ticks by component
-   * id, a widget's own state (`wizard.save`).
+   * What the person did in the step's view, kept with the run: a checklist's ticks by component
+   * id, the value of each Choice, Toggle and Slider by its `state`, a widget's own state
+   * (`wizard.save`).
    */
   view?: Record<string, unknown>;
```

Unlike ChatGPT, a reload shows the same view: the same portions, the same ticks.

### 1f. What does not change

- `DEFINITION_VERSION`, `upgradeDefinition`, the `.wizard` package layout.
- Existing definitions: no field means something else, nothing becomes required.
- Steps, rules, `ask`, decided fields, agent steps, widgets, results.
- The run's state, apart from the new keys in `outputs[step].view`.
- Button actions (`regenerate`, `open`). A checklist already copies or shares what is left
  (`share`). ChatGPT's `issueNewTurn` is the page's `cta`: it moves the run on with the answers.

### 1g. Example: the project configurator

The wizard ChatGPT drew, as a definition today. A page per question, the AI step at the end;
the budget share cannot be shown, the stepper follows the pages:

```json
{
  "version": 2,
  "title": "Projektkonfigurator",
  "lang": "de",
  "steps": [
    {
      "id": "type", "type": "page", "title": "Was möchtest du bauen?",
      "fields": [
        { "id": "type", "label": "Projekttyp", "kind": "select", "required": true,
          "options": ["Website", "Shop", "App"] }
      ]
    },
    {
      "id": "needs", "type": "page", "title": "Wie groß ist dein Shop?",
      "fields": [
        { "id": "size", "label": "Größe", "kind": "select", "required": true,
          "options": ["Klein – bis 50 Produkte", "Mittel – bis 1.000 Produkte",
                      "Groß – mehr als 1.000 Produkte"],
          "when": { "field": "type", "op": "equals", "value": "Shop" } },
        { "id": "pages", "label": "Wie viele Seiten?", "kind": "number",
          "when": { "field": "type", "op": "equals", "value": "Website" } }
      ]
    },
    {
      "id": "budget", "type": "page", "title": "Wie hoch ist dein Budget?",
      "fields": [
        { "id": "budget", "label": "Budget in Euro", "kind": "number", "required": true },
        { "id": "name", "label": "Projektname (optional)", "kind": "text",
          "placeholder": "Mein neues Projekt" }
      ]
    },
    {
      "id": "concept", "type": "agent", "title": "Projektkonzept",
      "instructions": "Erstelle ein Projektkonzept für {{type}} …",
      "output": { "format": "markdown" }
    },
    { "id": "done", "type": "result", "title": "Dein Konzept", "deliverables": [] }
  ]
}
```

What changes with this plan, as a diff of the same definition:

```diff
     {
       "id": "type", "type": "page", "title": "Was möchtest du bauen?",
+      "section": "Projekttyp",
       "fields": [ … ]
     },
     {
       "id": "needs", "type": "page", "title": "Wie groß ist dein Shop?",
+      "section": "Anforderungen",
       "fields": [
         { "id": "size", "label": "Größe", "kind": "select", "required": true,
           "options": [ … ],
+          "look": "list",
           "when": { "field": "type", "op": "equals", "value": "Shop" } },
         …
       ]
     },
     {
       "id": "budget", "type": "page", "title": "Wie hoch ist dein Budget?",
+      "section": "Budget",
       "fields": [
-        { "id": "budget", "label": "Budget in Euro", "kind": "number", "required": true },
+        { "id": "budget", "label": "Budget", "kind": "number", "unit": "€", "required": true,
+          "min": 2000, "max": 30000, "increment": 500, "default": 17000, "look": "slider" },
         { "id": "name", … }
-      ]
+      ],
+      "components": [
+        { "id": "root", "component": "Column", "children": ["b", "fit", "n"] },
+        { "id": "b", "component": "Field", "name": "budget" },
+        { "id": "fit", "component": "Metric", "label": "Davon für die Demo",
+          "value": { "calc": "demo / budget", "as": "percent" },
+          "caption": { "calc": "if(demo <= budget, \"im Budgetrahmen\", \"über dem Budget\")" } },
+        { "id": "n", "component": "Field", "name": "name" }
+      ],
+      "data": { "demo": "steps.estimate.total" }
     },
     {
       "id": "concept", "type": "agent", "title": "Projektkonzept",
+      "section": "Ergebnis",
       …
```

(`steps.estimate.total` stands for an earlier agent step that estimates the demo; in ChatGPT's
version the 9,000 € was a fixed number.)

### 1h. Example: the recipe with portions

An agent step's view (`output.surface`) today shows the ingredients as a checklist. With a
`Choice` and `calc`, the person switches between two and four people and the quantities follow,
in the browser, kept with the run:

```diff
 "surface": [
-  { "id": "root", "component": "Column", "children": ["chips", "list"] },
+  { "id": "root", "component": "Column", "children": ["chips", "people", "list"] },
   { "id": "chips", "component": "Chips", "items": { "path": "/tags" } },
+  { "id": "people", "component": "Choice", "state": "servings", "default": 2,
+    "options": [{ "label": "2 Personen", "value": 2 }, { "label": "4 Personen", "value": 4 }] },
   { "id": "list", "component": "Checklist", "items": { "path": "/ingredients" },
-    "labelKey": "name", "detailKey": "amount" }
+    "labelKey": "name",
+    "detail": { "calc": "round(amount * servings / 2)", "format": "{} {unit}" } }
 ]
```

Inside the checklist's rows, `amount` and `unit` are the row's columns. `detail` with a `calc`
next to `detailKey` is the one new Checklist prop; `format` gains `{column}` placeholders for
the row it is drawn in.

## Part 2 — the text form

What the model writes instead of JSON, compiled to the definition above. It is not stored: the
definition stays the JSON of Part 1, the text form is only how a model writes and reads it.

### Why a text form

The JSON surface format is good to store and validate and slow to write: an id per component,
`"component":`, lists of child ids the model has to keep consistent, `{ "path": … }` objects.
ChatGPT's DIL is built from what models already write well, Markdown and JSX, and stays usable
while half-written. The text form takes that, without the JavaScript.

### The rules

1. **A tag is an object, its attributes are its keys.** Attribute names are the JSON keys of
   Part 1, nothing else. A string in quotes, everything else in `{ }` as JSON.
2. **Children are the object's list.** Steps in the wizard, fields and components in a page,
   rules in a step.
3. **Text inside a tag is its text.** In `<Agent>` the instructions, in `<Result>` the message,
   in `<Page>` Markdown that becomes `Text` components (the page then gets `components`).
4. **`{ … }` that is not JSON is an expression.** `when={type == "Shop"}` compiles to a
   condition when one can say it, else to `{ "calc": … }`. A prop `value={demo / budget}`
   compiles to `{ "calc": "demo / budget" }`, a bare name `{budget}` to `{ "path": "/budget" }`.
5. **Ids come from the model.** Steps and fields carry an `id`, as in JSON. Component ids are
   made by the compiler (`c1`, `c2` …) and stay the same for the same position while it streams.
6. **No `{#if}` blocks.** A field's `when` is an attribute, as it is a key in JSON: one way.

| Text form | Definition |
|---|---|
| `<Wizard title="…" lang="de">` | the definition's top-level keys |
| `<Page id="budget" section="Budget" title="…">` | `{ "type": "page", … }` |
| `<Field id="budget" kind="number" min={2000} … />` | an entry of `fields`, and a `Field` component where the page has components |
| Markdown inside `<Page>` | `Text` components (`##` → `variant: "h3"`) |
| `<Metric label="…" value={demo / budget} as="percent" />` | a component with a `calc` prop |
| `<Next when={type == "Shop"} goto="shop" />`, `<Next ask="…" goto="…" />`, `<Next goto="end" />` | entries of `next` |
| `<Agent id="concept" model="standard">instructions</Agent>` | `{ "type": "agent", "instructions": … }` |
| `<Output format="json"><Text id="summary" /></Output>` | `output.fields` |
| `<Widget id="map" />` | a widget step; its HTML and sample.json stay files the architect writes |
| `<Wait id="remind" for="3d" />` | a wait step, as built in #496 |
| `<Result>message</Result>` | `{ "type": "result", "message": … }` |

Rule 1 carries what durable runs add (`signal`, `onFail`, `durable`, `who`, `timeout`, `remind`,
`approve`): they are keys, so they need no design here. Starts stay outside the definition, so the text form
has none.

### The configurator in the text form

```
<Wizard title="Projektkonfigurator" lang="de">
<Page id="type" section="Projekttyp" title="Was möchtest du bauen?">
  <Field id="type" kind="select" label="Projekttyp" required options={["Website", "Shop", "App"]} />
</Page>
<Page id="needs" section="Anforderungen" title="Wie groß ist dein Shop?">
  <Field id="size" kind="select" label="Größe" required look="list" when={type == "Shop"}
    options={["Klein – bis 50 Produkte", "Mittel – bis 1.000 Produkte", "Groß – mehr als 1.000 Produkte"]} />
  <Field id="pages" kind="number" label="Wie viele Seiten?" when={type == "Website"} />
</Page>
<Page id="budget" section="Budget" title="Wie hoch ist dein Budget?" data={{"demo": "steps.estimate.total"}}>
  <Field id="budget" kind="number" unit="€" required min={2000} max={30000} increment={500} default={17000} look="slider" />
  <Metric label="Davon für die Demo" value={demo / budget} as="percent" />
  <Field id="name" kind="text" label="Projektname (optional)" placeholder="Mein neues Projekt" />
</Page>
<Agent id="concept" section="Ergebnis" title="Projektkonzept" model="standard">
Erstelle ein Projektkonzept für {{type}} mit einem Budget von {{budget}} Euro …
</Agent>
<Result id="done" title="Dein Konzept" />
</Wizard>
```

About 1,200 characters. The same definition is about 1,600 as compact JSON and 2,900 as the
indented JSON the examples store. Length is the smaller gain. The larger one is what the model
no longer has to keep straight: no component ids, no child lists, no `{ "path" }` objects, and a
page that can be drawn as soon as its tag closes.

### Streaming

`parseWizardText(text, { partial: true })` in a new `packages/shared/src/wizard-text.ts` works
like ChatGPT's compiler: it parses everything written so far, cuts at the last complete tag,
closes open elements that already have content and drops the rest. It returns the definition
so far and the cuts it made. Run on every chunk (a definition is small; a full parse takes
well under a millisecond), it gives a step as soon as its closing tag arrives.

`printWizardText(def)` writes a definition back as text, so a model reads an existing wizard in
the same form it writes. Every wizard in `examples/wizards` must print and parse back to the
same definition: that round trip is the test.

## Part 3 — the fast first pass

For a new wizard, before the architect.

1. The wish arrives. One `streamText` call: the `standard` class, low effort, no tools.
2. The prompt is short: the text form's rules, the tag signatures generated from the schemas
   (name, attributes, one line on what it is for), two or three worked examples. About 3k
   tokens instead of 15k. New: `packages/shared/src/catalog-prompt.ts`, so the list cannot fall
   behind the schema. It leaves out what a switch keeps off: `<Wait>` and the keys above only with
   `durableRuns`, as the architect's prompt leaves out its `durable` section.
3. Every chunk goes through `parseWizardText(…, { partial: true })`. Each step that completes is
   saved to the draft; the editor and the test run show it at once (the existing `change`
   event on the wizard's stream).
4. At the end the validator runs. The code fixes what needs no model: a missing `id` (made from
   the label), duplicate ids, a missing `result` step, a `next` to an unknown step (dropped), a
   `look` that does not fit (dropped). What remains goes to the architect.
5. The architect runs in the background on the wizard that now exists: the issues left, widgets,
   connectors, downloads, images, and starts where `startTriggers` is on (`list_starts` and
   `set_starts` come with durable runs' PR 7). The step it works on shows "being prepared"; the person can
   already go through the pages.

On a computer that thinks through an AI client (Claude Code, Codex, Cursor), the CLI starts
when the wish box gets focus and stays open, so the call does not wait for a process start.
Whether that reaches two seconds is open (below).

Targets: the first page in two seconds or less, every page in five seconds or less, widgets and
images when they are ready.

## Part 4 — state in the browser, saved on the server

**The run's state lives on the server, and the server is its source of truth.** The browser
holds a copy so it can show a change at once and move to the next page without waiting. It may
run ahead of the server for a moment and then syncs: the server saves every change right after,
checks it again and, where it disagrees, its state wins. Both, always; the browser alone, never.

Three kinds of event, told apart from the definition and the run:

| Kind | Examples | The person waits on | Saved on the server |
|---|---|---|---|
| Local | typing, a slider, a `when` on the same page, `calc`, a view's `Choice`, a checklist tick | nothing | within a second (below) |
| Run | a page answered, back, the next page | nothing | at once, one after the other, until the server confirms |
| AI | a decided branch (`ask`), decided fields, an agent step, a connector call, `regenerate` | the server | it runs there |

### First: the shortcut on the server

Today `submitPage` always writes `running` and calls `kick`, even when the next step is a page. A
runner then claims the run, and `drive()` does nothing but write `waiting_input`. A process
without a runner (the studio, the doors) leaves that to the next look, every 2 s (`POLL_MS`).

The shortcut: when the next step needs no runner, the answer writes `waiting_input` and the new
cursor in its one update, and does not call `kick`. Every client gets this, the chat runner and
MCP included, and it needs no state in the browser.

```ts
/** A step a run reaches with no runner: a page or review nothing has to decide or fill first. */
function needsNoRunner(
  step: Step | undefined,
  startedBy: StartedBy | null,
  state: RunState,
): boolean;
```

It lives in `engine/runner.ts`, beside `isPersonStep`, and reads the step's keys only: with
`durableRuns` off those steps take the slow path too, which costs nothing.

`state` is the state after `advance`, never `run.state`. For an `ask` rule `advance` sets
`state.deciding` and returns the answered step as the cursor. `run.state` is from before that, so a
decided branch would look like a plain page, and the run would wait on the page just answered.

The slow path stays for:

- anything but a page or a review: an AI step, a `wait`, the result (`drive()` ends the run);
- a page with decided fields (`isDecidedField`): `drive()` decides them as the run arrives;
- a run begun by a start (`run.startedBy`, which comes with durable runs' PR 7): `drive()` fills
  its pages through `passStep`, with nobody there;
- a decided branch (`state.deciding`);
- a next step with `timeout` or `remind`: `waitForAnswer` would write the deadline, but its `wait`
  event would land in the timeline before the answered step's `step_done`;
- a next step with `who` other than `person`: whoever answered is not the one looking at it, so
  two seconds cost nobody anything.

On the combined branch the shortcut sits in `answerGoesOn`, which `submitPage` and `reviewStep`
both call, in place of the write of `running`:

- **Credits first.** A step with `timeout` or `remind` gave its hold back, and `holdAgain` runs
  before the write. Refused, the run waits for credits as it does now, so the shortcut sits behind
  that check.
- **Through `waitForAnswer`,** the call `drive()` uses, with `{ rev }` and `by`. `updateRun` writes
  the notices with the status, and `by` keeps a person from being told of the page they just
  reached themselves. Nothing has to be added for notices.
- **`keepAnswerer` and `tellAnswered` stay where they are.** `answerGoesOn` says whether the run
  went on, and only then do `submitPage` and `reviewStep` call `kick`.

A step someone on the team answered can lead to a plain page of the run's person, who is not there.
`updateRun` tells them just the same: that is the test for this part.

`pushRun` stays in `drive()`: without `durableRuns` it tells a phone in a pocket that a step that
ran is over, and a person who has just answered is looking. With `durableRuns` it does nothing,
because the notices do that work.

### Then: the next page in the browser

The browser does not have the definition. `RunView` carries the current `step` only, and the whole
definition must not reach a public link, because it holds the AI steps' instructions. So the
server sends what the browser may do alone:

```diff
 export interface RunView {
   …
+  /** Goes up with every write to the run: tells a late event from a new one. */
+  rev: number;
+  /** What was typed on this page and not sent yet (`run.unsent`), for who may answer it. */
+  unsent?: Record<string, unknown>;
+  /** The plain pages the run can reach from here without the server, by step id. */
+  ahead?: Record<string, { step: PageStep; next: { when?: When; goto: string }[] }>;
 }
```

`next` is written out, "otherwise" and the next step in the list included. The server writes the
pages as it writes the current one, in the viewer's language. `unsent` and `ahead` go only to a
viewer who may answer: on the combined branch, where `RunView.answeredBy` is null.

A page goes into `ahead` when all of this holds:

- `needsNoRunner` holds;
- it needs nothing only the server has: no `pageNeeds`, `optionsFrom`, `cards` or `prefill`, no
  `data` (`RunView.pageData` is for the current page only), no choice in `closed`, and no
  `connection`, `list` or `slot` field;
- the rules leading to it and the `when` of its fields read this run's answers only: no `ask`, no
  `max`, nothing from `steps.` or `lists.`, a `calc` included (`whenNames`).

Reviews and the result never go into it: they show outputs, and a result never shows on answers
the server has not confirmed.

```ts
/** The next page, when `ahead` says which; null when the server must decide. */
export function nextInBrowser(
  ahead: NonNullable<RunView["ahead"]>,
  stepId: string,
  values: Record<string, unknown>,
): string | null;
```

The runner calls it when a page is answered. With a step id it shows that page at once and sends
the answers in the background. With null, the runner waits as today.

### Saving

Today the answers on a page live only in the browser until the page is sent
(`packages/runner/src/RunnerView.tsx`); a reload loses what was typed. With pages moving on in
the browser, more happens before the server hears of it, so saving becomes explicit:

| What | How it reaches the server | Kept in |
|---|---|---|
| Answers being typed | `PUT /api/runs/:id/pages/:stepId/unsent`, 800 ms after the last change and when the tab is hidden | `run.unsent` (new column) |
| A page answered | `POST /api/runs/:id/pages/:stepId` with a sequence number, one at a time; retried until confirmed | `values`, `history` and the run's `cursor`, as today |
| View state (a `Choice`, a checklist tick) | `PUT /api/runs/:id/views/:stepId`, 800 ms after the last change and when the tab is hidden | `outputs[step].view`, as today |
| A first-pass step (Part 3) | saved to the draft as soon as its tag closes | the wizard's draft, as today |

```diff
 // apps/runtime/src/db/schema.ts, the run table
     state: text("state", { mode: "json" }).$type<RunState>().notNull(),
+    /** Answers typed on a page and not sent yet, by page. No part of `state`, and no `rev`. */
+    unsent: text("unsent", { mode: "json" }).$type<Record<string, Record<string, unknown>>>(),
```

`unsent` is a column of its own, for three reasons:

- `submitPage` only writes while `rev` is unchanged. Typing that bumps `rev` every 800 ms would make
  it fail with `runBusy`.
- `drive()` writes the whole `state` back, which would drop what was typed meanwhile.
- `PUT /views` answers 409 unless a run waits for input or is done. Answers being typed must save
  in any status.

Saving it changes neither `state` nor `rev`. `submitPage` clears the page's entry in its own
update. No step reads it, so unchecked text from a guest never reaches a model. `PUT …/unsent`
makes the same check as an answer (`accessibleRun` with `answers`).

How the runner keeps the promise:

- **In order, once.** The runner sends one page at a time and waits for the answer before the
  next. `requireWaiting` refuses a page while the run is `running`, so this works only with the
  shortcut, and `ahead` holds only pages the shortcut covers. Each page carries a sequence number,
  kept as `RunState.pagesSent`. A retry of a number the run already has answers as done. That check
  comes before `requireWaiting`, which would answer `pageOutdated`, or on the combined branch
  `answeredAlready`. Once the run has gone on to the team's step, `accessibleRun` refuses the retry
  first (`notYourStep`): the answer is already in, and the runner loads the run again.
- **Not lost when the tab closes.** On `pagehide` the runner sends what is still open with
  `fetch(…, { keepalive: true })`. At most the last moment of typing can be lost.
- **Shown, not claimed.** The next page shows before the server confirms. When it has not
  confirmed after two seconds, the runner says "Saving …"; when it cannot reach the server, it
  says the answers are not saved yet and keeps trying. It never shows a result or starts an AI
  step on answers the server has not confirmed.
- **A late event does not pull the person back.** `useRun` replaces the whole view on every event.
  While pages are in flight it keeps them apart from what arrives. A confirmed page answers with
  its `rev`, and a view older than that is dropped.
- **The server's state wins.** When the server refuses a page (an answer it finds invalid, a run
  that moved on in another tab or device, someone who answered first, a deadline that passed), the
  runner loads the run again and shows the server's page. What was typed stays in `unsent`.
- **View state waits its turn.** `writeRunState` also needs an unchanged `rev`, so a view's save can
  make a review's answer fail, and the other way round. The runner sends what is open first, and
  tries again on 409 once the run waits.
- **The server is the record.** A runner always starts from the run on the server. Browser
  storage keeps nothing of its own; what is in flight lives in memory until confirmed. Another
  tab, another device, the runtime's MCP tools (`get_run`) and Work chats all read the same run.

(`unsent` and not `typed`: `typed` is already a `FieldWay` in `definition.ts`.)

Test for this part: answer two pages, close the tab while typing on the third, open the run on
a phone. The phone shows the third page with what was typed.

## Part 5 — an export for ChatGPT

There are two ways for a wizard to reach ChatGPT.

**The full way, built:** the flow widget (`apps/runtime/src/mcp/flow-app.ts`) is an MCP App with
`openai/outputTemplate`. ChatGPT shows a wizard and its run in the chat, through our runtime,
with saving, AI steps, files and results.

**The quick way, new: "Copy for ChatGPT".** DIL is not public: ChatGPT's model writes it and
ChatGPT's server compiles it, so we cannot hand over a finished interface. We can hand over a
prompt that makes ChatGPT draw the wizard itself. The text form of Part 2 is close to DIL by
design, so this is the text form with a short instruction around it:

```
Build this as an interactive interface in this chat, one page at a time.
Use the steps, fields, choices, conditions and calculations exactly as written.
At the end, write the result as the last step describes, from the answers.

<Wizard …>…</Wizard>

Run it with saving, files and results: https://engenty.ai/w/<token>
```

| Carries over | Is lost |
|---|---|
| pages, fields, looks, sections, `when`, `calc` | saving and coming back later |
| choices, decided branches (ChatGPT decides them itself) | files, connectors, lists, connections |
| the last AI step, as the message built from the answers | review, regenerate, downloads, widgets |
| | `wait`, events, starts: a preview has no clock |

It costs nothing to run for us, it needs no ChatGPT app, and the link at the end leads to the
full wizard. What ChatGPT draws is a preview, not a run: nothing of it is saved on our server,
so it is never offered as the wizard itself. A `wait` or an event goes in as one sentence ("Here
the wizard waits three days"), and the link leads to the real run. The same text works as a prompt
in other chats that build interfaces.

Where: the studio's share dialog (`apps/web/src/studio/editor/ShareDialog.tsx`, "Copy for
ChatGPT") and a new CLI command `wizards export --chatgpt <wizard>`
(`apps/runtime/src/cli/main.ts`). It needs only Part 2's printer.

## How this fits the new direction

The studio is changing course in two ways, each with its own plan:

- **The studio does more than create wizards.** It also manages context and tools: Skills
  become a first-class place next to wizards (`docs/plans/skills.md` and the session building
  it), with sources, connectors and plugins. The text form (Part 2) and the catalog prompt
  (Part 3) are how the model writes a wizard fast; they do not change how it finds a space's
  skills or tools. The architect's background turn (Part 3, step 5) is where those come in.
- **Wizards become durable, long-running agents with a workflow and a human in the loop.**
  `docs/plans/durable-agents.md` covers that, and it is being built now.

Where the durable work stood on 2026-11-06:

| PRs | What | State |
|---|---|---|
| 0, 1 | runner line, `wait` steps and the minute clock | on `main` (#495, #496) |
| 3 | outside actions run once | open (#498), and on the combined branch |
| 2, 4 to 11 | timeline, durable agent steps, signals, a mailbox that wakes a run, starts, `timeout` and `remind`, telling people, `who` and `approve`, retries and `onFail` | on `claude/durable-runs-combined`, pushed with Part 1 of this plan at `fe9b26d3`; no PR, not merged with `main` |
| 12 | docs, and the PR that flips `durableRuns` | docs on the branch, the flip waits |

Nothing more of it goes to `main` until Matthias lifts that hold (`durable-agents.md`, on the
branch).

Where the two plans meet:

| | This plan | The durable-agents plan |
|---|---|---|
| State | On the server as the source of truth; the browser runs ahead and syncs (Part 4) | The same rule, for runs that last days |
| Waiting | Page to page: no wait for a runner, then nothing the person waits on (`nextInBrowser`) | Long waits: a person's approval, a signal, a time; how a run sleeps and wakes |
| Human in the loop | Pages and views a person fills in a session | Asking someone later, reminders, hand-overs |
| What the model does at run time | Selects, never writes (`dynamic-flow.md`) | Decided there |

This plan leaves the durable and waiting design to that plan. It asks one thing of it: a run that
waits long keeps `unsent` answers and view state on the server, so a page opened days later looks as
it was left. `unsent` counts as a change for a waiting run's retention.

## Order

Creation first: it is the largest gap, and the durable work barely touches it. What changes
`submitPage` comes after the combined branch lands, because that branch rewrites much of
`engine/runner.ts`. Steps 1, 2 and 4 wait for nothing. Step 3 needs the combined branch only for
the starts tools, and can come first with those added afterwards.

Step 6 was built first, out of this order, so what is next is steps 1 to 3. Part 1 makes pages
richer and does not make creating a wizard faster; that is steps 2 and 3.

The first pass stays behind a switch `fastCreate` (registered in
`packages/shared/src/feature-flags.ts`, set in `.features`) until it is done.

1. **Measure.** Log per architect turn: time to the first token, reasoning, each tool round,
   fix rounds, total; on the cloud and on a computer with each AI client. Log page to page as well.
   Seen in `debug_logs`. This sets the baseline for the targets. Not built. One run with logging
   that was not kept, on a laptop, from an answer to the next `waiting_input` on plain pages: 3 to
   9 ms with the runner in the same process (20 answers); a median of 873 ms and at most 1947 ms with
   studio and runner as separate processes (30 answers, seen by a polling client). No architect
   turn was measured.
2. **The text form.** Part 2, on today's format: parse, print, the round trip over
   `examples/wizards`. Keys are generic, so later additions need no new parser. Until Part 1 is on
   `main` an expression a condition cannot say is an issue, and Markdown in a page is not offered.
3. **The fast first pass.** Part 3, behind `fastCreate`. It touches the same `agents/architect.ts`
   as durable runs' PR 7 (starts tools), so whichever lands second merges with the other. It writes
   plain pages until Part 1 is on `main`, so this step brings the speed and not yet the richer pages.
4. **Copy for ChatGPT.** Part 5; needs only step 2.
5. **The shortcut on the server.** Part 4, after the combined branch is on `main`, since it sits in
   that branch's `answerGoesOn`. It is small, and every client gets it.
6. **The format.** Built, on the combined branch (Part 1). How it reaches `main` is Matthias's call:
   with that branch when the hold lifts, or moved over on its own, which nobody has tried. Its
   commits are split by section, but they sit on the durable work and change `engine/runner.ts`.
7. **The next page in the browser.** Part 4: first `run.unsent` and saving what is typed, which is
   worth having alone, then `rev`, `ahead`, `nextInBrowser`. Needs step 5.

## Changes by file

Built, for Part 1, on the combined branch:

| File | Change |
|---|---|
| `packages/shared/src/definition.ts` | field `min`/`max` widened, `increment`, `unit`, `look`; `section` on steps; `components` and `data` on pages; `whenSchema` with `calc`, `whenCalc`, `whenNames`; validator issues |
| `packages/shared/src/calc.ts` | new: the expression language, parser, evaluator, names, `calcScope` |
| `packages/shared/src/surface.ts` | `Field` on pages (`name` only), `CHAT_ONLY` without it; `Choice`, `Toggle`, `Slider`; `calc` and `as` in `bound` and `worded`; validator by place |
| `packages/shared/src/run.ts` | `RunView.pageData`, `progress.sections`; comment on `StepOutput.view` |
| `packages/shared/src/runner-texts.ts` | `numberAtLeast`, `numberAtMost` |
| `packages/shared/src/fit.ts` | a `calc` branch; a page's `data` reading a stored list |
| `packages/shared/src/translation.ts` | `section` and `unit` |
| `packages/shared/src/marketplace-entry.ts` | a `calc` condition in the entry's text |
| `apps/runtime/src/engine/input.ts` | a number outside `min` and `max` is refused |
| `apps/runtime/src/engine/requirements.ts` | a `calc` branch could go either way |
| `apps/runtime/src/engine/runner.ts` | the view: `progress.sections`, `pageData` |
| `packages/runner/src/fields.tsx`, new `packages/runner/src/field-looks.tsx` | slider, stepper, list looks |
| `packages/runner/src/RunnerView.tsx` | sections in the progress bar; page components |
| `packages/runner/src/surface.tsx` | `Field`, `Choice`, `Toggle`, `Slider`; `calc` props; view state saved |
| `apps/web/src/studio/editor/Inspector.tsx`, `FlowDiagram.tsx` | a `calc` test as text |
| `apps/runtime/src/prompts/authoring.md` | `look`, `section`, `calc`, page components, view inputs |
| `apps/docs/public/schema/v2/wizard.json`, `wizard-package.json` | regenerated |
| `docs/content/dev/wizard-format` | the format additions |

Still to do:

| File | Change |
|---|---|
| `packages/shared/src/definition.ts` | `nextInBrowser` |
| `packages/shared/src/run.ts` | `RunView.rev`, `unsent`, `ahead`; `RunState.pagesSent` |
| `apps/runtime/src/db/schema.ts`, a tenant migration | `run.unsent` |
| `apps/runtime/src/services/runs.ts` | the view: `rev`; `unsent` and `ahead` for who may answer |
| `packages/shared/src/feature-flags.ts` | `fastCreate` |
| `apps/runtime/src/routes/runs.ts` | `PUT /:id/pages/:stepId/unsent`; sequence numbers and `rev` on `POST /:id/pages/:stepId` |
| `apps/runtime/src/engine/runner.ts` | `needsNoRunner`; `answerGoesOn`: the shortcut; `submitPage` and `reviewStep`: `kick` only when the run went on; `submitPage`: sequence numbers, clears `unsent[stepId]` |
| `packages/shared/src/wizard-text.ts` | new: `parseWizardText`, `printWizardText` |
| `packages/shared/src/catalog-prompt.ts` | new: tag signatures from the schemas |
| `packages/runner/src/RunnerView.tsx` | advance in the browser; saves what is typed |
| `apps/web/src/runner/useRun.ts` | pages in flight, one at a time; drops a view older than the last confirmed `rev` |
| `apps/runtime/src/services/architect.ts` | the fast first pass before the architect; deterministic fixes |
| `apps/runtime/src/agents/architect.ts` | timing log; background turn after the first pass |
| `apps/runtime/src/agents/subscription.ts` | the AI client's CLI kept open from the wish box's focus |
| `apps/web/src/studio/editor/ShareDialog.tsx` | "Copy for ChatGPT" |
| `apps/runtime/src/cli/main.ts` | new command `export --chatgpt` |
| `docs/content/dev` | the text form |

## Open questions

- Does the architect also write the text form for edits, or keep `edit_wizard` on JSON?
  Printing makes both possible; one form for both is simpler for the model.
- Can a CLI kept open reach two seconds on a computer with Claude Code, Codex or Cursor, or does
  the first pass there need the credits or an API key? Step 1 answers it.
- The look names: `slider`, `stepper`, `list`. Any more (stars for a score, chips for
  multiselect) only when a wizard needs them.
- The functions of `calc`: enough for budgets, portions and totals? `items` fields already sum
  their rows; `sum` must give the same number.
- Should the server check `increment` as well as `min` and `max`? Today only the runner uses it.
- Does a Work chat's `show_view` get the text form and `calc` too? Same catalog, same speed
  problem; not part of this plan.
- Server-resolved images, like ChatGPT's `AsyncImage query`: an `Image` with a `query` that the
  runtime fills by image search or generation. Useful for the first pass (a page with a picture
  without an image step); not part of this plan.
