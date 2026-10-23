---
title: Skills
description: Instructions your wizards work by – always, or when a wizard needs one. Add them from skills.sh, upload them or write your own.
version: 0.11.3
---

A skill is a set of instructions your wizards work by: how you write, what a quote must hold, how
to handle a PDF. You find them under **Sources › Skills**. Skills are not switched on for
everyone yet.

A skill is a folder in the open Agent Skills format: a `SKILL.md` with a name, a description and
the instructions, and any text files the instructions point to. The same skill works in Claude,
Codex and other tools.

## When a skill applies

Each skill has one of three settings:

- **Always on.** Every AI step of every wizard in the space follows it. Use it for rules that
  always hold, such as your tone or what you never promise. It costs tokens on every run, so at
  most 5 skills can be always on, with 20,000 characters together.
- **On demand.** A wizard sees the skill’s name and description, and reads the skill when the
  description fits its task. The description decides, so write it as “what it is for and when it
  is needed”.
- **Off.** The skill stays in the space, and no wizard sees it.

A wizard reads a file of a skill when the skill’s instructions point to it. Goose sees the
space’s skills too and reads them when they help.

## Add a skill

“Add” offers three ways, and the search in the middle of the page finds skills both in your space
and on skills.sh:

- **From skills.sh.** Search the open directory of skills. Skills from organizations that skills.sh
  lists as official show “official source”, and the search shows only those until you switch
  “Official sources only” off. Every other skill shows “not checked”. You see each skill whole
  before you add it: its instructions and its files.
- **Write a skill.** Give it a name (lower-case letters, digits and hyphens) and a description,
  then write the instructions.
- **Upload.** Drop a `SKILL.md`, a `.zip` or a `.skill` file on the page. A zip brings the folder
  of its `SKILL.md` along.

A skill holds text files only. Pictures and other files are left out, and the page says which. A
script in a skill comes along as text: engenty wizards never runs it.

## Edit a skill

Your own skills save as you type. The name and the description stand at the top. “Code” shows
the whole `SKILL.md`, “Preview” shows the instructions as they read. A file opens in a dialog.

A skill from skills.sh stays as it came. When skills.sh has a newer version, the skill’s page
says so, and you see the changes before you take them (“View changes”). To change it yourself,
copy it as your own skill.

“Download as .zip” gives you the skill’s folder, for another tool or another space.

## Limits

| | At most |
| --- | --- |
| `SKILL.md` | 100 KB |
| Any other file | 256 KB |
| A whole skill | 1 MB and 100 files |
| Skills in a space | 100 |
| Skills always on | 5, with 20,000 characters together |

Skills come along with the [two-way sync](./cloud-sync.md) like the rest of the space.
