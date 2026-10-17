---
title: Plugins
description: Add pages, settings and tools for steps to engenty wizards on your computer. What a plugin may do, and how to install one.
version: 0.5.0
---

A plugin adds to engenty wizards without changing it:

| It can add | Where you find it |
|---|---|
| Tools for AI steps | In a step’s tool list, beside the built-in ones |
| What every AI step of a space knows | Nowhere: the steps get it, with tools to look things up |
| A page | Behind an icon in the studio’s app bar |
| A settings section | In the settings |
| A section of the space page | In one of the space page’s parts |
| A part of the space page | In the space’s menu, beside Info & brand, Knowledge and Data |
| A template | First among the templates of a new wizard |
| A channel a wizard runs through | Under “How should it run?” on a new wizard, and under “How others reach it” in the share dialog, where “Set up” opens the plugin’s own setup |
| Something that happens when a run ends, or again and again | Nowhere: it works in the background, for example posts a message |

> A plugin runs with the app’s full rights: it reads your wizards, your results, your settings
> and the files on your computer. Install only plugins you trust.

## Install one

A plugin is a file or a folder. Put it into the plugins folder of engenty wizards:

```bash
~/.engenty/wizards/plugins
```

- engenty wizards notices a new plugin while it runs. You don’t need to restart it.
- A plugin’s own instructions say which settings it needs. They go into the
  [settings file](./command-line.md#settings).
- To use another folder, name it with `PLUGINS_DIR` in the settings file. You can name several,
  separated by commas. They replace the plugins folder above, so name that one too if you want
  to keep it.

## See what is installed

Settings → Plugins lists the plugins with their version and the tools they add. The section
appears once there is a plugin, or a file that looks like one. It also appears while you are
signed in to an account.

| Button | What it does |
|---|---|
| Reload | Loads one plugin again from its files |
| Look again | Loads all plugins again and finds new ones |

- “The server part didn’t load” or “The studio part didn’t load” says what went wrong with a
  plugin. The plugin adds nothing until that is fixed.
- “Not a plugin” lists files in the plugins folder that look like a plugin but aren’t one.

## Remove one

Delete its file or folder. Tables the plugin made in your database stay, with their rows.

## Wizards that use a plugin’s tool

A wizard that lists a plugin’s tool runs only where that plugin is installed. Elsewhere the
editor shows an issue, and a run stops at that step. Keep that in mind when you export a wizard
or publish it to the cloud.

## On engenty.ai

engenty installs the plugins in the cloud. Settings → Plugins lists the ones switched on for your
account.

## Write your own

See the [developer docs](../dev/plugins/index.md).
