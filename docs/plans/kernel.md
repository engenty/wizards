# Plan: the kernel, a wizard as a file of edges and one function per step

Status: partly built, behind the switch `kernel` (off by default), on the branch `feat/kernel` (#697). Built:
the kernel as a package (A), the format (B.5), and the runtime as its host (C): a wizard in
version 0.3.0 is made, runs in the engine's line, and is answered through the pages, reviews and MCP
tools every run has. "What is built" below says what, and where it differs from this plan. The
design and its reasons are in
[The Smallest Wizard](https://claude.ai/artifact/S9Q6tXsn3VMvnTvFE8NvDQ). Decided by Matthias on
2026-11-14.

A word on numbers: today's format is version 0.2.0 (`DEFINITION_VERSION`). The new one is version 0.3.0 (`KERNEL_VERSION`).

Scope: a third format for a wizard, the engine that runs it, how it reaches models, tools and
people, where its code runs, and how the studio shows it. Built beside today's engine, behind the
switch `kernel`.

Not in scope: changing wizards in version 0.2.0 while they run, removing today's engine, a store other
than the tenant's database, prices.

## What is built

| Item | State | Where |
|---|---|---|
| A.1 The package | Built, under the MIT licence | `packages/kernel`, with a build of its own |
| A.2 Retries, stop, rows under an ask, a battery that asks for leave | Built. Pause and a wizard as an ask are not. | `kernel.ts` |
| A.3 Answers checked against fields | Built: the kernel takes the host's check, and a page's answers are checked as a form's are today | `kernel.ts`, `engine/runner.ts` |
| A.4 QuickJS as the second way | Built, with `btoa` and `atob`, which steps written for ordinary code expect | `quickjs.ts`, `compile.ts` |
| B.5 The file's schema | Built | `packages/shared/src/definition.ts`, `kernel-file.ts` |
| B.6 Compiling | Built, when a run is driven, kept in memory by the files' hash. The types of a file's input and steps are made by `typesOf`; nothing writes them beside a wizard at save yet. | `apps/runtime/src/kernel/wizard.ts`, `packages/kernel/src/types-of.ts` |
| B.7 The check | The file against its step files, in `validateWizard`; a folder checked and compiled by `checkDir` in the package. No `wizards check` command in the CLI yet. | `definition.ts`, `packages/kernel/src/check-dir.ts` |
| C.8 Tables and store | Built | `run_row`, `run_score`, `kernel/store.ts` |
| C.9 Batteries | Built over today's step executors. A step that asks the person for a yes becomes a row. | `kernel/batteries.ts` |
| C.10 Entry points | Built: start, the line, answers, back, retry, cancel, the clock, the report, and signals by address: the row a run waits at is written where senders look, and a signal for it answers the row. | `kernel/host.ts`, `kernel/signals.ts`, `engine/runner.ts` |
| C.11 A person answers | Built another way: see below. An ask's view (`components`, and the values in `data`) reaches the page. | `kernel/page.ts`, `kernel/views.ts` |
| D.13 Judging runs | Built, by a share the runtime is told (`KERNEL_EVALS`). No setting of a space yet. | `kernel/host.ts` |
| E Executor | In the package only, tested against the emulator. Not in the runtime. | `packages/kernel/src/executor.ts` |
| F.18 The map | Built, to read: the studio draws the file's steps and edges. Editing the map, a run's rows as a timeline and scores are not built. | `apps/web/src/studio/editor/kernel-flow.ts`, `KernelFlow.tsx` |
| F.21 For those who build | The authoring guide tells of step files while the switch is on. No starter in version 0.3.0. | `prompts/authoring.md` |
| G.22 Converting | Built: `toKernel` makes the file, its step files and notes on what is not carried over; all 31 starters convert, compile and run to their end with stand-ins. The studio's `POST /wizards/:id/convert` makes a copy of a wizard in version 0.3.0. | `packages/shared/src/convert-kernel.ts`, `services/convert.ts` |
| H.23 A runner per tenant | Built: `RUNNER_TENANT` makes a runner take one tenant's runs only, and the rule of decision 6 picks how a step's code runs | `env.ts`, `tenants/control.ts`, `kernel/host.ts` |
| H.24, H.25 | Not built: the runner still holds what today's step executors hold; no broker of its own, no rollout | |

Where it differs from the plan:

- **A wizard in version 0.3.0 is stored inside a definition of version 0.2.0.** The definition gains one
  optional entry, `kernel`, that holds the file; its `steps` are one result step, so everything
  that reads a definition finds a whole, small one. 97 places read a definition's steps; this way
  none of them had to change. `kernelShell` makes that definition from a file.
- **A run keeps what the kernel needs in `run.state.kernel`,** beside the columns the plan names.
- **The run's page was not rebuilt.** A run of version 0.3.0 is shown to it as the small wizard it is
  at that moment: the steps that returned with what they left behind, and the page it waits at,
  a form, a review, or the leave for an action as a review of what is about to be done. So the
  page, the pages and reviews routes and the MCP tools `answer_form` and `review_step` answer such
  a run unchanged.
- **A view is `components` and `data` on an ask,** the names a form of version 0.2.0 and the
  file's first page have. A step works its data out, so an ask's `data` holds values, where a
  step of version 0.2.0 names where to read them; the host puts the values where the page and
  the step executors read (`kernel/views.ts`). A form's layout and a review's view are checked
  when the step asks: one the catalog does not know fails the ask, with what is wrong. An agent
  ask's `surface` is kept, and the view its answer brings is shown where the step is shown.
- **The report of a run is the report of the small wizard it is at that moment,** with its rows
  and scores beside it. So the MCP door's tools, the questions a calling app shows and a run
  followed as a task read a run of version 0.3.0 as they read any run. A run started with its
  first page's answers takes them as its input, where every field that must be answered is given.
- **How a step's code runs follows decision 6:** ordinary code where the runner serves one tenant
  or the install is your own and the wizard is your own; QuickJS for a wizard from a starter and
  in every shared runner. `KERNEL_STEPS` overrides it for a runner.

## How it was tested

- The package: 84 tests, the kernel, both ways to run a step, the grant, evals, the folder check,
  the converter over nine hand-written wizards and the 31 starters, and executor against its
  Google emulator.
- The runtime: 63 tests in the files `test/kernel-*.test.ts`, with a stand-in for the model: both
  ways to run a step, the input asked for, back, limits, a step file that does not compile, leave
  for an action, a wait the clock ends, evals, the switch, the services, the run's page, a
  converted wizard run to its end, signals by address (`kernel-signals`), and views
  (`kernel-views`).
- The MCP door (`test/mcp-runs-kernel.test.ts`): a run answered page by page with the tools every
  run has, its pages as questions the calling app shows, and the run followed as a task.
- A restart of the runner at each kind of wait (`test/kernel-restart-process.test.ts`): a person,
  a time, a signal and the leave for an action, each reached in one process that is then killed
  and left in another, with steps as ordinary code and in QuickJS. Nothing is asked or done twice.
- With real models: the marketplace's templates, walked through in test runs
  ([catalog-0-3-0.md](catalog-0-3-0.md)).
- By hand against a started runtime: a wizard in version 0.3.0 made over HTTP, published, and
  answered in a browser on its public page, from the form through a review to the result.
- Not tested: the cloud, and the runtime's image as Docker builds it (it copies the kernel since
  2026-11-26; the image job does not run on a pull request).

## What is decided

1. **The file** (`wizard.json`) holds what a wizard needs and may reach, and the map: `requires`,
   `connections`, `input`, `output`, `start`, `edges`, `limits`. Nothing about a step is in it.
2. **A step** is a file, `steps/<id>.ts`, with one function and one interface:
   `export default async function (run, ask) { … return { value, to } }`. `ask` is the only way to
   do anything. `to` is one of the step's ways in `edges`.
3. **A run** is a cursor and rows. Every ask is a row. Every step that returned is a row. When an
   ask waits for a person, nothing runs. When the answer comes, that step runs again from its top.
4. **The grant** is made from the file when a run starts and kept on the run. An ask outside it
   fails. An action set to `ask` first asks the user, as a row of its own.
5. **An eval** is a file with the step interface in `evals/<step>/` or `evals/end/`. It judges and
   never routes.
6. **Step code runs as ordinary code only where the runner is one tenant's or one wizard's.**
   Everywhere else it runs in QuickJS. A runner holds no tokens and can call nothing but the kernel
   and the broker.
7. **Executor** (`@executor-js/sdk`) below the broker, for tools, accounts, credentials and the
   call. The kernel asks; the file says what may be reached.
8. **Mastra** stays inside the agent ask. **Tests** of a wizard are optional and not part of it.

## The rule that orders the work

Today's runners are shared: `waitingRuns` in `apps/runtime/src/tenants/control.ts` spans every
tenant. Decision 6 therefore gives two states, and the order below follows from them.

| Where | Until runners are per tenant | After |
|---|---|---|
| A local install, your own wizards | Ordinary code | Ordinary code |
| A local install, a wizard from someone else | QuickJS | QuickJS |
| The cloud | QuickJS, for every wizard | Ordinary code in the tenant's runner; a runner of its own for a wizard from someone else |

So QuickJS comes early, not last: it is what lets version 0.3.0 run in the cloud before the runners
change. What a step may use is the same in both: it computes and asks. Node's own modules in a
step work only where the code runs as ordinary code, and never in a published wizard.

## Which engine runs a wizard

By the wizard, not by a global flip. A wizard in version 0.2.0 keeps today's engine
(`apps/runtime/src/engine/runner.ts`). A wizard in version 0.3.0 runs on the kernel. The switch `kernel`
(`packages/shared/src/feature-flags.ts`, `kind: "release"`, off) allows making and running
version 0.3.0. Nothing changes for a wizard nobody converts.

## Where things live

| Thing | Where | New |
|---|---|---|
| The file | `wizard.draft`; at publish `wizard_version.definition` | No |
| Step and eval files | `wizard_file` under `steps/` and `evals/`; at publish `wizard_version.files` | No |
| The compiled wizard | The blob store, by the hash of its files | Yes |
| A run's cursor, grant, fence, wake | `run.cursor`, `run.grant`, `run.rev` with `run.claim`, `run.wake_at` | No |
| A run's rows | `run_row`: run, n, step, kind, type, role, state, the ask, the answer, by, due, parent, value, to | Yes |
| A run's scores | `run_score`: run, eval, row, score, why, error, asks | Yes |
| The line of runs | `run_index` and `runner` in the control database, `claimRun`, `take` | No |

Rows get a table, not a place in `run.state`: the timeline, the studio and evals read them, and
they are only ever added to, except by a rewind.

## The work

Each numbered item is one pull request unless it says otherwise. All of it is behind `kernel`.
Tests named here run alone, as the repository asks:
`pnpm --filter <package> exec vitest run <file>`.

### A. The kernel as a package

1. **`packages/kernel` from the spike.** `kernel.ts`, `turn.ts`, `grant.ts`, `describe.ts`,
   `memory.ts`, `load.ts`, `check.ts`, `evals.ts`, the two examples. Without `executor.ts`,
   `edge.ts` and their tests, which come back in E and H. Its licence is MIT (decided 2026-11-26): it is
   what others would embed, like `packages/runner`, and `scripts/mit-deps-check.mjs` covers it.
2. **What the spike left out of a run.** `retries` on an ask. `stop` and `pause`. A row under
   another row (`parent`), for what an agent does in its turn. A battery that answers "this needs
   the user's leave", so the broker's rules can ask where the file does not. A wizard as an ask.
3. **Answers checked against fields.** The kinds of a field and their checks from
   `packages/shared/src/definition.ts`, in place of the spike's check for `required`.
4. **QuickJS as the second way to run a step.** The spike's first state (`sandbox.ts` at commit
   `ea7bac3`) behind the same `turn` interface: a compiled step, a clock that stands still, a
   seeded random, a counted interrupt, a fresh module after a turn that broke it. The kernel takes
   which way to use from its host. Test: the offer and mail wizards pass in both ways.

