---
title: Skills
description: Instructions your wizards work by – always, or when a wizard needs one. Add them from skills.sh, upload them or write your own.
version: 0.13.0
---

A skill is a set of instructions your wizards work by: how you write, what a quote must hold, how
to handle a PDF. You find them under **[Capabilities](./capabilities.md) › Skills** in the app bar,
after Sources.

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
space’s skills too and reads them when they help, and so does the space’s AI in a Work chat. In a
Work chat a skill’s scripts run too, once you switched them on for the skill.

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

A wizard reads a skill’s text files: instructions, references, examples, scripts. Other files,
such as fonts, templates or pictures, come along for the skill’s scripts, and the page shows them
as “for scripts”. skills.sh hands out text files only, so a skill that needs fonts or templates
comes as a zip upload.

The **Discover** tab of Capabilities › Overview searches skills.sh and integrations.sh at once: you view or add a
skill right in the results, marked “In this space” once the space has it.

## Run a skill’s scripts

Some skills bring scripts in Python or JavaScript, such as one that fills a PDF form. A script
runs only when you switch on **Run scripts** on the skill’s page. Every skill starts with it off,
also one from skills.sh.

With it on, an AI step that has the sandbox puts the skill’s folder there when it loads the skill,
and runs the scripts the instructions call for. A step without the sandbox, or a computer where
the sandbox is off, keeps the scripts as text.

The sandbox is connected to the internet. Read the scripts of a skill nobody checked before you
switch them on: one you uploaded, or one from a source skills.sh doesn’t list as official. The
page says so beside the switch.

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
| A whole skill | 1 MB of text in 100 files |
| Files for scripts | 5 MB each, 20 MB and 200 files per skill |
| Skills in a space | 100 |
| Skills always on | 5, with 20,000 characters together |

Skills come along with the [two-way sync](./cloud-sync.md) like the rest of the space.
