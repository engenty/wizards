---
title: Licensing
description: How we handle sharing the source and enable your usage.
version: 0.21.1
---

The wizard format, the runner and four libraries are under the MIT licence. Anyone may read,
write and run wizards in their own tools, open or closed. The studio, the runtime and the rest of the code are
source available under FSL-1.1-MIT.

## MIT

Use it, change it and share it in any app, open or closed. Keep the licence text with it.

| Part | Where | Licence |
|---|---|---|
| The wizard format | fifteen files in `packages/shared/src` | MIT or FSL-1.1-MIT, your choice ([LICENSE-MIT](https://github.com/engenty/wizards/blob/main/packages/shared/LICENSE-MIT)) |
| The runner | `@engenty/wizards-runner` in `packages/runner` | MIT ([LICENSE](https://github.com/engenty/wizards/blob/main/packages/runner/LICENSE)) |
| The plugin for the AI apps | `plugin/`, without the engenty figures in it | MIT ([LICENSE](https://github.com/engenty/wizards/blob/main/plugin/LICENSE)) |
| The libraries | `@engenty/chatviews`, `@engenty/decision-model`, `@engenty/search-index`, `@engenty/search-libsql`, `@engenty/tool-harness`, `@engenty/vault`, `@engenty/plugins`, `@engenty/browser`, `@engenty/model-providers` and `@engenty/model-setup` in `packages/` | MIT (the `LICENSE` in each folder) |

### The wizard format

These fifteen files define a wizard, read it and pack it as a `.wizard` file:

- `definition.ts`, `fit.ts`, `run.ts`, `runner-texts.ts`
- `run-schema.ts`: what a wizard takes and gives, as JSON Schema
- `sharing.ts`, `store.ts`, `texts.ts`, `translation.ts`
- `theme.ts`: a theme’s values, which a `.wizard` file carries
- `wizard-data.ts`: the SQL of a wizard’s own data, read and checked
- `wizard-package.ts`: the `.wizard` file and its `wizard.json`
- `engenty/data-tables/columns.ts`, `columns-format.ts`, `columns-value.ts`

Each says `SPDX-License-Identifier: FSL-1.1-MIT OR MIT` in its first line, and you choose which
of the two licences you take them under. Take MIT, and you can use the format in any tool: an
editor, a converter, your own runtime. The files import only each other, zod and `@engenty/chatviews` (MIT: the views, the calc
language and the shapes of data), so they work without the rest of engenty wizards.

### The runner

`@engenty/wizards-runner` draws a wizard’s run: its pages, fields, reviews and results. It is
MIT, the format files it bundles included. Your own app can draw runs with it
([Your own UI](./integration/own-ui.md)).

### The libraries

Ten libraries go to npm with each release, at its version:

- `@engenty/decision-model`: one request to a decision model, by whichever way is set up (the
  Vercel AI Gateway, TypeSafe’s API or Ollama)
- `@engenty/search-index`: what every search index meets, chunks, scoring, embedders and the ways
  to one, and a search over a catalogue in memory by words and meaning
- `@engenty/search-libsql`: a search index on libSQL, full text and vectors
- `@engenty/tool-harness`: one harness around an agent’s tools: the few it always has, a search
  for the rest, one call that runs what was found, and what a model of which level may use
- `@engenty/vault`: secrets sealed with AES-256-GCM and bound to where they belong, key rings
  for a new key, keys from the environment, a private file or the macOS Keychain, a
  redactor that keeps secret values out of text, and what a password vault needs: which
  websites a login fits, authenticator codes and the CSV exports of password managers
- `@engenty/plugins`: the plugin contract engenty wizards and wizards.bot both load: the
  manifest, finding plugins in folders, a plugin’s tools, and a host that runs them in a Node
  process with fewer rights
- `@engenty/browser`: a browser for agents on Mastra’s agent-browser provider: its tools for any
  tool system, none that runs the model’s JavaScript, and a private fill that types a password
  or a code only into a field on the expected website
- `@engenty/model-providers`: every way an app reaches a model. The servers for open models on a
  person’s own computer: Ollama (its models, what each can do, which fits the memory, downloads,
  and a model on its own chat API with the context length set), LM Studio and Apple MLX. The AI
  clients signed in on their subscription (Claude Code, Codex, Antigravity, Cursor Agent: found,
  signed in, run headless as a model or as a chat with one MCP server). The providers a person
  brings a key for (OpenAI, Anthropic, Google, OpenRouter, the Vercel AI Gateway and more: who
  they are, the test of a key, a model on it). The wizards account’s gateway. And a short real
  call that says whether each answers
- `@engenty/model-setup`: the setup in which a person picks what an app thinks with, shared by
  engenty wizards and wizards.bot: the AI clients it offers, how each is found, installed and
  signed in through a terminal in the page, and the routes the page asks

They depend only on each other and on packages under MIT or a licence as permissive.

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
