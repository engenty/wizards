---
title: Licensing
description: How we handle sharing the source and enable your usage.
version: 0.11.2
---

The wizard format and the runner are under the MIT licence. Anyone may read, write and run
wizards in their own tools, open or closed. The studio, the runtime and the rest of the code are
source available under FSL-1.1-MIT.

## MIT

Use it, change it and share it in any app, open or closed. Keep the licence text with it.

| Part | Where | Licence |
|---|---|---|
| The wizard format | sixteen files in `packages/shared/src` | MIT or FSL-1.1-MIT, your choice ([LICENSE-MIT](https://github.com/engenty/wizards/blob/main/packages/shared/LICENSE-MIT)) |
| The runner | `@engenty/wizards-runner` in `packages/runner` | MIT ([LICENSE](https://github.com/engenty/wizards/blob/main/packages/runner/LICENSE)) |
| The plugin for the AI apps | `plugin/`, without the engenty figures in it | MIT ([LICENSE](https://github.com/engenty/wizards/blob/main/plugin/LICENSE)) |

### The wizard format

These sixteen files define a wizard, read it and pack it as a `.wizard` file:

- `definition.ts`, `fit.ts`, `numbers.ts`, `run.ts`, `runner-texts.ts`, `shape.ts`
- `sharing.ts`, `store.ts`, `surface.ts`, `texts.ts`, `translation.ts`
- `theme.ts`: a theme’s values, which a `.wizard` file carries
- `wizard-package.ts`: the `.wizard` file and its `wizard.json`
- `engenty/data-tables/columns.ts`, `columns-format.ts`, `columns-value.ts`

Each says `SPDX-License-Identifier: FSL-1.1-MIT OR MIT` in its first line, and you choose which
of the two licences you take them under. Take MIT, and you can use the format in any tool: an
editor, a converter, your own runtime. The files import only each other and zod, so they work
without the rest of engenty wizards.

### The runner

`@engenty/wizards-runner` draws a wizard’s run: its pages, fields, reviews and results. It is
MIT, the format files it bundles included. Your own app can draw runs with it
([Your own UI](./integration/own-ui.md)).

## FSL-1.1-MIT

The Functional Source License lets you use the code for yourself and your company, run it and
change it. You may not offer it to others as a competing product or service. Each release
becomes MIT two years after it is published.

| Part | Where |
|---|---|
| The studio | `apps/web` |
| The runtime and the `wizards` command | `apps/runtime`, `bin/` |
| What your code imports, `@engenty/wizards` on npm | `packages/wizards` |
| The rest of `packages/shared` | including `theme-look.ts`, which turns a theme into the look of a run |
| Everything else in the repository | unless COPYRIGHTS.md names another licence |

The licence: [LICENSE](https://github.com/engenty/wizards/blob/main/LICENSE).

## CC BY 4.0

The engenty figures are free artwork. Use, change and share them, commercially too, with
credit.

| Part | Where |
|---|---|
| The engenty figures as artwork | the files that describe how they look, and their pictures |

The licence: [LICENSE-FIGURES](https://github.com/engenty/wizards/blob/main/LICENSE-FIGURES).

## Trademarks

No licence grants rights to the name or the figures as a brand. Using them as your own brand,
logo or mascot needs permission.

| Part | Where |
|---|---|
| “engenty”, “engenty wizards” and the wordmark | everywhere they appear |
| The engenty figures as a brand | everywhere they appear |

The rules: [TRADEMARKS.md](https://github.com/engenty/wizards/blob/main/TRADEMARKS.md).

## The exact files

[COPYRIGHTS.md](https://github.com/engenty/wizards/blob/main/COPYRIGHTS.md) lists the exact
files under each licence. Where it and this page differ, COPYRIGHTS.md and the licence files
count.
