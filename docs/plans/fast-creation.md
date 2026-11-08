# Plan: fast creation and pages without waiting

Status: part of the durable work. Part 1 is built on `claude/durable-runs-combined` (`a719337c` to
`fe9b26d3`, the ids from before its rebase on `main`; no PR), and so are Parts 2 and 3 (below).
Of Part 4, the shortcut on the server is built there (step 5); the next page in the browser is
being built. Part 5 needs nothing new: chat apps get the
wizard through MCP Apps, and no prompt for ChatGPT is built (2026-11-08). Nothing of it is on
`main` but this text (Order). From the review of ChatGPT's Intelligent UI on
2026-10-29, checked against `feat/work-mode` (v0.13.0, Work mode, spaces, model tiers) on
2026-10-30. Part 4, the order and the fit with durable runs corrected on 2026-11-06, against `main`
and that branch at 6bac6ed0, by reading the code. Part 1 brought in line with what was built the
same day, against `fe9b26d3`. Step 1 is built on that branch and was measured on 2026-11-07 on a
laptop (Order, step 1). The cloud is not measured yet. Step 2, the text form, is built there the
same day, and Part 2 is brought in line with it. Step 3, the first pass, is built there on
2026-11-08 and measured the same way; Part 3 is brought in line with it. Step 5 is built there
the same day; Part 4's shortcut is brought in line with it.

Scope: a new wizard shows its first page about two seconds after the wish, and a run moves from
page to page without waiting on the server. The definition stays JSON and stays at version 2:
every format change below is additive. Five parts: the format (Part 1), a text form the model
writes (Part 2), a fast first pass that writes it (Part 3), state in the browser and on the
server (Part 4), and how a wizard reaches chat apps (Part 5).

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

Built on 2026-11-06 on `claude/durable-runs-combined`, because Matthias asked for it there. The sections below say what was built. The files are in "Changes by file".

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
- Tried in step 7, on a test wizard with a real AI step on Claude Code: at phone width (375 px)
  the section bar, the list's round buttons, the slider and the stepper draw with no overflow.
  Page `data` read the AI step's estimate (2,000 € of 8,000 €, a Metric "25 % · im Rahmen"). A
  `calc` branch on `steps.` took the right way, and `ahead` held only the page before it. A run
  translated from English into German shows its fields, sections and choices in German; the
  page's components stay English (below).
- Two rules an author meets, which the validator states clearly: a page's components read only
  that page's answers and its `data`, so an earlier answer needs a `data` key; a branch rule does
  not read a page's `data`, so it names `steps.<id>.<key>` itself.

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
   Part 1, nothing else. A string in quotes, everything else in `{ }` as JSON. The parser fills
   in what the schema fills in (`version` 2, an agent's `output`, a widget's `data` and the
   like) and a Result's `deliverables: []`; the printer leaves them out.
2. **Children are the object's list.** Steps in the wizard, fields and components in a page,
   rules in a step. With components on a page, the order of `fields` follows the `<Field>` tags.
3. **Text inside a tag is its text.** In `<Agent>` the instructions, in `<Result>` the message,
   in `<Page>` Markdown that becomes `Text` components (the page then gets `components`). Such
   text holds no `<` before a letter or `/`, and its ends are trimmed; a text that needs either
   is printed as an attribute (`instructions="…"`). `<Wizard>` takes no text: `intro` is an
   attribute.
4. **`{ … }` that is not JSON is an expression.** In `when`, `==`, `!=`, `>` and `<` joined
   with `and` compile to conditions; `>=`, `<=`, `or`, `not` and arithmetic compile to
   `{ "calc": … }`. `in`, `notEmpty`, `empty` and `contains` have no expression and are written
   as JSON (`when={{"field": "x", "op": "notEmpty"}}`). In a component's prop, a plain name
   `{budget}` compiles to `{ "path": "/budget" }` and anything else, a dotted name too, to
   `{ "calc": … }`; a calc with `as` or `format` is written as JSON. In a step's or field's
   attributes only `when` takes an expression; any other is dropped, with a cut.
5. **Ids come from the model.** Steps and fields carry an `id`, as in JSON. Component ids are
   made by the compiler (`c1`, `c2` …) and stay the same for the same position while it streams.
6. **No `{#if}` blocks.** A field's `when` is an attribute, as it is a key in JSON: one way.
7. **Component tags only in `<Page>`, as one tree.** A surface step's `components` and
   `candidates` and an agent's `output.surface` are JSON attributes. So are a page's components
   that are not one tree under a plain root `Column`: repeat templates, `Tabs` that name their
   children, a root with props, a `Field` component with an id of its own. They print as
   `components={[…]}` beside the `<Field>` tags.
8. **A tag name may mean two things, by where it stands.** `Text`, `List`, `Table` and `Choice`
   are components in a page and output kinds inside `<Output>`. Other output kinds are written
   `<YesNo>`, `<Score>` and so on. `Group` is a component; a page's `groups` stay JSON.

