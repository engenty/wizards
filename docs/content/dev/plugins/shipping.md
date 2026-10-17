---
title: Shipping
description: Hand a plugin to someone else, put it into a server's image, and decide which tenant has it.
version: 0.5.0
---

## To someone’s install

A plugin is a file or a folder. Whoever installs it puts it into their plugins folder, which is
`~/.engenty/wizards/plugins` for an installed app.

Give them:

| | |
|---|---|
| One file | `notify.ts` |
| A folder | The manifest, `src/`, `migrations/`, and the built `dist/`. Not `ui/`: it is the source of `dist/` |
| Dependencies | A `node_modules` beside the plugin, if it imports anything but the SDK, `zod` and `drizzle-orm` |
| Settings | The names of the `.env` lines it reads, in its description |

Say what the plugin does with data. A plugin runs with the app’s full rights, and the person who
installs it trusts you with them.

## As a package

Packages installed into a plugins folder count as plugins when they carry a manifest:

```bash
cd ~/.engenty/wizards/plugins
npm install @acme/wizards-contacts
```

The runtime finds `node_modules/@acme/wizards-contacts/engenty.plugin.json` at its next start,
or with “Look again” in Settings → Plugins. Put the manifest, the server half and the built
`dist/` into the package’s `files`.

## Into a server

With Docker, mount a folder and name it:

```yaml
services:
  wizards:
    environment:
      PLUGINS_DIR: /plugins
    volumes:
      - ./plugins:/plugins
```

Or copy the plugins into an image of your own, built on the runtime’s.

## With engenty wizards itself

Plugins in the repository’s `modules/` folder ship with every runtime: in a checkout, in the
npm package and installed app, and in the Docker image. A module there is part of the open
product.

- Its server half imports only what the runtime hands every plugin, and its own files. It has no
  `node_modules` of its own where it is installed.
- A module with a studio half is a workspace package whose `build` script is
  `node ../../scripts/build-plugin.mjs .`, so the product’s build builds its `dist/`.
  `apps/runtime/Dockerfile` copies each workspace package’s `package.json` before it installs:
  add the module’s there.

A plugin that is not part of the open product stays out of `modules/` and goes into a folder of
`PLUGINS_DIR`.

## Which tenant has a plugin

On an install of your own, on your computer or your own server, every tenant has every plugin
the runtime loaded. On engenty.ai the service installs the plugins and switches them on per
account. A person cannot install a plugin there.

## Versions

- The settings show `version` from the manifest. The runtime doesn’t compare versions.
- A plugin’s `.sql` files only ever grow: an update adds files and never changes one that ran.
- A wizard that uses a plugin’s tool names it by its id. Renaming a tool or the plugin breaks
  those wizards, so keep ids for good.
