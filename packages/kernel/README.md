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

## How a run moves

A run is a cursor and rows. The cursor is the step it stands in. Every ask is a row, and every
step that returned is a row with its value and its way.

When an ask waits for a person, the kernel stops: nothing runs and nothing is kept in memory.
When the answer comes, the step runs again from its top, and `ask` gives the answer back at once.
So a step may run more than once. That is safe because a step can only compute: it runs in
QuickJS with a clock that stands still and a seeded `Math.random`.

The file holds a run to its limits without trusting the code. An ask that names a tool or a role
the file does not list fails. A `to` the map does not have fails. A step reached more often than
its limit fails.

## The parts

| File | Is |
| --- | --- |
| `src/kernel.ts` | `start`, `answer`, `wake`, `rewind`, `read`. Knows the file, the step interface and the rows. |
| `src/sandbox.ts` | One turn of a step's code in QuickJS. |
| `src/describe.ts` | Reads a wizard without running it: do the map and the step files fit. |
| `src/check.ts` | Tooling for tests of a wizard: answers every ask from a list, and lists the edges no test takes. Not part of a wizard. |
| `src/compile.ts` | A wizard's folder to what the kernel takes. The save step; needs Node. |
| `src/memory.ts`, `src/node.ts` | A store in memory, the sandbox in Node. |
| `src/edge.ts` | A run as a Durable Object: its storage as the store, its alarm as the wake. |

A host gives the kernel a store (`load`, `save`), a sandbox, the wizards, and batteries: functions
that answer an ask at once, by its type. An ask without a battery waits for `answer`.

## What was tried

`pnpm --filter @engenty/wizards-kernel test`

- The offer wizard passes ten tests in the sandbox ([test/offer.cases.json](test/offer.cases.json)), and they
  take all twelve edges.
- A run resumes from its cursor and rows on a kernel that never saw it.
- Rewind, a timeout, asks side by side, a step that catches a failed ask.
- A step that never ends is stopped. So is one that takes all its memory.
- The same kernel runs under workerd, each run a Durable Object, woken by the object's alarm.

What it measured here: a turn takes about 1.5 ms in Node. For a Worker, the kernel with QuickJS
is 62 kB of script and a 519 kB WebAssembly module (241 kB gzipped).

## What it found

- A step that takes all its memory leaves QuickJS unable to free its runtime, and the WebAssembly
  instance aborts. The sandbox loads a fresh one for the next turn. It takes about five seconds
  until the memory limit stops such a step.
- Reading a promise back out of the sandbox fails (`Lifetime not alive`). The kernel reads only
  JSON text out of it.
- The interrupt is counted, not timed. In a Worker the clock does not move while code runs.

## What it leaves out

- A real model. The agent battery in the tests is a stand-in.
- Rows under an agent ask's row, `retries`, pause and cancel.
- A store on the runtime's `run` tables, and the converter from a version 2 definition.
- The memory and interrupt limits under workerd. They were tried in Node only.
- Types for a wizard's steps made from its file: `examples/offer/wizard.ts` is written by hand.
