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
