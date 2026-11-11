---
title: Architecture
description: How engenty wizards is built – the runtime and its roles, your computer and the cloud, tenants and spaces, the engine, its hosts and the run’s services, sandboxes, skills, plugins, the broker and the feature switches.
version: 0.19.0
---

engenty wizards is one server program, the **runtime**, and one web app, the **studio**, that it
serves. The same code runs on your computer and in the cloud. This page shows the parts and how
they fit, with the folder each one lives in.

![Studio and Work, two modes split per person, reach the runtime’s studio half. Published Wizards (durable Agents) reach the doors, on the guest side. The runner drives the engine, which reaches the models and, through the broker, the connected services. All of them keep their data in libSQL databases and a file store](../../assets/diagrams/architecture-parts.svg)

## The parts

| Part | Folder | What it does |
|---|---|---|
| Runtime | `apps/runtime/src` | The server: the API, the step runner, the databases, the models, the broker, the plugins |
| Studio | `apps/web/src/studio` | Where people build wizards, and where Work mode lives |
| Runner pages | `apps/web/src/runner` | What a person sees at a wizard’s link: its pages, its chat, the result |
| Shared | `packages/shared/src` | The wizard definition and its validator, the words the runtime and the studio share, the feature switches |
| Engine | `packages/engine/src` | The code that runs a run: the steps, the agent loop, QuickJS, `advance` and the host it asks |
| Run | `packages/run/src` | A host for one run in a Node process, and the command `wizards run` |
| Edge | `apps/edge/src` | A Worker that keeps each run in an object of its own |
| Documents | `apps/documents/src` | Reading PDFs, Word and Excel files and pictures, as a service apart |
| `@engenty/wizards` | `packages/wizards` | What code outside the repository imports: the plugin SDK, `@engenty/wizards-runner`, the OpenUI parts |
| Modules | `modules/` | Plugins that ship with the runtime |

## Roles of the runtime

The runtime reads `RUNTIME_ROLE` at start. It says which half of the routes the process serves
and whether it takes runs.

| Role | Serves |
|---|---|
| `studio` | The makers’ half: sign-in, `/api/studio`, `/install.sh`, the studio’s pages. Until the cloud routes them to an `api` process, also what `api` serves |
| `api` | Outside clients: the MCP server (`/api/mcp`) and the API (`/api/v1`), the space’s elements among them, so they scale and fail apart from the studio |
| `doors` | The customers’ half: `/api/public`, shared results, the plugins’ public routes and webhooks, `/embed.js`, the pages `/w/<token>` and `/s/<token>` |
| `web` | Both halves |
| `runner` | Takes the runs that wait and drives them. It serves the routes too, for what only the process holding a run can answer, such as its browser’s screen |
| `broker` | A run’s services, which a run asks for with its token. No page, no other route, and it takes no runs. `runner` and `all` serve them too, until the cloud runs a broker apart |
| `all` | Everything in one process. The default |

Every role but `broker` serves what both halves need: `/api/health`, `/api/config`, the runs’
API (`/api/runs`) and the OAuth callback (`/api/connect`). A broker serves only the health checks
beside a run’s services.

Studio and Work are two modes of one web app, and the `studio` half serves both: `/api/studio`
and `/api/studio/work`. They share the sign-in, the tenant database and the broker’s rules. The
line between them is drawn per person, not per process: `allowedModes`
(`apps/web/src/lib/mode.ts`) gives the people who build Studio, Work and Client, and everyone else
Work and Client. Client has no server half of its own. Published wizards come in through `doors`:
a guest’s run has no person signed in, never gets the Docker sandbox and meets the broker as a
guest. That is the one boundary between processes.

A run from a wizard’s link, in the cloud, where each role is its own process:

![A run in the cloud: the doors write the run and put it in line, a runner claims it and writes the steps, and the doors show the person the next page](../../assets/diagrams/architecture-run.svg)

The queue of runs is the control database. A runner claims a run in one statement that also
counts the tenant’s running runs against its limit, and writes a heartbeat while it drives the
run. When a runner falls silent, another takes its runs over. Runners register in the control
database’s `runner` table, and `RUNNER_URL` says where the web reaches one.

