---
title: Tools, skills and agents in the wizard
description: Function tools a wizard brings in its own files, which a step’s model calls like any tool.
version: 0.18.0
---

A wizard can bring code of its own in its workspace, the `files/` folder of a `.wizard` file.
A step names it in `tools`, next to the built-in tools. The wizard stays one file: whoever imports
it gets the code with it, and needs no plugin.

This page starts with function tools. Skills and agents in the wizard follow.

Code in a wizard runs only where the switch `codeSteps` is on, the same switch as for
[code steps](./agent-steps.md#code-steps). The wizard’s [`requires`](./index.md#what-a-wizard-needs)
says so: its tools are in `tools`, `run` holds `code` and `features` holds `codeSteps`.

## Function tools

A function tool is a fixed computation or one API call that the model calls when it needs it.
The model decides when and with what arguments. The code does the same thing every time.

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
