---
title: Developer
description: The wizard format, wizards in other systems and the runner, and plugins that extend engenty wizards.
version: 0.7.10
---

These pages are for people who write wizards as files, bring them into other systems or extend
engenty wizards. A wizard is one JSON document. The runner shows it to people page by page, on
its own page, on a website, in a chat or in your own app.

## Start here

| | |
|---|---|
| [The wizard format](./wizard-format/index.md) | A wizard as JSON: its steps, fields, templates and branches |
| [JSON Schema](./wizard-format/validate.md) | The JSON Schema for your editor and `wizards validate` |
| [Integration](./integration/index.md) | A published wizard for people, for AI apps and for your own code |
| [Your own UI](./integration/own-ui.md) | Your app draws the run with `@engenty/wizards-runner` |
| [Plugins](./plugins/index.md) | Tools for AI steps, routes with their own tables, pages in the studio |
| [The API](./api.md) | What a program may rely on, what is private, and how a client names itself |

## Wizards as files

A wizard is JSON, and it travels as a `.wizard` file. [The wizard format](./wizard-format/index.md)
describes every step type and field, the `.wizard` file, the JSON Schema for your editor and
`wizards validate`.

## Wizards in other systems

[Integration](./integration/index.md) shows how a published wizard reaches other systems: people
over a link, a website or a channel, AI apps over MCP, and your own code with the runner.

## Plugins

A plugin adds to a runtime without changing its code, and the runtime loads it from its files
while it runs. Start with [What a plugin is](./plugins/index.md) or the
[Quick start](./plugins/quick-start.md): a tool for AI steps in one file that works in two
minutes. The [Reference](./plugins/reference.md) lists every call, type, address and setting,
and [Examples](./plugins/examples.md) has two plugins to read and copy.

## What you need for a plugin


- engenty wizards on your computer, or a checkout of
  [engenty/wizards](https://github.com/engenty/wizards).
- TypeScript. The runtime reads a plugin’s server half as TypeScript, without a build.
- A checkout, if your plugin draws in the studio: you build its studio half with the studio’s
  own tools.

## Working on engenty wizards itself

These pages are about wizards and plugins. The documents about its own code are in the
repository:

| | |
|---|---|
| [docs/development.md](https://github.com/engenty/wizards/blob/main/docs/development.md) | How to run it from source, the checks, how it is built and how it is released |
| [docs/marketplace-contract.md](https://github.com/engenty/wizards/blob/main/docs/marketplace-contract.md) | What a runtime and the marketplace say to each other |
| [docs/copy-style.md](https://github.com/engenty/wizards/blob/main/docs/copy-style.md) | How the app talks to people: the voice, the glossary and the rules for every string |
