# Spike: durable runs on our own engine

Running log of `spike/durable-runs`. Throwaway code: what lands comes in PRs from the plan.
Question: can a wizard run wait for days on `drive()`, the line and rows, with Mastra's `DurableAgent` inside agent steps?

## 1. The line (done)

Reproduced in `apps/runtime/test/durable-line.test.ts` against unchanged code, then fixed:

| Bug | Before | Fix |
|---|---|---|
| Serial line | A runner-only process drove one run at a time: the second run never started while the first worked | `take` claims and drives without holding up `lookAtLine`; `RUNNER_MAX_RUNS` (16) caps a process, which the bug hid |
| Lost wake | `restRun` cleared a wake that came while the owner finished | `restRun` only `WHERE owner = this runner`; `wakeRun` clears the owner, so the run stays in line |
| Unfenced writes | An owner that lost the run wrote over the new owner | `run_index.generation` counts claims, `run.claim` holds it on the tenant row, `drive`'s writes need it (AsyncLocalStorage, like Mastra's fence scope) and the heartbeat aborts on a mismatch |
| Person's writes | Read, then write the whole state | `run.rev` counts writes; `submitPage`, `reviewStep`, `goBack`, `editOutput`, `retry` need the one they read |

Not covered: `routes/runs.ts:874,989,1022`, `credits/credits.ts`, `broker/grant.ts` write other columns of the row or the state directly.

## 2. Wait steps, the clock, signals (done)

`apps/runtime/test/durable-wait.test.ts`, on the real runner:

- `wait` for a time: the run leaves every process as `sleeping`; the clock's one statement over `run_index` puts it back in line; the next step runs.
- An early or stale wake finds the run as it is and puts the time back from its row: the tenant row decides. The clock clears `wake_at`, a cancel clears it too.
- `wait` for a signal: `run_wait` is written before looking, so a signal in between wakes the run. A signal before the wait is kept and taken later. Another key does not wake it. The timeout goes on with `timedOut`.
- A mail in a watched mailbox becomes two signals, by sender and by thread (`engine/mail-watch.ts`). Gmail is the only connector with `stream.pull`; `client.pullStream` does not exist yet. Pulled with a fake here.

Type errors from a new step type and two statuses: 4 in the runtime, 1 in the web. The types catch little: the logic consumers (views, the plugin SDK, health) have to be found by hand.

## 3. A durable agent step (done)

`apps/runtime/test/durable-turn.test.ts`: every phase a process of its own on one data folder, on the pinned Mastra 1.80, with a mock model and a real `kill -9`.

| Case | Result |
|---|---|
| `kill -9` inside tool call 2 of 3 | Takeover after 30 s, goes on at that call. Mail 0 not repeated, mail 1 not repeated (the effect row says `started`, the model hears it may have happened) |
| Deploy: `stopRunner`, then the process ends | Same, and the next runner takes it at once and waits for the lease |
| `kill -9` after the turn ended, before `drive` saved it | **Found a gap:** Mastra drops a finished turn's snapshot, so the whole turn ran again with new call ids. Fixed by keeping the turn's end in `onFinish` |
| Turn asks a person (`ask_person`) | `waiting_input`, process ends, the answer goes on in another process |
| Person cancels mid-turn | No further calls. A deploy's stop must not cancel: `abort("stop")` tells them apart |

Not covered: a real model; browser and sandbox after a recovery (`RunResources` are gone); costs per model step; `each` and generate entries.

## 4. The whole suite

1258 pass. `json-schema.test.ts` wants `pnpm schema` re-run. `knowledge.test.ts` and `plugin-hooks.test.ts` fail the same on unchanged main at b17f3f58.
