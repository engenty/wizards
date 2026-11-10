# Plan: runs on their own

Status: plan, written on 2026-11-10. Phase 0 done, not committed (see Progress). The same plan with its
diagram is the artifact "Self-contained Wizard Runs"
(claude.ai/artifact/1heGEt5oi3vLoghrHJsvyp). Builds on `docs/plans/broker.md` (its phase 3 is
phase 3 here), `docs/plans/modular.md`, `docs/plans/wizard-code.md` and
`docs/plans/wizard-data.md`.

A wizard is a file. A run of it is a small program that stores its state, waits, and makes
requests. Everything heavy or shared stays with the tenant, behind the broker. This plan says how
that looks when it is built, and how to get there from today's code in small pull requests.

## Progress

| Id | State | Result |
|---|---|---|
| 0.1 | written, not committed | This file, and a pointer in `docs/content/dev/architecture.md` |
| 0.2 | measured | esbuild 0.28.2, neutral build with workerd's conditions. `transition.ts` 476 KB, 0 Node builtins. Agent loop on `ai` + gateway 737 KB raw / 167 KB gzip, 0 builtins. Same on Mastra `Agent` 6,544 / 1,668 KB, 17 builtins (all `@mastra/core`) and `new Function(…)`. `steps.ts` and `runner.ts` do not bundle (canvas native addon, playwright), 43 builtins, the same 2,144 modules for both; Mastra alone is not the blocker (26+ builtins without it). Cycle `steps.ts → tools/index.ts → elements/catalogue.ts → elements/wizards.ts → services/runs.ts → runner.ts`, broken by 1.4b. QuickJS on `quickjs-emscripten-core` 55 KB + 507 KB `.wasm` imported as a module (`newVariant(…, { wasmModule })`), 0 builtins; `@mastra/quickjs` 4.3 MB, 13 builtins, fails once bundled. The code step's 10 s cap uses `Date.now()`, which stands still in a deployed object during CPU work. Results: `.claude/worktrees/agent-a86f1b90c11288fbe/spikes/engine-bundle/RESULTS.md`, uncommitted. |
| 0.3 | ran | One Durable Object per run on local workerd (wrangler 4.153.0), importing `transition()` and `parseWizard()` unchanged; model was a local mock, not the gateway; never deployed. Happy path form → decision → agent with a 3-minute stream → wait → signal → result in 243 s; the stream ran in one alarm call of 182 s wall, about 1.6 s process CPU. Killed 60 s into the stream: the call is cut, state and alarm survive, the watchdog alarm fired 30 s later without a request and the call went on from the saved text (180/180 tokens in order; needs a model API that continues an assistant message, else the call repeats). State survived kills at a form and during sleeps; overdue alarms fire at start-up. Bundle 933 KiB / 161 KiB gzip. No limit hit locally (local dev enforces none). Docs: 30 s CPU per request or alarm (max 5 min), 15 min wall per alarm call, 128 MB per isolate, one alarm per object, a stream is cut by code updates and runtime restarts. For the plan: each model call saved and the alarm re-armed (2.4), the one alarm carries `wakeAt`, reminders and the watchdog (6.1), signals matched at the tenant (`run_signal`). D4 stays a sub-processor and region question. Results: `.claude/worktrees/agent-ab157cabcca458941/spikes/run-object/RESULTS.md`, uncommitted. |
| 0.4 | written, passes, not committed | `apps/runtime/test/pinned-runs.test.ts` and a one-tool plugin `fixtures/pinned-runs/plugins/pinned.ts` (`pinned.stamp`). Six runs through the real runner with `durableRuns` on and a scripted model (`textModel` mocked as in `durable-steps`): form → agent → review → result; a `decision` branch with `next.ask` rules; a `tool` step (plugin tool, no model); `foreach` over 3 entries; a signal wait (`signalRun`, only the signal's `fields` reach the run); `retries: 1` with the clock's own wake after `failureRetryMs`. Each asserts the moves of `transition()` (wrapped with `vi.mock`), the `run_event` rows, the model calls and the full state. About 20–30 s, 10 s of it the real retry wait. Not pinned: `durableRuns` off, `onFail`, a `tool` step on a `wizard.*` tool (the validator refuses it). Holds only while `@engenty/wizards-shared/transition` and `src/models.js` stay mockable: package 2.1 must keep the engine inlined by vitest, and 1.4a must keep `textModel` behind `models`. |
| format | PR open | A `tool` step may call `list_write` with fixed input (`call: { tool: "list_write", input: { list, rows?, delete? } }`): a sign-up or a request is saved as a row with no model, once per visit (`run_effect` `<run>:<step>:<visit>`, as a connection's action). The architect's guide says so for collecting. After 1.4b it is one more name `tools.call` resolves. |

## In short

- **The wish:** a wizard that runs on its own, anywhere, without a 900 MB install and without losing tenants, rights, credits, people in the flow and the doors.
- **The finding:** eve, flue and executor are not processes per agent. Each is one server that holds many sessions. What is self-contained there is the unit on disk and one command to run it.
- **What we already have:** the unit (a `.wizard` file), a pure flow function (`transition()`), a grant per run, a broker, and doors that all read the same run view.
- **What is missing:** the code that runs a step reaches straight into the runtime: database rows, files, models, tools. So a run can only live inside the runtime process.
- **The plan:** give the run one way out (the run's services, each call with the run's token), move the code that runs a run into a package of its own, and then let that package live in three places: the runtime, `wizards run`, and an isolated object.
- **What does not change:** the wizard format, tenant isolation, the broker's rules, the doors' routes, the plugin API, Manage.

## Today, from the code

Line numbers are from `main` at `c71df50d`. Names are stable; lines move.

| Part | How it is | Where |
|---|---|---|
| Flow | Pure. Takes the run and an event, returns one command: `run`, `decide`, `ask`, `sleep`, `waitSignal`, `end`, `fail`, `stay`. Reads no database, calls no model. | `packages/shared/src/transition.ts` |
| Host of the flow | One file of 3,269 lines: the line of runs, claims, the drive loop, every handler for a person, the run view. Imports 34 runtime modules from outside the engine folder. | `apps/runtime/src/engine/runner.ts` · `createRun` :552, `drive` :2179, `flow` :1834, `apply` :1891, `makeContext` :1112, `runView` :3036 |
| Step code | `runAutomaticStep` picks a function by step type. The functions import models, tools, files, media, knowledge and the broker directly. | `engine/steps.ts` :1277 · `runAgentStep` :642, `runToolStep` :606, `runGenerateStep` :1223 |
| What a step is handed | `StepContext`. It carries two database row types (`space: SpaceRow`, `spaceFiles: SpaceFileRow[]`), the store scope, and in-process things: browser page, sandbox, egress. | `engine/types.ts` :24 · `engine/resources.ts` |
| Agent step | Mastra `Agent`, messages in memory. With `durable: true`: Mastra `DurableAgent`, snapshots in `mastra_workflow_*` tables of the tenant's database. | `engine/steps.ts` · `engine/durable-turn.ts` |
| Run state | One row per run in the tenant's database. Nine places write it. A second row in the control database is the line the runners read. | `schema.run` · `updateRun` :390 · `tenants/control.ts` (`run_index`) |
| Process | One program, roles `studio \| doors \| api \| web \| runner \| all`. A runner claims runs from the line and drives up to 16 at once, of any tenant. | `env.ts` :74 · `claimRun`, `heartbeatRuns` |
| Broker | A library in the runtime process. Decides connector calls, `http_request`, mail, sandbox egress. Knows who calls (`Who`, `Where`, carried in `AsyncLocalStorage`) and the run's `Grant`, fixed at the start. Writes `broker_log`. Acting calls happen once (`run_effect`). | `broker/call.ts`, `grant.ts`, `caller.ts`, `effect.ts`, `over.ts` |
| Not behind the broker | Model calls, `web_fetch`, `web_search`, `generate_image`, browser navigation, a plugin's own fetch. | `docs/content/dev/broker.md` |
| Tokens | HMAC tickets for one run's routes (`runTicket`), a view, a wait mail, a peer take. None carries who, where or a grant. | `secrets/signing.ts` |
| Models | A step names a class. The runtime resolves it: an installed AI client (child process), Apple on the device, Ollama, own keys, or the model-gateway (`/v4/ai`, fetch only). | `models.ts` · `harness/` |
| Tenants | Each has its own libsql database and its own key prefix in storage (`t/<tenant>/`). The tenant of a request comes from the link or the run id, never from the body. | `db/client.ts` `withTenant` · `files/objects.ts` · `tenants/tenant.ts` |
| Doors | All use `/api/runs/:id/…`: the view, a stream of views, pages, reviews, back, retry, cancel. The screen is `packages/runner` with a `RunSource`. MCP, `/api/v1` and plugins read the run report. | `routes/runs.ts` · `services/runs.ts` · `mcp/tools.ts` · `plugins/runs.ts` |
| One request already goes to another process | A run's live browser is answered by the runner that holds it. The route hands the request on. | `engine/owner.ts` `fromOwner` |
| Heavy parts | Chromium, ffmpeg, canvas, PDF and OCR reading, node-pty, the native libsql client. Five libraries install on first use into `extras/`. | `on-demand.ts` · `scripts/npm-package.mjs` |

Mastra is used less than its size suggests. No `createWorkflow`, no Mastra server. Inside a run it is the agent loop and its snapshots. Outside runs it is Memory for Work chats, the architect and the assistants.

## The intended structure

**A run does three things: it stores its state, it waits, and it makes requests.** Every model call and every tool call is a request that carries the run's token. A run holds no credentials, no database connection and no tool code.

### The three things

| Thing | What it is | Exists today as |
|---|---|---|
| Wizard | A file: `wizard.json` and `files/`. Data plus the wizard's own tools, skills and agents. It names no tenant. Its root `requires` says what a run needs. | The `.wizard` file, format version 1 |
| Run | The engine, the run's state and the run's token, on a host. One run, one tenant. | A `run` row driven inside the runner process |
| Services | Everything a run asks for: models, tools, files, data, knowledge, connections, whole steps that need heavy software. | Modules the step code imports directly |

### Record, state, token

Today one row is all three. They come apart.

|  | Holds | Lives | Written by |
|---|---|---|---|
| Run record | Run id, wizard and version, holder, mode, grant, status, label, cost, the host's address, expiry. | Always in the tenant's database (`run`) and the line (`run_index`). | The tenant's runtime: at the start, at each status change the host reports, at the end. |
| Run state | `FlowRun`: cursor, status, `RunState` (answers, outputs, history, visits), `wakeAt`. The messages of an agent turn that is under way. The events of the run. | With the host. In the runtime that is still the `run` row. On another host it is the host's own storage, and a copy goes to the tenant at each person's step and at the end. | Only the engine on that host. |
| Run token | Tenant, run, wizard, space, data space, mode, holder, host kind, expiry. Signed. The grant itself stays on the record. | With the run. | Minted once in `createRun`. A stopped or ended run is refused (`broker/over.ts`, as today), which is the revoke. |

### The engine and what it needs from its host

The engine is the code that takes a run from one event to the next wait. It is a package without Node-only imports. What it cannot do itself it asks its host for.

```ts
// packages/engine — sketch; names are proposals
export interface RunHost {
  /** The run's state: load, save with a revision, append events. */
  state: {
    load(): Promise<{ run: FlowRun; rev: number }>;
    save(run: FlowRun, rev: number): Promise<number>;       // throws when rev moved
    event(e: RunEvent): Promise<void>;
  };
  /** An agent turn under way, saved after every model call. */
  turns: { load(id: string): Promise<Turn | null>; save(t: Turn): Promise<void> };
  /** The clock: now, and "wake me then". */
  clock: { now(): number; wakeAt(at: number | null): Promise<void> };
  /** Everything outside the run. */
  services: RunServices;
  /** What the run was started with. */
  def: WizardDefinition; files: WorkspaceFile[]; token: string;
}

/** Takes the run from this event to its next wait or its end. */
export function advance(host: RunHost, event: FlowEvent): Promise<FlowResult>;
```

### The run's services

One typed object, two implementations: called as functions inside the runtime, and over HTTP from any other host. The same tests run against both.

| Service | Calls | Belongs to | Today's code behind it |
|---|---|---|---|
| `models` | `turn(request)`: one model call for a class, streamed. `decide`, `embed`. | shared | `models.ts` `textModel`, `agentModel`; `engine/decide.ts`; the model-gateway |
| `tools` | `list(stepId)`: name, description, input schema of every tool the step may use. `call(name, input, effect)`. | shared or tenant, per tool | `tools/index.ts` `buildStepTools`, `elements/catalogue.ts`, `tools/plugin.ts`, `tools/connector.ts` |
| `context` | `forStep(stepId)`: what the model is told beside the task: brand, knowledge index, skills, date, language. | tenant | `brandBlock`, `knowledgeBlock`, `spaceProfile`, `prepareInputs` |
| `files` | `read(ref)`, `save(bytes \| url)` giving a reference, `link(ref)` giving a signed address. Bytes go between a service and storage, not through the run. | tenant | `files/storage.ts` `saveAsset`, `loadAsset`; `files/objects.ts` |
| `data` | Lists, kept files, the wizard's own database: `query`, `exec`, list rows and counts. | tenant | `store/index.ts`, `tools/store.ts`, wizard data (#597) |
| `steps` | `run(step)` for steps a service does whole: `generate`, `widget`, `motion-graphics`. Answers with the output or with `pending`. | shared | `media/generate.ts`, `widgets/step.ts`, `motion-graphics/step.ts` |
| `people` | `tell(notice)`: a step waits for someone, a reminder, done, failed. | tenant | `engine/notices.ts`, `engine/push.ts` |

- **Every call carries the token.** The broker reads the tenant from it, opens that tenant's context (`withTenant`), sets the caller (`withCaller`) and checks the grant before any rule, as it does today for connector calls.
- **Every acting call carries an effect id.** The rule from `broker/effect.ts` holds for all of them: `<turn>:<toolCallId>` in an agent turn, `<run>:<step>:<visit>` for a fixed step. A call repeated after a restart finds its row and does not act twice.
- **A failure comes back with its class.** `retry`, `credits`, `sign_in` or `final`, the classes `transition()` already takes as `FlowFailure`.
- **A long call answers `pending`.** A film or a long sandbox command does not hold a request open. The service tells the run when it is done, and the run sleeps until then.
- **Whoever spends, books.** The gateway books model calls. A service books its own cost. The run calls no `chargeUsd`.

### Tenants

- Isolation stays as it is: a libsql database per tenant, storage under `t/<tenant>/`, the tenant taken from a link or run id and never from a body.
- A run belongs to exactly one tenant, and its token says which. The broker is the only way from a run to that tenant's data.
- A wizard file names no tenant. The tenant comes with the start.
- Shared software (browser, PDF and OCR reading, sandbox, films, the model-gateway) keeps nothing. It gets a file by reference from the tenant's storage and writes its result back there.

### Start, wake, signal, end

| Moment | Who acts | What happens |
|---|---|---|
| Start | The tenant's runtime (`createRun`) | Checks `requires`, plan and switches. Reserves credits. Fixes the grant. Mints the token. Picks a host with `hostFor(requires)`. Hands the host the definition, the workspace by reference, the token and the first state. |
| A person answers | A door, through the run routes | The route checks who may answer (`openedRun`, `mayAct`), then sends the event (`answered`, `reviewed`, `regenerate`, `back`, `cancel`) to the host. |
| The clock | The host | The host wakes itself at `wakeAt`: a timer, an alarm, or the runner's clock sweep as today. |
| A signal, a mail, a start by schedule | The tenant's runtime | Signals are stored at the tenant first (`run_signal`), then sent to the host as the event `signal`. |
| End | The host, then the tenant | The host posts the final state and cost. The tenant writes the record, releases credits, tells people and plugins, and releases what services held for the run (browser page, sandbox). |

### Doors

- Doors keep calling `/api/runs/:id/…` at the tenant. Who may see and answer stays in one place.
- The routes get the state from the run's host. When the host is this runtime that is a function call. When it is elsewhere it is three calls: `state`, `changes`, `events`. `engine/owner.ts` already hands a request on to another process; this makes it the rule.
- The view is computed from the state: `viewOf(def, state, extras)`, a pure function in `packages/shared`. The tenant adds what only it knows (translations, connections, lists, brand). The WordPress plugin already builds a view this way in the browser.
- No door is written per host. The screen (`packages/runner`), the MCP tools, the flow widget, plugin channels and `/api/v1` stay as they are.
- `wizards run` adds one door: the terminal.

### Where a run can live

| Host | State kept in | Wakes by | Services reached | For |
|---|---|---|---|---|
| The runtime (runner role) | The `run` row, as today | The line and the clock sweep, as today | As functions, or over HTTP to the role `broker` | Every wizard. The only host that can use an installed AI client or a local model. |
| `wizards run` | A file per run in a folder | A timer while the process lives; `--continue` after | Over HTTP: the organization's, or a runtime on the same machine | A server, a company network, a script, a developer's terminal. |
| An isolated object | The object's own storage | The object's alarm | Over HTTP: the organization's | Published wizards with many runs that mostly wait. |

`requires` decides before the start whether a host can run a wizard. Nothing falls back in the middle of a run.

### Connected, or on its own

- **Connected:** the tenant is the organization in the cloud. The run needs the broker's address and a token. Nothing heavy is on the machine.
- **On its own:** the tenant is on the same machine, inside a local runtime, with its own database, files and Wissen. It can sync with the organization later (`docs/plans/tenant-sync.md`; runs do not sync).

### What Mastra is afterwards

- Inside a run: nothing. The agent loop is the engine's, saved after every model call into the run's state. It has to be ours, because the state must live wherever the run lives.
- Outside runs, unchanged: Memory for Work chats (`services/work-mastra.ts`), the architect, the studio assistant, the space agent.
- A Mastra workflow as a step stays the optional roadmap item it is (`docs/plans/mastra-workflow-step.md`). It would be one more whole-step service.

## Step by step

The twelve step types of version 1, as they run in the intended structure.

| Step | Who does the work | Requests the run makes | Today |
|---|---|---|---|
| `form` | A person, at a door | `people.tell` when it waits long. Uploads go from the door to `files`. | `submitPage` runner.ts :2559, `readPageInput` |
| `review` | A person | `people.tell` | `reviewStep` :2748 |
| `result` | The engine | `files.link` for each deliverable | `availableFormats` :2918 |
| `wait` | The engine and the clock | None. A signal arrives as an event. | `enterWait` :1384, `engine/signals.ts` |
| `decision` | The engine | `models.decide` (class `classifier`) | `decisionAsAgent`, `engine/decide.ts` |
| `agent` | The engine: the loop of model call, tool calls, model call | `context.forStep`, `tools.list`, then `models.turn` and `tools.call` in turns. Saved after each model call. | `runAgentStep` steps.ts :642, `durable-turn.ts` |
| `agent` with `foreach` | The engine, up to `concurrency` at once | As agent, per entry | `runAgentEach` :503 |
| `tool` | The engine: one call, no model | `tools.call` for a plugin's tool or a connection's action; `data.exec` for a fixed SQL statement | `runToolStep` :606 |
| `code` | The engine, in QuickJS (WebAssembly, a heap of its own per run), on every host | Its `fetch` goes to the broker; its `tools.<id>()` are `tools.call`. Each with the run's token. | `engine/code-step.ts`, `engine/quickjs.ts` |
| `generate` | A service | `steps.run`; a video answers `pending` | `runGenerateStep` :1223, `media/generate.ts` |
| `widget` | A service (bundler, Chromium) | `steps.run` | `widgets/step.ts` |
| `motion-graphics` | A service on a runtime with the film tools | `steps.run`, answers `pending` | `motion-graphics/step.ts` |
| `surface` | The engine | `models.decide` where it composes | `engine/surface.ts` |

### Tools

| Tool | Needs | Keeps something per run | Behind the broker today | Intended |
|---|---|---|---|---|
| `web_search`, `web_fetch`, `image` | fetch, a model | no | no | A broker call with a descriptor and a log line |
| `http` | fetch | no | yes (`brokerHost`) | unchanged |
| `browser` (15 tools) | Chromium | one page per run | only kept sign-ins | The browser service keeps the page by run id. Navigation is a broker call. |
| `sandbox` | agentOS or Docker | one VM per run | egress only | The sandbox container already has this shape: `/vms/<run>` (`apps/sandbox`). |
| `code` | QuickJS | per program | through the tools it calls | Runs in the run. Its `fetch` and tool calls go to the broker with the run's token |
| `pages`, lists, files, `read_document` | the tenant's data; PDF and OCR reading | no | RWX gate for catalogue tools | `data`, `files` and tool calls under the broker |
| Connector actions, mail | fetch, IMAP | no | yes (`brokerCall`) | unchanged |
| `<plugin>.<tool>` | the plugin's code, in the runtime | the plugin's own | its connection calls | A tool call served by the runtime that loaded the plugin. A plugin's own fetch stays outside, as today. |
| `wizard.<name>` (#594) | QuickJS | no | yes | Runs in the run, like the `code` step |
| Sandbox tools, skill scripts (#606, #591) | the sandbox | the run's VM | egress | The sandbox service |
| `agent.<name>` (#605) | a model | no | as an agent step | The engine runs it as a turn inside the turn, one level deep |
| `data_query`, `data_exec` (#597) | the wizard's own database at the tenant | no | yes | `data` |

### Models

| Way | Needs | In the intended structure |
|---|---|---|
| Model-gateway (credits, own keys through the gateway) | fetch | `models.turn` from any host. First through the broker role, later straight to the gateway with the run's token. |
| Own keys, Ollama | fetch | `models.turn`, answered by the runtime that has the key or the model |
| An installed AI client (Codex, Claude Code, …) | a child process on the person's machine; the client runs the loop itself and calls tools over the loopback bridge | Only a local runtime offers it. The service returns the finished turn; the bridge passes each tool call to the broker under the run's token. |
| Apple on the device, the viewer's device | a helper binary, or the door | Only where it exists. A call the viewer's device answers stays an event to the door (`engine/device.ts`). |

## Module by module

| Today | Becomes | Phase |
|---|---|---|
| `packages/shared/src/transition.ts` | Unchanged. The engine's core. | — |
| `engine/steps.ts` | One file per step type, then moved to `packages/engine`. Whole-step code (media, widget, film) stays in the runtime as services. The `code` step and QuickJS go with the engine. | 1, 2 |
| `engine/types.ts` `StepContext` | Run ids, definition, files, state, template scope, abort signal, `services`. No row types, no `store`, no `resources`. | 1 |
| `engine/runner.ts` `drive`, `apply`, `flow`, `flowHost` | `advance(host, event)` in `packages/engine` | 2 |
| `engine/runner.ts` line, claim, heartbeat, `startRunner` | Stay. The runner is the runtime's host of the engine. | 2 |
| `engine/runner.ts` `updateRun` and eight other write paths | One module, `engine/run-store.ts` | 1 |
| `engine/runner.ts` `runView`; `services/runs.ts` `runReportOf` | Pure `viewOf` and `reportOf` in `packages/shared`; the runtime loads the extras | 2 |
| `engine/runner.ts` `createRun`, `submitPage`, `reviewStep`, `goBack`, `retry`, `cancel`, `signalRun`, `wakeNow` | Stay at the tenant. They check, then send an event to the run's host. | 4 |
| `engine/durable-turn.ts`, Mastra `Agent` in a step | The engine's own saved loop. Deleted. | 2 |
| `engine/resources.ts` `RunResources` | Sessions inside the browser and sandbox services, by run id; released at the end | 1, 3 |
| `engine/template.ts`, `input.ts`, `answerers.ts`, `surface.ts`, `decide.ts`, `failures.ts` (the table) | `packages/engine` | 2 |
| `engine/notices.ts`, `push.ts`, `starts.ts`, `mail-watch.ts`, `signals.ts`, `requirements.ts`, `events.ts`, `owner.ts` | Stay in the runtime, at the tenant | — |
| `tools/index.ts` `buildStepTools` | Behind `tools.list` and `tools.call`. The tool code stays where it is. | 1 |
| `broker/` | Also reads a run's token, has a descriptor for every tool, and serves the run's services over HTTP as the role `broker` (phase 3 of `docs/plans/broker.md`) | 3 |
| `secrets/signing.ts` | Gains `runToken` beside `runTicket` | 3 |
| `models.ts`, `harness/` | Stay. Called through `models`. | 1 |
| `routes/runs.ts`, `plugins/runs.ts`, `mcp/tools.ts` | Same routes and tools. They reach the run through its host. | 4 |
| `packages/runner`, `apps/web`, `apps/portal`, `packages/wizards` | Unchanged | — |
| `cli/main.ts` | Gains `run` | 5 |
| — | New: `packages/engine`, `packages/run`, `apps/edge`, `apps/runtime/src/run-services/`, `routes/run-services.ts` | 2, 3, 5, 6 |

## Transition plan

Eight phases. Each package is one pull request into the branch `feat/runs-on-their-own`, cut from `main` at `c71df50d`. Nothing of the plan goes to `main` until the whole branch is taken over on purpose. After every package the branch behaves as `main` does, until a switch is turned on.

| Phase | Result | Switch | Needs |
|---|---|---|---|
| 0 · Measure and pin | Two measurements, and tests that pin today's behaviour | none | — |
| 1 · One way out of a step | Step code reaches the runtime only through `ctx.services` | none, no change in behaviour | 0.4 |
| 2 · The engine as a package | `packages/engine` runs a run on any `RunHost`; the runner is one | none, no change in behaviour | 1 |
| 3 · Token and broker | Every request of a run carries a token and goes through the broker, in-process or over HTTP | `runServices` | 2 |
| 4 · A run on another host | The tenant's routes reach a run wherever it lives | `runHosts` | 3 |
| 5 · `wizards run` | One process, one run, from a folder or a file | `wizardsRun` | 4 |
| 6 · An isolated object | A run as an object with its own storage and alarm | `edgeRuns` | 4, and decision D4 |
| 7 · Services apart | The broker alone reads secrets; heavy tools in their own containers; smaller installs | none | 3 |

### Phase 0 · Measure and pin

**Why first:** two decisions need numbers, and the refactoring in phases 1 and 2 needs a net.

| Id | Pull request | Touches | Does | Done when |
|---|---|---|---|---|
| 0.1 | `docs(plans): runs on their own` | `docs/plans/runs-on-their-own.md`, a pointer in `docs/content/dev/architecture.md` | This page as the repo's plan file, so every package can cite a section. | The file is on `feat/runs-on-their-own`. |
| 0.2 | Spike, not merged: `spike/engine-bundle` | A scratch entry file importing the agent step path | Bundles it with esbuild for `--platform=neutral`, once with `@mastra/core/agent` and once with `ai` alone. Lists every `node:` import that is hit. Also QuickJS: `quickjs-emscripten` without `@mastra/quickjs`, the `.wasm` loaded as an imported module (workerd compiles no WASM from bytes), and the 10 s cap against an object's CPU time. | Sizes and blockers are written into the plan file. Decides D1. |
| 0.3 | Spike, not merged: `spike/run-object` | A workerd project with one object class | Hosts `transition()` with the object's storage and alarm. Runs a form, a decision and an agent step with a three-minute streamed model call through the gateway. Restarts in the middle. | Limits hit and what survived are written into the plan file. Decides D4 and whether phase 6 starts. |
| 0.4 | `test(engine): six runs pinned end to end` | `apps/runtime/test/pinned-runs.test.ts`, fixtures | Six definitions with a scripted model: form, agent, review, result · a decision branch · a `tool` step · `foreach` · `wait` with a signal · `onFail` with a retry. Asserts the commands of `transition()`, the `run_event` rows and the final `RunState`. | Green on `feat/runs-on-their-own`. Every later package keeps it green without editing its expectations. |

### Phase 1 · One way out of a step

**Goal:** nothing under the step code imports a runtime module. **No switch:** each package moves code and keeps behaviour. The in-process services call the same functions as before.

| Id | Pull request | Touches | Does | Done when |
|---|---|---|---|---|
| 1.1 | `refactor(engine): one file per step type` | `engine/steps.ts` → `engine/steps/{index,agent,decision,tool,foreach,generate,prompt}.ts` | A pure move. `runAutomaticStep` stays the entry. Lets the next packages work in different files. | No line of logic changed; the diff is moves and imports. |
| 1.2 | `feat(shared): the run's services as types` | `packages/shared/src/run-services.ts` | `RunServices` with the seven services above, `ToolDescriptor`, `EffectId`, `Pending`, `ServiceError` with a `FlowFailure` class. Types only, zod for what crosses HTTP. | Compiles; no importer yet. |
| 1.3 | `refactor(engine): the runtime's services in one place` | `apps/runtime/src/run-services/index.ts`, `engine/types.ts`, `makeContext` (runner.ts :1112) | `inProcessServices(run)` wraps today's functions. `StepContext` gains `services`. Nothing uses it yet. | A test builds it for a run and calls each service once. |
| 1.4a | `refactor(engine): steps call models through services` | `steps/agent.ts`, `steps/decision.ts`, `decide.ts`, `surface.ts`, `steps/generate.ts` (`writeHtml`) | Replaces `textModel`, `agentModel`, `attachTools`, `costOf`, `ctx.call` and the model part of `ctx.chargeUsd`. | These files no longer import `models.js`. |
| 1.4b | `refactor(engine): steps list and call tools through services` | `steps/agent.ts`, `steps/tool.ts`; `run-services/tools.ts` wraps `buildStepTools` | The agent step builds its model tools from descriptors and calls `tools.call`. The tool code and its closures stay inside the service. | Step files import nothing from `tools/`, `broker/` or `elements/`. That breaks the cycle `steps.ts → tools/index.ts → … → services/runs.ts → runner.ts`. |
| 1.4c | `refactor(engine): steps read and save files through services` | Step files; `run-services/files.ts` | Replaces `loadAsset`, `ctx.saveAsset`, `personUploads`, workspace reads, `snapshotHtmlImages`. | Step files import nothing from `files/`. |
| 1.4d | `refactor(engine): what the model is told comes from services` | `steps/prompt.ts`; `run-services/context.ts` | `context.forStep` returns brand, knowledge index, skills, date and language. Replaces every read of `ctx.space` and `ctx.spaceFiles`, and `prepareInputs`. | No step file reads `ctx.space` or `ctx.spaceFiles`. |
| 1.4e | `refactor(engine): whole steps run as services` | `steps/index.ts`; `run-services/steps.ts` | `generate`, `widget` and `motion-graphics` become `steps.run(step)`. Their code stays in `media/`, `widgets/`, `motion-graphics/`. The `code` step stays in the engine; its `snapshotFile` and data reads go to `files` and `data`. | `steps/index.ts` imports none of the three. |
| 1.4f | `refactor(engine): lists and data through services` | Step files, `template.ts` scope building; `run-services/data.ts` | Replaces `ctx.store`, `listRows`, `storedLists`, the wizard's own database. | Step files import nothing from `store/`. |
| 1.5 | `refactor(engine): the step context holds no database rows` | `engine/types.ts`, `makeContext` | Removes `space`, `spaceFiles`, `store`, `resources`, `call`, `chargeUsd`, `saveAsset`. `types.ts` stops importing `db/client`. | Type check passes with the fields gone. |
| 1.6 | `test(engine): step code imports only shared` | `apps/runtime/test/engine-imports.test.ts` | Reads the imports of `engine/steps/**`, `template.ts`, `input.ts`, `decide.ts`, `surface.ts`, `answerers.ts`. Allowed: `@engenty/wizards-shared/*`, `ai`, `zod`, each other. | Green, and it fails when a runtime import is added. |
| 1.7 | `refactor(engine): one module writes the run row` | `engine/run-store.ts`; `updateRun` :390, `holdRun` :257, `startDriving` :2150, `writeRunState` :2727, `keepUnsent` :2540, `asks.ts`, `device.ts`, `credits` | Every read and write of `schema.run` for a run under way goes through `RunStore`, with the claim and revision guards it has today. | A grep for `schema.run` under `engine/` finds only `run-store.ts`. |

### Phase 2 · The engine as a package

**Goal:** the code that runs a run builds without Node and runs on a host with no database. **No switch.** Package 2.4 changes how an agent turn is saved, so it lands with the pinned runs and the durable tests green.

| Id | Pull request | Touches | Does | Done when |
|---|---|---|---|---|
| 2.1 | `feat(engine): packages/engine with the step code` | New `packages/engine` (`@engenty/wizards-engine`); moves `engine/steps/**`, `template.ts`, `input.ts`, `answerers.ts`, `surface.ts`, `decide.ts`, `code-step.ts`, `quickjs.ts` (on `quickjs-emscripten` directly, without `@mastra/quickjs`), the class table of `failures.ts` | The runtime imports them from the package. `tsconfig` without Node types. Added to `scripts/npm-package.mjs` as a bundled workspace package. | Builds; the runtime's tests pass. |
| 2.2 | `feat(engine): RunHost and advance` | `packages/engine/src/{host,advance}.ts`; taken from `drive` (:2179), `apply` (:1891), `flow` (:1834), `flowHost` (:1820), `stepFailed` (:2078) | `advance(host, event)`: call `transition()`, do the command, feed the next event, until the run waits or ends. | Unit tests with a host in memory cover every command kind. |
| 2.3 | `refactor(runtime): the runner hosts the engine` | `apps/runtime/src/engine/host.ts`, `runner.ts` | `runtimeHost(run)`: `RunStore`, `setWake`, the in-process services, the event bus, asks. `drive` calls `advance`. Line, claim and heartbeat stay. | Pinned runs and every `durable-*` test pass. `runner.ts` no longer imports `steps`. |
| 2.4 | `feat(engine): agent turns saved by the engine` | `packages/engine/src/steps/agent.ts`; `host.turns` in `runtimeHost` (a `run_turn` table) | The loop: one model call, save the turn, run its tool calls with effect ids `<turn>:<toolCallId>`, save, repeat. Asking the person is the command `ask`. Every agent step is saved this way; `durable` on a step only says it may ask. | `durable-turn`, `durable-steps`, `run-effect` tests pass on the new loop. A kill between two model calls continues at the second. |
| 2.5 | `refactor(runtime)!: Mastra leaves the run` | Deletes `engine/durable-turn.ts`; a hidden one-off `wizards` command drops the `mastra_workflow_*` tables | No fallback path. Mastra stays for Work chats and the assistants. | Nothing under `packages/engine` or `apps/runtime/src/engine` imports `@mastra/*`. |
| 2.6 | `feat(shared): the run view and report from state` | `packages/shared/src/run-view.ts`; `runView` (:3036), `runReportOf` (`services/runs.ts`) | `viewOf(def, state, extras)` and `reportOf(view)`, pure. The runtime loads `extras` (translation, connections, lists, brand, share job) and calls them. | The same view as before for the pinned runs, byte for byte. |
| 2.7 | `test(engine): the engine without a database` | `packages/engine/test/` | `memoryHost()` and scripted services. The six pinned definitions run on it. A build for `platform: neutral` is part of the test. | Green in CI in under a few seconds. |

### Phase 3 · Token and broker

**Goal:** a run's requests work the same from inside and from outside the process. **Switch `runServices`:** off, the runner calls functions; on, it calls the role `broker` over HTTP. This phase is phase 3 of `docs/plans/broker.md` and finishes rule 3 of `docs/plans/modular.md`.

| Id | Pull request | Touches | Does | Done when |
|---|---|---|---|---|
| 3.1 | `feat(broker): a run's token` | `secrets/signing.ts`, `createRun` (:552), a `run.token_id` column | `runToken(claims)` and `readRunToken`: tenant, run, wizard, space, data space, mode, holder, host, expiry; HMAC like the tickets. The grant stays on `run.grant`. | Tests: a token of tenant A is refused for tenant B; an ended run's token is refused; a changed claim is refused. |
| 3.2 | `feat(broker): every tool has a descriptor` | `broker/registry.ts`, `tools/index.ts`, `tools/web-search.ts`, `tools/browser.ts`, `tools/pages.ts`, `tools/store.ts` | Resource, action and kind (read, write, act) for `web_fetch`, `web_search`, `image`, browser navigation, pages, lists, data. One log line per call. | A test walks `TOOL_IDS` and the catalogue and fails on a tool without a descriptor. |
| 3.3 | `feat(broker): every acting call has an effect id` | `broker/effect.ts`, `run-services/*` | The `run_effect` row before the act, for every write and act kind and for whole-step services. | The `run-effect` tests, extended to a browser download, a file write and a film. |
| 3.4 | `feat(runtime): the role broker` | `env.ts` (`ROLES`, `serves`), `app.ts`, `index.ts` | `RUNTIME_ROLE=broker`. `all` and `runner` serve it too until the cloud runs it apart. | `runner-roles` tests cover the new role. |
| 3.5 | `feat(broker): the run's services over HTTP` | `routes/run-services.ts` at `/api/run-services/v1/:service/:call` | Reads the token, opens the tenant (`withTenant`), sets the caller (`withCaller`), calls `inProcessServices`. Model text is streamed. | Each service answers over HTTP in a test with two tenants; a call across tenants is refused. |
| 3.6 | `feat(engine): the run's services over fetch` | `packages/engine/src/http-services.ts`, `packages/engine/test/services-contract.ts` | The client. One contract suite that runs against the in-process and the HTTP implementation. | Both pass the same suite. |
| 3.7 | `feat(broker): long calls answer pending` | `run-services/steps.ts`, `packages/engine/src/advance.ts`, a `run_job` table | A film, a video and a long sandbox command return a job. The service posts the result to the run when done; the run sleeps meanwhile. | A film step survives a restart of the runner in the middle. |
| 3.8 | `feat(runtime): the runner asks the broker over HTTP` | `engine/host.ts`, env `RUN_SERVICES_URL`, switch `runServices` | With the switch on, `runtimeHost` uses the HTTP client. Browser and sandbox sessions live in the broker role by run id; `RunResources` goes. | Pinned runs pass with the switch on and two processes (runner, broker). |

**In Manage, later and optional:** the model-gateway accepts a run's token directly, so a model call from another host skips the broker role. Until then `models.turn` is proxied by the broker role, which calls the gateway as today.

### Phase 4 · A run on another host

**Goal:** the tenant's routes, starts, signals and the end of a run work the same wherever the run lives. **Switch `runHosts`.** It ships with one other host: a second runtime process reached over HTTP, so it is tested before `wizards run` exists.

| Id | Pull request | Touches | Does | Done when |
|---|---|---|---|---|
| 4.1 | `feat(runtime): a run's record names its host` | `db/schema.ts` (`run.host`), a migration, `engine/run-store.ts` | Null means this runtime. Otherwise the host's address and kind. | Existing runs read as before. |
| 4.2 | `feat(engine): a host's three calls` | `packages/engine/src/host-api.ts`; `routes/peer.ts` | `GET state`, `GET changes` (a stream of revision and events), `POST events` (a `FlowEvent`). Served by the runtime host under `/api/peer/runs/:id/` with a peer ticket. | A client test drives a run with only these three calls. |
| 4.3 | `refactor(runtime): run routes reach the run through its host` | `routes/runs.ts`, `plugins/runs.ts`, `services/runs.ts` (`waitRun`), `engine/events.ts` (`watchRun`) | `hostOf(run)` returns the local host or the HTTP client. The view, the stream, pages, reviews, back, retry, cancel, asks and questions use it. | The doors' tests (`durable-doors`, `runner-roles-doors`) pass with a run on the second process. |
| 4.4 | `feat(runtime): a run ends at its tenant` | `engine/run-store.ts`, `updateRun` side effects (`tellRunEnded`, `releaseRun`, plugins `runEnded`, `reportRun`) | A remote host posts its state at each person's step and at the end. The tenant runs the side effects from the record's status change. | Notices, credits and plugin events fire once for a remote run. |
| 4.5 | `feat(runtime): wake, signal and stop reach any host` | `signalRun` (:3224), `wakeNow` (:2875), `stopRun` (:2903), `cancel` (:2854), `mail-watch.ts`, `starts.ts` | Each sends its event to `hostOf(run)`. | `durable-wait` and `signals` tests pass with a remote run. |
| 4.6 | `feat(shared): which host can run a wizard` | `packages/shared/src/fit.ts` (`hostFit`), `createRun` | `hostFit(requires, host)` beside `standaloneFit`. `createRun` picks with `hostFor` and hands over definition, workspace references, token and first state. | A wizard that needs an installed client is never placed on another host. |

### Phase 5 · `wizards run`

**Goal:** `wizards run ./weather` works on a machine that has only Node and a small package. **Switch `wizardsRun`** on the tenant's side for the start route. Builds on the direction of 10 October (`wizards run <address>`).

| Id | Pull request | Touches | Does | Done when |
|---|---|---|---|---|
| 5.1 | `feat(run): a host for one run in a Node process` | New `packages/run` (`@engenty/wizards-run`) | `nodeHost({ dir })`: state and turns as files, a timer for the clock, the HTTP services, the three host calls on a loopback port. | The pinned definitions run on it against a runtime in the test. |
| 5.2 | `feat(api): start a run on another host` | `routes/api.ts`, `mcp/scopes.ts` (scope `runs:host`) | `POST /api/v1/spaces/:spaceId/runs` with a wizard id or a definition and the host kind. Checks `requires`, plan and `x-wizards-client`, reserves credits, fixes the grant. Returns run id, token and the services' address. | A token from this route drives a run to its end; the run shows in the studio's list. |
| 5.3 | `feat(cli): wizards run` | `cli/main.ts`, `packages/run/src/terminal.ts` | The terminal door: asks a form's fields, shows a review, writes the result. Flags: `--<field>=`, `--answers`, JSON on stdin, `--json`, `--accept`, `--out`, `--open`, `--continue <run>`. | The weather example runs with and without a person. |
| 5.4 | `feat(run): a wizard from a folder, a file or an address` | `packages/run/src/resolve.ts` | A folder with `wizard.json`, a `.wizard` file, a URL. Validates first, with the checks of `wizards validate`. | All three forms start the same run. |
| 5.5 | `feat(run): without an organization` | `packages/run`, `hostFit` | With a runtime on the machine: its address and a token for this client. With none: only what `hostFit` allows with a model reached by fetch (Ollama, an own key). | The refund example runs with Ollama and nothing else installed. |
| 5.6 | `build(run): the small package` | `scripts/npm-package.mjs`, the Release workflow | Publishes `@engenty/wizards-run` with its own `bin`. `wizards run` in the large package calls the same code. | The installed size is measured and written into the plan file and the docs. |

### Phase 6 · A run as an isolated object

**Goal:** one run, one object, with its own storage, woken by its own alarm. **Switch `edgeRuns`.** Starts only after spike 0.3 and decision D4, because an object holds people's answers and so is a place of processing.

| Id | Pull request | Touches | Does | Done when |
|---|---|---|---|---|
| 6.1 | `feat(edge): the object that hosts a run` | New `apps/edge` | A `RunHost` on the object's storage and alarm, the three host calls, the HTTP services. No code per wizard. | The pinned definitions run in workerd locally. The object's one alarm serves `wakeAt`, reminders and the watchdog of a model call (0.3); each model call is its own alarm call, under the 15 min wall limit. |
| 6.2 | `feat(runtime): runs go to an object when they fit` | `hostFor`, env for the objects' address | Placement by `hostFit` and the switch, per tenant. | A published wizard's guest run lives in an object and shows in the studio. |
| 6.3 | Deploy, in the Manage repo | Coolify or the provider, secrets, region | The peer secret, the services' address, the region rule per model tier. | Runs of a tenant on an EU tier stay in the EU. |
| 6.4 | `test(edge): waits, deploys, stops` | `apps/edge/test` | A three-day wait with the clock moved; a deploy in the middle of a model call; a cancel in the middle of a tool call; a hundred runs at once. | Each ends as the same run does in the runtime. |

### Phase 7 · Services apart, smaller installs

**Goal:** the size and the secrets sit where they are needed. Can start once phase 3 is in, beside phases 4 to 6.

| Id | Pull request | Touches | Does | Done when |
|---|---|---|---|---|
| 7.1 | `feat(broker): only the broker opens secrets` | `secrets/crypto.ts`, `broker/account.ts`, the cloud's env | The key for `unseal` is set only on the role `broker`. Studio, doors and runner cannot read an account. | A runner process without the key completes a run that uses a connection. |
| 7.2 | `feat(sandbox)`\-style containers for documents, render and media | New apps beside `apps/sandbox`; `documents/`, `render/`, `media/` | Each behind a small HTTP API, called by the broker role. The runner's image loses Chromium and ffmpeg. | The runner image is measured before and after. |
| 7.3 | `build: what a minimal install carries` | `scripts/npm-package.mjs`, `on-demand.ts`, `install.sh`, `install.ps1`, the install docs | More of the heavy tools move to on-demand, now that they sit behind one interface. | The size in the installers and docs is the measured one. |
| 7.4 | `docs(dev): the architecture as built` | `docs/content/dev/architecture.md`, `docs/plans/*` | Rewrites the engine part. Marks this plan and the broker's phase 3 as built. Removes switches whose default became on. | `pnpm docs:check` passes. |

### What can run at the same time

| After | In parallel | Why they do not collide |
|---|---|---|
| — | 0.1, 0.2, 0.3, 0.4 | Different branches; two are never merged |
| 1.1 and 1.3 | 1.4c, 1.4d, 1.4e, 1.4f, 1.7 | Each owns different files after the split. 1.4a then 1.4b go one after the other: both change `steps/agent.ts` |
| 1.5 | 2.1 then 2.2; 2.6 beside them | 2.6 touches only `runView` and the report |
| 2.3 | 2.4, 2.7, 3.1, 3.2 | Agent loop, tests, signing and tool descriptors are separate files |
| 3.6 | Phase 4, phase 7.1 and 7.2 | Routes and hosts on one side, the broker's inside on the other |
| 4.6 | Phase 5 and phase 6 | Two new packages |

`engine/runner.ts` is the file every other session touches too. Packages 1.7, 2.2 and 2.3 change it most. They should go in quickly, one after the other, with the other sessions told.

## For sub-agents

### Rules for every package

- A worktree of your own from `origin/feat/runs-on-their-own`. One package, one pull request into that branch, titled as in the tables (Conventional Commits). No attribution lines. There only the conventions check runs (CI's tests run for pull requests into `main`), so run the pinned runs and the touched tests locally. Auto-merge is refused on that branch: merge with `gh pr merge --squash` by hand once told to. Nothing goes to `main`.
- Read the package's section in `docs/plans/runs-on-their-own.md` and the files it names before changing anything. Line numbers on this page are from `c71df50d`; find the function by name.
- Run locally only the test files you touched, plus `pinned-runs.test.ts` and, from phase 2, the engine's tests. CI runs the rest.
- Phases 1 and 2 change no behaviour. If a pinned expectation would have to change, stop and report; do not edit it.
- No fallback and no legacy path. Where stored data changes shape, convert it once with a hidden `wizards` command.
- New behaviour goes behind the phase's switch in `packages/shared/src/feature-flags.ts` and `.features`. Switches are not named in docs, changelog or help.
- A library used by few wizards is on-demand (`on-demand.ts`). A static import of one breaks the installed runtime.
- Nothing under `packages/engine` imports `node:*`, a database client or `@mastra/*`.
- Words people read follow `docs/copy-style.md`. Run `pnpm exec biome` by hand inside a `.claude` worktree.

### A brief, filled in for one package

```text
Package 1.4c · refactor(engine): steps read and save files through services

Goal     Step code no longer imports apps/runtime/src/files/*.
Read     docs/plans/runs-on-their-own.md, "The run's services" and "Phase 1".
         packages/shared/src/run-services.ts (RunServices.files)
         apps/runtime/src/run-services/index.ts
         apps/runtime/src/engine/steps/*.ts
Change   Every loadAsset, ctx.saveAsset, personUploads, snapshotHtmlImages and
         workspace read in engine/steps/** becomes a call on ctx.services.files.
         Put what is missing into run-services/files.ts, calling the same
         functions as before.
Leave    files/storage.ts and files/objects.ts as they are. No new behaviour.
Done     engine/steps/** has no import from "../../files/".
         pnpm exec vitest run test/pinned-runs.test.ts test/own-json.test.ts
Report   Files changed, anything in step code that still reaches files another way.
```

## Decisions

#### D1 · The agent loop in the engine

Our own loop on the AI SDK (`ai`, already used for decisions and JSON steps), or Mastra's `Agent` called one model call at a time.

**Proposed:** our own loop. The turn must be saved by us in any case. **Measured (0.2):** 737 KB and no Node builtins on `ai`; 6.5 MB, 17 builtins and `new Function` on Mastra's `Agent`.

#### D2 · Licence of the engine

`packages/engine` under FSL-1.1-MIT like the runtime, or dual with MIT like `transition.ts` and the format files.

**Proposed:** FSL-1.1-MIT. The format and the flow stay MIT; the engine is the product.

#### D3 · `wizards run` as its own package

A small npm package of its own, or only a command of the large one.

**Proposed:** its own package, and the large one calls it. Otherwise the small install does not exist.

#### D4 · Where isolated objects run

A provider's edge (Durable Objects), workerd on our own server, or no objects and small Node hosts in containers.

**Proposed:** decide after spike 0.3. A provider is a new sub-processor and needs a region rule for the EU tiers. **Spike 0.3:** technically a run fits one object, restarts included; what is left is the provider and region question.

#### D5 · Model calls from another host

Through the broker role, or straight to the model-gateway with the run's token (a change in Manage).

**Proposed:** through the broker role first. Straight later, when the hop shows in numbers.

#### D6 · The screen for `wizards run --open`

Carry the screen's files in the small package, or load them from engenty.ai.

**Proposed:** load them. A machine with no network uses the terminal.

#### D7 · Copies of a remote run's state

At every change, at each person's step and the end, or only at the end.

**Proposed:** at each person's step and the end. The studio then shows the answers without asking the host.

#### D8 · The names

`packages/engine`, `packages/run`, `apps/edge`, `RunHost`, `RunServices`, the role `broker`, the switches.

**Proposed:** as written. `broker` is the name the broker plan already gives the role.

## Risks

| Risk | Where | What holds it |
|---|---|---|
| The refactoring changes behaviour unseen | Phases 1, 2 | The pinned runs of 0.4, the existing `durable-*` tests, and packages that only move code |
| Other sessions change `runner.ts` at the same time | 1.7, 2.2, 2.3 | Three short packages in a row, announced |
| A call acts twice after a restart | Phase 3 onward | Effect ids on every acting call (3.3), written before the act |
| The run saved, the service did not hear it, or the other way round | Phases 3, 4 | The run saves the turn before it calls; a repeated call finds its effect row; the state has a revision |
| A token leaks from a host outside our network | Phase 5 | It opens one run's grant and nothing else, ends with the run, and guests' runs never live on a host we do not run |
| A hop per tool call makes steps slower | Phase 3 | Model calls take seconds, a hop milliseconds. Measured in 3.8 before the switch flips |
| The stream of views lags through the extra hop | Phase 4 | The host pushes changes; the route stops polling the row for remote runs |
| People's answers sit at a new provider | Phase 6 | D4, the region rule in 6.3, and `edgeRuns` per tenant |
| Two ways to save an agent turn for a while | 2.4, 2.5 | 2.5 deletes the old one in the next package; no switch between them |
| The code step's 10 s cap does not fire in an object: the clock stands still during CPU work (0.2) | 6.1 | Count calls of QuickJS's interrupt handler as well as the time, and set the object's `cpu_ms`; tested in 6.4 |

Read for this page: `packages/shared/src/{transition,definition,run,fit}.ts`; `apps/runtime/src/engine/*`, `broker/*`, `tools/*`, `elements/*`, `models.ts`, `harness/*`, `routes/{runs,api,peer}.ts`, `services/runs.ts`, `mcp/*`, `plugins/runs.ts`, `tenants/*`, `db/*`, `files/*`, `store/*`, `secrets/signing.ts`, `env.ts`, `cli/main.ts`; `packages/runner`, `packages/wizards`; `apps/sandbox`; `scripts/npm-package.mjs`. Plans it builds on: `docs/plans/{broker,modular,capabilities-next,durable-agents,runner-process,wizard-code,wizard-data,run-schemas,tenant-sync,wizard-channels,runners-and-voice,wordpress-plugin,api-clients,agentos-sandbox}.md`, and the format review "Wizards and Mastra workflows" of 10 November 2026. Compared with eve (Vercel), flue (Astro) and executor, read on 10 November 2026.