### B. The format

5. **The file's schema** in `packages/shared`: `requires` with `models` from `MODEL_CLASSES`,
   `tools`, `roles`, `hosts`; `connections` by kind, action and `allow` or `ask`; `input` and
   `output` with today's fields; `start`, `edges`, `limits`. A marker `format: 3`. Its JSON Schema
   beside today's (`packages/shared/scripts/write-schema.ts`, `apps/docs/public/schema/v3`).
6. **Compiling a wizard.** On a write to a draft and at publish: bundle `steps/` and `evals/` with
   esbuild into one module and into one script per step for QuickJS, keep both in the blob store by
   the files' hash, and write `wizard.d.ts` into the workspace: the input, each step's ways. A
   bundle that fails is an issue of the wizard, with file and line.
7. **The check.** `describe`, the compile, and the wizard's tests where it has some.
   `wizards check` in `bin/wizards.mjs`, and the same behind `validate_wizard`
   (`apps/runtime/src/mcp/tools.ts`). It lists what the file declares and no test asked for.

### C. The runtime as a host

8. **The tables.** `run_row` and `run_score` in `apps/runtime/src/db/schema.ts`, the migration
   with `pnpm db:generate`. A store over them and `run`, with the fence on `run.rev`
   (`apps/runtime/src/kernel/store.ts`). Test: two saves of one run, the second refused.
