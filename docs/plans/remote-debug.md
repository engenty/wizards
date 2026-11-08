# A look from afar: debugging every installation

Decided 2026-10-11. The occasion: a person's wizards failed on "ChatGPT 6 Sol", and nothing
could be read about it from the cloud — the runner's output was out of reach, the runtime's
container logged three lines since it started, and the local install's only trace was a
summary sentence where the client's actual words had been thrown away.

## What holds

Every installation keeps **the last lines it printed in memory** (`log.ts`, a ring of 3000
lines): the console is hooked once at start, each line still goes where it went, and a copy
stays with secrets taken out — bearer tokens, `wz_` keys, provider keys, JWTs, the values of
`k=`/`t=`/`token=` in a link, anything after `password:`/`secret=`. A restart starts the ring
over; nothing is written to disk by this.

The runtime answers about itself in one module, `debug.ts`, read-only and never with a key:

| | |
|---|---|
| `status` | version, process (node, uptime, memory), what it runs on (sandbox, browser, files, databases), plugins |
| `logs` | the ring, filtered (`since` id, `after` ms, `limit`, `level`, `q`) |
| `runs/:id` | one run of any tenant: status, error, cursor, cost, whether its line holds it, the wizard's title, the last 60 events |
| `tenants/:id/models` | where each class of a tenant runs, as its settings page shows it (source, bindings, which keys exist, the ways) |

Who reaches it:

| Installation | Way | Who |
|---|---|---|
| Cloud runtime | `GET /api/internal/debug/*`, the Manage-App's service key | the Manage-App, for its platform admins |
| Local install | `GET /api/local/debug/*`, a ticket signed with the data folder's secret (`local-debug`) | `wizards logs`, `wizards report` on that machine |
| A page in a browser (studio, a wizard's page) | `POST /api/log` | the page itself: errors it met go into the runtime's ring as `[browser …]` lines |

The **Manage-App** (closed repo) is the one place an operator looks: it keeps a ring of its own in
`manage` and `model-gateway`, asks each runtime's `/api/internal/debug/*`, and offers it all
behind the admin check as an API (`/api/admin/debug/*`) and an **MCP server**
(`<MANAGE_URL>/api/admin/mcp`) with read-only tools: `debug_status`, `debug_logs`, `debug_run`,
`debug_lookup` (a person or tenant by e-mail or id, with their last bookings), `debug_models`,
`debug_reports`. The MCP takes a platform admin's API key (`wz_…`) or an access token with the
scope `platform:debug` whose person is an admin. Every read is written to the admin record.

A **local install** cannot be reached from outside and is not: `wizards report` sends its status,
model settings (no keys) and the last 500 lines to the linked account (`POST /v1/diagnostics`,
the account's token), where the admin reads them (`debug_reports`). Nothing goes by itself.

The raw words of an installed AI client's failure are logged before they are summed up for the
person (`harness/model.ts`): "usage limit" in Codex's answer and the model it was asked for both
stay readable.

## Security

- Read-only everywhere: no tool runs code, changes a setting or restarts anything.
- The ring holds what the process printed, never a person's answers or a wizard's files; the
  redaction runs before a line is kept, so a key printed by mistake never reaches a reader.
- The runtime's internal routes take the service key only (`timingSafeEqual`), as the tenant
  calls do; a runtime that runs alone answers them with 401.
- The local routes take a ticket good for a minute, signed with the data folder's secret, which
  only that machine holds.
- `POST /api/log` is open: 8 KB per report, 60 an hour per address, a bounded ring behind it.
- An install sends a report only when its person asks; the Manage-App keeps 20 per tenant for 30
  days and takes 10 an hour per person.
- The Manage-App writes every debug read to its admin record (who, what, which source).

## Not built

- Live access to a local install (a tunnel it opens to the account): reports cover the need.
- Logs on disk or shipped to a log service; the ring is per process and goes with a restart.
- The studio showing its own install's log; the command line does.
- Now the runner is its own process ([runner-process.md](runner-process.md)), the web asks every
  runner that reports and named an address for its lines and merges them by time. Still not built:
  `status` listing the runners, and a run's line naming its owner and heartbeat.
