# Plan: agents and workflows elsewhere, as a step

Status: plan, rewritten on 2026-11-10 (first written on 2026-11-09 as "A Mastra workflow as a
wizard step"). Not built. Scope: MCP and A2A.

## Why

Agents and workflows are built in many frameworks: Mastra, LangGraph, eve, Flue and more. A
wizard should hand a task to one of them, wait however long it takes, let a person answer when it
asks, and read its result. None of these frameworks has a person's step in its own format; a
wizard has. So the wizard keeps the people (forms, reviews, results) and the other agent does the
work.

Building one adapter per framework doesn't scale. Two protocols reach most of them:

| Protocol | Who speaks it | Long work | Asking a person |
|---|---|---|---|
| MCP | Mastra, LangGraph, Executor and most tools | Tasks: a call returns a task, polled until done | Elicitation: a question with a JSON Schema for the answer |
| A2A | Mastra, LangGraph and other agent servers | Every call is a task with a state: `working`, `input-required`, `completed`, … | The `input-required` state with a message, often with a data part |

eve and Flue are served over their own HTTP for now; they come in when they speak one of the two.

## Decisions

1. **No new step type.** The `tool` step already calls one action of a connection with fixed
   inputs. It learns to wait: when the call comes back as a task, the step waits for it.
2. **Remote agents are connections.** MCP connectors exist (`connectors/external.ts`,
   `source_kind: "mcp"`). A2A comes in as a new source kind, imported by its address from the
   agent card (`/.well-known/agent-card.json`): each skill of the card is an action, with its
   input and output schema where the card gives one.
3. **A question becomes a form.** An MCP elicitation or an A2A `input-required` with a schema is
   shown as a form to the run's person, or to the owner (`ask` on the step: `person` or `owner`),
   and the answers go back to the agent. A question without a schema is a single text field. A
   step with `"ask": "fail"` fails instead.
4. **The run waits durably.** The step keeps the task's id in its state and waits like a `wait`
   step on a signal (`engine/signals.ts`). A push notification from the agent, or our poll, sends
   that signal. After a crash or a deploy the runner picks the task up by its id; nothing runs
   twice.
5. **The broker stands in front.** Each call, each answer sent back and each result is a line in
   the audit, under the connection's rules (`r`, `w`, send). A guest's run reaches a remote agent
   only through a fixed `tool` step, never from a model on its own.
6. **The result is the step's output.** A task's data parts are read against `output.fields` or
   `output.schema`; text parts give `text`; file parts become the step's assets. A result that
   doesn't fit fails the step, as with a code step.
7. **Costs stay with the other side.** What a remote agent spends on models is its own; the step
   costs no credits. A call limit per run and per day is the connection's, as today.

## The step

```json
{
  "id": "research", "type": "tool", "title": "Research the offers",
  "call": {
    "connection": "offer-agent", "action": "find_offers",
    "input": { "product": "{{product}}", "budget": "{{budget}}" }
  },
  "ask": "person",
  "timeout": "2d",
  "output": { "schema": { "type": "object", "properties": { "offers": { "type": "array" } } } }
}
```

| Key | What it does |
|---|---|
| `ask` | Who answers the agent's questions: `person` (the default), `owner`, or `fail` |
| `timeout` | How long the task may take, as for a person's step; then `onFail` |
| `working` | Shown while it runs; the agent's own progress messages replace it when they come |

A short call stays as it is: an action that answers at once never waits.

## What a person sees

- While it runs: the step's `working` text, then the agent's progress messages as they come.
- A question: a form built from the schema, with the agent's message above it, in the wizard's
  look. The run's link and the person's inbox show it as waiting for them.
- A run that waits for days shows the task in the run's timeline, like a wait.

## Remote agents as tools of an AI step

A step's model can hand a task to a remote agent as one of its tools (`remote.<connection>`,
next to `agent.<name>` for a wizard's own agents). There it can't ask a person: a question from
the agent goes back to the model as the tool's answer. Only after the tool step works.

## Steps

1. **MCP tasks and elicitation** on the existing MCP connections: a `tool` step whose call returns
   a task waits for it; elicitation becomes a form. Docs: `agent-steps.md` (tool steps),
   `runs-that-last.md`.
2. **A2A connections:** import by address from the agent card, skills as actions, tasks with
   push notifications or polling, `input-required` as a form, artifacts as output.
3. **Remote agents as tools** of an AI step.
4. **More sources** for the same step when they come: a Mastra workflow kept as JSON in the
   wizard's files, eve and Flue once they speak MCP or A2A.

## Open

- Whether a wizard published as an MCP tool (`run-schemas.md`, phase 4) is also offered over A2A,
  so other agents hand tasks to wizards the same way.
- Push notifications need a public address; a local install polls.
- Signed agent cards and which A2A agents a space may add: admin only, like connectors today.

## A Mastra workflow kept in the wizard's files

The first version of this plan. It stays later and optional, for the same reasons as
`durable-agents.md`: Mastra's timed waits live in memory, recovery runs only at start-up, the
default engine's writes are not fenced, and dynamic workflows are in beta. Until those are fixed a
retried step would run the whole workflow again, and everything it writes would have to be safe
to repeat. A Mastra server reached over MCP or A2A doesn't have this problem for us: the task and
its state live on its side.
