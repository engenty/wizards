# Plan: the client portal

Status: built on 2026-11-01, not released: the contract (#415), the Manage-App's client and page
by host (Manage #165), the portal app (this branch). Step 3 of `docs/plans/client-spaces.md`, phase 2b
of `docs/plans/modular.md`. Page with the diagram: the artifact “Client Portal Plan”
(claude.ai/artifact/3BKfh32GhDy6cfAptwAK1H).

A firm's client signs in at `<team>.wizards.page/portal` and finds their client space: what waits
for them, the chats with the firm, their files and the results the firm shared. They start the
wizards the firm opened to clients. The portal is an app of its own that reaches the runtime only
through a public contract, signed in as the client, so another app can build a portal on the same
contract.

## Decided

| | Decision |
|---|---|
| D9 Where it runs | Its own app (`apps/portal`): an SPA and a thin server. Not the Manage-App (no clients there, a clear API line) and not the runtime's studio or roles |
| D10 A client's write that needs a yes | Held for the bell, not refused. Not part of this plan's steps (open point 3) |
| D11 Order | The portal before phase 4 (published wizards as endpoints) |
| D12 Plans | Pro: one public page. Team: client spaces and portals |
| Address | `<team>.wizards.page/portal`, later the team's own domains. The Manage-App serves the rest of the host; `/portal` goes to the portal's container |
| Who | Only people with the organization's role `client`. The firm's own view of a client space stays in Studio and Work ("View as" in Client mode, `client-spaces.md` step 2) |
| Switch | `clientSpaces`, as the rest of client spaces |
| The organization's page (2026-11-01) | The app is the organization's page with an optional client part. Before sign-in it shows the firm's brand and its public page; client portals are a Team plan option. Later the organization's page can offer chat, wizards and information to everyone too: the routes leave room for it. MVP now, structure right |
| Addresses (2026-11-01) | No client space's name or id in a portal address. `/portal` is the client's home; deep links name the item (`/portal/r/<run>`, `/portal/chat/<chat>`, `/portal/f/<file>`), never the space. See "Addresses" below |
| Chats (2026-11-01) | A client writes to the firm's people. In a chat the client can ask the space's AI, which answers as the client under the broker and spends the firm's credits |

## The parts

```
browser ──/portal──▶ portal server ──Bearer──▶ runtime `api` role: /api/v1/client/…
   │                   │  (cookie: sealed tokens)      └─▶ broker (subjects: role client)
   │                   └──/portal/api/runs/:id/*?rt=──▶ runtime `doors`: /api/runs/:id/… (run protocol)
   ├──sign-in──▶ Manage-App (OAuth, PKCE, client `wizards-portal-<runtime>`)
portal server ──GET /v1/pages/host/<host>──▶ Manage-App: the team, its public page data, portal on
```

- **The portal server** (`apps/portal/server`): signs in through the Manage-App, keeps the tokens
  sealed in an http-only cookie (no database), renews them, and forwards two kinds of calls: the
  client contract with the access token, and a run's own routes with that run's ticket. It knows
  no rule; every decision is the runtime's.
- **The SPA** (`apps/portal/src`): React, its own bundle. Draws runs with
  `@engenty/wizards-runner` (MIT), as the WordPress plugin does, so a wizard looks as on its
  page. The firm's brand from the parent space.
- **The contract** (`/api/v1/client`): calls made from one spec list, with their input as JSON
  Schema (`GET /api/v1/client` lists them), like the element calls. Served by the `api` role.
- **The organization's public face** comes from the Manage-App, which already keeps the page data
  the runtime sends (`PUT /v1/pages/:tenantId`) and resolves a host to its team. A public read
  of it by host gives the team, its public page (brand, words, listed wizards) and whether its
  client portal is on (`clientSpaces`). Nothing in it is private: the same page is on the host.

## The contract

Every call acts as the token's person (I1) and only for role `client`: another role is answered
`403 { code: "clients_only" }`. A space in the path is one of the client's client spaces, else
`404` (I2, `ownedSpace` already refuses the rest). The broker decides each item as that client
(subjects: the person and the role `client`), so the parent's Knowledge comes back only where a
rule opens it to clients.

| Call | Scope | Space | What it gives |
|---|---|---|---|
| `me` | `data:read` | – | The person (name, e-mail) and the organization (name, address `slug`, `pagesHost`), so the portal checks the host |
| `spaces` | `data:read` | – | The client's client spaces: id, name, the firm's space name and its brand (`brandView` of the parent) |
| `run_open` | `data:read` | – | By the run alone: a ticket for it and its client space, for a deep link |
| `chat_messages` | `data:read` | – | By the chat alone: its messages and its client space |
| `file` | `data:read` | – | By the file alone: what it is and its client space; its bytes at `GET /api/v1/client/files/:id` |
| `for_you` | `data:read` | ✓ | What waits for them: their runs waiting on a page or an ask, results the firm shared since they last looked, the wizards opened to clients |
| `wizards` | `elements:read` | ✓ | The parent's published wizards a client may run (rule `x` for role `client`) |
| `wizard_start` | `elements:run` | ✓ | Starts one in the client space; gives the run id and its ticket |
| `results` | `data:read` | ✓ | Runs of the client space the client may see: their own, and the firm's shared with them |
| `chats` | `data:read` | ✓ | The client space's chats the client is a member of: the ones they started, the ones the firm added them to. The firm's other chats there stay internal |
| `chat_post` | `elements:run` | ✓ | Writes a message in one of those chats; a new chat with the firm when none is named. `ask: true` lets the space's AI answer, as the client |
| `files` | `data:read` | ✓ | The client space's documents and uploads |

Paths: `POST /api/v1/client/:name` (no space), `POST /api/v1/client/spaces/:spaceId/:name`,
`GET /api/v1/client/spaces/:spaceId/files/:fileId`. Body `{ input }`, answer `{ result }` or
`{ error, code }`, as the element calls.

Existing scopes, no new one: reading is `data:read`, starting a run or making the space's AI
answer is `elements:run`. The portal asks for `data:read elements:read elements:run`.

### Runs in a client space

Today every run belongs to its wizard's space (`engine/runner.ts` `spaceIdOf`, `loadSpace`). A
run started in a client space uses the parent's wizard and belongs to the client space:

- `run.clientSpaceId`: the client space a run was started in; null for a run of its wizard's
  space. Set at the start, never changed.
- **Setup from the parent, data in the client space.** The run's wizard, connections, skills,
  plugins, brand and mail domains stay the parent's (`ctx.space`, as today). Its data is the
  client space's: a new `ctx.dataSpace` for pages and tables a step writes, Knowledge (the client
  space, then what the parent opens, as `elements/knowledge.ts` reads it), shared lists, the
  audit's space (`whereOf`), the results list and `requireStudio("runs")`.
- The subjects of a client's run are the person and the role `client` (`runHolder` already gives
  that), so its steps read the parent only where opened and write only in the client space.
