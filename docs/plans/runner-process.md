# The runner as its own process

Decided 2026-10-05 for the cloud runtime: the runner (what executes runs) is separated from the
web (studio, share pages, API). Built 2026-10-10.

## Why

`compose.cloud.yaml` ran "web and runner in one process". Everything a run needed while it worked
lived in that process's memory: its abort handle, its concurrency slot, the question it waits on,
its browser and sandbox, the event bus the studio listens to. A second process could not serve
the same runs, a restart lost every open question, and the web could not be scaled apart from
the runs.

## What holds now

- **Roles.** `RUNTIME_ROLE` = `studio`, `doors`, `web` (both), `runner` or `all` (default). A
  local install stays one process (`all`). The cloud compose runs `runtime` as `studio`, `doors`
  as `doors` and `runner` as `runner`, from the same image. A runner also listens on its port:
  the web forwards to it what only the process holding the run can answer (the browser's
  screen, acting on its page).
- **The queue is the control database.** `run_index` gained `owner` (the runner working on the
  run) and `seen` (its last heartbeat). Waking a run sets `active` and clears `owner`; a runner
  claims it in one statement that also counts the tenant's owned runs against its limit
  (`LIMIT_CONCURRENT_RUNS`, or the plan's number). Runs beyond the limit stay queued. Every
  runner polls every 2 s and takes what is unowned or whose owner fell silent for 30 s; a
  shutting-down runner drops its runs, so another takes them at once. There is no in-memory slot
  table and no one-shot resume any more.
- **Heartbeat.** While driving a run the runner writes `seen` every 10 s and reads the run's
  status: cancelled elsewhere → the step's signal aborts.
- **Questions to the person live in the row.** `run.ask` was already there; `run.answer` is new.
  The step polls the row every second until the answer, a timeout (15 min) or an abort. The
  answer route writes `answer` only when the open question's id matches. A claimed run starts
  with both cleared: the step asks again. `run.unattended` marks an autopilot test run (an MCP
  client fills its pages); it was a process-local set.
- **Change notices.** `watchRun()` in `engine/events.ts` fires on the process's own bus and on a
  1 s poll of `run.updated_at`, the newest event id and the newest device call. Event rows
  another process wrote are handed on as events, each once. The SSE stream, the autopilot,
  `waitWhileMoving` and the plugins' `runs.subscribe` use it; a change made in another process
  arrives within a second.
- **The phone as a model goes through the tenant database.** The offer of the device a run is
  watched from is `run.device_offer`; a call to it is a `device_call` row the runner writes and
  polls (250 ms) for its answer, and deletes once answered or timed out. The run's stream (any
  web) sends open calls as `device` events, and the answer route writes the row's `answer`. A
  claimed run starts with its calls cleared.
- **Runners register.** Table `runner` (`id`, `url`, `seen`) in the control database. `RUNNER_URL`
  names where the web reaches a runner (compose: `http://runner:8891`); without it the web
  answers "not found" for the browser's screen of a run another process holds.

## Studio and doors (2026-10-12)

The web is two halves on one origin, cut along the makers / customers seam so each can run as
its own process and a kitchen can run without the studio at all.

| Studio only (`serves.studio`) | Doors only (`serves.doors`) | Both |
|---|---|---|
| sign-in and sessions (`/api/auth`, `/api/local/enter`), `/api/studio/*`, the authoring MCP (`/api/mcp`) and its OAuth discovery, `/api/v1` (sync from local installs), `/api/local/debug`, the Claude Code plugin, `/install.sh`, the studio's pages and `/` | `/api/public/*`, `/api/shares/*`, the plugins' public routes and webhooks, `/embed.js`, `/sw.js`, the app links under `/.well-known`, the pages `/w/<token>` and `/s/<token>` | `/api/health`, `/api/config`, `/api/log`, `/api/internal`, `/api/runs/*` (a maker's test run, a visitor's run, the AI app's widget — who may see a run is decided per request), `/api/connect` (the OAuth callback), the app's files below `/studio` (a wizard's page loads its scripts there) |

The runner serves everything (it is internal; the web hands it a run's browser). The MCP bridge
(`/api/mcp/bridge`) is served where runs execute.

`PUBLIC_URL` names the doors' origin when it is not `APP_URL`: `shareUrl`, result links, link
previews, the embed script, public logos and icons, a plugin's public address and the AI app
widget's base carry it. `/api/config` answers it; the studio's own link to a wizard
(`ownLink`) uses it. The connect callback posts its word to both origins. On engenty.ai both
halves answer under one origin: Coolify routes `/w`, `/s`, `/api/public`, `/api/runs`,
`/api/shares`, `/embed.js`, `/sw.js` and the app links to `doors`, the rest to `runtime`
(longest path rule wins in Traefik), so `PUBLIC_URL` stays unset there.

Not built: a kitchen on another server still reads wizards from the same tenant database; the
studio → kitchen sync (the reverse of the local → cloud sync) is its own piece.

Learned on the first deploy (v0.3.0, 2026-10-12): the cloud's tenant databases are files under
`/data` (`TENANT_DB_PROVISIONER=none`), and every role had a volume of its own, so the studio,
the doors and the runner each saw a tenant of their own — a wizard published in the studio was
"not found" on the doors, and the v0.2.57 runner never found the runs it claimed. v0.3.1 gives
the three roles one volume. The real answer is tenant databases on Turso (the provisioner).

## Ids across installs

Settled by the sync (2026-10-06): every tenant has its own database, a synced wizard keeps the
install's id inside that tenant, a space or wizard id a tenant made itself is refused for a sync
(`id_taken`), and the share link is made on the server. `local` as tenant and user id never
leaves an install. The runner id is `<hostname>-<random>`; run ids stay `nanoid(18)`.

## Not built

- A runner serves one browser container (`BROWSER_CDP_URL`); several runners share it.
- The studio's draft events (`services/draft-events.ts`) are process-local; one web process is
  assumed.
- Plugin jobs' "already running" guard is per process; `pluginJob.lastRunAt` keeps two runners
  from both starting a job within its interval only by chance.