9. **The batteries.** `apps/runtime/src/kernel/batteries.ts` over what exists: an agent ask to
   `runAgentStep` (`engine/steps.ts`) with the model from `textModel` (`models.ts`); a tool ask to
   `callConnection` (`tools/connector.ts`) and so to `brokerCall`; generate and render to their
   step functions. Where `decide()` in `broker/call.ts` says ask and the file says allow, the
   battery answers "needs leave" and the kernel asks. The `approval` table is not used by version 0.3.0.
10. **The entry points.** `apps/runtime/src/kernel/host.ts`, called from `services/runs.ts` and
    `engine/runner.ts` when the wizard is version 0.3.0:

    | Today | Kernel |
    |---|---|
    | `createRun`, `kick` | `start`, then the line as it is |
    | `take` → drive | `take` → move |
    | `submitPage`, `reviewStep`, `answerTurn` | `answer` |
    | `signalRun`, with `run_wait` for the lookup | `answer` on the waiting row |
    | `wakeDue` on the clock | `wake` |
    | `goBack`, `retry` | `rewind` |
    | `cancel`, `stopRun` | `stop` |
    | `runView`, the stream | From the rows |

    Test: the scenarios of `test/durable-wait`, `durable-person`, `durable-retry` and `signals`,
    with the offer wizard in version 0.3.0.
