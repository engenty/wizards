# Plan: a runner per tenant in the cloud

Status: decided on 2026-11-27 (below). Stage B's code is built on `feat/kernel`: the rows marked
"Built" in "What changes in code". The compose service for a tenant's runner is set up by hand and
not yet in `compose.cloud.yaml`; stage C is not built. Item 23 of [kernel.md](kernel.md), section
H. Items 24 (tokens leave the runner) and 25 (ordinary code in the cloud) build on it. Written
2026-11-26 on `feat/kernel`.

The question: how many runner processes the cloud holds, when one starts and stops, and which runs
each one takes.

## Today

| What | How it works | Where |
|---|---|---|
| The cloud's processes | One image in several roles: `runtime` (studio), `doors`, `api`, one `runner`, plus `browser`, `sandbox` and `portal`. Coolify pulls the images and runs the compose file. Nothing is started or stopped by a program. | `compose.cloud.yaml`, `.github/workflows/ci.yml` (job `images`, the `deploy/runtime` branch) |
| What a process does | `RUNTIME_ROLE`: `studio`, `doors`, `api`, `web`, `runner` or `all` | `apps/runtime/src/env.ts` (`role()`, `serves`) |
| The line of runs | `run_index` in the control database: `active` means the run wants a runner, `owner` and `seen` say who drives it. | `apps/runtime/src/tenants/control.ts` |
| Looking at the line | Every runner looks every 2 s (`POLL_MS`) and takes, oldest first, what is unowned or whose owner was silent for 30 s (`RUNNER_STALE_MS`). | `waitingRuns` in `control.ts`, `lookAtLine` and `startRunner` in `engine/runner.ts` |
| Taking a run | `claimRun` takes it in one statement, only while the tenant's runs being driven stay under its limit (`concurrencyLimit`: the Manage-App's `limits.concurrentRuns`, else `LIMIT_CONCURRENT_RUNS`). A process drives at most `RUNNER_MAX_RUNS` (compose: 4). | `control.ts`, `engine/runner.ts` (`take`, `claimAndHold`) |
| While a run is driven | A heartbeat every 10 s keeps the claim and hears of a cancel. When the run reaches a wait, `restRun` gives it back. | `driveClaimed` in `engine/runner.ts` |
| A run that waits | Nothing stays in a process's memory: a person's answer, a time or a signal is a row. The answer route calls `kick`, which puts the run back in line. | `docs/plans/durable-agents.md` (rules 2–4), `kick` in `engine/runner.ts` |
| The clock | Once a minute every runner puts in line what came due, over every tenant (`wakeDue`). Several runners doing it is harmless. | `control.ts`, `lookAtClock` in `engine/runner.ts` |
| A nudge | A process that is no runner tells one runner at once over `/api/peer/runs/:id/take`. `otherRunners(tenant)` picks the tenant's own runner first, else one that serves every tenant. | `nudgeRunner` in `engine/runner.ts`, `otherRunners` in `control.ts` |
| A runner for one tenant | `RUNNER_TENANT` set: `waitingRuns` lists only that tenant's runs, `take` refuses others, `registerRunner` writes the tenant into the `runner` table. Built in a5073cab, tested in `test/kernel-where.test.ts`. | `env.ts` (`runner.tenant`), `control.ts`, `engine/runner.ts`, `db/control-schema.ts` |
| How step code runs | `stepMode`: ordinary code when `RUNNER_TENANT` is set (or the install is your own) and the wizard is not from a template; QuickJS otherwise. `KERNEL_STEPS` overrides. Decided at every drive, not once per run. | `apps/runtime/src/kernel/host.ts` |
| Ordinary code | A step is imported into the runner's own process (`load` imports a `data:` module). | `apps/runtime/src/kernel/wizard.ts` |

## What a tenant's runner still shares today

`RUNNER_TENANT` changes which runs a process takes. It changes nothing else the process holds. These
are the gaps between "takes one tenant's runs" and "safe for that tenant's ordinary code".

| Gap | Today | What it means | Fixed by |
|---|---|---|---|
| Shared runners take the tenant's runs too | `waitingRuns` without `RUNNER_TENANT` lists every tenant's runs. `otherRunners` nudges a shared runner when the tenant's own is missing. | With both kinds running, a tenant's run lands in either one. In the shared runner it runs in QuickJS, so a step that imports Node's modules fails there. | Built in stage B: shared runners leave a tenant marked with `features.ownRunner` alone |
| Work over every tenant at boot and every minute | Every process runs `migrateAllTenants`, `reportAllWizards` and the hourly `purge` over all tenants. Every runner runs `startStarts`, `startMailWatch`, `startNotices` and the plugins' `startJobs` over all tenants. | A tenant's runner opens every tenant's database and does their work. N tenant runners do it N times. | Built in stage B: a tenant's runner opens its own database alone and does no work over the tenants |
| The tenant databases | Files under `/data`, one volume shared by every role, while the Manage-App's provisioner is `none` (comment in `compose.cloud.yaml`). `TENANT_DB_URL_TEMPLATE` puts them on a libSQL server with one token for all (`env.ts`). The Manage-App's `GET /v1/tenants/:id` answers `db: { url } \| null`, no token (`docs/manage-contract.md`). | Ordinary code in a tenant's runner can open every tenant's file, or with the template every tenant's database. | Item 24, and a token per tenant database |
| The process's secrets | The runner's environment holds the control database's token, the Manage-App's service key and the gateway's address. Ordinary code runs in that process. | Ordinary code reads them from `process.env`. | Item 24 |
| The browser | One Chromium for all runners (`BROWSER_CDP_URL`, fixed addresses on the `browser` network). | Ordinary code that reaches DevTools can drive every tenant's pages. | Item 24 (the runner's network) |