| Text form | Definition |
|---|---|
| `<Wizard title="…" lang="de">` | the definition's top-level keys |
| `<Page id="budget" section="Budget" title="…">` | `{ "type": "page", … }` |
| `<Field id="budget" kind="number" min={2000} … />` | an entry of `fields`, and a `Field` component where the page has components |
| Markdown inside `<Page>` | `Text` components: `#` and `##` → `variant: "h3"`, `###` and more → `"h4"`, a paragraph without a variant |
| `<Metric label="…" value={demo / budget} />` | a component with a `calc` prop |
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
  <Field id="budget" kind="number" label="Budget" unit="€" required min={2000} max={30000} increment={500} default={17000} look="slider" />
  <Metric label="Davon für die Demo" value={{"calc": "demo / budget", "as": "percent"}}
    caption={if(demo <= budget, "im Budgetrahmen", "über dem Budget")} />
  <Field id="name" kind="text" label="Projektname (optional)" placeholder="Mein neues Projekt" />
</Page>
<Agent id="concept" section="Ergebnis" title="Projektkonzept">
Erstelle ein Projektkonzept für {{type}} …
</Agent>
<Result id="done" title="Dein Konzept" />
</Wizard>
```

This parses to 1g with its diff, except the component ids: `c1`, `c2`, `c3` here, `b`, `fit`,
`n` there (rule 5). 1g itself, with its own ids, prints its components as `components={…}`
(rule 7).

Length is the smaller gain. Over the 17 wizards in `examples/wizards`, the text form is 4 to 8 %
shorter than compact JSON, because they are mostly prompt text, and 21 to 44 % shorter than the
indented JSON they are stored as. A page with components gains more. The larger gain is what
the model no longer has to keep straight: no component ids, no child lists, no `{ "path" }`
objects, and a page that can be drawn as soon as its tag closes.

### Streaming

`parseWizardText(text, { partial: true })` in `packages/shared/src/wizard-text.ts` works like
ChatGPT's compiler: it parses everything written so far, cuts at the last complete tag, closes
open elements that already have content and drops the rest. It returns `{ definition, cuts }`;
a cut is `{ at, what, step? }`, and the definition is not checked against the schema. Run on
every chunk, it gives a step as soon as its closing tag arrives, and that step does not change
after. An open step that already has content shows before its closing tag; its cut names the
step, so the first pass can keep only the closed ones. Markdown loses each line's indentation,
and a heading still being typed is a paragraph first, then the heading, with the same id.

`printWizardText(def)` writes a definition back as text, so a model reads an existing wizard in
the same form it writes. It checks each step by parsing it back; a step whose readable form does
not give the same JSON is printed with plain attributes. Every wizard in `examples/wizards` must
print and parse back to the same definition: that round trip is the test.

Built as step 2 (`dddb88b0`). All 17 examples round-trip with no cuts and none needs the plain
fallback; so do 1g with its own ids and a definition with durable runs' keys, a `calc` `when`,
Markdown and output fields. No prefix of an example throws. On the largest example (7,255
characters as text) a parse takes 0.04 ms and a print 0.12 ms, on a laptop. Nothing calls the
text form yet.

## Part 3 — the fast first pass

For a new wizard, before the architect.

Built as step 3 (`d6086588`), behind `fastCreate`, in `apps/runtime/src/services/first-pass.ts`
and `fastCreateTurn` in `services/architect.ts`. It is taken only for the first message of a
blank wizard; with the switch off, every message goes to `architectTurn` as before.

1. The wish arrives. One call, no tools, the `standard` class. "Low effort" exists only as
   OpenAI's `reasoningEffort: "low"`; the gateway's standard model needs none, and Anthropic's
   does not think without one. With a key it is `streamText` on `chatModel(way, "standard")`.
   Through an AI client it is `subscriptionText` in `agents/subscription.ts`: the client's CLI,
   started per call, with its normal model (Claude Code: sonnet, Codex: gpt-6.1-sol), no MCP and
   no session. The harness model (`client.model(alias)`) does not stream, so the CLI's JSON lines
   are read instead. The wish's attachments are left out; the architect after it gets them.
2. The prompt is short. `packages/shared/src/catalog-prompt.ts` builds the tags from the schemas
   (`wizardTextTags({ durableRuns })`, with each attribute, optional ones marked, enums with
   their values) and holds two worked examples (`WIZARD_TEXT_EXAMPLES`), which a test parses and
   validates. The rules for the model are in `prompts/architect.md` (`firstpass.system`), where
   `prompts/README.md` wants every sentence a model reads. `<Wait>` and durable runs' keys are
   there only with `durableRuns`. The tags take about 4k characters; the whole system prompt is
   under 20k characters, about 3k to 4k tokens instead of 15k.
3. Every chunk goes through `parseWizardText(…, { partial: true })`. A step counts as closed
   unless a cut names it as open (`TextCut.open`). Closed steps go to the draft through
   `writeDraft`, one save at a time; a step that closes while a save runs goes into the next one.
   The editor and the test run show each save through the existing `change` event. If the person
   changed the wizard meanwhile, the save retries once on the new revision.
4. At the end: the full parse, then the code fixes, then one last save. The fixes: a missing or
   invalid `id` (made from the label or title, umlauts written out), field ids unique across the
   wizard (a page's `Field` component renamed with its field), a missing `result` step (only at
   the end, so the editor never shows one the text then brings itself), a `next` to an unknown
   step and a `look` that does not fit (both dropped). A step the schema refuses is dropped and
   listed as an issue, or `writeDraft` would refuse the whole draft. What remains goes to the
   architect.
5. The architect runs after the first pass, on the wizard that now exists: the issues left,
   widgets, connectors, downloads, images, and starts where `startTriggers` is on. Its message
   is `firstpass.followup` (the wish and the issues left), and the thread holds the wish once.
   It runs in the same chat request, so the chat shows its work and Stop stops it; closing the
   editor ends it, as today. The pages are usable meanwhile: the preview and the flow show each
   save, and the test run can start. It does not say which step it works on, so the steps
   marked "Wird vorbereitet …" / "Being prepared…" are set once, after the first pass: steps with
   issues left and widget steps, until the turn ends. If the first pass writes no step or fails,
   the architect builds from the wish as before.

Each first pass logs one `[timing] firstPass` line (way, model, outcome, time to the first text,
the first and the last step saved, steps, saves, fixes, issues, cuts, characters), followed by
the architect's own line.

Not built: a CLI that starts when the wish box gets focus and stays open. It would take away the
process start, but Codex and Cursor hand over their text only when it is finished, so on a
computer with either, every page arrives at once whether the CLI is kept open or not.

Targets: the first page in two seconds or less, every page in five seconds or less, widgets and
images when they are ready. Measured in step 3 (Order).

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

- **Credits later.** A step with `timeout` or `remind` gave its hold back. Step 5 held again in
  `answerGoesOn`, before the write; since `641b0aec` the answer only sets `RunState.holdLater`,
  and `drive()` holds right before the next step that costs. Refused, the run waits for credits
  there. No step that costs runs without a hold, and the pages in between wait for nothing.
- **Through `waitForAnswer`,** the call `drive()` uses, with `{ rev }` and `by`. `updateRun` writes
  the notices with the status, and `by` keeps a person from being told of the page they just
  reached themselves. Nothing has to be added for notices.
- **`keepAnswerer` and `tellAnswered` stay where they are.** `answerGoesOn` says whether the run
  went on, and only then do `submitPage` and `reviewStep` call `kick`.

A step someone on the team answered can lead to a plain page of the run's person, who is not there.
`updateRun` tells them just the same: that is the test for this part.

The shortcut calls `pushRun` as `drive()` does when it reaches a page: without `durableRuns` a
phone hears the next page at once; with them `pushRun` does nothing, because the notices do that
work.

Built as step 5 (`890a34f7`), as above, with these details:

- `waitForAnswer` gets `{ ...run, cursor }`, so the deadline comes from the run's row and the next
  step goes in as the step. The state is written without `answered`, as `drive()` writes it;
  `lastBy` stays.
- The `[timing] page` line is written by the shortcut with `runner=no`, and by `drive()` with
  `runner=yes`.
- `reviewStep`'s redo goes through `answerGoesOn` too. Its target is an AI step, so it always takes
  the slow path.
- A refused hold of credits no longer calls `kick`. Before, a runner found the run sleeping and did
  nothing.
- The tests check `kick` through the control line (`run_index.woken_at`), in a process without a
  runner: the slow path leaves the run `running` and woken, the shortcut `waiting_input` and not
  woken.

### Then: the next page in the browser

The browser does not have the definition. `RunView` carries the current `step` only, and the whole
definition must not reach a public link, because it holds the AI steps' instructions. So the
server sends what the browser may do alone:

```diff
 // packages/shared/src/definition.ts
