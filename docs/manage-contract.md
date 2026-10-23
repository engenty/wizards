# Contract between the runtime and the Manage-App

The runtime (this repo) runs alone with own keys or a local model. When `MANAGE_URL` is set it
signs people in at a Manage-App, verifies that app's tokens, and sends model calls to its
model-gateway. This file is what both sides implement.

Local defaults: runtime API `:24368` (web `:5181`), Manage-App `:8892` (web `:5182`),
model-gateway `:8893`.

## Tokens

The Manage-App is an OAuth 2.1 / OIDC authorization server.

| | |
|---|---|
| Discovery | `<MANAGE_URL>/.well-known/openid-configuration`, `<MANAGE_URL>/.well-known/oauth-authorization-server` |
| JWKS | the `jwks_uri` from discovery |
| Access token | a JWT signed with a key from the JWKS, `iss` = the issuer from discovery — when the request names a `resource`; without one the token is opaque and only the Manage-App itself takes it |
| Claims | `sub` user id · `tenant` tenant id · `role` `owner` \| `admin` \| `member` · `name` · `email` · `scope` · `azp` client id · `aud` the requested `resource` (a list that also holds the userinfo endpoint when `openid` is in scope) |
| Scopes | `openid profile email offline_access wizards:read wizards:write wizards:publish runs:test` (`runs:test` also covers runs of published wizards a client starts: both spend credits) |

- A token names exactly one tenant. A person in several tenants picks one while signing in.
- The first sign-in creates the account, a tenant with the starting balance, and that tenant's
  database.
- `resource` (RFC 8707) is the audience. A runtime's resources are `<RUNTIME_URL>` (studio
  sessions, API) and `<RUNTIME_URL>/api/mcp` (MCP clients). The Manage-App keeps the list of
  runtimes it serves.
- The gateway accepts every access token the Manage-App issued, whatever its audience.
- A new account may need an invitation code. `<MANAGE_URL>/sign-up?code=<code>&next=<path>` takes
  one (`code` fills it in) and goes on to `next`, a path of the Manage-App: a runtime that runs
  alone sends a person without an account there, with its authorization request as `next`.

Clients:

| Client id | Kind | Redirect | Consent page |
|---|---|---|---|
| `wizards-runtime-<name>` | confidential (secret, sent as HTTP Basic), one per runtime | `<RUNTIME_URL>/api/auth/callback` | no |
| `wizards-desktop` | public, PKCE | `http://127.0.0.1:<any port>/api/auth/callback` | no |
| MCP clients | register themselves (RFC 7591) or bring a metadata document | their own | yes |

API keys (`wz_…`) belong to one user and one tenant. Issued and revoked in the Manage-App.

## Manage-App API for runtimes

Every call carries `Authorization: Bearer <service key of the runtime>`. JSON in, JSON out.
Errors: `{ "error": string, "code": string }`.

