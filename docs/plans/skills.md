# Skills

A plan, 2026-10-23, built the same day behind the `skills` switch. Skills are the first of three
expert additions to a space: external resources, tools and skills.

## What a skill is

A folder in the open Agent Skills format: a `SKILL.md` (front matter `name`, `description`, then
Markdown) and the text files it points to. The same skill works in Claude, Codex and other tools,
and skills.sh lists thousands of them.

## Decisions

- **Per space.** A skill belongs to a space, like Knowledge. A per-step choice (`skills: []` next
  to `mcp` on a step) can follow later without a new definition version.
- **Three modes.** `always`: whole in every AI step of the space (at most 5, 20,000 characters
  together). `demand`: a step sees name and description, loads it with `skill_load` and reads
  its files with `skill_read`. `off`: kept, unseen. engenty-pro lists no skills in the prompt and
  loads on demand only; a wizard's step has no chat history to find its way from, so it gets the
  short list.
- **One table, `space_skill`**: name, description, body, the rest of the front matter (`meta`),
  the folder's other files as JSON, mode, source (`own`, `upload`, `skills.sh`), origin and the
  hash of what skills.sh had. A sync kind `skill` and live triggers (migration 0026).
- **Text only.** Binary files are left out on upload and import. Scripts stay as text; nothing
  runs them and they don't reach the sandbox.
- **skills.sh as the source**, through the runtime: `/api/search` and `/r/<owner>/<repo>/<skill>`,
  which hands out every file of the folder. Owners on skills.sh's official list count as an
  official source; the search shows only those by default. A skill added is a copy: an update is
  offered when the hash differs, shown before it is taken.
- **A skill from skills.sh is read only**: copied to be changed.
- **Goose** gets `skill_load` and `skill_read` and a list of the space's skills; it changes none.
- **Docs** are written now and left out of the docs' navigation until the switch flips.

## Where

- `packages/shared/src/skills.ts`: the format, the parser, limits, the official owners.
- `apps/runtime/src/services/skills.ts`, `skills-registry.ts`, `routes/skills.ts`.
- `apps/runtime/src/tools/skills.ts`: the prompt block and the two tools.
- `apps/web/src/studio/project/Skills.tsx`, `SkillEditor.tsx`: Sources › Skills.
- Mockups: the canvas “Skills in Sources” (claude.ai/artifact/TyD1PY8yRXWkh5R4rmVaTW).

## Later

- A per-step or per-wizard choice of skills.
- Skills that plugins bring.
- Goose writing skills.
- The other two expert additions: external resources and tools.