So a runner with `RUNNER_TENANT` set must not go to the cloud before item 24, or it must carry
`KERNEL_STEPS=quickjs` until then: `stepMode` turns ordinary code on as soon as `RUNNER_TENANT` is set.

## The options

`M` is what one idle runner process uses in memory. It is not measured. The cloud's runner answers it
under `GET /api/internal/debug/status` as `process.memoryMb` (`docs/manage-contract.md`). `S` is the
time from "start the container" to the first look at the line: the container's start plus the awaited
boot in `index.ts` (`migrateControlDb`, `loadEntitlement`, `loadPlugins`, the app's import). Also not
measured. The compose file gives a runner 60 s before its health check counts.

| | A. Shared only | B. One per tenant, always on | C. One per tenant, started when it has runs, stops itself when idle | D. Warm runners that take one tenant each |
|---|---|---|---|---|
| Processes | 1 (or a few) | 1 per tenant that gets one, plus the shared one | The shared one, plus 1 per tenant with runs in line or in work | The shared one, K waiting, plus 1 per busy tenant |
| Memory | M | M × tenants | M × busy tenants at the peak | M × (K + busy tenants) |
| Before the first step | 0 to 2 s | 0 to 2 s | S + up to 2 s after a quiet spell, else 0 to 2 s | Seconds: the tenant's database opens, nothing else |
| Cost | Today's VPS | Grows with every tenant, busy or not | Grows with tenants busy at the same time | C plus K idle processes |
| A runner crashes | Its runs go to another runner after 30 s | The tenant's runs wait until Coolify restarts it | The tenant's runs wait until the process that starts runners starts it again | As C |
| The process that starts runners is down | — | — | Runs of tenants without a running runner wait in line. Nothing is lost: they are rows. | As C |
| Step code | QuickJS for every wizard | Ordinary code for the tenant's own wizards (after item 24) | As B | As B |
| Code to change | None | Shared runners skip those tenants; boot work per tenant; one compose service per tenant | B's changes, the idle stop, and a new process that starts containers | C's changes, and a runner that takes its tenant once after it started |

### A. Shared only

What runs now. Every wizard in version 0.3.0 runs in QuickJS in the cloud, as kernel.md's table "The
rule that orders the work" says. Nothing to build. Ordinary code never reaches the cloud.

### B. One per tenant, always on

A service per tenant in the compose file, or a Coolify resource per tenant, with
`RUNTIME_ROLE=runner` and `RUNNER_TENANT=<id>`. Coolify restarts it when it stops. Adding a tenant is
a change to the deploy by hand.

- Good for: one to a few tenants who pay for it. Possible soon: the code change is small.
- Bad for: many tenants. Each holds memory day and night, and most runs wait for people most of the
  time (durable-agents.md: nothing waits in memory, so an idle runner holds nothing of value).

### C. Started when it has runs, stops itself when idle

A tenant's runner exits by itself once it drove nothing and its tenant had nothing in line for
`RUNNER_IDLE_MINUTES`. It calls `stopRunner`, which hands back any runs (`disownRuns`), then exits.
Its container restarts never. A separate small process looks at the control database every few
seconds: a tenant marked for its own runner, with runs in line (`run_index.active`, no live owner)
and no live row in `runner` with that tenant, gets its container started. The container's name is
the tenant's, so a second start does nothing.

What a run sees: after an answer, a time or a signal it is back in line at once, as today. Its page
shows it at work. The first step starts after S plus up to 2 s when the tenant was quiet, after up to
2 s when its runner still runs. Nothing a person sees changes otherwise: the live view reads the
database, whatever process moves the run (durable-agents.md, rule 5).

- Good for: many tenants, few busy at once. Memory follows work.
- Costs: S on the first step after a quiet spell, and one new piece the cloud does not have today.
  Nothing in `apps/` or `packages/` starts a container now (no Docker socket, no Coolify call).

### D. Warm runners that take one tenant each

K runners start without a tenant and take no runs. The process that starts runners hands one a
tenant over a peer route. From then on it serves only that tenant and exits when idle, as in C. A
warm runner is never given a second tenant: ordinary code was imported into it, and a process keeps
what it imported.

- Good for: when S turns out too long for people to wait.
- Costs: K idle processes, and a runner whose tenant is set after it started (`env.runner.tenant` is
  read once today). With item 24 the tenant's own secrets come at that moment too.

## Recommendation

Two stages, with A as it is until then.

1. **B for one tenant first**, after item 24, so the cloud learns what M and S are and how a tenant's
   runner behaves. Shared runners skip that tenant. Until item 24 the tenant's runner carries
   `KERNEL_STEPS=quickjs`.
2. **C once more than a handful of tenants get one.** D only if the measured S is too long to wait for
   after a person's answer.

Which tenants get a runner of their own is a separate choice, below. Everyone else stays on the
shared runners with QuickJS, which already works for every wizard in version 0.3.0.

## What changes in code, for B and then C

| Change | Where | Stage |
|---|---|---|
| Built. A tenant marked for its own runner (`features.ownRunner` from the Manage-App, read through `tenantInfo`'s cache; out of reach, the last answer counts): shared runners leave its runs alone, in `waitingRuns`, `take`, `kick` and the nudge's fallback in `otherRunners`. The control database keeps no copy of the mark. | `tenants/own-runner.ts` (`hasOwnRunner`, `servesTenant`), `tenants/control.ts`, `engine/runner.ts` | B |
| Built. A tenant's runner opens and migrates its own database only: `knownTenants`, `activeTenants` and `migrateAllTenants` name its tenant alone. It runs no `reportAllWizards`, hourly `purge`, starts, mail watch, notices or plugin jobs; the shared runner does them for everyone, including the marked tenants. | `db/client.ts`, `index.ts`, `engine/starts.ts`, `engine/mail-watch.ts`, `engine/notices.ts`, `plugins/jobs.ts` | B |
| Built. The tenant's runner drives as many runs as its tenant may (`limits.concurrentRuns`), not `RUNNER_MAX_RUNS` | `engine/runner.ts` (`runCap`, `take`) | B |
| Built. Health: a marked tenant whose runs wait with no runner of its own shows in the `line` check, `degraded`, under `withoutRunner`; its runs leave the line's age out | `lineState` in `control.ts`, `health.ts` | B |
| The service in the compose file: no `/data` volume once the tenant's database is no file, its own place on the `browser` network or none | `compose.cloud.yaml` | B |
| The idle stop: `RUNNER_IDLE_MINUTES`, then `stopRunner` and exit 0 | `engine/runner.ts`, `env.ts`, `index.ts` | C |
| The process that starts runners: reads the line, starts `runner-<tenant>` from the runtime's image with that tenant's settings | New. Where it runs and what it may start is question 4. | C |
| Tests: a shared runner leaves a marked tenant's run (built); a tenant's runner touches no other tenant at boot (built); the idle stop hands back nothing it held; a run answered while its runner is stopped is driven by the next one | `apps/runtime/test/own-runner-line.test.ts`, `test/kernel-where.test.ts` | B, C |

A run may move between runners and so between QuickJS and ordinary code from one drive to the next:
`stepMode` is decided per drive. Each step runs again from its top with its rows, so that is fine for
a step that compiles both ways. A step that imports Node's modules compiles only as ordinary code, so
for a marked tenant the shared runners must not take it over (question 3).

## Measurements before deciding

| What | How |
|---|---|
| M, the memory of an idle runner and of one driving 4 runs | `process.memoryMb` from `GET /api/internal/debug/status` on the cloud's runner |
| S, from container start to the first look at the line | Start a runner with `RUNNER_TENANT` beside the cloud's; time its first `runner.line_at` |
| How many tenants have runs in line or in work at the same time | `run_index` over a week: tenants with `active` or a live `owner`, per minute |
| The VPS's free memory | Coolify's view of the host |

## Decided on 2026-11-27

1. **Which tenants get a runner of their own:** only those an admin switches it on for. One first,
   as stage B of the recommendation; plans that include it come once M and S are measured.
2. **Where the mark lives:** a feature the Manage-App answers in `GET /v1/tenants/:id`
   (`features.ownRunner`). Plans and tenants are the Manage-App's already; the control database
   keeps no second copy, it reads the feature as it reads the rest.
3. **A marked tenant's runner cannot start:** its runs wait. Waiting is safe for every wizard; the
   health check shows such a tenant (`lineState`). A shared runner never takes them over.
4. **What may start containers:** Coolify's API with a token of its own, scoped to the runners'
   project. Not the Docker socket, which could do anything on the host. Until stage C, nothing: B
   is set up by hand.
5. **The wait for the first step after a quiet spell:** at most 10 seconds. C if the measured S
   keeps under it, D if not.
6. **The tenant databases off the shared `/data` volume** is part of item 24. Ordinary code reaches
   the cloud only after it.
7. **One VPS** for now. A second host when the measured M times busy tenants outgrows the first;
   the move to libSQL for the control and tenant databases is planned then, not before.
