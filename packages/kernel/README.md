# The wizard kernel, a spike

A wizard as a file and a folder of steps, moved by a cursor. That is all a wizard is. Nothing in the runtime uses this
package. It exists to find out whether the design holds: see what was tried at the end.

## A wizard

```
offer/
  wizard.json     roles, tools, input, output, start, edges, limits
  steps/
    offer.ts      one function per step, always the same interface
    legal.ts
    …
  evals/
    offer/        judges the step `offer`, every time it returned
      tone.ts
      within-budget.ts
    end/          judges the finished run
      signed.ts
```

The file says what a wizard needs and may reach, and it is the map: `start` and the ways of each
step in `edges`. Nothing about a step is in it.

Every step file exports one function:

```ts
export default async function (run, ask) {
  const answer = await ask({ type: "review", role: "legal", show: ["offer"], timeout: "3d" });
  return { value: answer, to: answer.approved ? "check" : "offer" };
}
```

- `run` is read only: `input`, `today`, `steps.<id>` with the latest value of each step, `last`
  for the step before, `count(id)` for how often a step was reached.
- `ask(spec)` is the only way to do anything. Someone answers: a role, the agent, a tool, a
  signal, a time.
- `value` is what later steps read. `to` is one of the step's ways in the map; left out, the
  first way is taken.

[examples/offer](examples/offer) is a full wizard.

## Evals

A test checks the flow with the model's answers given. An eval keeps the real model and judges
what it wrote. An eval file has the step interface, judges and never routes:

```ts
export default async function (run, ask) {
  const { price } = run.steps.offer;
  return { score: price <= run.input.budget * 1.1 ? 1 : 0, why: `${price} of ${run.input.budget}` };
}
```

- The folder says what it judges: `evals/<step>/` a step, each time it returned; `evals/end/` the
  finished run. Nothing about evals is in the file.
- `run` is the run as it stood at that moment. `ask` may ask a model to judge; an ask to a person
  fails the eval. The score is a number from 0 to 1.
- Scores are kept on the run, beside its rows, and never change them. A rewind drops the scores of
  what it takes back.

Three ways to run them:

| Where | With | For |
| --- | --- | --- |
| A real run | `kernel.judge(run)`, when and how often the host decides | Watching what a wizard writes |
| A dataset | `evaluate`: the wizard on every entry, with a real model, the people's answers from the entry | A model, a prompt or a step against another, before a release |
| A past run | `reask`: one ask of a stored run asked again, same history, new code or model | What the new version would have written there |

## How a run moves

A run is a cursor and rows. The cursor is the step it stands in. Every ask is a row, and every
step that returned is a row with its value and its way.

When an ask waits for a person, the kernel stops: nothing runs and nothing is kept in memory.
When the answer comes, the step runs again from its top, and `ask` gives the answer back at once.
So a step may run more than once. It is meant to do nothing but compute and ask.

The file holds a run to its limits without trusting the code. An ask that names a tool or a role
the file does not list fails. A `to` the map does not have fails. A step reached more often than
its limit fails.

## Where a step runs

As ordinary code, in the runner's own process. What keeps a wizard's code from other tenants is
that a runner is one tenant's, or one wizard's: its own process or isolate, its own database. The
kernel has no sandbox of its own.

The first state of this spike ran steps in QuickJS inside a shared process. That is gone: with a
runner per tenant it bought nothing, and it cost a 519 kB WebAssembly module, npm packages, a
debugger, and an abort when a step took all its memory.

What a step can reach is then the runner's to settle. A runner that holds no tokens and can call
nothing but the broker leaves a step with `ask` as its only way out, whatever it tries.

## The parts

| File | Is |
| --- | --- |
| `src/kernel.ts` | `start`, `answer`, `wake`, `rewind`, `judge`, `read`. Knows the file, the step interface and the rows. |
| `src/turn.ts` | One run of a step or an eval from its top. |
| `src/describe.ts` | Reads a wizard without running it: do the map and the step files fit. |
| `src/load.ts` | A wizard's folder to what the kernel takes, in Node. |
| `src/memory.ts` | A store in memory. |
| `src/edge.ts` | A run as a Durable Object: its storage as the store, its alarm as the wake. |
| `src/evals.ts` | `evaluate` and `reask`: evals over a dataset and on a past run. |
| `src/check.ts` | Tooling for tests of a wizard: answers every ask from a list, and lists the edges no test takes. Not part of a wizard. |

A host gives the kernel a store (`load`, `save`), the wizards, and batteries: functions that
answer an ask at once, by its type. An ask without a battery waits for `answer`.

## What was tried

`pnpm --filter @engenty/wizards-kernel test`

- The offer wizard passes ten tests ([test/offer.cases.json](test/offer.cases.json)), and they take all
  twelve edges.
- A run resumes from its cursor and rows on a kernel that never saw it, and takes new code at its
  next step.
- Rewind, a timeout, asks side by side, a step that catches a failed ask.
- A step cannot change the run it reads. One that waits for something that is not an ask fails.
- Evals: a step judged each time it returned and the run at its end, by code and by a stand-in
  model; over a dataset for two models; one ask of a past run asked again and both scored.
- A wizard as a Worker of its own: the kernel, the file and the step files bundled into one
  script, 10 kB minified, run under workerd with each run a Durable Object woken by its alarm.

## What it leaves out

- A real model. The agent battery in the tests is a stand-in.
- The runner itself: a process or isolate per tenant or per wizard, what it holds and what it may
  call. Nothing here stops a step from using the network or the clock.
- A tool battery, and a check of a tool ask's `call` against the file.
- Rows under an agent ask's row, `retries`, pause and cancel.
- A store on the runtime's `run` tables, and the converter from a version 2 definition.
- Types for a wizard's steps made from its file: `examples/offer/wizard.ts` is written by hand.
- How often a host judges real runs, and what a judge costs: both are the host's to decide.
