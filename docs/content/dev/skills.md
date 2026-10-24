---
title: Skills
description: The skills of a space – the SKILL.md engenty wizards reads, its limits, the studio’s routes and the two tools a step reads skills with.
version: 0.11.4
---

A space’s skills are instructions in the Agent Skills format that its AI steps follow. They sit
behind the `skills` switch, which is off by default. While it is off, every route below answers
404 and no step sees a skill.

## The format

A skill is a folder with a `SKILL.md`: front matter, then Markdown.

```markdown
---
name: brand-voice
description: How we write. Use it for every text a person reads.
license: MIT
---

# Brand voice

Short sentences, first names, no exclamation marks. Examples in references/examples.md.
```

- `name`: lower-case letters, digits and single hyphens, at most 64 characters, unique in the
  space.
- `description`: at most 1024 characters. On demand, a step decides by it alone.
- Other keys (`license`, `metadata`, `allowed-tools` …) are kept as they came and written back
  on download. engenty wizards reads the subset of YAML skills use: plain and quoted values,
  block scalars (`|`, `>`), lists and one level of mapping.
- Every other file of the folder is kept by its path, text only: Markdown, code, data, YAML,
  JSON. Pictures and other binary files are left out. Scripts are kept as text and never run.

| | At most |
| --- | --- |
| `SKILL.md` | 100,000 bytes |
| Any other file | 256,000 bytes |
| A whole skill | 1,000,000 bytes, 100 files |
| Skills in a space | 100 |
| Skills always on | 5, their instructions 20,000 characters together |
| Skills on demand a step sees by name | 50 |

## In a step

Every AI step of the space’s wizards gets, after Brand and Knowledge:

- **The skills always on**, whole, under `# SKILLS THE SPACE ALWAYS USES`, each in
  `<skill name="…">`. The step’s ground rules and its task come first.
- **The skills on demand**, by name and description, under `# SKILLS ON DEMAND`.
- Two tools:
  - `skill_load { name }` answers the skill’s instructions and the paths of its files.
  - `skill_read { name, path, from? }` answers one file, 30,000 characters at a time.

A step that writes HTML (a document, a dashboard) gets the skills always on, without tools. A
model that runs no tools (an on-device model) gets the skills always on alone. The run shows
“Reading the skill …” for each read. Goose gets the same two tools and a list of the space’s
skills.

## Routes

Under `/api/studio`, signed in as for the studio:

| Route | What it does |
| --- | --- |
| `GET /projects/:id/skills` | The space’s skills, without their content |
| `POST /projects/:id/skills` | A new skill: `{ name, description, body?, mode? }` |
| `POST /projects/:id/skills/upload` | A `SKILL.md`, `.zip` or `.skill` in the form field `file` |
| `GET /projects/:id/skills/registry?q=` | A search on skills.sh |
| `GET /projects/:id/skills/registry/preview?ref=` | A skill of skills.sh read whole: `owner/repo/skill` |
| `POST /projects/:id/skills/registry` | Adds one: `{ ref, mode? }` |
| `GET`, `PATCH`, `DELETE /skills/:id` | One skill. `PATCH` takes `name`, `description`, `body`, `meta`, `files`, `mode`, or the whole `skillMd` |
| `POST /skills/:id/copy` | A copy as the space’s own skill |
| `GET /skills/:id/zip` | The skill’s folder as a zip |
| `GET`, `POST /skills/:id/update` | What skills.sh has now, and taking it: `{ hash }` |

`mode` is `always`, `demand` or `off`. A skill from skills.sh changes its `mode` only. Its
content changes with an update.

## skills.sh

The runtime searches `https://skills.sh/api/search` and reads a skill from
`https://skills.sh/r/<owner>/<repo>/<skill>`, which hands out the `SKILL.md` and every file of
its folder. `SKILLS_REGISTRY_URL` points elsewhere, for tests or a mirror. A skill from an owner
on skills.sh’s official list counts as from an official source. The list is in
`packages/shared/src/skills.ts`.