## Your computer and the cloud

| | On your computer | In the cloud |
|---|---|---|
| Processes | One, role `all`, on `127.0.0.1:24368` | `studio`, `doors` and `runner` from one image, plus a Chromium container that holds no secrets |
| Tenants | One, `local` | One per organization |
| Databases | libSQL files: `tenants/local.db` and `control.db` in the data folder | libSQL: a control database (`DATABASE_URL`) and one database per tenant, at the address the Manage-App hands out |
| Files | `objects/` in the data folder | An S3-compatible bucket (`S3_ENDPOINT`, `S3_BUCKET`) |
| Sign-in | A one-time link the command line opens | The Manage-App’s tokens (OAuth 2.1 / OIDC), which name the person, the tenant and the role |
| Models | An AI client on the computer (Claude Code, Codex, Antigravity, Cursor Agent), your own API keys, a local model, or a linked account’s credits | The model gateway, which runs a call on the organization’s own account at a provider or on credits. The organization’s keys live in the Manage-App; the runtime holds none (behind `ownKeysGateway`) |

![Your computer runs one process with your own AI and keeps its spaces the same as the cloud’s studio. The cloud runs studio, doors and runner behind a proxy, with the Manage-App and the model gateway beside it](../../assets/diagrams/architecture-places.svg)

The **Manage-App** runs engenty’s accounts, organizations, plans and credits, and the **model
gateway** serves the model classes in the cloud. Both are separate apps, not part of this
repository. A runtime talks to them when `MANAGE_URL` and `GATEWAY_URL` are set. Without them it
runs alone, as on your computer.

A computer signed in to an account keeps its spaces in step with the organization in the cloud
([Spaces in the cloud](../user-guide/cloud-sync.md)). What it publishes runs in the cloud, where
its links work while the computer is off.

## Tenants and spaces

A **tenant** is an organization’s data: its own database, its files and its plugins’ tables. The
runtime sets the tenant once per request, run or background job (`tenants/tenant.ts`), never
from a request body. The control database holds what spans tenants: the links, the index of
runs, the sessions and the settings.

A **space** lives inside a tenant. It holds what its wizards share and produce: info and brand,
knowledge, data, files, results, skills and connections. Every AI step knows its space. The
tenant tables carry a `space_id`, and the code says “space” throughout (`services/spaces.ts`).

Each tenant also has a live feed (`live_change`): numbered writes to what a studio shows. An open
studio reads it and shows what changed elsewhere without a reload (`apps/runtime/src/live/`).

### Tenant isolation

Every tenant has a database of its own and its own folder of files. The databases are libSQL,
reached through Drizzle (`db/client.ts`):

- **The control database** is one per runtime: `DATABASE_URL` with `DATABASE_AUTH_TOKEN`, else
  `control.db` in the data folder.
- **A tenant’s database** is at the address the Manage-App hands out for it, else at
  `TENANT_DB_URL_TEMPLATE` with `{tenant}` filled in, else `tenants/<id>.db` in the data folder.
  Code reaches a tenant’s tables only inside `inTenant()`. Outside it, `db` throws `NoTenantError`.
- **A tenant’s files** sit under the prefix `t/<tenant>/` in the file store (`files/objects.ts`):
  the data folder, or an S3-compatible bucket when `S3_ENDPOINT` and `S3_BUCKET` are set.
  Deleting a tenant removes that one folder.

