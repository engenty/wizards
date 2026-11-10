---
title: Tools, skills and agents in the wizard
description: Function tools, skills and agents a wizard brings in its own files, for its own steps.
version: 0.18.0
---

A wizard can bring what its steps work with in its own workspace, under `files/` in the
`.wizard` file. Its steps use it like the space’s own, and other wizards don’t see it. The
wizard stays one file: whoever imports it gets its tools and skills with it, and needs no plugin.

This page covers function tools, skills and agents.

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

## Agents

An agent is a role you write once: its instructions, its model class and its tools. A step lets
the agent do its work, or its model hands the agent a task, as it would call a tool.

| You need | Use |
|---|---|
| The same role in several steps, such as a researcher or a reviewer with fixed rules | An agent that runs the steps |
| A part of a step’s work done by a specialist, with its own model and tools | An agent as a tool of the step |
| One task in one place | A step with its own instructions |

### The file

An agent is the file `agents/<name>.md` in the workspace. The name has lowercase letters, digits
and `_`, and starts with a letter. The file is Markdown with front matter, in the shape of Claude
Code’s agents:

```markdown
---
description: Finds offers for a product and checks them against the budget
model: standard
tools: [web_search, web_fetch, wizard.score]
output:
  type: object
  properties:
    offers: { type: array, items: { type: string } }
  required: [offers]
---
You research offers on the web. Check each one against the budget with the score tool.
Name the shop and the price of every offer.
```

| Key | What it holds |
|---|---|
| `description` | What the agent does. A step’s model reads it to decide when to call the agent. Needed where a step lists the agent as a tool |
| `model` | The [model class](./agent-steps.md) it runs on. Default `standard` |
| `tools` | The tools it may use: built-in tools, plugin tools and the wizard’s function tools (`wizard.<name>`). No other agent |
| `output` | Optional. The JSON Schema of its answer where it is a tool, as a step’s [`output.schema`](./agent-steps.md) takes it |

The text below the front matter holds the agent’s instructions. Every call of the agent starts
with them.

### As a step’s agent

The step names the agent in `agent` and gives the task in `instructions`:

```json
{
  "id": "find", "type": "agent", "title": "Find offers",
  "agent": "researcher",
  "instructions": "Find offers for {{product}} under {{budget}}.",
  "output": { "format": "markdown" }
}
```

The file gives the model class and the tools, so the step names no `model`. Its `tools` may
leave some of the agent’s tools out, never add one. Without `tools` the step has all of the
agent’s tools. The step’s `output`, `hosts` and `connections` work as on any agent step.

### As a tool

A step lists the agent as `agent.<name>`:

```json
{
  "id": "plan", "type": "agent", "title": "Plan the purchase",
  "instructions": "Plan the purchase of {{product}}. Ask the researcher for offers.",
  "tools": ["agent.researcher"],
  "output": { "format": "markdown" }
}
```

The model calls it as `agent_researcher` with a task. The agent works with its own model and
tools and answers with text, or with JSON as its `output` says.

- It runs as the step: with the run’s grant, the step’s `hosts` and no connections.
- Its model calls are charged to the run.
- An agent called as a tool calls no other agent, and a step that runs an agent lists no other one.
- Every call is a line in the audit, under the agent’s name.

### What `requires` holds

The wizard’s `requires` lists the agents the steps use under `agents`, each with the classes it
calls and the tools it lists, as its file says. Its classes and tools count in `models`, `tools`
and `plugins` too, so a reader that skips `agents` still sees everything the wizard needs. An agent
needs the switch `codeSteps` only when it lists a function tool.

The studio fills it in when it saves the wizard or an agent’s file, and drops an agent no step
uses any more. `wizards validate` names an agent whose entry differs from its file. A run
doesn’t start until they match again.

### Checks

`wizards validate` reads every file under `agents/`. It reports:

- an agent a step names that has no file
- a file without front matter, with an unknown key or a model class that doesn’t exist
- a tool the agent lists that doesn’t exist, or another agent
- an `output` that is no output schema
- a step that names a `model` next to its agent, or lists a tool its agent doesn’t
- an agent a step lists as a tool that has no `description`
- an entry of `requires.agents` that doesn’t match the agent’s file, or names an agent no step uses

A run that names an agent its workspace lacks fails at that step.
