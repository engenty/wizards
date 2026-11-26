# Plan: Composio beside our own connections

Status: planned on 2026-11-26. Steps 3 and 4 built on `feat/composio` behind the switch
`composio` (off), against a stand-in for Composio and for Manage; step 2 (Manage) not built. Decided the same day: services such as Gmail can be
connected through Composio, as one more way beside the runtime's own connections and MCP servers,
not in their place. The six questions were answered the same day (see "Decided"). This changes `docs/plans/integrations.md`, which left a hosted broker out
("Not in this plan"). Read against `feat/kernel` at `c081d9ed` and n8n Labs' Nod at `04b8b68`.

## In short

A space gets a third way to connect a service: besides a built-in connector (Gmail through our
own OAuth client) and an imported one (OpenAPI or MCP), a service from Composio's catalog. The
person signs in at Composio, Composio keeps the token, and the runtime keeps only the id of that
sign-in. Every call still goes through our broker: the space's rules, the file's allow or ask,
the limits and the log stay ours. The cloud runtime holds no Composio key: it calls through the
Manage-App, which holds it, as Nod calls through n8n's connection service. A local install does
the same with its linked account, or uses a Composio key of the person's own.

| | Step | Where | Who |
|---|---|---|---|
| 1 | A Composio project, its auth configs, and the key in the Manage-App's environment | Composio, Coolify | Matthias |
| 2 | Manage passes Composio's API through, for one tenant's user at a time | Manage repo | Agent |
| 3 | Composio as a source of connectors in the runtime: catalog, sign-in, calls through the broker | This repo | Agent |
| 4 | The studio: Composio's services in Entdecken and "Verbindung hinzufügen" | This repo | Agent |
| 5 | A kernel file names a Composio service like any other | This repo | Agent, after decision 7 |
| 6 | Composio on the list of who processes data, for tenants that switch it on | Legal pages | Matthias |

## How Nod does it

Read in `github.com/n8n-io/nod` at `04b8b68`. Nothing of it was run.

| | Nod |
|---|---|
| The Composio key | Not in the app. The app calls n8n's connection service (`https://composio.n8n.cloud`, `NOD_COMPOSIO_PROXY_URL` to change it), which owns the Composio project (`docs/.../deploy/configuration.md`) |
| Who the app is to that service | Each install makes a key pair and signs every request: method, path, time, a request id and the body's hash (`src/providers/composio/identity.ts`, `proxy.ts`). The service enrolls it once (`/v2/access/enroll`) and gives it a Composio user id |
| What the service passes | Composio's own API under `/v2/api/v3.1/…`, plus `/v2/connect/start|status|complete` for signing in and `/v2/files/upload`. The app uses Composio's SDK (`@composio/core`) with a `fetch` that rewrites and signs (`proxy.ts`) |
| Limits | The service refuses with `public_budget_exceeded` (429) or `installation_busy`; the app waits by `Retry-After` |
| Who holds the tokens | Composio, signed in through Composio's own OAuth apps (`trust/privacy.md`) |
| How the agent calls | One tool that calls a connected action with its exact schema, and one that searches the catalog, over Composio's Tool Router (`src/runtime/tools.ts`, `integrations.ts`) |
| Beside Composio | Notion, Linear, n8n and other apps through their own MCP servers; HTTP and command-line ways; saved logins in a vault |
| Before an action | A model checks each action against the person's words and asks when they don't cover it (`trust/approvals.mdx`) |
| Data | Calls pass n8n's service and Composio. Composio's Zero Data Retention does not cover its own OAuth apps without an Enterprise plan: the content of those calls can stay in Composio's logs for up to a year (`trust/privacy.md`) |

What we take: the key behind a service of ours, the signed pass-through, one Composio user per
holder, Composio beside MCP and our own connectors. What we keep differently: allow or ask is
decided by rules (the file, the space), never by a model.

## How it fits what is there

Read in this repo; the broker is `docs/plans/broker.md`.

- **A connector has a source** (`packages/shared/src/connectors.ts`: `builtin | openapi | mcp`). A
  fourth source, `composio`, gives connectors made from Composio's catalog: one per toolkit
  (`gmail`, `slack`, …), its actions from the toolkit's tools (`GMAIL_SEND_EMAIL`, …), each action
  with its kind (read, write, send, destructive) so the space's rules apply as they do now.
- **A space's connection stays one row** (`space_connection`, `apps/runtime/src/db/schema.ts`).
  For Composio, `secret` holds no token: only the connected account's id at Composio, sealed as
  every secret is. A person's own sign-in (`space_connection_sign_in`, `person_connection`) the
  same way.
- **Every call goes through `brokerCall`** (`apps/runtime/src/broker/call.ts`): paused, audience,
  actions, rules, the grant, asking, the limits per run and per day, the log line. Only the
  handler at the end is new: it asks Manage to run the tool for that connected account. Nothing
  above it changes.
- **Signing in** follows the flow for Google through Manage (`connectors/via-account.ts`,
  `connectors/space-connections.ts` `startSpaceConnectionOAuth` / `finishSpaceConnectionOAuth`):
  start, the person signs in at Composio, back to `/api/connect/callback`, the runtime keeps the
  connected account's id.
