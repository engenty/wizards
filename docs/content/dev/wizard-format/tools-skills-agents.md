---
title: Tools, skills and agents in the wizard
description: Function tools, sandbox tools and skills a wizard brings in its own files, for its own steps.
version: 0.18.0
---

A wizard can bring what its steps work with in its own workspace, under `files/` in the
`.wizard` file. Its steps use it like the space’s own, and other wizards don’t see it. The
wizard stays one file: whoever imports it gets its tools and skills with it, and needs no plugin.

This page covers function tools first, then sandbox tools and skills. Agents in the wizard follow.

## Function tools

A function tool is a fixed computation or one API call that the model calls when it needs it.
The model decides when and with what arguments. The code does the same thing every time. A step
names it in `tools`, next to the built-in tools.

Code in a wizard runs only where the switch `codeSteps` is on, the same switch as for
[code steps](./agent-steps.md#code-steps). The wizard’s [`requires`](./index.md#what-a-wizard-needs)
says so: its tools are in `tools`, `run` holds `code` and `features` holds `codeSteps`.

| You need | Use |
|---|---|
| A computation the model calls while it works, with typed arguments | A function tool |
| A computation at a fixed point of the run, with no model | A [code step](./agent-steps.md#code-steps) |
| Research, writing or judging | The step’s model, with its built-in tools |

### The file

A tool is the file `tools/<name>.ts` or `tools/<name>.js` in the workspace. The name has
lowercase letters, digits and `_`, and starts with a letter. The file exports four things:

```ts
export const description = "Scores an offer against the budget";

export const input = {
  type: "object",
  properties: { price: { type: "number" }, budget: { type: "number" } },
  required: ["price", "budget"],
};

export const output = {
  type: "object",
  properties: { score: { type: "number" } },
  required: ["score"],
};

export async function run({ price, budget }, { fetch, tools }) {
  return { score: Math.max(0, 1 - price / budget) };
}
```

| Export | What it holds |
|---|---|
| `description` | What the tool does. The model reads it to decide when to call it |
| `input` | The JSON Schema of the arguments, an object. The model sees it as the tool’s schema |
| `output` | Optional. The JSON Schema of what `run` returns. A result that doesn’t fit goes back to the model as an error |
| `run` | The function. It gets the arguments and `{ fetch, tools }`, and returns JSON |

### In a step

The step lists the tool as `wizard.<name>`:

```json
{
  "id": "rank", "type": "agent", "title": "Rank the offers",
  "instructions": "Score each offer in {{steps.find.offers}} against {{budget}} and list the best three.",
  "tools": ["wizard.score", "web_fetch"],
  "hosts": ["api.exchangerate.host"],
  "output": { "format": "markdown" }
}
```

The model calls it as `wizard_score`, since tool names take no dot.

### What `run` gets

| Name | What it does |
|---|---|
| `fetch(url, { method, headers, body })` | Sends a request to one of the hosts the step lists in `hosts`. It answers with `status`, `ok`, `headers.get()`, `text()` and `json()`. A host the step doesn’t list is refused |
| `tools.<name>(args)` | Calls another tool of the step by the name the model sees, such as `tools.web_fetch({ url })` |

A tool reaches only the step’s own `hosts`, also in a member’s run. A guest’s run reaches only
the hosts its grant lists, as with `http`.

`tools` holds the step’s other tools, without `generate_image`, `scan_documents`, the browser
and the wizard’s other tools. A change that needs the person’s yes is refused inside a tool. The
model then calls that tool itself, and the person is asked.

### Limits

The code runs sealed off, the same way as a code step:

- It has no imports, no files and no timers.
- A call stops after 10 seconds, its requests included.
- A call makes at most 20 requests and tool calls.
- It runs in a guest’s run too, and it costs no credits.

Every call is a line in the audit, under the tool’s name, and so is every request it sends.

### Checks

`wizards validate` loads every file under `tools/` the way a run loads it. It reports:

- a tool the step names that has no file
- a name with two files, `.ts` and `.js`
- a file that imports, doesn’t load or lacks an export
- an `input` or `output` that is no valid JSON Schema, or an `input` that is no object

A run that names a tool its workspace lacks fails at that step.

## Sandbox tools

A sandbox tool is a script with a fixed entry point, such as a Python program that converts a
file. It runs in the run’s sandbox, so it can use Python, Node, the shell and packages it
installs. The model calls it with typed arguments and gets typed output back. It never sees the
script.

Like a function tool, it runs only where the switch `codeSteps` is on. Its wizard’s `requires`
holds `sandbox: "shell"` too.

| You need | Use |
|---|---|
| A short computation or one API call, with typed arguments | A [function tool](#function-tools) |
| A program, packages or files, with typed arguments | A sandbox tool |
| Open work where the model decides what to run | A [skill](#skills) with scripts |

### The folder

A sandbox tool is the folder `tools/<name>/` in the workspace. The name follows the rules of a
function tool. The folder holds `TOOL.md` and the scripts beside it:

```
files/
└── tools/
    └── convert/
        ├── TOOL.md
        └── convert.py
```

```markdown
---
description: Converts a supplier's price list (CSV or XLSX) into our item table
input:  { type: object, properties: { file: { type: string } }, required: [file] }
output: { type: object, properties: { items: { type: array } }, required: [items] }
run: python3 convert.py
hosts: [api.exchangerate.host]
---
Reads the file, maps the supplier's columns, converts currencies to EUR.
```

| Key | What it holds |
|---|---|
| `description` | What the tool does. The model reads it to decide when to call it |
| `input` | The JSON Schema of the arguments, an object. The model sees it as the tool’s schema |
| `output` | Optional. The JSON Schema of `output.json`. A result that doesn’t fit goes back to the model as an error |
| `run` | The command, on one line. It runs in the tool’s folder |
| `hosts` | Optional. The hosts the script reaches. The step lists them in its `hosts` too |

The front matter is YAML, so a schema may be written in YAML or in JSON. The body under it is
for the people who read the file.

### In a step

The step lists the tool as `wizard.<name>`, like a function tool, and the model calls it as
`wizard_<name>`:

```json
{
  "id": "import", "type": "agent", "title": "Import the price list",
  "instructions": "Convert the price list the person gave and list items over 100 EUR.",
  "tools": ["wizard.convert"],
  "hosts": ["api.exchangerate.host"],
  "output": { "format": "markdown" }
}
```

The step doesn’t need the `sandbox` tool. Without it, its model has the tool but no shell.

### A call

1. The first call copies the folder to `tools/<name>/` in the run’s sandbox.
2. A file the person gave, named in the arguments as `upload:<id>`, is copied to `in/`. Its
   argument becomes the path from the folder, such as `in/prices.csv`.
3. The arguments are written to `input.json`.
4. `run` runs in the folder, for at most 5 minutes.
5. `output.json` is read and checked against `output`. The model gets it as the tool’s result.
6. Files the script wrote to `out/` become files of the step. The model then gets
   `{ "output": …, "files": [{ "name", "assetId" }] }`.

A script that exits with another code than 0 fails the call. The model gets the code and the end
of what the script printed. Calls of one tool run one after the other.

The sandbox lasts the run. Packages a call installs and files it writes stay for the next call.
`input.json`, `output.json`, `in/` and `out/` are emptied before each call.

### Where it runs

| Where | Sandbox |
|---|---|
| Your computer | agentOS, or Docker where Docker is the engine |
| The cloud | agentOS in a container of its own, where the cloud’s sandbox is switched on |
| A guest’s run | agentOS only, where `SANDBOX_GUESTS` names it |

A run without a sandbox fails at a step that names a sandbox tool. agentOS runs Python as
Pyodide and Node, not native programs: no ffmpeg, ImageMagick or LibreOffice there.

The sandbox reaches the npm and PyPI registries and the hosts of the run’s grant, which are the
hosts the steps list. Every other host is refused. So a tool’s `hosts` count only when the step
that names the tool lists them as well. A step that doesn’t fails at its start.

Every call is a line in the audit, under the tool’s name.

### Checks

`wizards validate` reads every `TOOL.md` under `tools/`. It reports:

- a `TOOL.md` without front matter, or front matter that is no YAML
- a missing `description`, `input` or `run`
- an `input` or `output` that is no valid JSON Schema, or an `input` that is no object
- `hosts` that are no host names
- a name with two tools, such as `tools/convert.ts` and `tools/convert/TOOL.md`
- a step that names the tool and doesn’t list its hosts in `hosts`
- a `requires` without `sandbox: "shell"`

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
it loads the skill. Its model runs the scripts there with `run_command`. The sandbox is the
same as for [sandbox tools](#where-it-runs): on your computer, and in the cloud where its
sandbox is switched on.

Without the sandbox, the skill’s text still counts and its scripts don’t run.

A wizard with a `sandbox` step has `"sandbox": "shell"` in its `requires`. On a runtime
without a sandbox the step works on in text, and the run’s log says so.

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