| Call | Body → answer |
|---|---|
| `GET /v1/tenants/:id` | → `{ id, name, slug?, pagesHost?, status: "active" \| "suspended" \| "deleted", balanceCredits, plan?: { id, name }, limits: { concurrentRuns, projects?, build?, members? }, modules?: string[], features?: { [id]: boolean }, db: { url: string } \| null }` · `db: null` means the runtime keeps the tenant's database as a file · `slug`, `pagesHost`: the organization's address (`acme`, `acme.wizards.page`), shown in the studio's "Public page" part; an older Manage-App names none · `plan`: the plan the tenant is on (Free, Pro, Team, …), shown in the studio · `limits.projects`: how many projects the tenant works with (the studio shows a project switcher above one; a project a local install synced counts); `null` for as many as it wants; left out, the runtime keeps one · `limits.build: false`: the tenant makes and changes nothing on the runtime, its studio shows what its local install synced; left out, it builds · `limits.members`: the people the plan allows (`null`: no limit), shown on the studio's organization page; the Manage-App enforces it · `modules` (optional, a list of plugin ids): the plugins of the runtime switched on for the tenant, besides the runtime's `PLUGINS_DEFAULT`; an id the runtime has no plugin for is ignored ([content/dev/plugins/shipping.md](content/dev/plugins/shipping.md)) · `features`: the plan's switches the runtime reads; one not named is off. Known: `ownKeys` — the tenant's own API keys and bindings to a provider's model in the cloud studio (`PUT /api/studio/models` refuses them with `403 { code: "plan" }` otherwise) · `level`: `{ level, name, next: { level, name, runs, published } \| null, progress: { runs, published } }`, what the team's use earned (or an admin gave it); the studio's catalog shows a template from its `level` on and the featured ones first; `features` already leave off what a level above the team's opens · `holds`: `{ page: { reason } \| null, wizards: [{ id, reason }] }`, what an admin held; a held wizard's run page starts no new run (`wizardPaused`) |
| `GET /v1/tenants/:id/members` | → `{ members: [{ userId, name, email, image, role, joinedAt }], invitations: [{ id, email, role, expiresAt }], seats: { limit: number \| null, taken } }` · the people of the tenant and who is invited, for the studio's organization page; they are invited, given roles and removed with the calls below · `seats.taken` counts members and open invitations |
| `POST /v1/tenants/:id/invitations` | `{ actorId, email, role, lang: "de" \| "en" }` → `{ invitation: { id, email, role, expiresAt } }` · invites for the person signed in to the studio (`actorId`), whose role the Manage-App checks in its own records: owners and admins invite (on plans other than Team only the owner), only an owner invites an owner · mails the invitation in `lang`; an open invitation to the same address is replaced · refusals: `403` `forbidden`, `PLAN_SEATS` (with `limit`), `PLAN_ROLES`, `not_member`; `409` `already_member` |
| `DELETE /v1/tenants/:id/invitations/:invitationId` | `{ actorId }` → `{ ok: true }` · withdraws an open invitation; owners and admins, an owner's invitation only an owner |
| `PATCH /v1/tenants/:id/members/:userId` | `{ actorId, role }` → `{ ok: true }` · gives a member another role; owners and admins, the owner role only an owner · `409` `last_owner` when the last owner would go |
| `DELETE /v1/tenants/:id/members/:userId` | `{ actorId }` → `{ ok: true }` · removes a member, or lets `actorId` leave when it names them; an admin removes no owner · `409` `last_owner` |
| `GET /v1/tenants/:id/address?actorId=` | → `{ slug, host, canChange, changeUntil, changedAt, creator, domains: [{ id, domain, verified, record: { name, value } }] }` · the organization's address and own domains, for a member · `canChange`: the person made the organization and it is in its first 14 days, with no change yet |
| `GET /v1/tenants/:id/address/check?slug=` | → `{ ok: true }` or `{ ok: false, code }` · `code`: `length`, `chars`, `hyphen`, `reserved`, `profanity`, `brand`, `taken` |
| `PUT /v1/tenants/:id/address` | `{ actorId, slug }` → the same answer as `GET …/address` · the creator's one change; `403 address_closed` otherwise, `400` with a check's code |
| `POST /v1/tenants/:id/domains` | `{ actorId, domain }` → `{ id, domain }` · owners and admins; `400 domain` for something that is no domain |
| `POST /v1/tenants/:id/domains/:domainId/verify` | `{ actorId }` → `{ verified }` · looks for the TXT record |
| `DELETE /v1/tenants/:id/domains/:domainId` | `{ actorId }` → `{ ok: true }` |
| `GET /v1/tenants/:id/keys?actorId=` | → `{ keys: [{ id, name, start, createdAt, lastRequest }] }` · the person's API keys for this organization, the newest first |
| `POST /v1/tenants/:id/keys` | `{ actorId, name }` → `{ id, name, key }` · a key that acts as the person in this organization; `key` comes only here |
| `DELETE /v1/tenants/:id/keys/:keyId` | `{ actorId }` → `{ ok: true }` · only the person's own key; `404` otherwise |
| `POST /v1/keys/verify` | `{ key }` → `{ valid: false }` or `{ valid: true, keyId, name, userId, userName, tenantId, role }` |
| `POST /v1/grants/check` | `{ userId, clientId, tenantId }` → `{ active }` · whether the grant behind an access token still stands: the person is a member of the tenant and not locked out, and — for a client that shows a consent page — the consent is still there (“Trennen” on the account page removes it) · the runtime asks before it takes a token at `/api/mcp` and the API, and keeps the answer 30 s; no answer refuses the token |
| `POST /v1/reservations` | `{ tenantId, runId, credits }` → `{ id }` · `402` with code `no_credits` when the free balance is below `credits` · the same `runId` again replaces the earlier reservation |
| `POST /v1/reservations/release` | `{ runId }` → `{ ok: true }` · unknown run is fine |
| `POST /v1/usage` | `{ tenantId, runId?, stepId?, kind, usd, idempotencyKey }` → `{ credits }` · for what is not a model call |
| `GET /v1/runs/:runId/usage?tenantId=` | → `{ credits, steps: { [stepId]: credits } }` · what the ledger booked for the run; rows without a step under `""` |
| `GET /v1/tenants/:id/usage?months=` | → `{ months: [{ month: "2026-10", credits, runs: [{ runId, credits }] }] }` · what the tenant spent per calendar month (UTC), the newest first, `months` 1–12 (3 when left out), each with its 20 costliest runs; the studio assistant names the wizards behind the runs |
| `PATCH /v1/tenants/:id` | `{ name }` → the same answer as `GET /v1/tenants/:id` · renames the organization; the studio's first visit asks for the name ([content/user-guide/create-account.md](content/user-guide/create-account.md)) · `name` 1–80 characters |
| `PUT /v1/tenants/:id/profile` | `{ userId, lang, kind: "personal" \| "club" \| "small" \| "corp", size?, sector?, role?, need?, phone?, website?, links?: string[], questions? }` → `{ ok }` · what the studio's first visit learned about the organization, for the admin app's list of people · `links`: the addresses the person ticked or added (≤ 10) · `questions`: “Wünsche oder Fragen”; a new one is mailed to the platform's people · `403 not_member` |
| `POST /v1/install-mail` | `{ email, lang: "de" \| "en" }` → `{ ok: true }` · the Manage-App mails its install mail (the command and the first steps) to `email`, which must belong to a person of a tenant this runtime serves (`404` otherwise); 3 a day per address (`429`) · "Mail me the command" on the cloud studio's start page |
| `GET /v1/users/:id` | → `{ id, name, email, image, features, admin, tenants: [{ id, name, slug, role, personal, plan: { id, name } \| null, invitedBy: { name } \| null }] }` · `features`: the person's own switches, laid over the organization's · `admin`: the person runs the platform; the studio offers them the assistant's developer mode and “Organisation erstellen” · `tenants`: the person's organizations, their own first; the studio's switcher lists them (an older Manage-App sends none) · `invitedBy`: who invited the person into it, for the studio's welcome page; null for their own |
| `PUT /v1/pages/:id` | `{ slug, name, lang: "de" \| "en", space: null \| { slug, title, headline?, intro?, lang, form?: "du" \| "sie", brand: { name, logoUrl, theme }, imprint: { name, lines, website? } \| null, wizards: [{ slug, title, description, avatar, lang, results: [{ title, kind, formats }], effort: { fields, reviews, minutes, uploads }, steps: [{ title, by: "you" \| "ai" }], runUrl, exampleUrl? }] } }` → `{ ok: true, url }` · the organization's public page at `<slug>.wizards.page` (the Manage repository's docs/plans/wizards-page-launch.md): the runtime sends it whole, from the space whose page is on and the published definitions of the wizards it lists, after a publish, after every change of the page, the brand or the facts, when a listed wizard's sharing is switched off or its link renewed, and when one is deleted; the last send wins · `space: null` where the page is off or no listed wizard is published and shared; Manage then shows its "nothing here" page · `slug` is the organization's address, which Manage takes from its own record · `theme` is `runTheme(brand)`; `logoUrl` the main logo at `/api/public/logos/:id`; `results` from `resultsOf`, `effort` from `effortOf`, `steps` from `outlineOf` merged to about five rows · a failed send is logged and the next change sends everything again |
| `DELETE /v1/pages/:id` | → `{ ok: true }` · empties what was sent; not used by the runtime yet |
| `PUT /v1/wizards/:id` | `{ wizards: [{ id, title, description, avatar, lang, space: { id, name } \| null, published, publishedAt, template: { id, revision } \| null, runUrl, effort, results, capabilities, steps, changedAt }] }` → `{ ok: true }` · the team's wizards, whole, for the Manage-App's admin app (the Manage repository's docs/plans/wizards-admin.md): sent after a wizard is created, duplicated, published or deleted, its sharing switched or its link renewed · `template`: the marketplace entry it was made from (`wizard.starter`) · `runUrl` only for a published, shared wizard · the published version's words where there is one, the draft's otherwise |
| `POST /v1/runs/:id` | `{ runId, wizardId, via: "studio" \| "page" \| "link" \| "test" \| "api", state: "running" \| "waiting" \| "finished" \| "failed" \| "cancelled", startedAt, at, step?: { id, title, kind }, error? }` → `{ ok: true }` · a run's turn, when its state changes and every two minutes while a step is at work, so a run without a word for long is stuck · `step` and `error` with a failure · its credits are in the ledger by run |
| `POST /v1/feedback/:id` | `{ runId, wizardId, good, comment?, lang }` → `{ ok: true }` · "How did it go?" at the end of a run (`POST /api/runs/:id/feedback`); one per run, the last answer counts |
| `POST /v1/bug-reports` | `{ tenantId?, wizardId?, runId?, where: "run" \| "studio" \| "page", url, userAgent?, comment?, error?: { message, stack? }, logs: string[], screenshot?: data URL, contact? }` → `{ id }` · "Report a problem" (`POST /api/bug-reports`): what the person chose to send, with what they typed masked in the browser; at most 4.5 MB |
| `POST /v1/push` | `{ tenantId, device: { token, platform: "ios" \| "android" }, title, body, data: { runId, kind } }` → `{ ok: true }` · a push to the mobile app (the apps repo engenty-wizards-apps) on one device: `token` is the raw APNs or FCM token the app gave the run (`POST /api/runs/:id/notify`); the Manage-App holds the APNs and FCM keys · `kind`: `done`, `failed`, `waiting` or `asks` · a token APNs or FCM no longer takes is not an error |

Free balance = balance − open reservations. A reservation's hold shrinks by what its run has
been booked. Reservations older than 24 h lapse.

With a user's access token instead of the service key:

| Call | Answer |
|---|---|
| `GET /v1/me` | `{ user: { id, name, email, image }, tenant: { id, name, role, plan: { id, name }, balanceCredits, expiring: [{ kind: "start" \| "monthly" \| "gift", credits, expiresAt }] }, tenants: [{ id, name, role }] }` · `expiring`: the part of the balance that ends on a date, the nearest first |
| `GET /v1/me/usage?months=` | the same as `GET /v1/tenants/:id/usage`, for the token's tenant |
| `POST /v1/diagnostics` | `{ kind: "install", version, status, models, logs: [{ id, at, level, text }] }` → `{ id }` · what a local install sends when its person runs `wizards report` ([plans/remote-debug.md](plans/remote-debug.md)): its status, model settings without keys, the last lines it printed; at most 256 KB, 10 an hour per person (`429`); the Manage-App keeps 20 per tenant for 30 days, for its admins |

Without any key:

| Call | Answer |
|---|---|
| `GET /v1/plans` | `{ currency, plans: [{ id, name, description, priceCents, monthlyCredits, topUp, limits: { members, projects } }], packages: [{ id, name, credits, priceCents }] }` · the public plans, the cheapest first, prices in cents of `currency` before tax · `packages`: the credits to buy on top, empty where nothing is sold · the studio assistant's `plans` |

Roles on the runtime: `owner` and `admin` make and delete (wizards, spaces, connectors, the space's
settings); `member` edits the wizards there are, tests and publishes them. A member's attempt
answers `403 { code: "forbidden" }`, whichever way it came in (studio, API, MCP). A runtime that
runs alone has one person, who does everything.

## Numbers of a tenant

An organization on engenty.ai gets one number for texts and calls from engenty, for all its spaces: it
asks for one, an admin of the Manage-App assigns it. WhatsApp runs on numbers every organization shares.
Plugins reach these through `server.channels` ([content/dev/plugins/server.md](content/dev/plugins/server.md#numbers-of-the-manage-app));
the runtime asks with its service key and keeps the answer of `GET` a minute.

| Call | Body → answer |
|---|---|
| `GET /v1/tenants/:id/channels` | → `{ number: { id, number, country, kinds, providerRef, since } \| null, request: { id, country, wish, email, createdAt } \| null, shared: [{ number, country, kinds }], allowed }` · `allowed`: the tenant's plan has a number of its own (false on Free) · `number`: the organization's own, E.164 (`+43…`), `kinds` of `sms`, `call`, `whatsapp`, `providerRef` the provider's id of it (Twilio's `PN…`) or null · `request`: its open request for one · `shared`: the numbers every organization shares |
| `POST /v1/tenants/:id/channels/requests` | `{ userId, country, wish?, lang }` → `{ request: { id, country, wish, email, createdAt } }` · a member of the tenant asks for its number; `country` ISO 3166 (`AT`) · `403 plan`: a plan without a number · `409 has_number`: it has one · `403 not_member` · asking again answers the open request · the person gets a mail when it is assigned or declined |
| `DELETE /v1/tenants/:id/channels/requests` | → `{ withdrawn }` · takes the open request back |
| `POST /v1/tenants/:id/channels/usage` | `{ kind: "sms" \| "call" \| "whatsapp", quantity, idempotencyKey, runId? }` → `{ credits }` · what the number carried, booked at the Manage-App's prices: `sms` by segment, sent or received, `call` by started minute, `whatsapp` by message sent · the same key books once · the number's monthly price the Manage-App books itself |

### Clients of the public run API

| Call | Answer |
|---|---|
| `GET /v1/clients` | `{ clients: [{ id, name, runsPerHour, revoked }], unknown: { allow, runsPerHour } }` · which clients (`x-wizards-client`, docs/content/dev/api.md) may start runs on the Manage-App's runtimes and how many an hour across all visitors (`null` = no cap); `unknown` is what an id not in the list gets. Fetched at the start and hourly; a `404` means no list, and every client may start runs. Not yet built in the Manage-App: docs/plans/api-clients.md |

## Manage-App → runtime

`Authorization: Bearer <service key of the runtime>`.

| Call | Body |
|---|---|
| `POST <RUNTIME_URL>/api/internal/tenants/:id` | `{ action: "suspend" \| "resume" \| "delete" \| "holds" }` → `{ ok: true }` · `holds`: an admin held or released the team's page or a wizard; the runtime forgets what it kept of the tenant |
| `GET <RUNTIME_URL>/api/internal/plugins` | → `{ plugins: [{ id, name, description, version }], features }` · the plugins the runtime carries, so a plan's `modules` are picked from what exists; `features` every feature switch it knows (the core's and its plugins', under their ids) |
| `GET <RUNTIME_URL>/api/internal/debug/status` | → `{ app, version, process: { pid, node, platform, hostname, startedAt, uptimeSeconds, memoryMb, log }, managed, appUrl, manageUrl, gatewayUrl, sandbox, browser, files, database, tenantDatabases, tenants, plugins: [{ id, version }] }` · a look from afar ([plans/remote-debug.md](plans/remote-debug.md)); never a key |
| `GET <RUNTIME_URL>/api/internal/debug/logs?since=&after=&limit=&level=&q=` | → `{ sources: [{ from, ok, error? }], lines: [{ id, at, level, text, from }] }` · the last lines the process printed, secrets taken out; `since` an id, `after` ms, `limit` ≤ 2000 (200), `level` `debug` \| `info` \| `warn` \| `error` and up, `q` a text |
| `GET <RUNTIME_URL>/api/internal/debug/runs/:id` | → `{ tenantId, run: { id, wizardId, version, mode, status, cursor, error, ask, unattended, costCredits, userId, createdAt, updatedAt, expiresAt }, wizard: { id, title, publishedVersion } \| null, line: { active } \| null, events: [{ id, stepId, type, message, createdAt }] }` · one run of any tenant; `404` when unknown |
| `GET <RUNTIME_URL>/api/internal/debug/tenants/:id/models` | → `{ tenantId, source, bindings, creditFallback, keys: { [provider]: boolean }, ways: { [class]: { kind, by, ref, problem } } }` · where each class of the tenant runs; `404` for a tenant the runtime never opened |

## Plugins of a tenant

A runtime that runs alone gives every tenant every plugin it loaded. In a runtime of a
Manage-App:

- Plugins are installed by whoever runs the runtime, into the image or a folder of
  `PLUGINS_DIR`. A tenant cannot install one.
- `PLUGINS_DEFAULT` is a comma-separated list of ids every tenant has.
- The Manage-App switches further ones on per tenant: `modules` in its answer to
  `GET /v1/tenants/:id` (kept for a minute; while the Manage-App is out of reach, what it said within the hour). An id
  the runtime does not carry is passed over; without an answer the tenant has only
  `PLUGINS_DEFAULT`. The
  Manage-App learns which plugins a runtime carries from `GET /api/internal/plugins`, so a plan's
  modules are picked from what exists.
- For a tenant without a plugin, that plugin does not exist: no routes or public routes, no
  tools, no space context or assistant tools, no listeners, no jobs, no runners, no index
  entries, no studio half, no starters.
- A plugin's tables are made in every tenant's database, whether the tenant has the plugin or
  not.
- Nothing reloads while it runs: `PLUGINS_WATCH` is ignored there, `/api/studio/plugins/-/reload`
  answers `403` and `/-/events` `404`. A reload would hit every tenant at once; a new version of a
  plugin comes with a new start of the runtime.
- Pro modules are a local install's alone: a runtime of a Manage-App neither fetches nor loads
  them.

So one image serves tenants with different sets of plugins: the plugin is in the image, and the
Manage-App decides who has it. `apps/runtime/test/managed.test.ts` covers it.

## Google accounts through the Manage-App

A local install has no Google OAuth client of its own (a secret cannot ship in it). Its Google
connectors (Gmail, Drive, Calendar, Contacts) connect through the Manage-App of the linked
account, which holds the client (`GOOGLE_CONNECT_CLIENT_ID`/`_SECRET` there, redirect
`<MANAGE_URL>/connect/google/callback`). The Manage-App keeps no token. An install with
`GOOGLE_OAUTH_CLIENT_ID`/`_SECRET` of its own, and the cloud runtime, connect directly.

| Call | Body → answer |
|---|---|
| `GET /v1/connect` (no token) | → `{ google: boolean }` · whether the Manage-App connects Google; the install offers Google only then |
| `POST /v1/connect/google/start` | `{ scopes, returnUrl, state }` → `{ url }` · Google's consent page. `scopes`: only those the runtime's Google connectors use, else `400 invalid_scope`; `returnUrl`: an address on the person's machine (`127.0.0.1`, `[::1]`, `localhost`, `*.localhost`), else `400`; `state`: the install's own, handed back untouched |
| `GET <MANAGE_URL>/connect/google/callback` | Google comes back; the Manage-App swaps the code (PKCE, its secret) and sends the browser to `returnUrl?state=…&ticket=…`, or `returnUrl?state=…&error=access_denied \| exchange_failed` |
| `POST /v1/connect/google/redeem` | `{ ticket }` → `{ access_token, refresh_token?, expires_in?, scope?, token_type? }` (Google's answer) · once, within a minute, by the person who started; else `404 invalid_ticket` |
| `POST /v1/connect/google/refresh` | `{ refreshToken }` → the same shape, with a fresh `access_token` · `400 invalid_grant` when Google dropped the connection (connect again), `429` beyond 240 an hour per person |

Every call but `GET /v1/connect` carries the linked account's access token. The install stores
the tokens like its own and marks the connection `via: "account"`, so its refreshes keep going
through the Manage-App.

## Pro modules of a local install

A runtime that runs alone, linked to an account, gets the closed plugins the account's plan
includes (`modules` of the plan) from the Manage-App
([Pro modules](pro-modules.md)). Every call carries the linked account's
access token; `runtime` is the install's release (`0.2.27` or `v0.2.27`).

| Call | Answer |
|---|---|
| `GET /v1/modules?runtime=` | `{ runtime: "v0.2.27", plan: { id, name }, modules: [{ id, name, version, description, size, sha256, signature, included }], entitlement: { token, expiresAt } }` · every module built for that release, `included` where the plan has it (none for an organization that is not `active`); `[]` when none is built for it · `400 invalid_request` for a `runtime` that is no release |
| `GET /v1/modules/:id/package?runtime=` | the module's zip (`application/zip`, header `x-module-sha256`) · `403 plan` when the plan does not include it, `404` when it is not built for the release, `429` beyond 60 an hour per organization |

- `entitlement.token`: a JWT the Manage-App signs with its JWKS (as access tokens), issuer its
  origin, audience `urn:engenty:wizards:modules`, `sub` the tenant, `modules` the plan's module
  ids, `exp` a few days ahead (`MODULES_ENTITLEMENT_DAYS`, default 7). It carries no `tenant`
  claim and no runtime's audience, so it is never taken for an access token.
- `signature`: Ed25519 over `engenty-module:v1\n<id>\n<version>\n<runtime>\n<sha256>`, made where
  the closed plugins are built, not by the Manage-App. The runtime checks it with the public key
  it ships with before it unpacks anything.

## Spaces of a local install

A runtime that runs alone, linked to an account, sends what it publishes to the account's cloud
runtime (`CLOUD_URL`). Only the published version goes, when it is published; drafts, runs and
connected accounts stay. The project keeps the ids it has on the install — its own and its
wizards' — and is changed on the cloud runtime only by the next sync: the studio there shows it
and runs it. The share link of a copy is the cloud runtime's own.

Calls of the cloud runtime, below `<RUNTIME_URL>/api/v1`, with the account's access token
(`resource` = `<RUNTIME_URL>`) or an API key:

| Call | Scopes | Body → answer |
|---|---|---|
| `PUT /spaces/:spaceId/wizards/:wizardId` | `wizards:write wizards:publish` | `{ space: { name, brand: { name?, about?, colors? }, facts, logo: { name, mime, description, data } \| null }, version, definition, files: [{ path, mime?, data }], shareEnabled, dailyRunLimit? }` (`data` is base64) → `{ wizardId, shareUrl, code, shareEnabled, publishedVersion: number \| null, runnable, problems }` · makes or updates the project and the wizard; the same wizard again keeps its link · `code`: the copy's ID for the mobile app |
| `PUT /spaces/:spaceId/data` | `wizards:write` | `{ tables: [{ id, title, columns, rows: [{ id, cells }] }], pages: [{ id, title, markdown }] }` → `{ tables, pages }` · the space's own tables and pages (not a wizard's), sent after a wizard when they changed; replaces what came before, under the install's ids · `404` before the space's first wizard arrived |
| `PATCH /spaces/:spaceId/wizards/:wizardId` | `wizards:publish` | `{ shareEnabled?, dailyRunLimit? }` → `{ ok: true }` |
| `POST /spaces/:spaceId/wizards/:wizardId/rotate-link` | `wizards:publish` | → `{ shareUrl, code }` · the copy gets a new link (the install made one); the old one stops answering |
| `DELETE /spaces/:spaceId/wizards/:wizardId` | `wizards:write` | → `{ ok: true }` · the copy goes with its link and its runs |
| `GET /spaces` | `wizards:read` | → `{ spaces: [{ id, name, syncedAt, wizards: [{ id, title, publishedVersion, shareUrl, shareEnabled }] }] }` |
| `DELETE /spaces/:spaceId` | `wizards:write` | → `{ ok: true }` · the project goes with its wizards |
| `POST /spaces/check` | `wizards:read` | `{ definition, files: [path] }` → `{ problems }` · what a wizard would lack there, nothing is written |

- **Ids**: 8 to 40 characters of `A–Z a–z 0–9 _ -`, as the install makes them. An id a project or
  wizard made on the cloud runtime already has is refused (`reason: "id_taken"`).
- **Problems**: `{ code: "invalid" | "connector" | "model" | "sandbox" | "mcp", blocking, steps: [{ id, title }], detail }`.
  A sent version with a blocking problem is kept and shown but not published: runs go on with the
  version before (`publishedVersion`), and `runnable` is false.
- **Room**: a synced project counts against `limits.projects`. Beyond it the call is refused with
  `400 { reason: "space_limit", spaces: [{ id, name }] }`, naming the synced projects in the way.
- **Limits**: 240 sendings an hour per tenant (`429`), 48 MB per wizard (`413`), and the
  runtime's `LIMIT_SYNCED_WIZARDS` (50) wizards per synced project (`400 { reason: "wizard_limit" }`).
- **Refusals**: `403 { code: "insufficient_scope" }`; and `403 { code: "read_only" }` from every
  other write of a synced project, or by a tenant with `limits.build: false`.
- **A sending that breaks off** (`5xx`, the connection) leaves nothing behind: the files' bytes
  are kept first, then the project, the wizard, its workspace and the version are written in one
  transaction. The install sends again by itself — after a minute, then twice as long each time,
  up to an hour — until it arrives; not after a refusal (`4xx`), which only the person can mend.

## Two-way sync of a space

Behind the switch `twoWaySync` (off by default; docs/plans/tenant-sync.md). A runtime that runs
alone, linked to an account, keeps its spaces the same as the organization's spaces on the cloud
runtime, both ways: the space's details, wizards (draft and workspace), translations, the build
chat, pages, tables and rows, categories, files and connectors. Runs, the studio assistant's
chats, the wizard's store, connected accounts, the index and model settings stay on each side.

The cloud is the hub. Triggers note every write of a synced table in its `sync_change`, and its
number (`seq`) orders the changes. The install pushes an item with the number of the cloud's
version it changed (`base`); the cloud takes it when its own version has not changed since, and
otherwise answers with its version, which the install merges (sync/client.ts). Both sides must
have the same tenant schema, the last migration's tag.

Calls of the cloud runtime, below `<RUNTIME_URL>/api/v1`, with the account's access token:

| Call | Scopes | Body → answer |
|---|---|---|
| `GET /sync` | `wizards:read` | → `{ tenantId, schema, role, limits: { projects }, spaces: [{ id, name, seq }] }` |
| `GET /sync/spaces/:spaceId/changes?since=&cursor=` | `wizards:read` | → `{ changes: [{ kind, item, seq, record }], next, more, cursor? }` · `record: null` = deleted · from `since=0` every item of the space, a page at a time (`cursor`) · 300 a page |
| `POST /sync/spaces/:spaceId/changes` | `wizards:write` | `{ schema, items: [{ kind, item, base, record }] }` → `{ results: [{ kind, item, status: "taken", seq } \| { status: "conflict", seq, record } \| { status: "refused", reason, message }], seq }` · 500 items, 16 MB · a space is made by the item `{ kind: "space", item: spaceId }` |
| `POST /sync/spaces/:spaceId/blobs/missing` | `wizards:write` | `{ hashes }` → `{ missing }` · the files' bytes go before the records that point to them |
| `PUT /sync/spaces/:spaceId/blobs/:sha256` | `wizards:write` | the bytes (`application/octet-stream`) → `{ ok }` · `400` when they are not what the hash says |
| `GET /sync/spaces/:spaceId/blobs/:sha256` | `wizards:read` | → the bytes |
| `POST /sync/spaces/:spaceId/wizards/:wizardId/publish` | `wizards:write wizards:publish` | → `{ wizardId, shareUrl, code, shareEnabled, publishedVersion, runnable, problems }` · publishes the cloud's draft, which the install pushed before |
| `POST /sync/spaces/:spaceId/wizards/:wizardId/rotate-link` | `wizards:publish` | → `{ shareUrl, code }` |
| `POST /sync/spaces/:spaceId/adopt` | `wizards:write` | → `{ adopted }` · a space synced one way (`origin = "local"`) becomes the cloud's own and syncs both ways |
| `GET /sync/live` | `wizards:read` | Server-Sent Events while open: `hello { seq }`, `changes { seq, spaces }` (the spaces with a change, not the items), `reset { seq }` (pull every space), `ping` every 20 s · `id:` is the `seq`, `Last-Event-ID` resumes · the changes of the push of the install named in `x-wizards-install` are left out · ends after 30 minutes · `404` while the switch `liveChanges` is off |

- **Kinds and items**: `space` (its id), `wizard`, `translation` (`<wizard>:<lang>`), `message`,
  `page`, `table`, `row`, `category` (with its values), `file`, `connector` (`<space>:<id>`).
  Records carry no tenant id, revision or time a write sets by itself; files go by the SHA-256 of
  their bytes. A connected system's `headers` stay on each side.
- **Roles**: the token's role counts. A member changes what is there; making or deleting a wizard,
  and any change of the space's details or its connectors, is for owners and admins
  (`reason: "forbidden"`). A tenant with `limits.build: false` is refused (`403 read_only`).
- **Refusals**: `400 { reason: "schema_mismatch", schema }` when the tenant schemas differ (the
  sync pauses until both match); `404 { reason: "not_found" }` for a space that is not there and
  is not made by the push; per item `reason` `forbidden`, `id_taken`, `space_limit`,
  `blob_missing`, `invalid`, `not_synced`.
- **Limits**: 1200 pushes and 3600 pulls an hour per tenant (`429`). An install keeps one
  `GET /sync/live` open and pulls a space it names at most every 2 seconds.
- **The install**: every call carries `x-wizards-install`, an id the install keeps.

## Clients of an account: the WordPress plugin

The WordPress plugin is an OAuth client of the Manage-App like an MCP client: it registers itself
(`POST /api/auth/oauth2/register`, public client, PKCE, its own `admin-post.php?action=engenty_connect`
as the redirect), sends the admin to the authorization endpoint with `resource=<RUNTIME_URL>/api/mcp`,
`scope=openid profile email offline_access wizards:read wizards:write wizards:publish runs:read`,
`login_hint` (the admin's e-mail) and, for "create an account", `prompt=create` (the sign-in page
then offers a new account first), and keeps the refresh token on the site. An API key does the
same calls.

Calls of the runtime, below `<RUNTIME_URL>/api/v1`:

| Call | Scopes | Answer |
|---|---|---|
| `GET /me` | — | `{ user: { id, name, email, role }, tenant: { id, name, plan: { id, name } \| null, credits }, build, create, plugins, missing, spaces: [{ id, name, title, wizards, writable }], scopes, client, urls: { app, embed, studio, newWizard, space, account, billing, upgrade } }` · `missing`: of `contacts` and `appointments`, what the plan lacks |
| `GET /wizards?space=` | `wizards:read` | `{ wizards: [{ id, spaceId, title, description, avatar, published, publishedVersion, token, code, shareUrl, shareEnabled, iconUrl, available, unavailableReason, dailyRunLimit, plugins, standalone, studioUrl, updatedAt }] }` · a draft has no `token`, `code`, `shareUrl` · `standalone`: whether it runs on a website by itself, `{ fit: "full" \| "less" \| "no", notes, missing, optional, needs, without }` (`packages/shared/src/fit.ts`) |
| `GET /wizards/:id/package?knowledge=` | `wizards:read` | the published version as a `.wizard` package (`application/vnd.engenty.wizard+zip`, `content-disposition` with the file name); `knowledge=1` adds the project's pages under `files/knowledge/` as Markdown (2 MB cap, the manifest's `knowledge: { pages, truncated }`); `404 not_found` while the wizard is a draft only |
| `POST /wizards` | `wizards:write wizards:publish` | `{ starterId, spaceId?, lang?, publish = true }` → `{ wizard, published, issues }` · a wizard from a template, published when it has no issues; `403 read_only` without `limits.build` |
| `GET /templates?q=&lang=` | `wizards:read` | `{ templates: [{ id, title, pitch, avatar, language, useCases, formats, plan, plugin, needs, credits }] }` · the plugins' starters first |
| `GET /runs?space=&wizard=&status=done\|open\|all&q=&days=&page=` | `runs:read` | `{ runs: [{ id, wizardId, wizard, status, step, createdAt, updatedAt, origin, email, summary, credits, files }], page, pages, total }` · live runs, 50 a page |
| `GET /runs/:id` | `runs:read` | the run's report (outputs with signed downloads) and `{ wizard, createdAt, origin, email, answers: [{ label, kind, value }], shareUrl }` |
| `GET /space?space=` | `wizards:read` | `{ id, name, title, about, colors, facts, logoUrl, knowledge: { pages, tables, files }, writable, studioUrl }` |
| `POST /space/site` | `wizards:write` | `{ spaceId?, url, name, tagline, language?, facts: [{ label, value }], colors: [{ name, value }], logo?: { name, mime, data }, pages: [{ key, title, url?, role?, markdown }], assist = true }` → a job `{ id, status: "running", activity, … }` · fills the space's empty details, writes the pages into Wissen under the origin `wordpress` (a page gone from the site goes), then lets the space assistant read the rest; 20 an hour per tenant |
| `GET /space/site/:job` | `wizards:read` | `{ id, status: "running" \| "done" \| "failed", activity, pages, reply, error, space }` |
| `ANY /plugins/:id/*` | `wizards:read` for GET, else `wizards:write` | the plugin's own routes as the token's person · `403 { code: "plugin", plugin }` when the tenant's plan lacks it |

`POST /api/public/wizards/:token/runs` takes `origin` (the embedding page, from `embed.js`'s
`data-page`) beside `embedded`; it is kept as `run.origin`.

## Model-gateway

The gateway speaks the Vercel AI Gateway protocol, so `@ai-sdk/gateway` works with
`createGateway({ baseURL: "<GATEWAY_URL>/v4/ai", apiKey: <token> })`.

| | |
|---|---|
| Model id (header `ai-language-model-id` for language models, `ai-model-id` for the others — as `@ai-sdk/gateway` sends them) | `wizards/<class>` with class `classifier`, `low`, `standard`, `high`, `image`, `video`, `audio`, `speech`; the gateway binds it to a model. A concrete model id — an AI Gateway id, `fal:<endpoint>`, `elevenlabs:<model>` — is refused unless the catalog enables it; `models` of `/v1/models` lists the media models it enables. |
| Caller: a person (desktop app) | `Authorization: Bearer <access token>`; the tenant is the token's |
| Caller: a runtime | `Authorization: Bearer <service key>` plus `x-wizards-tenant`; visitors have no token |
| Class names | `x-wizards-definition: 2` on every call and on `/v1/models`: the classes are named as in version 2 of the wizard definition. A caller without it is a runtime from before: its `standard`, `high` and `highest` are read as `low`, `standard` and `high`, and `/v1/models` answers it in those names |
| Attribution (optional, both callers) | `x-wizards-run`, `x-wizards-step`, `x-wizards-effort` (`low` \| `medium` \| `high`); a runtime may add `x-wizards-user` |
| Chat-image models | `wizards/image` may arrive on `/language-model` (models that answer a chat with an image, like Gemini) or on `/image-model` |
| No balance | `402`, body `{ error: { message, type: "insufficient_credits" } }` — unless the run named in `x-wizards-run` holds a reservation |
| Suspended tenant, unknown class, model not enabled | `403`, type `forbidden` |
| Booking | one ledger row per call: tenant, user, run, step, class, model, tokens, provider cost, credits |

The classifier class may be bound to a model that only decides (type `evaluation`, e.g.
`typesafe-ai/jev`). The runtime calls `wizards/classifier` like any language model. A call that
asks for a JSON object whose fields are all booleans or strings from a fixed set, with no tools
and no stream, is a decision: the gateway asks the evaluation model and answers with that
object. Every other call, and a decision the model leaves open, is answered by the model of the
`low` class and booked under `classifier`.

`POST <GATEWAY_URL>/v4/ai/systemone` (header `ai-model-id: wizards/classifier`) asks the evaluation
model directly, in TypeSafe's System One shape: `{ state, questions }` in, `{ model, answers,
usage }` out, each `noul` answer with its P(yes). A search of a space's Wissen asks it which of
the candidates it found help answer the question. Answered by the model the classifier class is
bound to when that is an evaluation model, else by `typesafe-ai/jev`; booked under
`classifier`. `501` when no evaluation model is enabled: the runtime then keeps the order its
index gave.

A model the tenant's plan leaves out — a class not in its list, or a named media model not in
its list — is refused with `403`, type `forbidden`, whatever the catalog enables.

`GET <GATEWAY_URL>/v1/models` (any valid token or service key) → what an estimate needs:

```json
{
  "markup": 2,
  "classes": {
    "low":      { "model": "deepseek/deepseek-v4.1-flash", "kind": "text", "inputCreditsPerMTok": 15, "outputCreditsPerMTok": 60 },
    "image":    { "model": "google/gemini-3.1-flash-image", "kind": "image", "creditsPerImage": 13.4 },
    "video":    { "model": "google/veo-3.1-fast-generate-001", "kind": "video", "creditsPerSecond": 30 },
    "audio":    { "model": "fal:fal-ai/wizper", "kind": "audio", "transcribes": true, "creditsPerMinute": 1.2 },
    "speech":   { "model": "google/gemini-3.8-flash-tts", "kind": "speech", "creditsPer1kCharacters": 3.334 }
  },
  "webSearchCredits": 2,
  "models": [
    { "id": "fal:fal-ai/flux/schnell", "name": "FLUX.1 [schnell]", "source": "fal", "provider": "fal", "kind": "image", "creditsPerImage": 0.6 },
    { "id": "elevenlabs:eleven_multilingual_v2", "name": "ElevenLabs Multilingual v2", "source": "elevenlabs", "provider": "elevenlabs", "kind": "speech", "creditsPer1kCharacters": 20 }
  ],
  "plan": { "id": "pro", "classes": null, "models": null }
}
```

`plan`: what of this the caller's tenant may use — `classes` and `models` list what is allowed,
`null` allows everything above; `plan` itself is `null` for a caller without a tenant.

`audio.transcribes`: the class is bound to a transcription model and is called on
`/transcription-model` (body `{ audio: <base64>, mediaType }`); otherwise it is a language model
that takes the audio file on `/language-model`. `speech` is called on `/speech-model`. `models`
are the media models a caller may name itself (`kind` `image`, `video`, `speech`,
`transcription`), each with its retail price; the gateway serves fal and ElevenLabs models in
the AI Gateway's shapes and books them by the catalog's price.

A catalog that lists the class `embedding` (`"kind": "embedding"`) says the gateway also takes
`wizards/embedding` on `/embedding-model`: the runtime then keeps vectors of a project's documents.
Without it the runtime indexes them by keywords only and never calls that id.

1 credit = 1 cent retail; credits = provider cost in cents × markup. The provider cost is the
AI Gateway's cost of the call, which includes web-search fees.