11. **A person answers.** The run page (`packages/runner`: `RunnerView`, `AskPanel`) draws a row:
    a form from its fields, a review, the card for an action that needs leave, a `view` of
    components. `answer_form`, `review_step` and `answer_ask` in the MCP server answer a row.
12. **The first wizard end to end.** The offer wizard, made over MCP, run in a local install with
    a real model. This is the point where the switch is worth turning on for ourselves.

### D. Evals

13. **Judging runs.** `judge` when a run ends, for the share of runs a space sets; scores in
    `run_score`; credits counted like any agent ask. Off unless a space turns it on.
14. **A dataset and a past run.** `wizards eval <wizard> --dataset <file>`, and `reask` from the
    studio on one row.

### E. Connections through executor

15. **The mail wizard in the runtime.** `packages/kernel/src/executor.ts` as a battery in the
    runtime, version pinned. A credential provider over the runtime's own connection secrets, so
    accounts stay where they are. Which account stands behind a kind follows
    `docs/plans/run-connections.md`.
16. **Task-sized actions stay.** The actions of `engenty/connections-google/connectors/gmail.ts`
    (`search_threads`, `get_thread`, `send_message`, …) are what a wizard names first. Executor's
    raw operations are for an API that has no connector, which is where
    `connections-external/importer` already reads specs with it.
17. **The emulator in tests.** A helper that starts `@executor-js/emulate` for a service. First
    use: the mail wizard against Gmail, in the runtime's tests. It needs the network once, for
    Google's description of its API; keep a copy in the repository so the test does not.

### F. The studio

18. **The graph from the file.** `apps/web/src/studio/editor/FlowDiagram.tsx` and
    `FlowPreview.tsx` read `edges`. Adding, removing and moving an edge and setting a limit write
    the file. A new way out of a step needs the step to return it: the assistant changes the file.
