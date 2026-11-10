# Plan: a Mastra workflow as a wizard step

Status: roadmap, optional, written on 2026-11-09. Not built. Waits until Mastra fixes the issues
below.

## Why

Wizards don't nest yet. Logic that several wizards reuse could come from Mastra workflows instead:
a step runs one, hands it inputs and reads its result. Mastra workflows have no UI and nobody
answers in them; their JSON form (dynamic workflows) has no step for a person, and a code workflow
can only `suspend()` with a payload and wait for `resume()`. So a Mastra workflow is an automatic
step. The wizard's forms and reviews stay with the people.

Since the format's outputs are JSON Schema, a workflow's `inputSchema` and `outputSchema` map onto
the step's input and output as they are.

## Open questions

| Question | Options |
|---|---|
| Where a workflow comes from | A plugin registers it in code, trusted like plugin tools · a dynamic-workflow JSON in the wizard's files, which needs our tools and agents under ids · a remote Mastra server, used like a connection |
| What `suspend()` does | The step fails · or the wizard shows `suspendSchema` as a form and resumes with the answers, so a Mastra workflow can ask a person through us |
| A step of its own? | A plugin can already wrap a workflow as a tool, and a `tool` step calls it. A step type pays off only for suspend as a form, showing the workflow's progress, or workflows kept as JSON in the wizard's files |

## What we wait for

The same points `durable-agents.md` names for Mastra's workflows:

- Timed waits survive a restart. Today a sleep is a timer in memory.
- Recovery works while other processes run, not only at start-up.
- The default engine's writes are fenced.
- Dynamic workflows are out of beta.

Until then a retried step runs the whole workflow again, and Mastra repeats an interrupted tool
call by design, so everything a workflow writes would have to be safe to repeat. `run_effect`
can't see inside it.
