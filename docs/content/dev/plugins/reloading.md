---
title: While it runs
description: Save a file and the plugin loads again – what reloads, what survives, and how to work on a plugin.
version: 0.5.0
---

A runtime that runs alone watches its plugins. You don’t need to restart it while you write one.

## What happens on a change

| You change | What happens |
|---|---|
| A file of the server half | The plugin loads again: what it registered is removed, its `onUnload` functions run, and its files are read again |
| `dist/client.js`, `dist/client.css` | The open studio takes the new files in place. A page of the plugin that is open stays open |
| A file below `ui/` | Nothing happens until it is built: the change counts once `dist/` changes |
| A new file or folder in a plugins folder | The runtime looks again: new plugins load, the others stay as they are |
| A plugin’s file or folder is removed | That plugin unloads. Its tables stay |
| A new `.sql` file | It runs on the open tenant databases with the reload |
| An npm dependency of the plugin | It needs a restart: Node keeps a package once it is imported |
| The manifest’s `id` | The plugin is gone under the old id and loads under the new one |

A reload takes about as long as reading the files: well under a second.

## What survives a reload

| | |
|---|---|
| Rows in the plugin’s tables | Stay |
| Variables of the module | Start again |
| A step that is running | Keeps the tools it started with |
| Timers, sockets, watchers | Are yours to stop: `server.onUnload`, `studio.onUnload` |
| A plugin page open in the studio | Stays open, drawn by the new code |

## A plugin that breaks

A plugin that fails when it loads again stays out until you fix its file: its tools are gone and
its routes answer `404`. Settings → Plugins shows the error. Save the fixed file and the plugin
is back.

## By hand

Settings → Plugins has two buttons for owners and admins of a runtime that runs alone:

| Button | What it does |
|---|---|
| “Reload”, the arrow on a plugin’s row | Loads that plugin again |
| “Look again” | Loads every plugin again, finds new ones and drops missing ones |

`PLUGINS_WATCH=0` in the install’s `.env` turns the watching off; the buttons still work.

## Working on a plugin

A loop that needs no restart, from a checkout:

1. Put the plugin’s folder somewhere and name its parent in `PLUGINS_DIR` (`.env.local`).
2. Start the app:

   ```bash
   pnpm dev
   ```

3. In a second terminal, build the studio half on every save:

   ```bash
   node scripts/build-plugin.mjs <plugin folder> --watch
   ```

4. Open the plugin’s page in the studio and edit. The server half reloads when you save, and
   the page updates once the build has finished.

The runtime’s log names the plugins it loaded at start (`plugins: contacts, workdays`) and says
why a plugin did not load.

## On engenty.ai

Nothing reloads there: a new version of a plugin arrives when the service starts again.