19. **A step on its node.** The step's file in the editor, and the asks it made in runs: role,
    instructions as sent, fields. The file's `requires` and `connections` as a form. Decided
    2026-11-26: a step's Auftrag is typed over in its panel, for every step, with the code between
    its words kept as chips, as its short texts are. A wizard with one step opens on its prompt.
    Built on 2026-11-26: `instructions`, `prompt` and `brief` are typed over like the short texts
    (`kernel-flow.ts`, `typedOver`), and the editor opens a wizard of one step on that step. Not
    looked at in a browser: a local studio opens only after its setup made a test call to a model.
20. **A run as rows.** `RunTimeline.tsx` from `run_row`, with asking a row again and answering it
    differently. Scores beside the steps they judged.
21. **For those who build.** The authoring guide (`get_authoring_guide`) and a starter in version 0.3.0.
    The assistant writes step files through `write_file`.

### G. Converting

22. **Version 0.2.0 to version 0.3.0**, as a function in `packages/shared`: a definition in, a file and its
    step files out.

    | Version 0.2.0 | Version 0.3.0 |
    |---|---|
    | A form, review, agent, tool, generate step | A step file with one ask |
    | `next` rules and `goto` | The returned `to`, and the edge |
    | `foreach` | Asks side by side in one step |
    | `calc`, a `code` step | Code in the step |
    | Templates | Text built in the step |
    | `who` | `role` |
    | A connection's `policy` | `connections` |
    | The result step | `output` |

    Done when all 31 starters convert, fit their map, and run through with stand-ins. Then
    "Convert" on a wizard in the studio, as a new draft the person looks at. No wizard is converted
    without someone asking.

### H. Where code runs

23. **A runner for one tenant.** A runner that claims only one tenant's runs (`waitingRuns`,
    `claimRun`), started per tenant with runs to do. This is the largest piece outside the code:
    how many processes the cloud holds and when one stops.
24. **Tokens leave the runner.** The broker as a role of its own (`RUNTIME_ROLE` in
    `apps/runtime/src/env.ts`), reached over the peer routes. The runner's network allows only the
    kernel's database and the broker (`compose.cloud.yaml`).
25. **Ordinary code in the cloud.** With 23 and 24 in place, the tenant's own wizards leave
    QuickJS. A wizard from someone else gets a runner of its own or stays in QuickJS.
26. **The edge.** A wizard as a Worker of its own with each run a Durable Object, as the spike ran
    it (`edge.ts`). Only once someone needs it.

## The order, and what each stage gives

| Stage | Items | After it |
|---|---|---|
| 1 | A, B | A wizard in version 0.3.0 can be written, checked and run in tests |
| 2 | C | It runs in a local install and in the cloud (QuickJS), with people answering |
| 3 | F 18–20, G | People see and steer it in the studio; old wizards can move |
| 4 | D, E | Its writing is judged; connections go through executor |
| 5 | H 23–25 | Step code is ordinary code in the cloud |
| 6 | Flip | New wizards are version 0.3.0 |

D and E do not block 3 and can run beside it.

## Before the switch flips

- The 31 starters exist in version 0.3.0 and behave as before for a person using them.
- A run in version 0.3.0 survives a restart of its runner at every kind of wait. Tested:
  `test/kernel-restart-process.test.ts`.
- A wizard from the marketplace cannot read a file or open a connection on a local install.
- The studio's assistant builds a new wizard in version 0.3.0 from a sentence.
- A run's cost is counted as before.
- Languages: where a wizard's labels and prompts in several languages live. Today a starter is one
  definition per language. Not designed.

## Risks

- **Two engines for a while.** Every fix to how a run behaves is made once or twice until the old
  engine goes. Keep the time short by converting the starters early.
- **A step runs again from its top.** Code before an ask must not count on running once. The check
  can warn about a clock or a random in a step that runs as ordinary code.
- **Rules in two places.** The file's `connections` and the space's rules in the broker. The
  stricter one wins; item 9 is where that is built and tested.
- **Runners per tenant** change how the cloud is run, not only the code. Item 23 needs its own
  plan before it starts.
- **Executor** is before 1.0. Pinned, behind one file, with the runtime's own connectors still
  there.

## Not decided

- Whether a way no test covers marks a run or fails it. The spike does neither.
- The exact names inside `requires` and `connections`. The spike's are a reading of today's format.
- How a form shows a number worked out while the person types. No code runs during a wait.
