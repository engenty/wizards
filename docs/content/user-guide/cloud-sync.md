---
title: Spaces in the cloud
description: How engenty wizards on your computer keeps its spaces the same as your organization’s spaces at engenty.ai, both ways, and what happens when both sides change the same thing.
version: 0.9.8
---

With an account signed in, engenty wizards on your computer keeps its spaces the same as your
organization’s spaces at engenty.ai. What you change on your computer arrives in the cloud, and
what someone changes in the cloud’s studio arrives on your computer. You can work offline: your
changes wait and go up once the cloud can be reached.

A computer is signed in to one organization. Everything on it syncs with that organization. To
work in another one, sign in again and pick it (Settings → Account, or
`wizards account sign-in` in the terminal).

## What syncs

| Syncs both ways | Stays where it was made |
|---|---|
| The space: name, what it says about itself, brand, facts, themes, its public page | Runs and results |
| Wizards: the draft, its files, translations and the chat you built it with | Chats with the studio’s assistant |
| Knowledge: pages, tables and their rows, categories | What wizards keep for people: their lists, files and sign-ins |
| The space’s files | Connected accounts and keys |
| Connectors | The model settings, and the headers of connected systems |

Publishing on your computer publishes the wizard here, then in the cloud, as its next version
there. Its address at engenty.ai stays the same. If the cloud can’t be reached, the studio
publishes there again by itself later.

## When it syncs

engenty wizards syncs when you save, when you open a wizard, page, table or space, and once a
minute in between. Nothing changes about how you save.

Settings → Spaces in the cloud lists every space with a switch, “Keep the same as in the cloud”.
It shows each space’s state:

| It shows | Means |
|---|---|
| Up to date | Both sides are the same. “Last arrived” says when the last change came down |
| 3 changes wait | They go up at the next sync. “Check now” syncs right away |
| Only on this computer | The switch is off, and the space stays here |
| Only in the cloud | The switch is off for a space of the cloud. Switch it on to have it here |
| The cloud runs a newer version | The sync waits until you update engenty wizards (`wizards update`) |
| This computer runs a newer version than the cloud | Your changes go up once the cloud is updated |
| The cloud can’t be reached right now | Your changes wait here |

New spaces, made here or in the cloud, sync without you switching them on.

## When both sides changed the same thing

Usually the two changes fit together. Say you changed a page’s first paragraph and someone in the
cloud changed its last one. The studio then merges them by itself, and the page shows “Merged with
changes from the cloud”, with what changed where. “Undo, keep mine” or “Undo, keep the cloud’s”
takes one side back.

When both sides changed the same place, for example a wizard’s title, the studio asks which
version stays. You see it on the wizard, page or table, in the bar above every page, and under
Settings → Spaces in the cloud:

| Choice | Does |
|---|---|
| Keep the cloud’s version | Your change here is replaced |
| Keep this computer’s version | Your change goes up and replaces the cloud’s |
| Choose place by place | Shows each place that differs, and you pick a side for each |
| Ask AI for a proposal | The AI writes a version with both changes. Nothing changes until you take it |

Until you decide, each side keeps its own version, and the published version keeps running.

## Who can change what

Your role in the organization counts on your computer too. Owners and admins change everything.
Members change wizards, knowledge and files, but they don’t add or delete wizards, and they don’t
change the space’s settings or its connectors. The cloud refuses what your role doesn’t allow, and
Settings → Spaces in the cloud says which changes it didn’t take.

## Switch it off

To keep a space on your computer alone, turn its switch off under Settings → Spaces in the cloud.
To keep everything here, sign out under Settings → Account. To turn the sync off on this computer
but keep the account, add this line to `~/.engenty/wizards/.features`:

```bash
twoWaySync=off
```
