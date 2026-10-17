---
title: Developer
description: Extend engenty wizards with plugins – tools for AI steps, routes with their own tables, pages in the studio.
version: 0.7.3
---

You extend engenty wizards with **plugins**. A plugin adds to a runtime without changing its
code, and the runtime loads it from its files while it runs.

## Start here

| | |
|---|---|
| [What a plugin is](./plugins/index.md) | The two halves, what each can add and what a plugin may touch |
| [Quick start](./plugins/quick-start.md) | A tool for AI steps in one file that works in two minutes |
| [Reference](./plugins/reference.md) | Every call, type, address and setting |
| [Examples](./plugins/examples.md) | Two plugins to read and copy |

## Wizards as files

A wizard is JSON, and it travels as a `.wizard` file. [The wizard format](./wizard-format.md)
describes the format, the JSON Schema for your editor and `wizards validate`.

## Wizards in other systems

[Integration](./integration/index.md) shows how a published wizard reaches other systems: people
over a link, a website or a channel, AI apps over MCP, and your own code.

## What you need

- engenty wizards on your computer, or a checkout of
  [engenty/wizards](https://github.com/engenty/wizards).
- TypeScript. The runtime reads a plugin’s server half as TypeScript, without a build.
- A checkout, if your plugin draws in the studio: you build its studio half with the studio’s
  own tools.

## Working on engenty wizards itself

These pages are about extending engenty wizards. The documents about its own code are in the
repository:

| | |
|---|---|
| [docs/development.md](https://github.com/engenty/wizards/blob/main/docs/development.md) | How to run it from source, the checks, how it is built and how it is released |
| [docs/marketplace-contract.md](https://github.com/engenty/wizards/blob/main/docs/marketplace-contract.md) | What a runtime and the marketplace say to each other |
| [docs/copy-style.md](https://github.com/engenty/wizards/blob/main/docs/copy-style.md) | How the app talks to people: the voice, the glossary and the rules for every string |
