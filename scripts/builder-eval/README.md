# Builder eval

How well the studio's architect turns a wish into a wizard. Each wish in `wishes.json` goes to
`/api/studio/wizards/:id/chat` the same way "Wizard bauen" on `/studio/new` sends it. The script
keeps the wizard, the reply and the time, and writes `report.md`.

```bash
API=http://127.0.0.1:<api port> node scripts/builder-eval/run.mjs <outDir> [--only id,id] [--parallel 2]
```

You need a dev server from source with `DEV_LOGIN=1` and models set up. Each wish takes one or two
minutes and spends credits like a studio turn. The wizards stay in the space, so you can open them
in the studio afterwards.

## What the script measures

- **shape**: the step types in order (`form → agent → generate:image → result`), page and field
  counts, model steps, images, branches, reviews, tool steps, whether it keeps data between runs,
  whether it writes into another system.
- **misses**: the shape checked against each wish's `expect` (no image wanted, no model step
  needed, a branch, collecting, writing).
- **the usual shape**: questions, then a model step, then an image. The count of these shows
  whether every wish still comes out the same.
- **issues** left by the validator, the time, and whether the reply ends in a question.

## Rubric (a person or a model scores each wizard 0–2)

| | 0 | 1 | 2 |
|---|---|---|---|
| Fits the wish | builds something else | the core is there, parts are missing or extra | does what was asked |
| Asks only what it needs | asks for things the result never uses | one or two fields too many | every field is used |
| Every step earns its place | AI or image steps with no purpose | one step too many | nothing to take out |
| Result | generic text | usable | designed for the person who gets it |
| Assumptions | assumes silently on a vague wish | says some of them | asks the one deciding question, or names what it assumed |

Compare a prompt change against a baseline on the whole set, not on a single wish: replies vary
between runs (`apps/runtime/src/prompts/README.md`).
