---
title: Files and manifest
description: Where the runtime looks for plugins, what counts as one, and what engenty.plugin.json says.
version: 0.5.0
---

## Where the runtime looks

| Folder | What is in it |
|---|---|
| `modules/` of the runtime | Plugins that ship with engenty wizards |
| Each folder of `PLUGINS_DIR` (comma-separated) | Plugins of this install |

- An installed app looks in `~/.engenty/wizards/plugins` unless its `.env` names another folder.
- In a checkout `PLUGINS_DIR` is empty. `PLUGINS_DIR=examples/plugins` in `.env.local` loads
  the examples.
- A runtime that watches its plugins creates a folder of `PLUGINS_DIR` that is missing.

## What counts as a plugin

In such a folder:

| Entry | Is |
|---|---|
| `notify.ts`, `notify.js` | A plugin of one file. Its id is the file’s name |
| `contacts/engenty.plugin.json` | A plugin with a manifest |
| `hello/index.ts`, `hello/index.js` | A plugin without a manifest. Its id is the folder’s name |
| `node_modules/<package>`, `node_modules/@scope/<package>` | Installed packages that carry a manifest |

- The runtime skips names that begin with `.` or `_`.
- It doesn’t read `.mjs` files: Node keeps such a file once it is imported, so it could not load
  again.
- Of two plugins with the same id, the first one found stays. The other shows under “Not a
  plugin” in Settings → Plugins, as does a manifest that cannot be read.

## A plugin’s folder

```
contacts/
  engenty.plugin.json     the manifest
  src/
    plugin.ts             the server half
    schema.ts             its tables, for Drizzle
  migrations/
    0001_init.sql         the tables, as SQL
  ui/
    plugin.tsx            the studio half, as you write it
  dist/
    client.js             the studio half, built
    client.css
  package.json            only if it has dependencies of its own
```

Only the manifest is required. A plugin with a studio half must be a folder with a manifest.

## The manifest

`engenty.plugin.json` is the same file an engenty module has. The runtime keeps fields it
doesn’t know as they are.

```json
{
  "id": "contacts",
  "name": "Contacts",
  "version": "0.1.0",
  "description": "Keeps the email address of everyone who ran a wizard to its end."
}
```

| Field | | Default |
|---|---|---|
| `id` | Lower case, digits and `-`, starting with a letter, at most 40 characters. Part of the plugin’s addresses and of its tools’ ids | required |
| `name` | Shown in the settings | required |
| `version` | Shown in the settings | `0.0.0` |
| `description` | Shown in the settings | |
| `server` | The server half, from the plugin’s folder | `src/plugin.ts`, then `src/plugin.js`, then `dist/plugin.js` |
| `studio` | The built studio half | `dist/client.js` |
| `styles` | The built studio half’s styles | `dist/client.css` |

A path in the manifest must stay inside the plugin’s folder.

## Dependencies

| The plugin imports | It comes from |
|---|---|
| `@engenty/wizards/plugin`, `@engenty/wizards/plugin/thread`, `zod`, `drizzle-orm`, `drizzle-orm/sqlite-core` | The runtime’s own copies, wherever the plugin’s file is |
| Its own files | Beside it, as TypeScript |
| Anything else | A `node_modules` the plugin brings beside it |

For the studio half see [The studio half](./studio.md#what-the-studio-shares).
