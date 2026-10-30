---
title: Skills
description: The skills of a space – the SKILL.md engenty wizards reads, its limits, the studio’s routes, the two tools a step reads skills with and how their scripts run in the sandbox.
version: 0.13.0
---

A space’s skills are instructions in the Agent Skills format that its AI steps follow. They sit
behind the `skills` switch, which is on by default. While it is off, every route below answers
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
- Every other file of the folder is kept by its path. Text a model reads (Markdown, code, data,
  YAML, JSON) sits in the skill’s row while it fits. Any other file (a font, a template, an
  `.xsd` schema), and text past the limits, is a file for scripts: its bytes go to the blob store
  by their SHA-256 (`blob_files` holds path, hash and size), so a step that reads the space’s
  skills never loads them. No model reads them. They sync by hash, as workspace files do.

| | At most |
| --- | --- |
| `SKILL.md` | 100,000 bytes |
| Any other file | 256,000 bytes |
| A whole skill’s text | 1,000,000 bytes, 100 files |
| A file for scripts | 5,000,000 bytes |
| A skill’s files for scripts | 20,000,000 bytes, 200 files |
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

Without the sandbox, `skill_read`’s description says that scripts are text and nothing runs
them. A file for scripts answers that it isn’t text to read.

A step that writes HTML (a document, a dashboard) gets the skills always on, without tools. A
model that runs no tools (an on-device model) gets the skills always on alone. The run shows
“Reading the skill …” for each read. Goose gets the same two tools and a list of the space’s
skills.

## Scripts in the sandbox

`run_scripts` on a skill (`runScripts` in the API and the sync record) is off for every new
skill, from skills.sh too, and for a copy. A person switches it on in the studio. skills.sh
skills are unchecked third-party code, and the Docker sandbox has open internet access.

A step whose `tools` include `sandbox`, on a server where the sandbox is on, then:

- reads under the skills a line naming the skills whose scripts run (`skills.scripts` in
  `prompts/step.md`);
- writes the skill’s folder to `skills/<name>/` in the sandbox’s working directory (`/sandbox`)
  when `skill_load` loads it: `SKILL.md`, the text files and the files for scripts. The folder is
  removed first and written once per run and version of the skill, eight files at a time;
- gets `folder` and a `scripts` note in `skill_load`’s answer, which says to run the scripts with
  `run_command` from the working directory (`python3 skills/pdf/scripts/fill.py`) and to install
  what they import first.

If the folder can’t be written, `skill_load` still answers the instructions, and the note says
the scripts can’t run in this step. A skill with `run_scripts` off, a step without the sandbox,
and Goose get the text alone. The code is in `apps/runtime/src/tools/skills.ts`.

## Routes

Under `/api/studio`, signed in as for the studio:

| Route | What it does |
| --- | --- |
| `GET /spaces/:id/skills` | The space’s skills, without their content |
| `POST /spaces/:id/skills` | A new skill: `{ name, description, body?, mode? }` |
| `POST /spaces/:id/skills/upload` | A `SKILL.md`, `.zip` or `.skill` in the form field `file` |
| `GET /spaces/:id/skills/registry?q=` | A search on skills.sh |
| `GET /spaces/:id/skills/registry/preview?ref=` | A skill of skills.sh read whole: `owner/repo/skill` |
| `POST /spaces/:id/skills/registry` | Adds one: `{ ref, mode? }` |
| `GET`, `PATCH`, `DELETE /skills/:id` | One skill. `PATCH` takes `name`, `description`, `body`, `meta`, `files`, `mode`, `runScripts`, or the whole `skillMd` |
| `POST /skills/:id/copy` | A copy as the space’s own skill |
| `GET /skills/:id/zip` | The skill’s folder as a zip |
| `GET`, `POST /skills/:id/update` | What skills.sh has now, and taking it: `{ hash }` |

`mode` is `always`, `demand` or `off`. A skill from skills.sh changes its `mode` and
`runScripts` only. Its content changes with an update. An upload takes up to 32 MB.

## skills.sh

The runtime searches `https://skills.sh/api/search` and reads a skill from
`https://skills.sh/r/<owner>/<repo>/<skill>`, which hands out the `SKILL.md` and the text files
of its folder; it leaves out fonts and pictures. `SKILLS_REGISTRY_URL` points elsewhere, for tests or a mirror. A skill from an owner
on skills.sh’s official list counts as from an official source. The list is in
`packages/shared/src/skills.ts`.
