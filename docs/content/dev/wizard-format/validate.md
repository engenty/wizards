---
title: JSON Schema and validation
description: The JSON Schema for your editor, and wizards validate for everything a schema cannot say.
version: 0.7.10
---

## JSON Schema

| For | Schema |
|---|---|
| A definition | [`https://engenty.ai/schema/v1/wizard.json`](https://engenty.ai/schema/v1/wizard.json) |
| `wizard.json` in a package | [`https://engenty.ai/schema/v1/wizard-package.json`](https://engenty.ai/schema/v1/wizard-package.json) |

Put the address under `"$schema"`, and editors such as VS Code complete keys and mark mistakes
as you type. The studio’s export writes it into every `wizard.json`.

The schemas are written from the code that reads wizards, so they match it. They are stricter
in one way: a key the app does not know is an error. The app would drop such a key without a
word.

## `wizards validate`

```bash
wizards validate invoice.wizard
```

It checks a wizard the way the studio’s import does, without a running studio and without an
account. It also checks what a JSON Schema cannot say: unique ids, steps and fields that refer
to each other, templates that name answers that exist by then, and files in the workspace.

It takes any number of paths:

| Path | Read as |
|---|---|
| `invoice.wizard` | A package |
| `invoice/` or `invoice/wizard.json` | An unpacked package, its workspace under `invoice/files/` |
| `invoice.json` | A definition on its own, or a `wizard.json` |

```text
✗ invoice.json 2 issues
  The last step must be a result step.
  "{{nope}}" refers to a field that is not asked before "g".
```

A wizard without issues gets a ✓ with its number of steps and files. `--json` prints the
results as JSON. The exit code is `0` when every wizard is fine, `1` when one has issues and `2`
when no path was given.

## In CI

```bash
npx wizards validate wizards/*.wizard
```

`npx wizards` installs engenty wizards into `~/.engenty/wizards` first, the first time. To check
without an install, on Node.js 24.11 or newer, run the runtime from npm directly:

```bash
npx -p @engenty/wizards-runtime wizards validate wizards/*.wizard
```

What belongs to a space is checked only on import. See
[What the import takes](./wizard-file.md#what-the-import-takes).
