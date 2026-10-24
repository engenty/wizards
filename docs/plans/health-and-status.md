# Health checks, a status page and alerts for the cloud

Concept, 2026-10-24. The runtime's checks, the watchdog and the compose healthchecks are built
(#219 and the PR after it); the rest follows the order of work below.

## As built (2026-10-24)

- **The cause of the hangs.** `compose.cloud.yaml` labelled `runtime` and `doors` with
  `traefik.docker.network=${PROXY_NETWORK:-coolify}`. Coolify escapes `$` in labels, so Traefik
  got that text as the network's name, knew no such network, and took one of the container's
  three addresses per route. A route that drew the `browser` network's address hung. Every
  Traefik reload (a deploy of any app on the server) drew again: on 2026-10-24 first
  `/api/runs`, later `/w/`, `/embed.js`, `/studio/`. Fixed in v0.11.10 (#223): the label says
  `coolify`. The health checks in the containers could not see it: the hang was in front of them.
- **Runtime:** #219 (checks, `/api/health/ready`, `/api/public/health`, `line_at`), #221
  (watchdog, healthchecks of all four containers), #224 (the browser's check in HTTP/1.1),
  released as v0.11.9 and v0.11.10. Coolify shows the app `running:healthy`.
- **Gateway:** `/health/ready` per provider, engenty-wizards-manage#94. A provider is `low` while
  its prepaid credit is below `GATEWAY_LOW_BALANCE_USD` (10 $) and `down` at nothing (#98): the
  Vercel AI Gateway's and OpenRouter's balance, ElevenLabs' characters, fal's only with an admin
  key in `FAL_ADMIN_KEY` (#101; fal's model key may not read it). Refusals that are ours
  (401, 402, 403, 429) count as the provider's failures.
- **Monitor and status page:** not a hosted service yet. Matthias decided to run it on the same
  server for now and move it later, so it can't tell when the whole server is down. It is
  [Gatus](https://github.com/TwiN/gatus) (no account to create, config in git):
  `monitoring/gatus/` in engenty-wizards-manage (#96), Coolify app `status`, at
  https://status.engenty.ai (an A record at Namecheap). 13 endpoints every minute (the providers
  every 2, failing on `low` too), in one list with failures first, each row named by its group:
  Gatus starts its groups collapsed and has no setting for that. It looks like engenty.ai
  through `ui.custom-css` only (#97, #103: Gatus's `:root.dark` needs `html:root.dark` to lose).
- **Alerts:** after two failures in a row and on recovery, a push through ntfy.sh (topic in the
  app's `NTFY_TOPIC`) and a mail to matthias@engrd.at through the Manage-App's new
  `POST /api/alerts` (`ALERT_TOKEN`, `ALERT_EMAIL`, `STATUS_URL`). ntfy.sh sends no mail without an
  account, hence the Manage-App.
- **Runner heartbeat:** `HEARTBEAT_URL` stays empty. Gatus takes pushes only as authenticated
  POSTs; the monitor's "Runs" endpoint reads the runners from the studio's `checks.line` instead.
- **Deploys without a gap.** Coolify recreates the services of a Docker Compose app, so every
  deploy answered 503 or 404 for 15 to 20 s. It replaces a single-container app with a rolling
  update instead: the new container starts, Coolify waits until it is healthy, then stops the
  old one. Both apps are single-container apps now, built from a Dockerfile:
  - The Manage-App: manage and the gateway as two processes of one container (`both.ts`,
    engenty-wizards-manage#104); a stopping process lets running requests finish for `DRAIN_MS`.
  - The runtime: studio (:8891), doors (:8892) and runner (:8893) as three processes of one
    container (`runtime/roles.mjs` with `RUNTIME_ROLE=cloud`, #107); a role that ends is started
    again on its own, so the watchdog still restarts only what hangs. `deploy/runtime` holds a
    Dockerfile of a few lines on the release's cloud image, written by `cloud-runtime.yml`.
    `compose.cloud.yaml` stays for installs of their own.
  - The browser is its own Coolify service, `runtime-browser`, on a network of its own. Its
    DevTools port is published on the coolify bridge only (`BROWSER_CDP_URL=http://10.0.1.1:9222`),
    so a page in the browser reaches no other app.
  - The Traefik labels are the apps' own (studio paths to :8891, doors paths to :8892 at a higher
    priority), each route with a retry, so a request that meets the stopping container goes to
    the new one.
  - **Gotcha:** Coolify waits for the new container only if the Dockerfile it builds names a
    `HEALTHCHECK`; one inherited from the base image doesn't count (#109). Without it the old
    container stops at once.
  - Measured from the server during a deploy: the Manage-App 0 failures in 1,413 requests, the
    runtime 2 in 2,622 (single requests at the moment the old container stopped).

## The occasion

On 2026-10-24 every `/api/runs/*` request on engenty.ai hung without an answer, even for a run id
that does not exist. `/api/health` answered `{"ok":true}` and `/api/public/wizards/<token>`
answered. Wizard pages showed an endless spinner. Coolify showed the app as running, the logs
showed nothing, and Matthias heard of it from a colleague whose link was broken. A restart of the
app fixed it; the cause is still unknown.

What the incident showed:

- `GET /api/health` (`app.ts`) answers from the process alone. It reads no database, so a process
  whose requests hang still passes it.
- `runtime` and `doors` have a compose healthcheck on `/api/health` (`compose.cloud.yaml`). It
  passed the whole time. `runner` and `browser` have none, so Coolify shows the app as
  `running:unknown`. The app's own `health_check_enabled: false` does not matter here: for a
  compose app Coolify reads the containers' healthchecks.
- Docker marks a container unhealthy but never restarts it. Coolify does not either.
- Nothing probes engenty.ai from outside. Everything that could watch it (the self-hosted
  `healthchecks` service, the Manage-App's runtime check in `routes/admin/system.ts`) runs on
  the same server, 147.93.120.81, as the thing it watches.
- No call to the control database (libSQL on Turso) or to the object store (`aws4fetch` against
  RustFS) has a timeout. A request that waits on one that never returns waits forever.
- The runner's line has the same weak spot: `lookAtLine()` (`engine/runner.ts`) sets `looking`
  and awaits `waitingRuns()`. If that await never returns, the runner takes no run again, while
  `registerRunner()` keeps writing `runner.seen` every 10 s and the runner looks alive.
- The log ring (`log.ts`) starts empty after a restart, and Coolify's restart makes new
  containers, so `docker logs` of the old ones are gone too. The hung requests left no trace.

## Goals

1. Each container can say, within 3 s, whether it can do its job, and whether the fault is its
   own (a restart helps) or a dependency's (a restart doesn't).
2. A process whose requests hang notices it, writes what hangs into its log and restarts itself.
3. Something outside the server probes engenty.ai, the wizard pages and the runs' API every few
   minutes and emails Matthias, with a push to his phone, when one fails twice in a row.
4. A status page that stays up when the server is down tells customers what works.

## 1. Health checks in the runtime

### Endpoints

| Path | Served by | Who may call it | Answers |
|---|---|---|---|
| `GET /api/health` | every role | anyone | unchanged: `{ ok: true }` from the process alone, no I/O. Liveness. |
| `GET /api/health/ready` | every role | anyone | this process and what it depends on, per check: name and status only. 200 for `ok` and `degraded`, 503 for `down`. |
| `GET /api/public/health` | doors | anyone | the same as `/api/health/ready`. The proxy sends `/api/public` to `doors` and `/api` to `runtime`, so the doors need a path of their own under their prefix. |
| `GET /api/internal/debug/health` | every role | the Manage-App's service key (`internalRoutes`) | the same checks with timings, error messages and the details below. For the admin app's System page and `remote-debug`. |

The runner is not reachable from outside. Its healthcheck calls `/api/health/ready` inside the
container, and the other roles report its state from the control database (check `line` below).

### Checks

One module, `apps/runtime/src/health.ts`, holds the checks. Each role runs the ones it needs.

| Check | What it does | Timeout | Roles | When it fails |
|---|---|---|---|---|
| `process` | event loop delay (`monitorEventLoopDelay`, p99 over the last 30 s), requests open longer than 30 s (see *Requests in flight*), tenant databases still opening after 10 s (`opened` in `db/client.ts`), memory | — | all | `down` when requests hang or the loop stalls: the fault is this process's |
| `control` | `SELECT 1` through `controlDb`, the client every request uses. When it fails, the same through a new client opened for the check and closed afterwards | 2 s each | all | shared client fails, new one works: the process's client is stuck → `process` turns `down` too. Both fail: Turso is unreachable → `control` is `down`, `process` stays `ok` |
| `tenants` | writes and removes a small file in `/data/tenants`; `BEGIN IMMEDIATE` and `ROLLBACK` on `/data/health.db` (WAL, `busy_timeout` 1000) | 2 s | all | volume full or read-only, or another process holds the write lock of the shared volume |
| `objects` | `HEAD` of `health/probe` in the bucket; any answer below 500 counts (a 404 is fine) | 2 s | all, when `S3_BUCKET` is set | `down` |
| `gateway` | `GET <GATEWAY_URL>/health`: reachable, nothing about its providers (those are on the gateway's own `/health/ready`, see *The gateway's providers*) | 2 s | runtime, runner | `degraded`: pages and the studio still work, AI steps don't |
| `manage` | `GET <MANAGE_URL>/api/health` | 2 s | runtime | `degraded`: open studios keep working, nobody new can sign in |
| `browser` | `GET <BROWSER_CDP_URL>/json/version` | 2 s | runner | `degraded`: only steps that use the browser fail |
| `line` | from the control database: runners whose `seen` is under 30 s old (`RUNNER_STALE_MS`) and whose `line_at` (new, below) is too; the oldest run that is `active` and unowned | 2 s | all | no live runner → `down` (required only on the runner); a run waiting more than 10 min → `degraded` |

`line_at` is a new column of the control table `runner`: the runner's poll writes it at most
every 10 s, unless the line's query (`waitingRuns()`) has been open for more than 30 s. `seen`
keeps meaning "the process is alive"; `line_at` means "the runner can still ask the line". A
query open for more than a minute turns the runner's own `process` check `down`, so the
watchdog restarts it. Driving a run happens inside the look at the line and takes as long as
its steps, so a long look alone is no sign of a hang.

### Never hang

- Every check runs under its own timeout (`Promise.race` with a timer). A libSQL query can't be
  aborted, so a check whose previous call is still open is not started again: it answers
  `down` with "waiting since <time>" right away. Hung checks never pile up.
- All checks run in parallel; the answer goes out after 3 s at the latest, with whatever has not
  finished marked `down`.
- The result is kept for 10 s, and requests that arrive meanwhile share one evaluation. A public
  endpoint can't be used to load Turso or the bucket.
- The checks open no tenant database and write nothing outside `/data/health.db` and the probe
  file. The probe key in the bucket is written once, by the first check that finds none.

### Response

Public (`/api/health/ready`, `/api/public/health`):

```json
{
  "status": "degraded",
  "role": "doors",
  "version": "0.11.8",
  "checkedAt": "2026-10-24T09:12:03.120Z",
  "checks": {
    "process": "ok",
    "control": "ok",
    "tenants": "ok",
    "objects": "ok",
    "line": "degraded"
  }
}
```

`status` is the worst of the checks. The public answer carries no error text, host, tenant or
run id.

Internal (`/api/internal/debug/health`) adds per check `ms`, `error` (one line, secrets taken out
as in the log ring) and, for `process`, the open requests (method, path without query, age),
the event loop delay and memory; for `line`, each runner's `seen` and `line_at` and the number
of waiting runs.

### Requests in flight

A middleware first in `app.ts` keeps each request's start time in a map and drops it when the
answer is sent. Streams that stay open on purpose don't count: the run's stream, the studio's live feed and the
wizard stream (`/api/runs/:id/stream`, `/api/studio/live`, `/api/studio/wizards/:id/stream`).
A request open longer than 30 s is logged once with its method, path and age
(`[slow] GET /api/runs/abc open 30 s`). Next time, the log says which await hangs.

### Watchdog

When the `process` check is `down` three times in a row, 30 s apart, the process writes what it
knows (the open requests, the failed checks) into its log and exits with code 1. Compose's
`restart: unless-stopped` starts it again in the same container, so `docker logs` keep the lines
from before. `HEALTH_WATCHDOG=1` turns it on; `compose.cloud.yaml` sets it, a runtime that runs
alone on someone's computer leaves it off.

A dependency that is down (Turso, the bucket, the gateway) never ends the process: a restart
would not bring it back.

## 2. The status page

### Where it lives

On a hosted status page at `status.engenty.ai`, from the same service that probes and alerts
(see the comparison below). A status page has to answer when engenty.ai doesn't, so it can't
live on the server it reports on. That rules out the `landing` app (`apps/www` of
engenty-wizards-manage), a new Coolify service and the `healthchecks` service, which all run on
147.93.120.81.

The site links to it in its footer. The run page links to it when the runs' API fails (see the
words below).

### What it shows

Components, each fed by the probes in section 3:

| Component (EN) | Komponente (DE) | Probes | Containers behind it |
|---|---|---|---|
| Website | Website | `https://engenty.ai/` | `landing` |
| Wizard pages | Wizard-Seiten | the doors' probes (2–5) | `doors` |
| Runs | Läufe | the runner's heartbeat, `line` in the doors' answer | `runner`, `browser` |
| AI steps | KI-Schritte | the gateway | `manage` (gateway) |
| AI providers, one row each | KI-Anbieter, je eine Zeile | the gateway's check per provider | the services the gateway calls |
| Studio | Studio | the studio's probes | `runtime` |
| Sign-in | Anmeldung | the Manage-App | `manage` |
| Docs | Doku | `https://engenty.ai/docs` | `docs` |

Plus the uptime of the last 90 days per component and the incidents written there. The page
shows components, never container names, hosts or versions.

### Words

Following `docs/copy-style.md`: the state first, then what to do; no exclamation marks; *we*
for engenty the company.

| Where | English | Deutsch |
|---|---|---|
| status chip | working · slow · not working | läuft · langsam · gestört |
| incident, start | Wizard pages aren't loading. We're looking into it. | Wizard-Seiten laden gerade nicht. Wir sehen uns das an. |
| incident, fixed | Wizard pages load again. Runs that were open carry on where they stopped. | Wizard-Seiten laden wieder. Offene Läufe gehen dort weiter, wo sie stehen geblieben sind. |
| run page, the API fails | This wizard can't load right now. See status.engenty.ai for what is happening. | Dieser Wizard lädt gerade nicht. Was los ist, steht auf status.engenty.ai. |
| site footer | Status | Status |

## 3. Probing and alerts

### Probes from outside

Every 3 minutes, from outside the server. Each one has a 5 s timeout: a probe that gets no
answer fails, which is what a hang looks like.

| # | Request | Passes when | Component |
|---|---|---|---|
| 1 | `GET https://engenty.ai/` | 200, the page has "engenty" | Website |
| 2 | `GET https://engenty.ai/api/public/health` | 200 | Wizard pages |
| 3 | `GET https://engenty.ai/api/runs/status-probe` | **404 with a JSON body within 2 s** — the run does not exist; this goes through `runTenant` and the control database's `run_index`, exactly what hung on 2026-10-24 | Wizard pages |
| 4 | `GET https://engenty.ai/api/public/wizards/<probe token>` | 200, body has the probe wizard's title | Wizard pages |
| 5 | `GET https://engenty.ai/w/<probe token>` | 200 | Wizard pages |
| 6 | `GET https://engenty.ai/api/health/ready` | 200 | Studio |
| 7 | `GET https://engenty.ai/studio/` | 200 | Studio |
| 8 | `GET https://account.engenty.ai/api/health` | 200 | Sign-in |
| 9 | `GET https://gateway.engenty.ai/health` | 200 | AI steps |
| 10 | `GET https://engenty.ai/docs` | 200 | Docs |
| 11–19 | `GET https://gateway.engenty.ai/health/ready?provider=<id>`, one per provider | 200 | AI providers |

Heartbeat (the service waits for a ping and alerts when none comes):

| Heartbeat | Sent by | Expected | Component |
|---|---|---|---|
| runner | the runner, after a completed look at the line, at most once a minute, to `HEARTBEAT_URL` (new env, empty = no ping) | every 2 min, grace 3 min | Runs |

The probe wizard is a published wizard of one page without AI steps, in a tenant of engenty's
own. Probes 4 and 5 only read it; they start no run and cost no credits. Probe 3 uses a fixed
id, so the runtime's cache of run tenants (`runTenants` in `tenants/control.ts`) never holds it
and every probe asks the control database.

A probe that starts a real run (a page answered, the run moves to its end) would also test the
runner. It is left for later: a visitor may start 6 runs an hour (`LIMIT_VISITOR_RUNS_PER_HOUR`),
so it needs an API client of its own.

### The gateway's providers

AI steps reach their models through the gateway of engenty-wizards-manage
(`apps/server/src/gateway/`), and the gateway calls services of other companies (`upstream` in
`apps/server/src/env.ts`):

| Provider | For |
|---|---|
| Vercel AI Gateway, OpenRouter, Opper, OpenAI, Anthropic, Mistral, xAI | language models |
| fal | pictures and videos |
| ElevenLabs | voice |
| TypeSafe | the classifier that checks what a search found (not on the status page) |

When one of them fails, the runtime sees only failed AI steps. The gateway gets a readiness
check of its own, `GET /health/ready`:

- One check per provider whose key is set: a call that costs nothing (the model list, or the
  account endpoint where there is no list), 3 s timeout, kept for 60 s.
- The gateway also counts, per provider, the calls it forwarded in the last 5 minutes and how
  many failed (`ProviderError` in `gateway/provider.ts`). More than half failed, with at least
  5 calls: `down`; answers slower than usual: `slow`. A model list that answers says little about
  whether the models do.
- The answer names each provider and its status, nothing else. `?provider=<id>` answers 503 when
  that one is down, so one monitor watches one provider.
- A provider without a key is left out. Which ones the cloud uses is decided by the keys in the
  manage app's env on Coolify, not here.

Alerts for providers go out like the others, but a provider that is down is not ours to fix:
the incident text says which provider and that AI steps using it fail until it is back.

TLS: the service warns 14 days before a certificate of engenty.ai, account.engenty.ai or
gateway.engenty.ai expires.

### When to alert

- **Down:** a probe fails twice in a row (about 6 min). One failure alone alerts no one.
- **Slow:** probe 3 takes longer than 2 s twice in a row. The runs' API should answer a 404 in
  milliseconds; slowness there came before hangs.
- **Heartbeat:** no runner ping for 3 min after it was due.
- **Recovery:** one message when the component works again.
- An open incident alerts once and again after 30 min if it is still open, not every 3 min.

### Channels

- Email to matthias@engrd.at.
- Push to his phone through the service's own app.
- If the plan has no push, a webhook to an ntfy topic of engenty's own does the same, with the
  ntfy app on the phone.

The alerts go to Matthias alone. Customers learn of an outage from the status page.

### Healthchecks of the containers

In `compose.cloud.yaml` of this repository. The workflow `cloud-runtime.yml` of
engenty-wizards-manage copies it to `deploy/runtime` with the next release.

```yaml
x-ready: &ready
  # Unhealthy only when this process is stuck (the `process` check): a dependency that is
  # down doesn't make the container unhealthy, a restart wouldn't help.
  test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:8891/api/health/ready',{signal:AbortSignal.timeout(4000)}).then((r)=>r.json()).then((b)=>process.exit(b.checks.process==='down'?1:0),()=>process.exit(1))"]
  interval: 30s
  timeout: 5s
  retries: 3
  start_period: 60s

services:
  runtime:
    environment:
      HEALTH_WATCHDOG: "1"
    healthcheck: *ready
  doors:
    environment:
      HEALTH_WATCHDOG: "1"
    healthcheck: *ready
  runner:
    environment:
      HEALTH_WATCHDOG: "1"
      HEARTBEAT_URL: ${HEARTBEAT_URL:-}
    healthcheck: *ready
  browser:
    # No curl in the image: bash asks Chromium's DevTools port directly.
    healthcheck:
      test: ["CMD", "bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/9222 && printf 'GET /json/version HTTP/1.0\\r\\nHost: 127.0.0.1\\r\\n\\r\\n' >&3 && grep -q Browser <&3"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s
```

With all four containers reporting, Coolify shows `running:healthy` or `running:unhealthy`
instead of `running:unknown`.

Traefik leaves a container that is unhealthy out of its routes. When `doors` is stuck, `/api/runs`
then falls to the `runtime` router for `/api`, and `runtime` serves the runs' API too. The wizard
pages under `/w/` get a fast 404 from the proxy instead of a spinner until the watchdog has
restarted `doors`.

The Coolify settings of the app need no change. Coolify's own notifications
(Settings → Notifications → Email to matthias@engrd.at) are worth turning on for failed
deployments and the server's disk. They don't replace the probes: they run on the same server.

## Options for the status page and alerts

| | A. `healthchecks` on Coolify (there now) | B. Uptime Kuma on a second small server | C. A hosted service (Better Stack) |
|---|---|---|---|
| What it is | healthchecks.io v4.2, self-hosted | open-source prober with status pages | uptime probes, heartbeats, status page, on-call |
| Probes from outside | no: it only waits for pings, it doesn't request URLs | yes, from that server | yes, from several regions |
| Survives our server being down | no: same server, 147.93.120.81, behind plain HTTP on sslip.io | yes, if the server is elsewhere | yes |
| Probe interval | — | 20 s or more | 3 min on the free plan, 30 s paid |
| Keyword, status code, response time | — | yes | yes |
| Heartbeats | yes, its strength | yes (push monitors) | yes (10 on the free plan) |
| Status page on status.engenty.ai | no | yes | yes (1 on the free plan) |
| Email, phone push | email, webhooks, ntfy | email (SMTP), ntfy, Telegram, Pushover and more | email; push through its app |
| Cost | nothing | a small VPS a month, plus updates and backups of one more server | nothing on the free plan (10 monitors, 10 heartbeats, 3 min, 1 status page) |
| Who watches the watcher | nobody | nobody, unless it is probed too | the vendor |

The free plan's limits are from third-party comparisons; check them on Better Stack's pricing
page before signing up.

**Recommendation: C.** It is the only option that is outside the server from day one, with no
second server to keep alive. The 10 probes and the runner's heartbeat above fit the free plan;
the 9 provider monitors (11–19) don't, so they need the paid plan, or the free plan watches
only `/health/ready` without `?provider` and the page shows one row for all providers.
3 minutes and two failures make about 6 minutes to an alert, against "a colleague noticed" on
2026-10-24. If 6 minutes turns out to be too slow, the paid plan's 30 s checks are the next step;
B is the fallback if a vendor is not wanted.

The `healthchecks` service then has no job. Before it is removed, look in its dashboard for
anything that still pings it.

## Order of work

Each line is one pull request, small enough to review in one go.

1. **engenty-wizards** `feat(runtime): readiness checks` — `health.ts` with the checks, their
   timeouts and the 10 s cache; `/api/health/ready`, `/api/public/health` on the doors,
   `/api/internal/debug/health`; tests with a control database and a bucket that never answer.
2. **engenty-wizards** `feat(runtime): log requests that hang` — the in-flight map, the
   `[slow]` line, the `process` check's open requests.
3. **engenty-wizards** `feat(runtime): the runner reports that its line moves` — control
   migration for `runner.line_at`, the `line` check, `HEARTBEAT_URL`.
4. **engenty-wizards** `feat(runtime): watchdog restarts a stuck process` — `HEALTH_WATCHDOG`,
   exit after three `down` in a row.
5. **engenty-wizards** `build(compose): healthchecks for every cloud container` — the compose
   changes above. Then a release (`pnpm release`, a patch); the tag reaches `deploy/runtime` and
   Coolify deploys it.
6. **No PR, by hand:** the probe tenant and its one-page wizard; the Better Stack account with
   alerts to matthias@engrd.at and push; the 10 probes and the heartbeat, `HEARTBEAT_URL` in the
   runtime app's env on Coolify; the status page with the components above; the DNS record
   `status.engenty.ai` → the status page; Coolify's email notifications.
7. **engenty-wizards-manage** `feat(gateway): readiness per provider` — `/health/ready` with
   the free check and the failure count per provider, `?provider=<id>`.
8. **engenty-wizards-manage** `feat(admin): runtime health on the System page` — the admin app
   shows `/api/internal/debug/health` instead of the plain `/api/health` reachability of
   `routes/admin/system.ts`; `feat(www): link the status page in the footer`.
9. **engenty-wizards** `feat(web): the run page points to the status page when the API fails`
   — the words above, English and German.

1–4 can land in any order behind `HEALTH_WATCHDOG` staying off; 5 needs 1–4. 6 can start right
after 1 is deployed: probes 1, 3–5 and 7–10 work today, without any of the code. 11–19 need 7.

## Open

- `kick()` (`engine/runner.ts`) takes a run at once in every role but `web`. The cloud's roles are
  `studio` and `doors`, so those processes drive runs too, not only `runner`. Worth a look: it
  was written before the web was cut in two (docs/plans/runner-process.md).

- The cause of the hang on 2026-10-24. Probe 3 notices the next one within minutes, and the
  `[slow]` lines say which request waited on what.
- Whether the libSQL client gets a timeout of its own for every query (not only the checks'),
  so a request fails after some seconds instead of hanging. That changes every route's failure
  mode, so it is a decision of its own.
