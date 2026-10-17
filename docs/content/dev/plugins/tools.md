---
title: Tools
description: A tool an AI step can call – how to register it, how a wizard lists it, and what the model sees.
version: 0.5.0
---

A tool is a function an AI step may call while it works. The model decides when, from the
tool’s description.

```ts
server.registerTool({
  name: "lookup",
  title: "Contacts",
  description:
    "Looks a person up by email among the people who ran a wizard of this space before.",
  inputSchema: z.object({ email: z.string().email() }),
  execute: async ({ email }) => {
    const [found] = await db()
      .select()
      .from(person)
      .where(eq(person.email, email.toLowerCase()));
    return found ? { known: true, name: found.name, lastWizard: found.wizard } : { known: false };
  },
});
```

| Field | |
|---|---|
| `name` | Lower case, digits and `_`, starting with a letter, at most 40 characters. Unique in the plugin, its [space tools](./space.md#a-block-for-every-ai-step) included |
| `title` | What the editor calls it. Default: the name |
| `description` | For the model: what the tool does and when to use it. The assistant reads it too when it builds a wizard |
| `inputSchema` | A zod schema. `.describe()` on a field tells the model what to put there |
| `execute(input, step)` | Returns what the model gets back: anything that can be JSON |

## Names

| Where | The tool is called |
|---|---|
| A step’s `tools` in a wizard | `contacts.lookup`: `<plugin id>.<tool name>` |
| The model | `contacts_lookup`. A `-` in the plugin’s id becomes `_`: `run-log.recent` is `run_log_recent` |
| The editor | Its `title` |

## What `execute` knows

The second argument is the step that calls the tool:

| | |
|---|---|
| `step.runId`, `step.stepId` | The run and the step |
| `step.tenantId` | The tenant |
| `step.space` | `{ id, name }`: the space of the step’s wizard |
| `step.project` | The same as `step.space`, by its older name |
| `step.wizard` | `{ id, title }` |
| `step.mode` | `"test"` for a test run from the studio, else `"live"`. Keep what a test run makes apart, such as a booking or a message to someone outside |
| `step.signal` | Aborted when the run is cancelled. Pass it to `fetch` |
| `step.emit(message)` | Tells the person what the step is doing right now |

`server.getTenantDb()` inside `execute` is the database of the tenant the run belongs to.

```ts
execute: async ({ url }, step) => {
  await step.emit("Asking the price list …");
  const response = await fetch(url, { signal: step.signal });
  return response.json();
},
```

## Errors

An error thrown in `execute` does not fail the step. The model gets `{ "error": "<message>" }`
as the tool’s result, with the first 400 characters of the message, and can try again or work
around it. Throw errors whose message says what was wrong with the input.

## In a wizard

A step lists the tool beside the built-in ones:

```json
"tools": ["web_search", "contacts.lookup"]
```

- The editor offers the tools of the tenant’s plugins in every AI step.
- The assistant and the MCP authoring guide list them with their descriptions.
- A draft with a step that lists a tool this tenant does not have shows an issue.
- A run fails at the step that names such a tool, with “This step needs the tool “…”. The
  plugin “…” isn’t installed here.” A wizard that uses a plugin’s tool runs only where that
  plugin is installed. Keep that in mind before you publish a wizard to the cloud or export it.
- The model has to call the tools. Apple Intelligence on a Mac calls none: a step whose class it
  answers (Classifier, Standard) runs from its prompt alone. A step that needs the tool runs on
  High, or a [call without a model](#called-without-a-model) does the job.

### Called without a model

Where a step only fetches data and hands it on unchanged, it can call the tool itself: no model
picks the tool, and no model copies its answer.

```json
{
  "id": "known",
  "type": "agent",
  "title": "Known contact",
  "call": {
    "tool": "contacts.lookup",
    "input": { "email": "{{steps.ask.email}}" }
  },
  "output": {
    "format": "json",
    "fields": [
      { "id": "known", "kind": "yesno" },
      { "id": "name", "kind": "text" }
    ]
  }
}
```

- The tool’s answer is the step’s json output, as it is. An answer that is not an object (a
  list, a text) is kept as `{ "result": … }`. `output.fields` name the keys later steps read,
  so the editor and the checks know them.
- String inputs are templates. A template that fills in to a number or to `true`/`false` is
  passed as one, and an empty one is left out. The input is checked against the tool’s schema.
- What the tool throws, or an answer that is only `{ "error": … }`, is the step’s error. A tool
  this tenant does not have fails the step too.
- It costs no credits and answers as fast as the tool: the free times of a calendar in under a
  second instead of half a minute.

## While a step runs

A step that is running keeps the tools it started with. When a plugin loads again, the change
reaches the next step.

## Write a good tool

- One job per tool. Two small tools are easier for a model to choose between than one with a
  `mode` field.
- Describe the result as well as the input: “returns the working days as a number”.
- Return data, not prose. The step writes the sentences.
- Bound what it returns: a `limit` with a maximum, the newest 50 rows.
- A tool that changes something outside says so in its description. There is no
  ask-the-person-first for plugin tools: the step runs them without asking.
