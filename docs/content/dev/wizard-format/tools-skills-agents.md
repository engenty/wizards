---
title: Tools, skills and agents in the wizard
description: Code and instructions a wizard brings in its own files, for its own steps.
version: 0.18.0
---

A wizard can bring what its steps work with in its own workspace, under `files/` in the
`.wizard` file. Its steps use it like the space’s own. Other wizards don’t see it.

## Skills

A skill of the wizard is a folder in the workspace, in the same format as the space’s skills:

```
files/
└── skills/
    └── supplier-forms/
        ├── SKILL.md
        ├── reference/fields.md
        └── scripts/fill.py
```

```markdown
---
name: supplier-forms
description: Fills a supplier's order form from our item list. Use it when a step orders from a supplier.
mode: always
---

# Supplier forms

Read [the field list](reference/fields.md) first. Fill the PDF with
[fill.py](scripts/fill.py): `python3 skills/supplier-forms/scripts/fill.py items.json form.pdf`.
```

| Key | What it is |
|---|---|
| `name` | The folder’s name: lower-case letters, digits and hyphens, at most 64 characters |
| `description` | When a step uses the skill, at most 1,024 characters |
| `mode` | `always` puts the skill whole into every AI step. Left out, a step loads it on demand |

Any other key stays in the file as it is, as `license` or `metadata` would.

### Where it counts

Every AI step of the wizard sees the wizard’s skills, the way it sees the space’s:

- **Always on.** The skill stands whole in the step’s instructions. A generate step for a
  document or a dashboard gets it too.
- **On demand.** The step sees the skill’s name and description. Its model loads the skill with
  `skill_load` when one fits the task, and reads a file of it with `skill_read`.

A skill of the wizard comes before a skill of the space with the same name. The space’s skill
is then left out of the wizard’s steps. Each load and each file read is a line of the space’s
audit, under `skill:wizard.<name>`, and the space’s rights for skills decide it.

A motion-graphics step that names `skills/<name>` reads the same folder.

### Scripts

A step with the `sandbox` tool gets the skill’s folder at `skills/<name>/` in the sandbox when
it loads the skill. Its model runs the scripts there with `run_command`. The sandbox runs on
your computer and where Docker is the engine. The cloud has no sandbox for wizard code yet.

Without the sandbox, the skill’s text still counts and its scripts don’t run.

### When to write one

A skill is for open work, where the model decides what to read and what to run: a house style,
how to fill a supplier’s forms, a few scripts it combines as each case needs. A fixed task with
known inputs and a known result is no skill. A code step does it without a model.

### What `wizards validate` checks

- Each folder under `skills/` has a `SKILL.md`, with front matter between `---` lines and a
  `name` and a `description` in it.
- The `name` is the folder’s name, so no two skills share one.
- `mode` is `always` or `demand`.
- Every file the `SKILL.md` links to, as in `[fill.py](scripts/fill.py)`, is in the folder.
- At most 5 skills are always on, with at most 20,000 characters of instructions together.
