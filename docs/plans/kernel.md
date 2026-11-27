# Plan: the kernel, a wizard as a file of edges and one function per step

Status: built, on the branch `feat/kernel` (#697). The flip, the switch `kernel` gone and every new wizard in version 0.3.0, is on `feat/kernel-flip`, to merge after #697. What waits on the deploy is H.25 (item 24 says what the deploy changes). Built:
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
| A.2 Retries, stop, rows under an ask, a battery that asks for leave | Built, pause and a wizard as an ask included, in the kernel. The runtime calls neither yet. | `kernel.ts` |
| A.3 Answers checked against fields | Built: the kernel takes the host's check, and a page's answers are checked as a form's are today | `kernel.ts`, `engine/runner.ts` |
| A.4 QuickJS as the second way | Built, with `btoa` and `atob`, which steps written for ordinary code expect | `quickjs.ts`, `compile.ts` |
| B.5 The file's schema | Built | `packages/shared/src/definition.ts`, `kernel-file.ts` |
| B.6 Compiling | Built. At a save the step and eval files are compiled and kept in the object store by the hash of the code files; runs and every runtime take them from there. `wizard.d.ts` is written beside a wizard at every save where it changed. | `apps/runtime/src/kernel/wizard.ts`, `apps/runtime/src/services/wizards.ts`, `packages/kernel/src/types-of.ts` |
| B.7 The check | Built: the file against its step files in `validateWizard`, and the code read without running it in `kernelCodeIssues`: every step and eval compiled, each way a step's code takes against the map. A draft's issues, `validate_wizard`, `wizards validate` and `wizards check` all say it. `wizards check` is not in the help yet. | `definition.ts`, `kernel/check.ts`, `cli/check.ts`, `packages/kernel/src/check-dir.ts` |
| C.8 Tables and store | Built | `run_row`, `run_score`, `kernel/store.ts` |
| C.9 Batteries | Built over today's step executors. A step that asks the person for a yes becomes a row. | `kernel/batteries.ts` |
| C.10 Entry points | Built: start, the line, answers, back, retry, cancel, the clock, the report, and signals by address: the row a run waits at is written where senders look, and a signal for it answers the row. | `kernel/host.ts`, `kernel/signals.ts`, `engine/runner.ts` |
| C.11 A person answers | Built another way: see below. An ask's view (`components`, and the values in `data`) reaches the page. | `kernel/page.ts`, `kernel/views.ts` |
| D.13 Judging runs | Built: a space sets how many of a hundred finished runs its wizards' evals judge (`space.eval_share`, 0 unless set), in the space's Info while the switch is on; the host reads it when a run ends. Scores in `run_score`, shown in the run's rows. `KERNEL_EVALS` is gone. | `kernel/host.ts`, `services/spaces.ts`, `space/SpaceSettings.tsx` |
| D.14 A dataset and a past run | Built: `wizards eval <wizard> --dataset <file>` runs the wizard of the running install over a dataset as test runs and judges each; a past run's rows are asked again in the studio and judged with "Score now". Not in the help yet, like `wizards check`. | `cli/eval.ts`, `routes/local-eval.ts`, `services/evals.ts`, `RunRows.tsx` |
| E Executor | Not built into the runtime (decided 2026-11-27): Composio brings the services that have no connector of our own, through the same broker ([composio.md](composio.md); engenty/wizards#770, switch `composio`). The battery for the runtime is kept as the tag `archive/kernel/executor`. The package keeps `executor.ts` and the emulator for its tests. | `packages/kernel/src/executor.ts` |
| F.18 The map | Built: the studio draws the file's steps and edges, and a step's panel changes its ways and its limit in the file. | `apps/web/src/studio/editor/kernel-flow.ts`, `KernelFlow.tsx` |
| F.20 A run as rows | Built: the runs panel opens a run on its rows, with the scores beside the step they judged; a row is asked again, and one a person answered is answered differently. | `apps/web/src/studio/editor/RunRows.tsx`, `RunTimeline.tsx` |
| F.21 For those who build | The authoring guide and the studio's assistant tell of step files while the switch is on. A starter in version 0.3.0 makes a wizard with its step files, and is offered as usable only while the switch is on. The starters themselves are the marketplace's, in another repository. | `prompts/authoring.md`, `agents/architect.ts`, `services/marketplace.ts` |
| G.22 Converting | Built: `toKernel` makes the file, its step files and notes on what is not carried over; all 31 starters convert, compile and run to their end with stand-ins. The studio's `POST /wizards/:id/convert` makes a copy of a wizard in version 0.3.0. | `packages/shared/src/convert-kernel.ts`, `services/convert.ts` |
| H.23 A runner per tenant | Stage B built: `RUNNER_TENANT` makes a runner take one tenant's runs only, up to the tenant's `limits.concurrentRuns`, and open its own database alone, with no work over the other tenants. A tenant the Manage-App marks with `features.ownRunner` is left alone by the shared runners; its runs wait for its own runner, and the health check names it while that runner is down. The rule of decision 6 picks how a step's code runs. Not built: the compose service (set up by hand) and stage C, runners started when there are runs and stopping when idle ([kernel-runners.md](kernel-runners.md)) | `env.ts`, `tenants/control.ts`, `tenants/own-runner.ts`, `engine/runner.ts`, `db/client.ts`, `index.ts`, `health.ts`, `kernel/host.ts` |
| H.24 Tokens leave the runner | Built in the code, not deployed: the role `broker`. A runner with `RUNNER_TENANT` sends every connector call to it over the peer routes and reads no account; its model calls reach the gateway through it, booked on its own tenant; it opens no other tenant's database and makes none. What the deploy must change, and what the runner still holds, is under item 24. | `env.ts`, `broker/remote.ts`, `routes/broker-peer.ts`, `tenants/tenant.ts`, `db/client.ts`, `test/broker-role.test.ts` |
| H.25 Ordinary code in the cloud | Not built: waits on the deploy of item 24 and on what it still leaves | |

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

The guideline (2026-11-27): no wizard of today has to survive. The format is thought from the
ground up, and the catalog may be built again from scratch in version 0.3.0. Converting
(item 22) is a help, not a condition.

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
7. **The broker** below the kernel, for tools, accounts, credentials and the call: our own
   connectors, MCP servers and Composio. The kernel asks; the file says what may be reached.
   Executor (`@executor-js/sdk`) was the first plan here; it is not built into the runtime (section E).
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

Version 0.3.0 is the format, and the kernel runs it. A wizard in version 0.2.0 loads only where
the switch `version020` is on (`packages/shared/src/feature-flags.ts`, `kind: "release"`, off),
for a tenant that still needs one; then today's engine (`apps/runtime/src/engine/runner.ts`) runs
it. Off, a wizard in version 0.2.0 is not listed or opened, a definition in version 0.2.0 is not
saved, a run of one does not start or move, and the marketplace offers version 0.3.0 only
(`apps/runtime/src/old-format.ts`). A new wizard always starts in version 0.3.0. The guide tells
the assistant of step files, and of version 0.2.0 only as what a step's asks take.

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
   Pause and a wizard as an ask built on 2026-11-26, in the kernel only. `pause` holds a run and
   the runs that answer its asks; an answer is still written, `resume` moves it. An ask of
   `type: "wizard"` names a wizard the file lists in `requires.wizards`; the kernel starts a run
   of it, and its output answers the ask, its failure or stop fails it. In the runtime the file's
   schema has no `requires.wizards` yet (decision 7 names it), so such an ask fails there as one
   the file does not grant, and nothing pauses a run there: no button, route or tool calls it.
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
   Built on 2026-11-26. The compile a draft's check does is the one a run takes
   (`compiledCode`): code that compiles is kept under `compiled/<mode>/<hash>.json` in the
   tenant's object store, by the paths and hashes of the code files, so publish keeps what the
   last save compiled. `wizard.d.ts` is left out of that hash. Kept compiles are not deleted
   with the blobs they came from; they go with the tenant.
7. **The check.** `describe`, the compile, and the wizard's tests where it has some.
   `wizards check` in `bin/wizards.mjs`, and the same behind `validate_wizard`
   (`apps/runtime/src/mcp/tools.ts`). It lists what the file declares and no test asked for.
   Built on 2026-11-26. One check of the code for every door (`kernel/check.ts`): a step or eval
   file that does not compile for the sandbox, a step file that exports no function, and a way a
   step's code takes that the map lacks. The file's own check now also names a step the map
   reaches and gives no way on. A draft's issues carry both, so the studio, the assistant's
   writes and `get_wizard` say them before a run; `validate_wizard` takes a `wizardId` to check
   against that wizard's files; `wizards validate` compiles the step files of a package.
   `wizards check <folder>` reads a wizard's own folder (`wizard.json` with the map, `steps/`)
   the same way, then writes `wizard.d.ts` and runs its `tests.json`; any other path goes to
   `wizards validate`. The command is left out of the help until the switch is on.

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
    Built on 2026-11-26: `space.eval_share`, how many of a hundred finished runs are judged, 0
    by default, set by an admin in the space's Info ("Läufe bewerten", behind `kernel`) through
    `PATCH /api/studio/spaces/:id`. The host draws against it when a run comes to its end; the
    env `KERNEL_EVALS` is gone, and tests set the space. An eval's asks go through the run's
    batteries, so they cost what a step's asks cost.
14. **A dataset and a past run.** `wizards eval <wizard> --dataset <file>`, and `reask` from the
    studio on one row.
    Built on 2026-11-26: `wizards eval` names a wizard of the running install by its title or
    id and sends the dataset (a JSON list of `name`, `input` and, by step, `answers`) to
    `POST /api/local/eval`, signed with the data folder's secret as `wizards logs` is. Each entry
    becomes a test run of the draft; its waits are answered from the entry until it has no more
    to say, and the run is then judged whatever the space's share (`services/evals.ts`). The
    command prints each entry's scores as it comes and the mean of each eval at the end; the
    runs stay in the studio. The kernel's own `reask` on a copy is not used: in the studio a
    row is asked again on the run itself (item 20), and "Jetzt bewerten" in the run's rows
    (`POST /api/runs/:id/judge`) judges what has not been judged since.

### E. Connections through executor

Decided 2026-11-27: not built into the runtime. Services such as Gmail come through our own
connectors and Composio, beside each other and through the same broker
([composio.md](composio.md)). Item 15 was built on the branch `kernel/executor` and is kept as the
tag `archive/kernel/executor`; items 16 and 17 stay as written for the package.

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
    Built on 2026-11-26, in the step's panel (`KernelFlow.tsx`): each way of the file has where it
    leads as a choice, a button that makes it the first and one that removes it; a way is added
    from the steps that have a file, and the limit is a number. The file is written with
    `withWays` and `withLimit` (`packages/shared/src/kernel-file.ts`). The panel lists the code's
    ways beside the file's (`stepWays` in `kernel-flow.ts`): a way of the file the code names
    nowhere offers a note to the assistant, a way the code takes and the file lacks offers to add
    it. `start` is not changed there, and nothing is dragged on the map itself.
19. **A step on its node.** The step's file in the editor, and the asks it made in runs: role,
    instructions as sent, fields. The file's `requires` and `connections` as a form. Decided
    2026-11-26: a step's Auftrag is typed over in its panel, for every step, with the code between
    its words kept as chips, as its short texts are. A wizard with one step opens on its prompt.
    Built on 2026-11-26: `instructions`, `prompt` and `brief` are typed over like the short texts
    (`kernel-flow.ts`, `typedOver`), and the editor opens a wizard of one step on that step. Seen
    in a local studio on 2026-11-26: the prompt is typed over and written into the step file with
    its code kept. A `.ts` file is stored as text since then, so the code view shows a step file
    that was written without a type of its own.
    Built on 2026-11-26: the file's `requires` and `connections` as a form in the wizard's
    settings (`KernelNeeds.tsx`): model classes and built-in tools to pick, other tools, hosts and
    roles as lists, and each connection with its actions, allowed or asking first. The file is
    written with `withRequires` and `withConnections`; `withKernelFile` writes the file's
    connections into the definition around it, where the broker reads them. The names are the
    ones the file has today; they are still open (see the decisions).
20. **A run as rows.** `RunTimeline.tsx` from `run_row`, with asking a row again and answering it
    differently. Scores beside the steps they judged.
    Built on 2026-11-26: `RunRows.tsx` in the run's timeline, read from `GET /api/runs/:id/rows`
    and written through `POST /api/runs/:id/rows/:n` with `back`. The timeline answers for such a
    run without `durableRuns`, with the file's steps and the roles a person answers in. An eval's
    scores show where the runtime judges runs (`KERNEL_EVALS`); the studio has no button that
    judges one run.
21. **For those who build.** The authoring guide (`get_authoring_guide`) and a starter in version 0.3.0.
    The assistant writes step files through `write_file`.
    Built on 2026-11-26: the studio's assistant is told of step files as the guide tells an MCP
    client, while the switch is on. A starter in version 0.3.0, a plugin's or the marketplace's,
    makes a wizard with its step files (`plugins.test.ts`), and an entry of that version is marked
    usable only while the switch is on. The marketplace's own templates in version 0.3.0 are in
    engenty-wizards-manage. Seen the same day in a local studio: from one sentence the assistant,
    answering through Codex, made a wizard in version 0.3.0 of three step files with a way back
    and limits; the check had nothing to say of it. The studio's own assistant, on a key or the
    gateway, is covered by a test only.

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
    Built in the code on 2026-11-27, not deployed:

    | What | How | Where |
    |---|---|---|
    | The role | `RUNTIME_ROLE=broker` serves the broker's peer routes and nothing else of the app | `env.ts` (`serves.broker`), `app.ts` |
    | A connector call | On a runner with `RUNNER_TENANT`, `brokerCall` sends who calls, where, the connection by its id, the action and the input to `POST /api/peer/broker/call`. The broker reads the row, the account and the secret itself, decides, runs the action and logs it, and sends back the result or the refusal. Where the rules ask, it sends the question; the runner asks it as before (a run of version 0.3.0 answers with a row of its own) and sends the call again with the answer. What a step does before and after the action (a file put into the input, a file kept from the result, the run's log line) runs on the runner (`prepare`, `after`, `started`). | `broker/call.ts`, `broker/remote.ts`, `routes/broker-peer.ts`, `tools/connector.ts` |
    | Whether an account is there | `brokerConnected` the same way, `POST /api/peer/broker/connected`: as whom, never the secret | the same |
    | A model call | The gateway of a Manage-App's runtime is reached through `/api/peer/gateway/*`. The broker adds the runtime's key and the tenant the runner's ticket names: a runner books on its own tenant and no other | `models.ts` (`managedGateway`), `routes/broker-peer.ts` |
    | The tickets | Each runner signs with `BROKER_KEY`, the HMAC of `broker:<tenant>` under the broker's `BROKER_SECRET` (`brokerKeyOf`). A ticket covers its tenant and the call's body, for a minute; the gateway's for an hour. The broker answers it in that tenant alone | `secrets/signing.ts` |
    | The tenant databases | A runner with `RUNNER_TENANT` refuses another tenant in `inTenant` and `tenantDb`, makes no database of its own tenant where none was mounted, and its sweeps and its minute's work (`knownTenants`, `activeTenants`, `migrateAllTenants`) know its tenant alone | `tenants/tenant.ts`, `db/client.ts`, `engine/starts.ts`, `engine/mail-watch.ts`, `engine/notices.ts`, `plugins/jobs.ts` |
    | A shared runner, a runtime that runs alone | Call in their own process, as before | |

    Tested in `test/broker-role.test.ts`: a tenant runner's call goes through the broker, which
    alone opens the secret, the runner asks where the rules ask, a call with its own handler is
    refused, a ticket opens no other tenant, the gateway gets the runtime's key and the runner's
    tenant, and the runner opens no other tenant's database.

    What the deploy must change (`compose.cloud.yaml`, the user's):

    - A service `broker`: the same image, `RUNTIME_ROLE=broker`, `BROKER_SECRET`, `STORE_ENC_KEY`,
      `APP_SECRET`, `MANAGE_SERVICE_KEY`, `GATEWAY_URL`, and the tenant databases as the studio has
      them. Not behind the proxy: on a network of its own with the tenant runners.
    - Each tenant's runner: `RUNTIME_ROLE=runner`, `RUNNER_TENANT=<id>`,
      `BROKER_URL=http://broker:<port>` and
      `BROKER_KEY=$(printf 'broker:%s' <id> | openssl dgst -sha256 -hmac "$BROKER_SECRET" -r | cut -d' ' -f1)`.
      Without `STORE_ENC_KEY`, `BROKER_SECRET` and `GATEWAY_URL`. Its networks: the broker's and the
      sandbox's, not `browser` and not the outside.
    - `STORE_ENC_KEY` set and not equal to `APP_SECRET`: without it the store's key is made from
      `APP_SECRET`, which the runner keeps. Where the cloud seals with `APP_SECRET` today, what is
      sealed has to be sealed again under the new key first; nothing in the code does that yet.
    - The tenant's database off `runtime-cache`: the runner mounts its own tenant's files only.
      Today they are `tenants/<id>.db` with its `-wal` and `-shm`, `tenants/<id>/` beside it and
      the tenant's objects under `objects/t/<id>/` (or S3). A volume per tenant needs them in one
      folder; that move is not in the code.

    What a tenant's runner still holds or reaches:

    - `MANAGE_SERVICE_KEY`, for the Manage-App's answers about its tenant (`tenantInfo`, the
      features, the members): a key for every tenant. A key per tenant, or those reads through the
      broker, is the next step.
    - `APP_SECRET`, which signs sessions and links of every tenant; and the control database,
      which holds every tenant's sessions, while it is a file on the shared volume (libSQL is
      planned later, kernel-runners.md decision 7).
    - A tenant's own provider keys saved in the cloud studio: sealed in the tenant's settings,
      which the runner cannot open without `STORE_ENC_KEY`. Its models then go through the gateway,
      the tenant's own accounts with the switch `ownKeysGateway`.
    - Calls that bring their own handler need the account in the process and are refused on such a
      runner: a connector's tool list read again (`list_tools`), the targets of share jobs, a
      plugin's `request`, and the mail stream the runner watches (`brokerPullStream`,
      `brokerReadMessage`), so mail starts no run there yet. Each needs a named action on the
      broker's side. The browser's kept sign-ins (`brokerSecret`) are read in the runner's own
      process, which cannot open them without `STORE_ENC_KEY`: the browser starts signed out.
    - The runner trusts its own process for who calls; the broker checks the tenant, not the
      person. Ordinary code of the tenant could name another person of the same tenant.
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

Where each condition stands on 2026-11-27:

| Condition | Where it stands |
|---|---|
| A catalog exists in version 0.3.0. By the guideline it may be built again from scratch; it need not be the 31 starters behaving as before | The reworked templates are on the Manage-App's `feat/catalog-0-3-0` (engenty/engenty-wizards-manage#213), not merged |
| A run in version 0.3.0 survives a restart of its runner at every kind of wait | Met: `test/kernel-restart-process.test.ts` |
| A wizard from the marketplace cannot read a file or open a connection on a local install | Met: a starter's steps run in QuickJS whatever the runner (`stepMode`, `test/kernel-where.test.ts`), and QuickJS has no `fetch`, `process`, `require` or timers (`quickjs.test.ts`). Its asks reach only what the grant holds, through the broker, and a `file` ask reads only the wizard's own files |
| The studio's assistant builds a new wizard in version 0.3.0 from a sentence | Met: task 18, seen in the studio |
| A run's cost is counted as before | Met by construction: every ask a model answers runs through today's step executors (`kernelBatteries`), which charge as every run does |
| Languages | Decided (below); a second language is built with the first entry that has one |

## Risks

- **Two engines for a while.** Every fix to how a run behaves is made once or twice until the old
  engine goes. It goes in the release after the flip.
- **A step runs again from its top.** Code before an ask must not count on running once. The check
  can warn about a clock or a random in a step that runs as ordinary code.
- **Rules in two places.** The file's `connections` and the space's rules in the broker. The
  stricter one wins; item 9 is where that is built and tested.
- **Runners per tenant** change how the cloud is run, not only the code. Item 23 needs its own
  plan before it starts.

## Decided on 2026-11-27

Decided in this session, each with its reason. The guideline above holds for all of them.

- **A way no test covers** is only listed, as `wizards check` does today. Tests of a wizard are
  optional; a wizard with some tests must not be held to more than one with none.
- **The names inside `requires` and `connections`** stay as they are: `requires.models`, `tools`,
  `roles`, `hosts` and `wizards`, and `connections` by kind, then action, then
  `allow` or `ask`. A Composio toolkit is named there like any other connector. The runtime's
  schema keeps `requires.wizards`; an ask of another wizard fails there in its own words until the
  runtime starts runs of one.
- **A number worked out while the person types** is a `calc` in the ask's view: a prop
  `{ "calc": "amount * rate" }` over the form's field ids and its data, worked out by the page as
  the person types (`packages/chatviews/src/calc.ts`). It was there already; a test in
  `kernel-views.test.ts` holds it for an ask. No step code runs during a wait, and a `calc` cannot
  call anything. The value the run keeps is worked out by the step when it runs again with the
  answers.
- **The kernel stays our own engine.** Mastra's JSON workflows were tried: a step that names its
  next step and a timed wait do not fit, and the grant, the rows and the line of runs would stay
  ours around them. Mastra stays inside the agent ask (decided point 8).
- **Executor is not needed for the flip.** Services come through our own connectors, MCP servers
  and Composio, all through the broker. Decided point 7 now reads as the broker below the kernel;
  the runtime battery of `kernel/executor` is kept as the tag `archive/kernel/executor`.
- **What a step may read:** the input, the date and earlier steps, as before, and by an ask each,
  answered without a model: the space's brand (`{ type: "brand" }`) and a file of the wizard's own
  (`{ type: "file", path }`), for every wizard; one of the file's `lists`
  (`{ type: "list", list, query }`), and a row written to it (`{ type: "list", list, row }`). The
  grant holds the file's lists; an ask for another list fails. Each answer is a row, so a step
  that runs again reads the same. Built: `readerBatteries` in `kernel/batteries.ts`, two tests in
  `kernel-run.test.ts`, the authoring guide and the kernel's README.
- **How often a review sends a step back** in a converted wizard: 10, the converter's default,
  inside the 4 to 11 of the reworked templates. A wizard built in version 0.3.0 sets its own in
  `limits`.
- **Languages.** A wizard has one language, `lang`. Another language is a file
  `lang/<code>.json` beside `wizard.json`: the texts a person reads, by where they stand in the
  file (`input.fields.name.label`) and by the id of an ask's text in a step. A step reads
  `run.lang` for what it writes into a prompt. One wizard per language goes. Built when the first
  entry in a second language is; until then the catalog is German (catalog-0-3-0.md).
- **The flip.** When the conditions above hold, a new wizard is version 0.3.0 and the switch
  `kernel` goes. Built on `feat/kernel-flip`: the switch is out of the list, the run's refusal
  and its words are gone, the marketplace offers and runs version 0.3.0, the guide and the
  assistant say every new wizard is one, and `wizards check` and `wizards eval` are in the help.
  Merged as #771. Decided on 2026-11-27 after it: version 0.2.0 does not load unless the switch
  `version020` is on, rather than old flows running untested ("Which engine runs a wizard").
  When no tenant needs it, the switch and today's engine go.
  The catalog is built again in version 0.3.0, not converted entry by entry.
- **Runners per tenant:** the answers are in [kernel-runners.md](kernel-runners.md).