Inside a tenant, the broker’s RWX rules keep the spaces apart ([The broker](#the-broker)).

![The control database is shared. Each tenant has its own libSQL database and its own prefix in the file store, and the broker’s RWX rules stand between its spaces](../../assets/diagrams/architecture-tenants.svg)

## The engine

A wizard is one JSON document ([The wizard format](./wizard-format/index.md)). The **engine**
takes a run of it from one event to its next wait: it shows pages, runs AI steps, goes back, makes
a step again and follows branches. It is a package of its own, `packages/engine`
(`@engenty/wizards-engine`). It imports nothing of Node, no database client and no Mastra, so it
builds for any JavaScript platform. What it can’t do itself, it asks of two things: its **host**,
which keeps the run, and the **run’s services**, which reach everything outside the run.

| Step | Runs on |
|---|---|
| `form`, `review`, `result` | The runner pages, with what the person entered. The engine waits for the answer |
| `wait` | Nothing: the run rests until the clock or a signal wakes it. See below |
| `decision` | The engine, with one model call that picks an `ask` rule (`models.decide`) |
| `agent` | The engine’s own loop (`src/steps/agent-turn.ts`) with the step’s tools: web search and fetch, the browser, the sandbox, HTTP, the space’s knowledge and data, connections, MCP, plugins’ tools |
| `tool` | The engine, with one call and no model: a plugin’s tool, a connection’s action or a fixed SQL statement |
| `code` | The engine, in QuickJS. See [Code in a run](#code-in-a-run) |
| `surface` | The engine: it reads the run’s data and lays out the components, or asks a model which to keep |
| `generate`, `widget`, `motion-graphics` | A service that does the whole step: the AI SDK’s media calls, the widget bundler and the renderers (`media/`, `widgets/`, `motion-graphics/`, `render/` in the runtime) |

A step names a **model class** (`classifier`, `low`, `standard`, `high`, plus `image`, `video`,
`audio`, `speech`), never a model. Which model serves a class is a setting outside the wizard
(`models.ts`).

An agent step is a loop of turns. The engine makes one model call and saves the turn. Then it
runs the call’s tools one at a time and saves each result, then makes the next model call. A
process that goes on later loads the turn. A tool call without a saved result is made again under
the same id, so it doesn’t act twice (see [Effect ids](#effect-ids)). A `durable` step may stop at a
turn to ask the person (`ask_person`), and the person’s answer goes on from there. A `foreach`
step keeps one turn per entry.

![The step runner walks the wizard definition: pages for the person, agent steps with their tools, and the steps that make media](../../assets/diagrams/architecture-engine.svg)

### Where a run goes

One function decides every move of a run: `transition()` in `packages/shared/src/transition.ts`.
It takes the wizard, where the run stands and what happened. It answers where the run stands now
and the one thing to do next. It reads no database, calls no model and keeps nothing, so a test
walks a wizard through days of waits in milliseconds.

```ts
const event = { kind: "stepDone", stepId: "send", output };
const { run: next, command } = transition(wizard, run, event, host);
// next:    cursor "reply", status "waiting_signal", wakeAt in 3 days
// command: { kind: "waitSignal", name: "mail.received", key: "thread:t-42" }
```

| What happened (`FlowEvent`) | When |
|---|---|
| `start` | A run begins |
| `stepDone`, `stepFailed` | An automatic step finished, or failed with a passing or a final reason |
| `decided` | A model picked one of a step’s `ask` rules |
| `answered`, `reviewed`, `regenerate` | A person answered a page, approved or declined a review, or sent a result back |
| `back` | A person went back a page |
| `signal`, `woke` | A signal the wait matches came, or the clock rang |
| `resume`, `cancel` | “Try again” on a failed run, or the run is stopped |

| What to do next (`FlowCommand`) | The engine |
|---|---|
| `run` | Runs the AI step, then sends `stepDone` or `stepFailed` |
| `decide` | Asks a model which `ask` rule holds, then sends `decided` |
| `ask` | Shows the page or review to whoever `who` names, with its deadline and reminder |
| `sleep`, `waitSignal` | Writes the wake time, or the wait for the signal, and lets go of the run |
| `end`, `fail` | Ends the run |
| `stay` | Nothing: a wake came early, or a signal came twice |

`advance(host, event)` in `packages/engine/src/advance.ts` drives the function. It sends the
event, writes the answer through the host and does what the command says: it runs the step, holds
credits, tells people and writes the log. Then it feeds the next event, until the run waits for
someone, sleeps or ends. A move after a step or an answer is written at once. Some moves need work
first: a start fills its page, and a decision picks a page’s fields. The function’s limits are its
own (`FLOW_LIMITS`): retries after 1, 5 and 30 minutes, a `Retry-After` of at most 6 hours, 30 days
for a person to act, and `onFail` at most three times.

The function is MIT-licensed, like the format’s other files. A tool that checks or shows a wizard
can follow the same flow as the engine.

A run that waits holds no process, no timer and no slot where durable runs are switched on
([Runs that last days](./wizard-format/runs-that-last.md)). `waiting_input` waits for a person,
`sleeping` for a time and `waiting_signal` for a signal. Its host wakes it: [The hosts](#the-hosts)
says how each one does.

### The host

`RunHost` (`packages/engine/src/host.ts`) is what the engine asks of the place a run lives.

| Part | What the host does |
|---|---|
| `store` | Loads the run’s state and saves each move on its revision. A save on a revision that moved fails |
| `turns` | Keeps an agent step’s turns, saved after every model call and every tool call |
| `clock` | Says what time it is, and wakes the run at its `wakeAt` |
| `event` | Writes a line of the run’s log |
| `ask` | Tells whoever a person’s step waits for |
| `signals` | Registers a wait, and hands over a signal that came before it |
| `credits` | Holds what the run needs before it goes on |
| `context` | Builds what a step’s code runs with, the run’s services among it |
| `failure` | Sorts a step’s error into the classes `transition()` takes: `retry`, `credits`, `sign_in`, `final` |
| `within` | Runs a step under the host’s deadline for its type |

### The hosts

Three hosts run the same engine.

| Host | Code | Keeps the state in | Wakes by | Runs |
|---|---|---|---|---|
| The runner | `apps/runtime/src/engine/host.ts` (`runtimeHost`) | The tenant’s database: `run`, `run_turn`, `run_event` | The line and the clock | Any wizard |
| The node host | `packages/run/src/node-host.ts` (`nodeHost`) | A folder per run: `run.json`, `turns/`, `events.ndjson`, `signals.json` | A timer while its process lives, `--continue` after | `wizards run` |
| An object | `apps/edge`: a Worker with one Durable Object per run (`RunObject`) | The object’s own storage | The object’s alarm | A guest’s runs of a published wizard |

**The runner.** `drive` (`engine/runner.ts`) claims a run from the line, builds `runtimeHost` and
calls `advance`. The line, the claim and the heartbeat stay in the runner. The runner is the only
host that reaches an installed AI client or Apple’s models on the computer. A second runtime
process can host runs as well: `RUN_HOSTS` lists it, and it shares the tenant’s database. Its
`RUNNER_URL` must be the address `RUN_HOSTS` names, or no runner claims its runs.

**The node host.** `wizards run <source>` takes a wizard from a folder, a `.wizard` file or an
address (`packages/run/src/resolve.ts`) and checks it as `wizards validate` does. It starts the
run at the organization (`POST /api/v1/spaces/:spaceId/runs` with `host: "node"` and the scope
`runs:host`), whose answer carries the run’s token and the services’ address. Then `nodeHost`
drives the run in its own folder, with the terminal as its door. The folder’s `start.json` keeps
the token and the definition for `--continue`, readable by you alone. With no organization and no
runtime on the computer, the run goes alone: one model through Ollama or an OpenAI-compatible key,
its files in the run’s folder, and no tools, data or connections (`packages/run/src/alone.ts`). A
wizard that needs more is refused before it starts. `packages/run` also has a command of its own,
`wizards-run`, for a small package that isn’t published yet. Running wizards from the command line
isn’t open to every organization yet.

**An object.** `apps/edge` is a Worker for workerd. It hands `/api/peer/runs/<run>/…` to the run’s
object, one object a run, with no code per wizard. The object keeps the run’s token as the run’s
secret and reaches the services at `SERVICES_URL`. Each alarm call makes at most one model call.
The next model call goes on in a new alarm call from the saved turn, so no call meets the
platform’s wall-clock limit. The object’s one alarm is the earliest of four times: now while the
run works, a watchdog 30 seconds ahead while a call runs, the run’s `wakeAt`, and a copy the tenant
hasn’t taken yet. Reminders stay with the tenant. Objects are built and tested on a local workerd.
None runs in the cloud yet.

### Which host takes a run

`createRun` (`engine/runner.ts`) picks the host before the first step. Nothing falls back in the
middle of a run.

- `hostFit` (`packages/shared/src/fit.ts`) compares a wizard’s `requires` with how a host reaches
  models. The runner has every way: credits, your own API key, Ollama, Apple and an installed AI
  client. A node host has credits, keys and Ollama. An object has credits and keys.
- `hostFor` (`engine/hosts.ts`) takes the first host that fits. A guest’s live run of a published
  wizard goes to an object first (`EDGE_URL`), then to the hosts in `RUN_HOSTS`, else it stays on
  this runtime. Test runs, members’ runs, starts and client spaces stay here.
- The record names the host (`run.host`, and `run_index.host` in the line), and the run’s token is
  signed after. `handOver` then posts the definition, the files by reference, the token and the
  first state to `/api/peer/runs/:id/hand-over`. A host that refuses leaves the run here, before
  any step ran.
- `wizards run` names its host itself through the API, after the same checks of `requires`, plan
  and credits.

Runs on other hosts aren’t on for every organization yet. Until they are, every run stays on the
runtime that started it.

### The run’s services

Step code reaches what is outside the run only through `ctx.services`. The types and the schemas
of what crosses HTTP are in `packages/shared/src/run-services.ts`.

| Service | Calls | What it reaches |
|---|---|---|
| `models` | `turn` (streamed), `decide`, `embed`, `agentModel`, `agentTurn` | The model a class resolves to, and the cost booked under the step |
| `tools` | `list`, `call`, `forStep`, `stepCall`, `ofAgent` | The step’s tools and their code, which stays in the runtime |
| `context` | `forStep`, `prepareInputs` | What the model is told beside the task: date, language, brand, the space’s files, knowledge, skills |
| `files` | `read`, `save`, `link`, `uploads`, `workspace` | The tenant’s file store. Bytes go between the service and storage, a run holds references |
| `data` | `query`, `exec`, `rows`, `counts` | The space’s lists and the wizard’s own database |
| `steps` | `run` | The steps a service does whole: `generate`, `widget`, `motion-graphics` |
| `people` | `tell` | The notices of a person’s step, a reminder, an end |

The services come in two forms, and one contract test (`packages/engine/test/services-contract.ts`)
runs against both:

- **In process.** `apps/runtime/src/run-services/` calls the runtime’s own functions. A runner
  that serves its runs itself, as the role `all` does, uses them.
- **Over HTTP.** `httpServices({ url, token })` in `packages/engine/src/http-services.ts` calls
  `POST /api/run-services/v1/:service/:call` with the run’s token as the bearer. The node host and
  the object always use it. A runner uses it when `RUN_SERVICES_URL` names a process that serves
  them, the role `broker`.

The route (`routes/run-services.ts`) reads the token, opens the run’s tenant, checks that a named
step is a step of the run’s definition, builds the step’s context from the record and sets the
caller for the broker. A request names a step by its id and never carries the step itself. Model
turns answer as NDJSON, one part a line, and a failure late in the stream is a last line. `files/read`
answers the bytes with the reference in `x-asset-ref`. A failure answers with its class: `retry` 503,
`credits` 402, `sign_in` 403, `final` 422. A call that acted sets `x-run-acted`, so the run knows a
retry of the step is no longer safe. Two calls aren’t step code’s: `run/release` lets go of the
run’s browser and sandbox at the end of every drive, and `run/report` takes a copy of a run from
another host.

The role `broker` serves the run’s services and the health checks, and nothing else
([Roles of the runtime](#roles-of-the-runtime)). It holds a run’s browser and sandbox by run id,
and the runner hands a request for them on to it. Measured on one machine, a tool call takes
about 4 ms over HTTP and under 1 ms in process. A model call takes seconds. A cloud
where the runners ask a broker apart isn’t on for every organization yet.

### The run’s token

Every call of a run’s services carries the run’s token. `runToken` in `secrets/signing.ts` signs
its claims with an HMAC, as the runtime’s other tickets are signed: the tenant, the run, the
wizard, the space, the data space, the mode, the holder, the host’s kind and the expiry.
`readRunToken` (`broker/token.ts`) checks the signature and the expiry, opens the tenant the token
names, finds the run and compares every claim with the record. The grant stays on the record.

- The token is never stored. `run.token_id` holds its id, and `tokenOf(run)` signs it again from
  the record when a host needs it. A run from before the token has no id, and its services over HTTP refuse it.
- It ends with the run’s `expiresAt`, else 30 days after it was signed. An object’s run’s token
  ends 30 days after the run started, so a token signed again is the same one the object holds.
- A run that ended is refused, which is the revoke. Only `run/release` and the end’s own copy take
  the token of a run that ended.
- Moving a run to another host changes its token, since the host’s kind is a claim.

### The host calls

Doors keep calling `/api/runs/:id/…` at the tenant, and who may see and answer a run stays decided
there (`openedRun`, `mayAct`). The routes reach the run through its host with
`hostClientOf(run)` (`engine/run-host-client.ts`). For a run of this runtime that is the runner’s
own functions. For a run elsewhere it is `hostApi` (`packages/engine/src/host-api.ts`), three
calls under `/api/peer/runs/:id/`:

| Call | What it does |
|---|---|
| `GET state` | Where the run stands: cursor, status, state, wake, revision, the error and an open question |
| `GET changes?since=<rev>&after=<line>` | A stream of NDJSON lines, one when the revision moved or the log grew. A blank line every 15 seconds keeps it open |
| `POST events` | `{ event, by?, page? }`: a `FlowEvent`, or a door’s own event (a question answered, a stop, a view kept, an edited result, a translation). 409 says why with `said`, 422 lists the fields with `errors` |

A host checks the caller its own way. A second runtime takes a peer ticket of 60 seconds with the
tenant in `x-wizards-tenant`. An object takes the run’s token. The node host serves the calls on
127.0.0.1 with a secret of its own, for the terminal only. The organization doesn’t reach a run on
`wizards run` yet: the terminal is its one door, and the studio shows its copies.

The tenant lays the host’s state over the record (`hostedRun`) and builds the view there, with
`viewOf` from `packages/shared/src/run-view.ts`. Translations, connections, lists and the brand
come from the tenant. The view of a run in an object shows the tenant’s first lines and the
object’s newest.

### Where the state lives

The host keeps the run’s state, its turns and its log, and only the engine on that host writes
them. The tenant keeps the record: the holder, the grant, the status, the cost and the host. For a
run of this runtime both are the same `run` row. A host elsewhere posts a copy to `run/report` as
each step starts, at each person’s step, at each wait and at the end. A step’s services build its
context from the record, so the record must know the steps before it.

- `keepReport` writes a copy through the same guarded write as a local move. The record takes the
  host’s revision, and an older copy changes nothing.
- A change of status sets off at the tenant what it sets off for a run of its own, once
  (`statusMoved`): notices, the release of credits, the plugins’ `runEnded`, the report to the
  Manage-App.
- A copy’s cost is not used. The services book every call where it is made.
- The log stays with the host. A copy carries no lines.

Waking and signals follow the record’s host. `run_index.host` is a copy of it in the line. A runner
claims only the runs of this runtime and of a runtime host at its own `RUNNER_URL`. When the wake
of a run elsewhere comes due, the clock sends the host `woke` once. An object and a node host keep
their own time. A signal is stored at the tenant first (`run_signal`), then sent to the run’s host
as `signal`. A run in an object or on `wizards run` doesn’t get signals yet.

### Effect ids

Where durable runs are switched on, every call that acts has an effect id. It writes a row in
`run_effect` before it acts (`broker/effect.ts`, `actOnce`).

| Id | For |
|---|---|
| `<turn>:<toolCallId>` | A tool call in an agent turn |
| `<run>:<step>:<visit>` | A tool step, a data write, a saved file, a whole step’s service |

A call that finds its row `done` gets the stored output back, with files as references and never
their bytes. A row still `started` means a crash in the middle. Then a person’s yes repeats the
call, or the step fails with “may have happened” and acts no more. A row of another run is refused.
Tools that keep rows of their own (connector actions, `http_request`, a program’s calls, a wizard’s
function and agent tools) get no second row.

### Pending jobs

A film (`motion-graphics`) and a video (`generate` with a video) take minutes, so `steps.run`
answers `Pending` instead of holding a request open. The engine keeps the job in `state.job` and
writes the run `sleeping` at its step. The job runs in the background of the process that serves
the step and writes `run_job` in the tenant’s database. When it ends, it wakes the run, and the
step asks `steps.run` again and gets the output.

- The job’s process writes a heartbeat every 10 seconds. A job whose process went silent is taken
  over and started again from scratch.
- The run also looks at its job every 2 minutes by itself, so a lost wake costs at most that.
- People see such a run as running, not as sleeping.

Jobs aren’t on for every organization yet. Without them, a film renders while the step runs, as
before.

### Code in a run

The `code` step and a wizard’s own function tools (`wizard.<name>`) run TypeScript or JavaScript
in QuickJS, on `quickjs-emscripten-core` inside the engine (`packages/engine/src/quickjs.ts`,
`code-step.ts`). A run of code gets a heap of 32 MB and 10 seconds. Its `fetch` and its
`tools.<id>()` calls go through the run’s services, so they need nothing of the host. In an object
the clock stands still while code runs, so there QuickJS also counts the calls of its interrupt
handler (`countQuickJsInterrupts`), and an endless loop still meets its 10 seconds. The `.wasm`
comes as an imported module there (`useQuickJsWasm`), since workerd compiles no WebAssembly from
bytes.

### The documents service

Reading documents is a service of its own, `apps/documents`, made the way the sandbox is.
`POST /read` takes a file’s bytes and answers its text: a PDF’s own text and OCR for scanned
pages, pictures by OCR, `.doc`, `.docx`, and `.xlsx` as tables. `POST /fetch` reads a signed link,
only from the origins in `DOCUMENTS_FETCH_ORIGINS`. A shared `DOCUMENTS_SECRET` guards both, and
the service keeps nothing.

`documentsService()` (`apps/runtime/src/documents/service.ts`) is the one way in for every reader:
the `read_document` tool, knowledge, Dateien, Work chat files and the plugins’ loader. With
`DOCUMENTS_URL` set it asks the service, and a failure there is a failure. Unset, the runtime reads
in its own process with the libraries it installs on first use, as before. Both run the same code,
`apps/runtime/src/documents/read.ts`. Text, Markdown, CSV, HTML, JSON and mails stay in the
runtime, and so does a vision model for what OCR can’t read.

How the engine came out of the runtime is the plan `docs/plans/runs-on-their-own.md`.

### Sandboxes

An agent step with the tool `sandbox` runs shell commands and code in a sandbox. Each run gets
its own, made on first use and thrown away when the run stops (`engine/resources.ts`). Where a
runner asks a broker for its runs’ services, the sandbox and the browser live in the broker by run
id, and `run/release` lets go of them at the end of every drive.

| Engine | What it is |
|---|---|
| `docker` | One container per run through the host’s Docker, from the `engenty-sandbox` image (`SANDBOX_IMAGE`) |
| `agentos` | One VM per run in a helper process, with no Docker: a Linux userland compiled to WebAssembly, Node and Python 3.13. No native programs such as ffmpeg. `wizards sandbox add` installs it. It reaches the npm and PyPI registries and the hosts in `SANDBOX_ALLOW_HOSTS` |

`SANDBOX` picks the engine: `docker`, `agentos`, `off`, or nothing for the first one that is ready.
`SANDBOX_GUESTS` picks the engine for a guest’s run, one that nobody signed in for: `off` (the
default) or `agentos`, never Docker. With `off`, a guest’s run has no sandbox. A member’s run and
a Work chat use the server’s engine.

## Skills

A skill is a folder in the Agent Skills format, kept in the space. A step reads an always-on skill
with every prompt and an on-demand one through a tool when its description fits. Where the skill
may run scripts and the step has the sandbox, its folder goes into the sandbox. [Skills](./skills.md)
has the format, the tools and the routes.

## Plugins

A plugin adds tools for AI steps, routes with tables of their own and pages in the studio. The
runtime finds plugins in its folders at start and again while it runs: the ones in `modules/`,
the folders in `PLUGINS_DIR`, then the ones installed on this runtime. A plugin reaches a connection only
through `server.connections.call`, which goes through the broker as its caller.
[Plugins](./plugins/index.md) explains how to write one.

## The broker

Every call to a connected service goes through one function, `brokerCall`
(`apps/runtime/src/broker/call.ts`): from a wizard step, a Work chat, Goose, a share target or a
plugin. It reads the account’s secret (nothing else does), decides allow, ask or deny, runs the
action and writes one line of the log. Model calls don’t pass it.

- **Connections belong to the space.** A connection signs in as the space or as each person,
  is open to admins, members or everyone, and has a rule for each kind of action: read, write,
  delete, send.
- **A run’s grant** is fixed when the run is created, from the definition it starts on: the
  connections, actions and hosts its steps name. An edit never widens a run under way.
- **RWX rules** per space say who may read, write and execute which document, table, page or
  other resource. Unset means deny, and a deny wins.
- **The log** keeps every call. The critical lines reach the admins under the bell in Work.

[The broker](./broker.md) has the details. The studio shows all of it under
[Capabilities](../user-guide/capabilities.md).

![Every caller goes through brokerCall, which checks the grant, the audience and the rule, then runs the action, asks first or refuses, and logs every call](../../assets/diagrams/architecture-broker.svg)

## The tool catalogue

A space’s elements reach every AI through one list (`apps/runtime/src/elements/`): its knowledge,
its skills, its published wizards and, for outside clients, its connections. A wizard’s step, a
Work chat, Goose and the MCP and API clients take their tools from it, for a caller fixed before
a model sees a tool: no tool takes who calls or for whom. Every call goes through the broker’s
gate, which decides wizards (`x` to run), skills (`r` to read, `x` for their scripts) and a
space’s setup (`w`, Goose’s writes) by the RWX rules, and writes a line of the log with the
client’s name.

## Work mode

Work mode has chats with the space’s AI (`services/work-chats.ts`, `services/work-ai.ts`,
`apps/web/src/studio/work/`). A chat is a Mastra memory thread in the tenant’s database: the
thread is the chat, the resource is the space. A turn of the space’s AI gets the space’s tools:
its knowledge, its skills, the chat’s sandbox, the connections open to the person who asked, the
plugins’ tools and the web. A tool that acts outside the space doesn’t run when it is called. The
call is held until a person approves it, on every model, also on an AI client that runs the tools
itself.

One turn of the space’s AI with a held call:

![A call outside the space waits at the gate. After Approve the chat runs it once through the broker and tells the AI the outcome](../../assets/diagrams/architecture-work-turn.svg)

Each chat gets its own sandbox on its first command. It stays while the chat is in use, so a file
one turn writes is there for the next, and goes after 30 minutes without a command.
[Work mode](../user-guide/work-mode.md) shows it from the person’s side. It is behind the
`workMode` switch.

## Feature switches

Parts that ship in the code but are not on for everyone yet sit behind a switch
(`packages/shared/src/feature-flags.ts`). The runtime asks `feature("name")`, the studio
`useFeature("name")`. A switch gets its value from four layers, the last one winning:

1. The default the code declares, and each plugin’s switches under its id.
2. The `FEATURES` environment variable: `workMode=on,goose=off`.
3. The Manage-App, for the organization in the cloud or the account a computer is linked to.
4. The `.features` file: `~/.engenty/wizards/.features` on your computer, the repository’s root
   in a checkout, the data folder in the cloud. Same shape as `.env`: one `name=on` or
   `name=off` per line.

![Four layers set a switch: defaults, FEATURES, the Manage-App and the .features file, the upper one winning](../../assets/diagrams/architecture-switches.svg)

The runtime reads the file on every call, so a change counts at once. `wizards features` lists
what counts on a computer.