+export interface AheadRule { when?: When; goto: string }
+/** A page the browser may show with no server, and where it goes. */
+export interface AheadPage { step: PageStep; next: AheadRule[] | null }

 // packages/shared/src/run.ts
 export interface RunView {
   …
+  /** What was typed on the current page and not sent yet (`run.unsent`), for who may answer it. */
+  unsent?: Record<string, unknown>;
+  /** Goes up with every write of the run's state and status: tells a late view from a new one. */
+  rev: number;
+  /** The plain pages the run can reach from here with no server, the current one included. */
+  ahead?: Record<string, AheadPage & { progress: RunView["progress"] }>;
+  /** The number of the last page sent with one (`RunState.pagesSent`): the next is one more. */
+  pagesSent?: number;
 }
```

`next` is written out: the `when` rules in order, then "otherwise", explicit or the next step in
the list, or the end. It is null where the server decides where the page goes: an `ask`, a `max`,
or any rule back to an earlier step, because `followRules` counts every loop and the browser has
no counts. Such a page can still be shown ahead; only the page after it waits for the server.

Each entry carries its `progress`, because only the server knows a page's place and section. The
current page is in `ahead` too, since `nextInBrowser` needs its `next`. `aheadOf` in
`engine/runner.ts` walks from the current page, breadth first, at most 20 pages, in the translated
definition, so the pages come in the viewer's language. `ahead`, `unsent` and `pagesSent` go only
to a viewer who may answer: on the combined branch, where `RunView.answeredBy` is null. `ahead` and
`pagesSent` are set only while the run waits on a page and was not begun by a start.

A page goes into `ahead` when all of this holds:

- `needsNoRunner` holds;
- it needs nothing only the server has: no `optionsFrom`, `cards` or `prefill`, no `data`
  (`RunView.pageData` is for the current page only), no choice in `closed`, and no `connection`,
  `list` or `slot` field;
- the `when` of its fields reads only names that are field ids of the wizard, whose values the
  browser has. Nothing from `steps.` or `lists.`, and no other name.

Upload fields may go into it: an upload does not depend on the run's current page. Reviews and the
result never go into it: they show outputs, and a result never shows on answers the server has not
confirmed.

```ts
/** The next page, when `ahead` says which; null when the server must decide. */
export function nextInBrowser(
  ahead: Record<string, AheadPage>,
  stepId: string,
  values: Record<string, unknown>,
): string | null;
```

It takes the first rule that holds, as `followRules` does, and answers null when that rule leads
anywhere but a page of `ahead`: the end, a step that works, a review, the result. The runner calls
it when a page is answered. With a step id it shows that page at once and sends the answers in the
background. With null, the runner waits for the server as before. A page shown ahead cannot go
back, and has no outputs, lists or `ask`.

The browser picks the next page from all of the page's values, the server from the fields that
were shown. Where a hidden field's value would change the way, the two can differ; then the
server's page wins when the next answer is refused. No test covers that case yet.

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
  shortcut, and `ahead` holds only pages the shortcut covers. Each page carries a sequence number
  (`seq`) and the id of the tab that sent it (`tab`), kept as `RunState.pagesSent: { n, step, tab }`.
  A retry from the same tab of a number the run already has answers `{ ok, rev, already: true }`,
  with no write. Without the tab, two tabs or devices answering the same page would send the same
  number, and the second would be dropped as a retry instead of refused. That check comes before
  `requireWaiting`, which would answer `pageOutdated`, or on the combined branch `answeredAlready`.
  Once the run has gone on to the team's step, `accessibleRun` refuses the retry first
  (`notYourStep`): the answer is already in, and the runner loads the run again. An answer without
  a number, as the chat runner's model gives with `answer_page`, goes where the run stands, as
  before.
- **Not lost when the tab closes.** On `pagehide` the runner sends what is still open with
  `fetch(…, { keepalive: true })` (`api.keep`). At most the last moment of typing can be lost.
- **Shown, not claimed.** The next page shows before the server confirms. When it has not
  confirmed after two seconds, the runner says "Saving…" / „Wird gespeichert …“. When the server
  cannot be reached (no answer, 502, 503, 504), it says the answers are not saved yet and tries
  again, waiting longer each time, up to 10 s. It never shows a result or starts an AI step on
  answers the server has not confirmed.
- **A late event does not pull the person back.** `useRun` replaces the whole view on every event.
  While pages are in flight it keeps them apart from what arrives. A confirmed page answers with
  its `rev` (`{ ok, rev }`), and a view older than that is dropped. Once every page is in, the
  server's view shows.
- **The server's state wins.** When the server refuses a page (an answer it finds invalid, a run
  that moved on in another tab or device, someone who answered first, a deadline that passed), the
  runner puts that page's values into `unsent`, loads the run again and shows the server's page
  with its field errors. The pages after the refused one go too. What was typed stays in `unsent`,
  also for a page that was already sent.
- **View state waits its turn.** `writeRunState` also needs an unchanged `rev`, so a view's save can
  make a review's answer fail, and the other way round. The runner sends what is open first, and
  tries again on 409 once the run waits.
- **The server is the record.** A runner always starts from the run on the server. Browser
  storage keeps nothing of its own; what is in flight lives in memory until confirmed. Another
  tab, another device, the runtime's MCP tools (`get_run`) and Work chats all read the same run.

(`unsent` and not `typed`: `typed` is already a `FieldWay` in `definition.ts`.)

Test for this part: answer two pages, close the tab while typing on the third, open the run on
a phone. The phone shows the third page with what was typed.

Built as step 6, in two commits: `b0d0f879` saves what is typed, `db62e6e7` shows the next page in
the browser. With these details:

- `run.unsent` comes with tenant migration `0068_run_unsent`. `keepUnsent` in `engine/runner.ts`
  writes a page's entry in place with `json_set`, so two pages saved at once both stay. `PUT
  …/unsent` takes pages of the definition only, and at most 64 KB.
- `answerGoesOn` clears the page's entry in the update it already makes. A page refused for
  credits clears it in its own write.
- `RunView.unsent` is the current page's entry, while the run waits for input.
- The runner (`useKeepTyping` in `RunnerView.tsx`) saves nothing once the page is sent, nothing the
  person did not change, and nothing in a standalone page (WordPress). A page starts from `unsent`
  first.
- The test was done with a second session of the same member from `curl`, as another device: it
  got the third page with both texts. The browser pane fires no `pagehide` when it closes a tab, so
  the last moment before a close was not checked there. A note typed just before leaving by
  navigation was kept.

### After that: pages the server works out

Pages that are not shown ahead still waited for a runner: with web and runner apart, a median of
1.1 s, at most 3 s. Three commits after step 6 bring that to about 54 ms:

- **The runner is told at once** (`4e675150`). `kick` in a process without a runner also calls a
  runner that reports (`otherRunners`): `POST /api/peer/runs/:id/take` (`routes/peer.ts`), with a
  ticket signed by the processes' shared secret (`peerTicket` in `secrets/signing.ts`), good for
  60 s, one run and one tenant. The runner takes the run at once (`takeNow`). The line and the
  runner's look every 2 s stay as the fallback. `watchRun` looks every 100 ms for 15 s after the
  run changed, else every second as before. The runner does not call the web back, since web
  processes register no address; that would save about 50 ms and is not built.
- **No credit hold at the answer** (`641b0aec`): "Credits later" above. `reserveForRun` takes the
  amount as a number or a function, so the estimate is worked out only where a hold is made, with
  the Manage-App.
- **The stream's first view at once** (`2a2838b6`). `/api/runs/:id/stream` waited 120 ms before
  every view. It sends the first at once, then at most one per 40 ms (`VIEW_GAP_MS`).

## Part 5 — wizards in chat apps: MCP Apps only

A wizard reaches ChatGPT, Claude and the other AI apps through our MCP server, and the app
draws it directly where it can: the flow widget (`apps/runtime/src/mcp/flow-app.ts`) is an MCP
App, with `openai/outputTemplate` for ChatGPT. The app shows the wizard and its run in the chat,
through our runtime, with saving, AI steps, files and results. Where an app draws no MCP Apps,
the run goes on as text through the same tools. This is built.

No prompt that makes a chat draw the wizard itself (Matthias, 2026-11-08). Such a copy would be
a preview without saving, files or results, and it would be offered beside the real run. Every
way into a chat app is the run itself, through the MCP server.

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
branch). This plan is built on the same branch and comes under the same hold.

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

This plan is part of the durable work (Matthias, 2026-11-06). All of it is built and tested on
`claude/durable-runs-combined`, which is kept rebased on `main`. Nothing of it goes to `main` until
Matthias decides, after step 7: there is no PR for that branch until then, and no step below lands
on its own. So nothing here waits for `main`. The steps follow what each needs.

Part 1 is built. It makes pages richer and does not make creating a wizard faster; that is steps 2
and 3, and creation comes first because it is the largest gap.

The first pass stays behind a switch `fastCreate` (registered in
`packages/shared/src/feature-flags.ts`, set in `.features`) until it is done.

1. **Measure.** Built on the branch (`9f5c1860`, `5ba2a22d`): a `[timing] architect` line per
   architect turn (time to the first output, reasoning, rounds, fix rounds, time in tools, total)
   and a `[timing] page` line from an answer to the next page, both in `debug_logs`. On the cloud,
   `debug_logs` also asks the runners, which print the page lines. This is the baseline for the
   targets of Part 3. Measured on 2026-11-07 on a laptop, local runtime:

   | How it thinks | Runs | Create | Edit |
   |---|---|---|---|
   | Claude Code (opus, extra effort) | 3 | 65 to 77 s; first output after 1.1 to 2.4 s; 11 to 13 rounds, 5 or 6 of them fix rounds | 42 to 53 s; 5 to 9 rounds |
   | Codex (gpt-6-astra) | 3 | 47 to 59 s; first finished item after 4.1 to 9.5 s; 4 rounds, no fix rounds | 18 to 37 s; 2 or 3 rounds |
   | Anthropic key, in the process (the cloud's code) | 1 | 22 s; first output after 4.5 s; 1 round | 22 s; 1 round |
   | Gateway (`moonshotai/kimi-k3`) | 1 | 24 s; first output after 3.6 s | 103 s, not explained |

   Not measured: Cursor (not signed in on that computer), an OpenAI key (refused), and the cloud,
   which needs a deploy. Codex reports no reasoning, and its first output is the first finished
   item, not a token. One Claude Code creation reported no change although the wizard went from
   2 to 5 steps; not fixed yet.

   Page to page, plain pages, 30 answers each, from the answer arriving to the runner reaching the
   next page:

   | Studio and runner | `durableRuns` | Median | At most |
   |---|---|---|---|
   | One process | on | 6.5 ms | 32 ms |
   | One process | off | 8 ms | 89 ms |
   | Separate processes | on | 871 ms | 1979 ms |
   | Separate processes | off | 1249 ms | 1973 ms |

   This agrees with an earlier run whose logging was not kept: 3 to 9 ms in one process, a median
   of 873 ms and at most 1947 ms in separate processes.

   What it shows: with an API key a creation takes about 22 s, the twenty seconds of "Why".
   Through an AI client it takes 47 to 77 s, and the difference goes with the rounds: Claude Code
   writes and fixes 11 to 13 times where the key writes once. Between pages, the wait comes from
   studio and runner being separate processes, not from the runner.
2. **The text form.** Part 2, with Part 1's format: parse, print, the round trip over
   `examples/wizards`. `calc`, page `components` and Markdown in a page are there from the start.
   Built on the branch (`dddb88b0`); Part 2 says what it does and what it measured.
3. **The fast first pass.** Part 3, behind `fastCreate`, with the richer pages and the starts tools
   (`list_starts`, `set_starts`) that are already on the branch. Built on the branch
   (`d6086588`); Part 3 says what it does. Measured on 2026-11-08 on a laptop, local runtime in
   one process, with step 1's wish, three runs each, at a load of 5 to 22 and 69 to 71 % of
   memory free:

   | How it thinks (first-pass model) | First text | First page saved | Last page | Issues left | Architect after |
   |---|---|---|---|---|---|
   | Anthropic key (claude-sonnet-5-5) | 0.7 to 1.1 s | 1.4, 1.5, 1.8 s | 7.4 to 7.5 s | 0 | 23 to 30 s, 1 round |
   | Gateway (deepseek-v4.1-flash) | 1.3 to 3.9 s | 1.5, 2.4, 4.2 s | 2.9 to 5.6 s | 1 to 4 | 7 to 23 s |
   | Claude Code (sonnet) | 2.1 to 3.4 s | 3.6, 4.6, 8.6 s | 8.6 to 9.9 s | 0 | 10 to 16 s |
   | Codex (gpt-6.1-sol) | 15.8 to 16.9 s | the same | 16.5 to 17.5 s | 0 | 15 to 46 s |

   Before, the person saw nothing until the architect was done: about 22 s with a key, 65 to 77 s
   through Claude Code, 47 to 59 s through Codex (step 1). The first page within two seconds is
   met with the Anthropic key and twice of three with the gateway. It is not met through Claude
   Code, which starts its CLI per call, or through Codex, which hands over its text only when it
   is finished. Every page within five seconds is met only with the gateway. The code fixes had
   nothing to fix in any of the 12 runs; the gateway's drafts left 1 to 4 issues for the
   architect. Not measured: Cursor, an OpenAI key, the cloud. All tests pass with `fastCreate`
   and `durableRuns` on and off. "Wird vorbereitet …" was not seen in the browser, as no draft
   left an issue or had a widget.
4. **Dropped.** A prompt for ChatGPT is not built (Part 5). Chat apps get the wizard through
   the MCP server and MCP Apps, which are built.
5. **The shortcut on the server.** Part 4, in the branch's `answerGoesOn`. It is small, and every
   client gets it. Built on the branch (`890a34f7`); Part 4 says how. Measured on 2026-11-08 on a
   laptop, plain pages, 30 answers per set, at a load of 3 to 17, as the server logged it and as
   the client saw it:

   | Web and runner | `durableRuns` | Before: logged / client, median | Before: at most | After: logged / client, median | After: at most |
   |---|---|---|---|---|---|
   | One process | on | 9.5 / 24 ms | 32 / 234 ms | 4 / 15 ms | 8 / 27 ms |
   | One process | off | 6 / 16 ms | 78 / 119 ms | 3.5 / 15 ms | 8 / 24 ms |
   | Separate processes | on | 708 / 725 ms | 2007 / 2306 ms | 5.5 / 16 ms | 11 / 26 ms |
   | Separate processes | off | 1292 / 1370 ms | 1997 / 2026 ms | 4 / 14 ms | 8 / 24 ms |

   All 120 answers after it went the shortcut's way (`runner=no`). With separate processes, as on
   the cloud, the wait between plain pages goes from 0.7 to 1.3 s to about 15 ms.
6. **The next page in the browser.** Part 4: first `run.unsent` and saving what is typed, which is
   worth having alone, then `rev`, `ahead`, `nextInBrowser`. Built on the branch (`b0d0f879`,
   `db62e6e7`); Part 4 says how. Measured on 2026-11-08 on a laptop, from the click to the next
   page's heading in the browser, 30 answers per set, with two wizards of 11 pages: one plain, one
   with `remind` on every page, which takes the slow path:

   | Web and runner | Pages | Median | At most |
   |---|---|---|---|
   | One process | plain, shown ahead | 7 ms | 14 ms |
   | One process | the server's | 141 ms | 180 ms |
   | Separate processes | plain, shown ahead | 4 ms | 7 ms |
   | Separate processes | the server's | 1125 ms | 2970 ms |

   A plain page now shows in 4 to 7 ms, the answer reaching the server after it. Pages that need
   the server still wait for a runner: with separate processes about 1.1 s, at most 3 s. A refused
   answer (50 in a field of 1 to 10) brought the first page back after 24 ms with "Höchstens 10" and
   both typed values. With the server out of reach for 6 s, the next page showed with the note that
   the answers are not saved yet, and the server had the answer once it was back. The chat runner
   went the same way. All tests pass with `durableRuns` and `fastCreate` on and off.

   After it, the hand-off to a runner (Part 4, "After that"), measured the same way on the wizard
   with `remind`, web and runner apart, at a load of 3 to 5:

   | State | Median | At most |
   |---|---|---|
   | After step 6 | 1125 ms | 2970 ms |
   | The runner told at once (`4e675150`) | about 140 ms | 205 ms |
   | No credit hold at the answer (`641b0aec`), no change on a computer | about 135 ms | 174 ms |
   | The stream's first view at once (`2a2838b6`) | about 54 ms | 62 ms |

   The runner's own line shows it reaching the next page 8 to 19 ms after the answer.
7. **Test it all together.** Durable runs and this plan, on the one branch:
   - what `durable-agents.md` lists as not tested together: real models, Manage's part of telling
     people, a real mail, push, a real mailbox, the cloud's split roles, a 2-day wait across a deploy
     on staging, and the rest of that list;
   - what Part 1 lists as not tried: phone width, a translated run, page `data` reading a real AI
     step, a run with `calc` on a branch;
   - the targets of Part 3, on the cloud and on a computer with each AI client, and the test at the
     end of Part 4's "Saving".

   The local part is done (2026-11-08), on the branch at `2a2838b6`, in one process with
   `durableRuns`, `startTriggers` and `fastCreate` on, at a load of 4 to 23. No code failed, so
   there are no fix commits.

   - Part 1's open cases: Part 1, "Tried in step 7".
   - A durable AI step with the Anthropic key asked the person through `ask_person`. The server
     was stopped once while the run waited for the answer and once during a 1-minute wait; both
     times the run went on after the restart and ended done.
   - On an install whose text classes run on an AI client (Claude Code here), a durable step runs
     as a plain step: the log says `noDurable`, there is no `ask_person`, and the model guessed
     the answer. That is the design, but nothing tells the author (Open questions).
   - Part 3's targets, one creation per way, at a load of 12 to 23:

     | How it thinks | First page | Last page | Issues left |
     |---|---|---|---|
     | Anthropic key (claude-sonnet-5-5) | 1.9 s | 7.4 s | 0 |
     | Claude Code (sonnet) | 4.7 s | 9.1 s | 0 |
     | Gateway (deepseek-v4.1-flash) | 5.0 s | 9.1 s | 1 |
     | Codex (gpt-6.1-sol) | 20.7 s | 21.2 s | 0 |

     As in step 3: the first page within two seconds only with the Anthropic key, and with the
     gateway on a quiet machine. Cursor was not signed in.
   - Part 4's test: two pages answered in the browser, typing on the third, then away by
     navigation. Another session of the same member got the third page with both texts. A real
     browser's tab close was not tried (Part 4, "Built as step 6").

   Not tested on a computer, and why:

   - staging and a 2-day wait across a deploy, a real Manage-App role, the cloud's own
     containers with several web processes: they need a deploy, which waits for Matthias;
   - a real mail and Manage's part of telling people: the Manage-App sends them;
   - push: `POST /v1/push` in Manage is not built;
   - a real mailbox, a signed call from a real service, a real channel plugin: they need outside
     accounts; Outlook and IMAP are not built;
   - the Docker sandbox after a recovery: Docker Desktop was not running;
   - Cursor: not signed in.

Then Matthias decides whether the branch goes to `main`. A merge is not a release. Part 1 has no
switch, so it goes live with the first release after that merge; `durableRuns` and `fastCreate` stay
off until they are flipped.

## Changes by file

Built on the combined branch, for Part 1, the text form, the first pass, the shortcut and the next page in the browser:

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
| `packages/shared/src/wizard-text.ts` | new: `parseWizardText` (with `partial`), `printWizardText`; `TextCut.open` |
| `packages/shared/src/feature-flags.ts` | `fastCreate` |
| `packages/shared/src/catalog-prompt.ts` | new: `wizardTextTags`, `WIZARD_TEXT_EXAMPLES` |
| `packages/shared/src/surface.ts` | `SURFACE_COMPONENTS`, `SURFACE_REQUIRED` exported |
| `apps/runtime/src/services/first-pass.ts` | new: the first pass, the code fixes |
| `apps/runtime/src/services/architect.ts` | `fastCreateTurn`; `architectTurn` with `{ asked }` |
| `apps/runtime/src/agents/subscription.ts`, `chat-clients.ts` | `subscriptionText`: the CLI without tools, MCP or session |
| `apps/runtime/src/prompts/architect.md` | `firstpass.system`, `firstpass.lang`, `firstpass.followup` |
| `apps/runtime/src/texts.ts`, `apps/web/src/lib/i18n.ts` | the first pass's status lines, "Being prepared…" |
| `apps/web/src/studio/editor/ChatPanel.tsx`, `FlowDiagram.tsx` | the `preparing` event; steps marked while the architect works |
| `apps/runtime/src/engine/runner.ts` | `needsNoRunner`; `answerGoesOn`: the shortcut, `pushRun`, the timing line; `submitPage` and `reviewStep`: `kick` only when the run went on |
| `packages/shared/src/definition.ts` | `AheadRule`, `AheadPage`, `nextInBrowser` |
| `packages/shared/src/run.ts` | `RunView.rev`, `unsent`, `ahead`, `pagesSent`; `RunState.pagesSent` |
| `packages/shared/src/runner-texts.ts` | `run.saving`, `run.notSaved` |
| `apps/runtime/src/db/schema.ts`, tenant migration `0068_run_unsent` | `run.unsent` |
| `apps/runtime/src/engine/runner.ts` | `keepUnsent`, `aheadOf`; the view: `rev`, `unsent`, `ahead`, `pagesSent`; `submitPage`: sequence numbers, clears `unsent[stepId]` |
| `apps/runtime/src/routes/runs.ts` | `PUT /:id/pages/:stepId/unsent`; `seq`, `tab` and `rev` on `POST /:id/pages/:stepId` |
| `packages/runner/src/RunnerView.tsx`, `api.ts` | saves what is typed (`useKeepTyping`, `api.keep`); the saving notes |
| `apps/web/src/runner/useRun.ts` | pages in flight, one at a time; the page ahead; drops a view older than the last confirmed `rev`; retries; a refused page |
| new `apps/runtime/src/routes/peer.ts`, `secrets/signing.ts` | `POST /api/peer/runs/:id/take`; `peerTicket`, `peerTicketValid` |
| `apps/runtime/src/engine/runner.ts` | `kick` calls a runner that reports; `takeNow`; `RunState.holdLater`, the hold before the next step that costs |
| `apps/runtime/src/engine/events.ts` | `watchRun` every 100 ms for 15 s after a change |
| `apps/runtime/src/credits/credits.ts` | `reserveForRun` with the amount as a function |
| `apps/runtime/src/routes/runs.ts` | the stream's first view at once, then one per 40 ms |

Still to do:

| File | Change |
|---|---|
| `docs/content/dev` | the text form |

## Open questions

- A durable step on an install whose text classes run on an AI client runs as a plain step,
  without `ask_person`, and nothing says so while the wizard is written. Should the studio, which
  knows the install's models, warn there, or the authoring guide say it?
- The `noDurable` line at the start of such a step ("This step starts over after an interruption
  …") reads as if something had been interrupted. Its wording needs a look.
- Text in a page's components (a heading, a Metric's label, a caption from `calc`) stays in the
  original language in a translated run (Part 1, "Not built"). Step 7 saw it on a real run.

- Does the architect also write the text form for edits, or keep `edit_wizard` on JSON?
  Printing makes both possible; one form for both is simpler for the model.
- Can a CLI kept open reach two seconds on a computer with Claude Code, Codex or Cursor, or does
  the first pass there need the credits or an API key? With the CLI started per call, step 3's
  first page came after 3.6 to 8.6 s through Claude Code and 16 to 17 s through Codex. Codex and
  Cursor hand over their text only when it is finished, so keeping their CLI open does not bring
  the first page sooner than the whole draft. A CLI kept open is not measured.
- On a computer with Codex or Cursor, should the first pass go through the credits or a key when
  the person has either, and the AI client only for the architect after it?
- Should the text form get expressions for `in`, `notEmpty`, `empty`, `contains`, and a short
  way to give a calc its `as`? Today those are written as JSON (Part 2, rule 4), which a model
  may get wrong more often.
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
