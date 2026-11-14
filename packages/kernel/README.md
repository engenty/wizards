# The wizard kernel

The engine of a wizard in version 2 of the format: a file and a folder of steps, moved by a
cursor. That is all a wizard is. The runtime is its host behind the switch `kernel`
(`apps/runtime/src/kernel`, docs/plans/kernel.md).

## A wizard

```
offer/
  wizard.json     requires, connections, input, output, start, edges, limits
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

[examples/offer](examples/offer) is a full wizard with a loop, three roles and evals. [examples/mail](examples/mail)
uses a connection and asks the user before it sends.

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

## What a wizard may reach

Steps are code, so what they will ask for cannot be read from them. The file declares it:

```json
"requires": {
  "models": ["standard"],
  "tools": ["http.request"],
  "roles": { "legal": "Legal" },
  "hosts": ["api.example.com"]
},
"connections": {
  "gmail": { "search_threads": "allow", "read_thread": "allow", "send": "ask" }
}
```

- An ask that names a model class, a tool, a role, a host or a connection's action the file does
  not list fails. A step narrows the file for one ask: `tools: ["gmail.read_thread"]`.
- An action set to `ask` first asks the user, as a row of its own. Nothing is done before the
  answer, and a no fails the action.
- The grant is made from the file when a run starts and kept on the run. A later edit of the file
  does not widen a run that is open.
- A host can say what it has. A wizard that requires more is refused before it starts.
- The file names kinds, never accounts. Whose Gmail it is, is bound where the wizard is installed.

## A real connection: Gmail through executor

`src/executor.ts` puts the kernel's batteries on an executor
([executor.sh](https://executor.sh), `@executor-js/sdk`): a tool ask and the tools an agent is
handed become calls of the executor's tools. `src/executor.test.ts` runs the mail wizard that way
against executor's emulator of Google, a Gmail that keeps state.

- Gmail's own API description becomes 81 tools. The file names `gmail.users.messages.send`; the
  executor addresses `tools.gmail.org.me.users.messages.send`. The part in between, `org.me`, is
  the account, bound where the wizard is installed.
- The token sits in the executor's credential store. No step, no row and no log line holds it.
- The agent reads the thread with two real calls. The send waits for the user as a row of the
  run, and only then reaches Gmail. The answer lands in the customer's thread.
- When Gmail fails, the action's row fails with Gmail's message. Asked again, the user is asked
  again and the mail is sent once.
- The kernel did not change for any of this.

What does not fit by itself: executor asks for approval through a callback in the running
process, which cannot wait for days. So the kernel asks, as a row, and answers executor's own
gate with yes. `stricterThere` lists where executor's policy is stricter than the file.

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

Two ways, and the kernel's host says which.

- **As ordinary code**, in the host's own process. For a runner that is one tenant's, or one
  wizard's, and code that is its own. `load.ts` loads a folder this way.
- **In QuickJS** (`quickjs.ts`), for every other case. A step is compiled into one script
  (`compile.ts`); it gets the run to read and `ask`, and nothing else. The clock stands still and
  `Math.random` is seeded. A step that imports one of Node's own modules does not compile. `btoa`
  and `atob` are there.

A step that only computes and asks behaves the same in both. The tests run the two example
wizards both ways.

## The parts

| File | Is |
| --- | --- |
| `src/kernel.ts` | `start`, `answer`, `wake`, `rewind`, `stop`, `judge`, `read`; `record`, `back` and `move` for a host with a line of its own. Knows the file, the step interface and the rows. |
| `src/grant.ts` | The grant from the file, an ask held to it, what a host lacks, what the file declares and no run used. |
| `src/turn.ts` | One run of a step or an eval from its top, as ordinary code. |
| `src/quickjs.ts`, `src/compile.ts` | The same in QuickJS, and a wizard's folder compiled for it. |
| `src/check-dir.ts`, `src/types-of.ts` | The check of a folder, and the types written from its file. |
| `src/describe.ts` | Reads a wizard without running it: do the map and the step files fit. |
| `src/load.ts` | A wizard's folder to what the kernel takes, in Node. |
| `src/memory.ts` | A store in memory. |
| `src/executor.ts` | The batteries on an executor: tools, accounts and credentials from there. |
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
- Requirements and connections: asks outside the file fail, an action set to `ask` waits for the
  user, the grant stays as it was at the start, a host that lacks something refuses the wizard.
- The mail wizard through executor against an emulated Gmail: read, wait for the user, send,
  fail and send again, with no token in any row.
- Evals: a step judged each time it returned and the run at its end, by code and by a stand-in
  model; over a dataset for two models; one ask of a past run asked again and both scored.
- A wizard as a Worker of its own: the kernel, the file and the step files bundled into one
  script, 10 kB minified, run under workerd with each run a Durable Object woken by its alarm.

## What it leaves out

- A real model. The agent battery in the tests is a stand-in.
- Pause, and a wizard as an ask.
- Leave for an action an agent calls inside its own turn: only a tool ask's one `call`, or a
  battery that says so, asks the user.
- A real Google account and its OAuth sign-in. The emulator hands out a token.