- `wizard_start` checks `x` on the wizard in the parent for the role `client` (the firm opens a
  wizard to clients in Studio), then starts it as the client. `wizard_run` of the element calls
  starts in a client space the same way, for the firm's members too.
- A firm member's run in a client space belongs to the client space as well, internal until
  shared.

### A client in the studio

A client who signs in at the studio is sent on to their portal (`CLIENT_PORTAL_URL`, by default
`https://{host}/portal` with the organization's `pagesHost`): the studio is never theirs.

### Shared on purpose

A run the firm makes in a client space stays internal. `run.clientSharedAt` marks one shared
with the client space's clients: set in Studio (Work's results, "Share with the client"), through
`POST /api/studio/runs/:id/client-share`. The client sees their own runs and the shared ones,
nothing else. A shared run is only read: `run_open` gives a ticket that opens its view, stream
and downloads (`GET`) and no command. `/s/<token>` links stay as they are.

### The run protocol for the portal

The portal draws a run with the run's own routes (`/api/runs/:id/…`, the stream, pages, reviews,
uploads, downloads). `run_open` and `wizard_start` give a ticket (`runTicket`, 12 hours); the portal
server adds it as `rt` when it forwards. A client's studio session no longer opens runs by being
in the organization: a person with the role `client` reaches a run only by its ticket or as its
starter in their client space.

## The portal app

| Address | Page |
|---|---|
| `/portal` | Signed out: the firm's public face (its brand, its public page's words and wizards, "Sign in" where the client portal is on). Signed in: the client's home, **For you** / **Für dich** of the current client space |
| `/portal/chats`, `/portal/files`, `/portal/results` | The parts of the current client space |
| `/portal/r/<run>` | One run or result, in the runner |
| `/portal/chat/<chat>` | One chat |
| `/portal/f/<file>` | One file |
| `/portal/w/<wizard>` | One of the firm's wizards opened to clients: its start |

### Addresses