- **The kernel** needs nothing new: a `tool` ask with `call: "gmail.send"` becomes a tool step
  of the definition around the file (`apps/runtime/src/kernel/batteries.ts`) and goes through
  `brokerCall`. Which connector `gmail` binds to is today a connector id; the file's names are
  decision 7 (`docs/plans/kernel.md`).

## The Manage-App's part

Manage holds the Composio key and passes calls through, for the tenant and person that asks.
The endpoints are a proposal, shaped like today's Google ones (`docs/manage-contract.md`).

| Endpoint | What it does |
|---|---|
| `GET /v1/connect` | Says `composio: true` beside `google` when Manage has a key |
| `GET /v1/connect/composio/toolkits?q=` | The catalog: toolkits, their tools and auth kinds. Cached |
| `POST /v1/connect/composio/start` | `{ toolkit, holder, returnUrl, state }` → `{ url }`: Composio's sign-in page for that holder |
| `POST /v1/connect/composio/complete` | `{ state, ticket }` → `{ connectedAccountId }` |
| `POST /v1/connect/composio/execute` | `{ connectedAccountId, tool, input }` → Composio's answer. Checks that the account belongs to the caller's tenant |
| `DELETE /v1/connect/composio/accounts/:id` | Signs out at Composio when a connection is removed |

What the runtime sends and reads, as built (`apps/runtime/src/connectors/composio.ts`):

| Call | Body or query | Answer |
|---|---|---|
| `GET /v1/connect/composio/toolkits?q=` | | `{ toolkits: [{ slug, name, description, logo, categories, managed }] }`; `managed`: Composio has an OAuth app of its own for it, or it asks no sign-in |
| `GET /v1/connect/composio/toolkits?slug=gmail` | | `{ toolkit, tools: [{ slug, name, description, input, tags }] }`; `input` is the tool's JSON schema, `tags` Composio's (`readOnlyHint`, `destructiveHint`, …); `toolkit: null` where there is none |
| `POST …/start` | `{ toolkit, holder, returnUrl, state }`, `holder` `s:<space>` or `u:<user>` | `{ url }`; Composio comes back to Manage, Manage to `returnUrl?state=…&ticket=…` |
| `POST …/complete` | `{ state, ticket }` | `{ connectedAccountId }` |
| `POST …/execute` | `{ connectedAccountId, tool, input }` | Composio's `{ successful, data, error }` |
| `DELETE …/accounts/:id` | | 2xx; 404 where it is gone already |

The cloud runtime adds `tenant` (in the body, or `?tenant=` on a GET), since its service key
speaks for every tenant; a linked account's token names its own. A 429 with `Retry-After` retries
the step after that many seconds.

- **Who calls.** The cloud runtime with its service token; a local install with its linked
  account's token, as for Google today. A Composio user id is per holder within a tenant
  (`t:<tenant>/s:<space>` or `t:<tenant>/u:<user>`), so one tenant never reaches another's
  accounts, and Manage checks it on every call.
- **Limits.** Calls per tenant per hour at Manage, on top of the broker's per run and per day.
  A refusal is a 429 with `Retry-After`, which the broker turns into a retry of the step.
- **Nothing is kept** at Manage but the mapping of connected accounts to tenants. No tokens, no
  call content.

## Not in this plan

- **Composio's Tool Router and its search tool for agents.** An agent sees a connection's actions
  as it does today. Search over the whole catalog in a run would reach past what the file grants.
- **Composio's triggers** (a new mail starts a run). Starts stay `docs/plans/starts.md`; a
  later plan can add Composio's triggers there.
- **Replacing a built-in connector.** Gmail through our own client stays. A space chooses.
- **Executor** (`packages/kernel/src/executor.ts`, kernel task 24) is on hold until this plan is
  decided; Composio takes the place executor had for services, not for a wizard's own OpenAPI.

## Decided

Answered by Matthias on 2026-11-26.

| | Question | Decided |
|---|---|---|
| 1 | Zero Data Retention needs Composio's Enterprise plan for its own OAuth apps | Start without it, and say on the privacy page that the content of calls can stay in Composio's logs |
| 2 | Whose OAuth apps people sign in to | Composio's own. No app of ours to register per vendor |
| 3 | Who may use it | Every tenant, from the start. No plan switch |
| 4 | Local installs | Through Manage with the linked account, and also with a Composio key of the person's own |
| 5 | Which services | Composio's whole catalog, in Entdecken |
| 6 | Cost | Carried in the plan for now. Calls are not booked on credits |

What follows from 4: a local install with a key of its own calls Composio directly, under one
Composio user per space and person of that install. The key is kept as the install's other keys
are (`apps/runtime/src/secrets/vault.ts`: the Keychain or the sealed file), entered in the
studio's settings where the model keys are, and never sent to Manage. Where both are there, the
person's own key wins.

What follows from 1 and 3: the privacy page names Composio as a processor for every tenant, with
what it keeps, before step 3 ships. Step 6 of "In short" is that page.
