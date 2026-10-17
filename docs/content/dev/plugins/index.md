---
title: Plugins
description: What a plugin is, what its two halves can add, and what it may touch.
version: 0.5.0
---

A plugin adds to a runtime without changing its code. The runtime finds plugins when it starts,
loads them from their files and loads a plugin again when its files change.

## What a plugin can add

| It adds | Where it shows | Page |
|---|---|---|
| A tool for AI steps | In a step’s tool list, in the assistant’s and the MCP authoring guide | [Tools](./tools.md) |
| A runner: a door a wizard runs through, with the run API that drives runs from it | In the share dialog’s channels, at `/w/<token>/<runner>`, on the wizard’s first page | [Runners](./runners.md) |
| A runner’s settings and setup in the share dialog | In the share dialog, behind its gear and behind “Set up” in the runner’s row | [Runners](./runners.md#the-runners-part-of-the-share-dialog) |
| A block and tools for every AI step of a space | In the steps’ instructions | [The space](./space.md) |
| Pages, tables and files of a space’s Knowledge, with their categories | In Knowledge, and in what `project_search` finds | [The space](./space.md#knowledge-a-plugin-writes) |
| Texts in a space’s search index | In what `project_search` finds | [The space](./space.md#the-search-index) |
| Tools of the studio’s assistant, and their cards | In the assistant’s chat, on every page. For now the assistant is off unless it is switched on | [The space](./space.md#tools-of-the-space-assistant) |
| Routes | Below `/api/studio/plugins/<id>`, for programs with a key below `/api/v1/plugins/<id>`; public ones below `/api/public/plugins/<id>`, one for every tenant below `/api/public/plugins/<id>/shared` | [Routes](./routes.md) |
| Tables | In every tenant’s database | [Tables](./tables.md) |
| A listener on runs that end and spaces that change | Nowhere: it works in the background | [Events](./events.md) |
| A job, again and again | Nowhere: it works in the background | [The server half](./server.md#jobs) |
| The team’s own number for texts and calls, on engenty.ai | Where the plugin’s runner and pages use it | [The server half](./server.md#numbers-of-the-manage-app) |
| An account of a space (a calendar, a mailbox), signed in through a built-in connector | Where the plugin’s own pages offer it | [Accounts](./connections.md) |
| A wizard as a template | First among the templates of a new wizard, and in the MCP `list_starters` | [Starters](./starters.md) |
| A page of the studio | Behind an icon in the app bar, or at its address | [The studio half](./studio.md) |
| A section of the settings | In the settings’ list | [The studio half](./studio.md) |
| A section of the space page | In one of its parts, below the part’s own sections | [The studio half](./studio.md#the-space) |
| A part of the space page | In the space’s menu, beside Info & brand, Knowledge, Data and Results | [The studio half](./studio.md#a-part-of-the-plugins-own) |

## Two halves

| | Server half | Studio half |
|---|---|---|
| File | `src/plugin.ts`, or the one file a small plugin is | `ui/plugin.tsx`, built to `dist/client.js` and `dist/client.css` |
| Runs in | The runtime | The studio, after sign-in |
| Loaded | As TypeScript, no build | As the built script |
| Types | `@engenty/wizards/plugin` | `@engenty/wizards/plugin/studio` |
| Adds | Tools, runners, routes, tables, listeners, jobs, starters, accounts, Knowledge, the space’s block, index and assistant tools | Pages, icons in the app bar, sections of the settings and of the space page, parts of the space page, a runner’s settings and setup in the share dialog, cards in the assistant’s chat |

A plugin has one half or both. The studio half talks to the server half over the plugin’s own
routes.

```mermaid
flowchart LR
  page["Studio half, in the browser<br/>ui/plugin.tsx<br/>pages, app bar, settings"]
  runner["The runtime's step runner"]
  server["Server half, in the runtime<br/>src/plugin.ts<br/>tools, routes, listeners"]
  db[("Tenant database<br/>the plugin's tables")]
  page -- "the plugin's routes" --> server
  runner -- "calls a tool, says a run ended" --> server
  server --> db
```

## What a plugin may touch

A plugin runs inside the runtime’s process with all of its rights. It can read every tenant’s
data, the install’s settings and the files of the computer it runs on. There is no sandbox and
no permission list.

- Install only code you know.
- A plugin for others says in its own description what it reads and where it sends it.

## Not the Claude Code plugin

The “Claude Code plugin” of engenty wizards is something else: it is what a runtime hands to
Claude Code (`plugin/` in the repository). These pages are about plugins of the runtime.

## Not there yet

- A plugin can’t bring connectors of its own, or tools for MCP clients and AI apps. It connects
  accounts through the built-in connectors: [Accounts](./connections.md).
- A plugin can’t add new kinds of steps or fields: the public pages of a wizard load no plugin.
  A plugin’s runner is served whole at its own sub-path; nothing is loaded into the page or the
  chat.
- You can’t build a studio half without a checkout of the repository.