Decided on 2026-11-01 (replacing addresses with a client space's name or id):

- **Why:** a client relationship can itself be confidential (law firms, tax advisers). A name in
  an address leaks through the browser's history, the `Referer`, server logs and screenshots.
  Client names at the root of the team's host would collide with the public spaces' addresses
  and make the public page's server know the clients' names.
- **The current client space is held per tab**, never in the address and never in the shared
  session: one client space, that one; several, the last one opened (kept in the browser), with
  a switcher on the page; a tab keeps its own (`sessionStorage`), so two tabs on two matters do
  not overwrite each other. The calls of the contract name it; the address bar does not.
- **Deep links name the item.** Ids are random. The contract finds the item's client space and
  the broker decides as the client; mails and notifications link this way.
- **Uniform answers.** Without a session every `/portal/…` but `/portal` itself gets the same
  redirect to the sign-in. Signed in, a client space, run, chat or file the person is not in
  answers exactly as one that does not exist: the same status and body, from one query that asks
  for the item and the person's place together, so neither the answer nor its timing tells them
  apart.
- **No traces:** `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex` on all of `/portal`;
  no portal address in any sitemap.
- **Rate limits** on `/portal/…` and, tighter, on the sign-in.
- **`portal` is a reserved word** for a public space's address (`RESERVED_PAGE_SLUGS`); the
  Manage-App's reserved words (`HOUSE` in `address-words.ts`) need it too.
- The addresses live in one place (`apps/portal/server/paths.ts`), used by the server and the
  SPA, since their exact shape may still change.

- **Brand:** before sign-in the public page's brand; after it the parent space's brand
  (`runTheme`, the main logo). The engenty look where there is none.
- **Languages:** German and English, by the browser, switchable. German gender-neutral
  (`docs/copy-style.md`), checked by `pnpm copy:check`.
- **Phone first:** a bottom bar with the four parts on a phone, a side bar on a wide screen.
- **Sign-in** (Manage-App OAuth with PKCE, as `apps/runtime/src/auth/index.ts`): the callback is
  at the portal's own origin (`PORTAL_URL/portal/auth/callback`, one redirect URI for every team);
  it hands the session to the team's host with a one-time code that only the browser that started
  the sign-in can use (a state cookie on that host). Sign-out clears the cookie.
- **Another organization:** the token's organization is the one active at the Manage-App. When it
  is not the host's team, the portal says so and offers to sign in again.

## Deploying

- `apps/portal/Dockerfile`: a small Node image (server + SPA), `ghcr.io/engenty/engenty-wizards-portal`,
  built with the runtime's images for every release (`.github/workflows/ci.yml`, job `images`).
- `compose.cloud.yaml`: a `portal` service on port 8893. It needs `PORTAL_URL` (its own origin,
  where every sign-in comes back), `PORTAL_CLIENT_SECRET` and `PORTAL_SECRET` (32 characters or
  more); `MANAGE_URL` and `APP_URL` it shares with the runtime. It calls the `api` and `doors`
  services inside the stack.
- **Coolify (by hand):**
  1. The domain of `portal`: `PORTAL_URL`'s host, e.g. `https://portal.wizards.page`.
  2. A Traefik router for `/portal` on every team's host, ahead of the Manage-App's
     `*.wizards.page` router: `HostRegexp(`^[a-z0-9-]+\.wizards\.page$`) && PathPrefix(`/portal`)`
     to `portal:8893`, with a higher priority. Own domains: one rule each, later.
  3. The Manage-App's `RUNTIMES` entry for `cloud` gains `portalUrl` (= `PORTAL_URL`) and
     `portalSecret` (= `PORTAL_CLIENT_SECRET`); its restart writes the client
     `wizards-portal-cloud`.
  4. The variables above on `portal`, then deploy it with the release that ships client spaces.
- **Manage-App** (Manage #165): the pre-registered client per runtime with a portal
  (`RUNTIMES[].portalUrl`, client `wizards-portal-<name>`, redirect
  `<portalUrl>/portal/auth/callback`, resource the runtime's `APP_URL`), no consent page; and the
  public read `GET /v1/pages/host/:host`.

## Steps

1. **Plan** (this page, the artifact).
2. **The contract** (one PR): `run.clientSpaceId` and `run.clientSharedAt`, runs in a client space, the
   client calls from one spec list, "Share with the client" on the studio route, the run ticket
   for clients; tests that a client sees nothing of another client or of the
   parent's setup, and the parent's Knowledge only where opened; `docs/content/dev/api.md`.
3. **The Manage-App** (Manage PR): the portal's OAuth client per runtime, the page by host.
4. **The portal** (one PR): `apps/portal`, the image, the compose service; tried on a local stack
   with the Manage-App.

## Not built yet

- **The firm's side in Studio:** "Share with the client" and renaming a client space have their
  routes (`PUT /api/studio/runs/:id/client-share`, `PATCH /api/studio/spaces/:id/client`); the
  buttons wait for the space's Clients part (`client-spaces.md`, step 2).
- **The Manage-App's reserved words:** `portal` still needs adding to `HOUSE` in
  `address-words.ts` there, so no team takes it as its own address word either.
- **A run's knowledge in a client space:** a step's Knowledge block counts the client space's own
  items; the parent's opened items are found by search but not counted there.

## Open

1. **Own domains:** the page by host answers for the team's address first; own domains join once
   the Manage-App serves pages on them.
2. **Organization at sign-in:** solved: the portal sends the host's team as `organization`, which
   the Manage-App's sign-in already takes.
3. **D10 in the portal:** a client's chat or run that needs a person's yes is held for the bell.
   Until the broker holds outside calls (`modular.md`, "Approvals from outside"), it is refused
   with why.
4. **Uploads from the client:** the files part only lists and downloads; uploading waits for a
   decision on the client's write rules for files.
5. **Notifications:** a mail when something new waits for the client.
6. **A brand without a public page:** a Team without a public page shows its name in the engenty
   look before sign-in. An organization brand of its own would need a setting.
7. **The rest of `<team>.wizards.page` in this app:** the public page, public chat and more could
   move here from the Manage-App. To decide when public chat comes.
