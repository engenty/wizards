# Plan: the client portal

Status: version 1 built on 2026-11-01 (the contract #415, the Manage-App's client and page by host
Manage #165, the portal app #416, #417), not released. Re-planned the same day as **version 2**,
"the firm's AI for its clients"; phase 1 of it is built (this branch). Step 3 of
`docs/plans/client-spaces.md`, phase 2b of `docs/plans/modular.md`. Pages: “Client Portal v2”
(claude.ai/artifact/Q5xdCVEKQSU8n7nvPUi97j, the mockups M1–M9 and P1–P4), and the first
“Client Portal Plan” (claude.ai/artifact/3BKfh32GhDy6cfAptwAK1H) for the parts that stayed.

A firm hands its clients an AI that knows their project, runs the firm's ready-made wizards and
keeps everything that comes out: a chat in the firm's colours, with the wizards beside it and one
place for results. A client signs in at `<team>.wizards.page/portal`, asks the firm's AI and gets
answers from their client space and what the firm opened to clients, starts the firm's wizards
and finds every result. The firm's people come in by hand-off (phase 2), not as the front door.
The portal is an app of its own that reaches the runtime only through a public contract, signed
in as the client, so another app can build a portal on the same contract.

## What changed from version 1

Version 1 had four lists (For you, Chats, Files, Results), and its chat went to the firm's people:
the AI answered only with "Ask the AI too" ticked. That treated the chat as person to person.
Once the AI answers, the chat is the fastest way to anything, so it moves to the front:

- The home is the chat. Every client message goes to the firm's AI, which answers as the client.
- **For you** / **Für dich** becomes the row **Waiting for you** / **Wartet auf dich** above the
  composer, at most three cards, gone when nothing waits.
- Three places: **Chat**, **Wizards**, **Results** / **Ergebnisse** (with the tab **Files** /
  **Dateien**). `/portal/chats` and `/portal/files` are gone.
- The AI speaks as "<firm> AI" / „<Firma> KI“ with the firm's mark, never as a person. Engenties
  stand only for wizards (cards, starters, runs) and once in a small "with engenty wizards" line.

What stayed: the own app `apps/portal`, the contract `/api/v1/client`, addresses that never name
a client space, the firm's brand, runs in a client space, "Share with the client".

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
| Chats (version 2, 2026-11-01) | Every client message goes to the firm's AI, which answers as the client under the broker with a client's tools only. The firm's people join a chat by hand-off (phase 2) |
| Who reads a client's chat (2026-11-01) | The firm's members read every chat in a client space, as they see the rest of it. The client is told under the composer from the first message: "You and <firm> see this chat." / „Du und <Firma> seht diesen Chat.“ A hand-off adds the person who answers |
| Who pays (2026-11-01) | The firm's credits pay every turn and every wizard a client starts, never stopped per client. An optional monthly budget per client space (phase 4) only warns the firm's admins (bell and mail) when a client goes over it; the client keeps working. When the firm's credits run out, the AI pauses and the client can hand the chat over |
| Public links (2026-11-01) | A client cannot make a public link of a result unless the firm turns it on for that client space in Studio (phase 4). Downloads always work; a link inside the space opens for the people in it |

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
| `chat_messages` | `data:read` | – | By the chat alone: its messages and its client space. A message's `parts` keep the order it was written in: text, the AI's views (`show_view`) and the runs it started (`wizard_run`) as cards; a run only where the client opens it |
| `file` | `data:read` | – | By the file alone: what it is and its client space; its bytes at `GET /api/v1/client/files/:id` |
| `for_you` | `data:read` | ✓ | What waits for them: their runs waiting on a page or an ask, results the firm shared since they last looked, the wizards opened to clients |
| `wizards` | `elements:read` | ✓ | The parent's published wizards a client may run (rule `x` for role `client`), each with its engenty (`avatar`) and its number of steps |
| `wizard_start` | `elements:run` | ✓ | Starts one in the client space; gives the run id and its ticket |
| `results` | `data:read` | ✓ | Runs of the client space the client may see: their own, and the firm's shared with them |
| `chats` | `data:read` | ✓ | The client space's chats the client is a member of: the ones they started, the ones the firm added them to. The firm's other chats there stay internal |
| `chat_post` | `elements:run` | ✓ | Writes a message in one of those chats; a new chat when none is named. The firm's AI answers every message, as the client; the answer shows on the next read (`answering` while it writes) |
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

### The AI's turn for a client

The turn is Work's AI turn (`services/work-ai.ts`, `chatTurnWay()`), made for the person with
the role `client` (the session's role, `TurnFor.role`). Its tools are narrower than a member's
(`clientTools`): Knowledge (the client space, then what the firm opened to clients), the wizards
opened to clients (`wizard_list`, `wizard_run`: a run lands in the client space) and `show_view`.
No skills, sandbox, connections, plugin tools or web search: nothing that reaches past the client
space or acts with the firm's sign-ins, so D10 rarely comes up. Its instructions say whom it
answers, that the firm reads along, to say where it can't know, and to run a wizard where one
fits. `test/client-ai.test.ts` holds a client's turn to exactly these tools.

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
| `/portal` | Signed out: the firm's own page with one button (its brand, its public page's words, "Sign in" where the client portal is on). Signed in: the chat-first home of the current client space |
| `/portal/wizards` | The firm's wizards opened to clients, in the studio's card style |
| `/portal/results` | Results as a grid, with the tab **Files** / **Dateien** |
| `/portal/r/<run>` | One run or result, in the runner |
| `/portal/chat/<chat>` | One chat |
| `/portal/f/<file>` | One file |
| `/portal/w/<wizard>` | One of the firm's wizards opened to clients: its card and start |

- **The frame:** on a wide screen a side bar with the firm's logo, the client space (a menu only
  with several), **New chat**, **Wizards**, **Results** and the chats by when they were written
  in (today, this week, then by month); the person, the language and sign-out at its foot. On a
  phone a top bar with the space as its title and three tabs: Chat, Wizards, Results.
- **The home:** a greeting by first name; **Waiting for you** (at most three of `for_you`'s
  waiting runs); the composer; the firm's wizards as starters; **New for you** from `results`.
  On the first visit (no chats, no results) one sentence on what the AI knows and example
  prompts instead of starters.
- **A chat:** the client's messages on the right, the AI's answers as "<firm> AI" with the firm's
  mark, its views drawn with the runner's surface, its runs as cards that open `/portal/r/<run>`.
  The answer comes by reading the chat while it is `answering` (phase 2 streams it). Under the
  composer: "You and <firm> see this chat."
- **The composer:** one box; Enter sends; its **Wizard** button lists the wizards and starts one.
- **Wizards:** the engenty on the card's top edge, title, two lines, steps, **Start**; a run
  waiting on the client above them.
- **Results:** the client's waiting runs first with a status chip, then every result, each with
  its wizard's engenty, title, source ("By you" / "By <firm>") and date; filters by source.

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
  (`runTheme`, the main logo) through `look.ts`. The accent marks the main action only; ground and
  text stay calm; no gradients, banners or hero images. A calm gold marks what waits, the same
  for every firm. The engenty look where there is no brand.
- **Engenties** are the studio's (`apps/web/src/engenty/engenty.tsx`), written out with their
  idle morph to `apps/portal/src/engenty-shapes.ts` by `apps/web/scripts/engenty-shapes.tsx`:
  one eye, never drawn by hand.
- **Languages:** German and English, by the browser, switchable. German gender-neutral
  (`docs/copy-style.md`), checked by `pnpm copy:check`.
- **Phone first:** three tabs at the bottom on a phone, a side bar from 900px.
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

Version 1 (built): the plan, the contract (#415), the Manage-App's client and page by host
(Manage #165), the portal (#416, #417). Version 2 builds on it in phases, each behind
`clientSpaces` and whole on its own:

1. **The firm's AI in a new portal** (built, this branch): the portal rebuilt to the mockups; the
   chat-first home; every client message to the AI; the narrower turn for clients with its tests;
   views and runs as cards in `chat_messages`; Wizards with engenties; Results as a grid with
   Files; this page.
2. **Live answers and the firm's people:** the turn streams through the portal server (AI SDK UI
   message stream); `chat_handoff` with a summary to the firm's bell in Work, the firm answers in
   the same chat; uploads from the composer into the client space's files; mails (something
   waits, the firm answered, a long wizard finished).
3. **Results as artifacts:** one result record that chats and runs write into (`result_save`), with
   kind and source; versions and change by asking on an opened result, with Undo; preview images
   made on save; downloads per kind; the share menu (a link for the space, "Zur Durchsicht an
   <Firma>").
4. **The firm's controls** in Studio's Clients part: the AI's instructions for clients, who takes
   hand-offs, public links per client space (off by default), usage per client space and the
   optional monthly budget that warns the firm's admins; the panel of what the AI reads here.

## Not built yet

- **Phases 2 to 4** above: streaming, hand-off, uploads, mails, result versions and previews,
  budget, the firm's settings in Studio.
- **The firm's side in Studio:** "Share with the client" and renaming a client space have their
  routes (`PUT /api/studio/runs/:id/client-share`, `PATCH /api/studio/spaces/:id/client`); the
  buttons wait for the space's Clients part (`client-spaces.md`, step 2).
- **The Manage-App's reserved words:** `portal` still needs adding to `HOUSE` in
  `address-words.ts` there, so no team takes it as its own address word either.
- **A run's knowledge in a client space:** a step's Knowledge block counts the client space's own
  items; the parent's opened items are found by search but not counted there.
- **A failed turn** leaves no message: the chat stops saying the AI writes, and nothing explains
  why until phase 2 streams the turn and its error.
- **Languages:** the portal says du; the page's language setting (du, Sie, English) comes later.

## Open

1. **Own domains:** the page by host answers for the team's address first; own domains join once
   the Manage-App serves pages on them.
2. **D10 in the portal:** a client's chat or run that needs a person's yes is held for the bell.
   Until the broker holds outside calls (`modular.md`, "Approvals from outside"), it is refused
   with why. The client's narrower tools make it rare.
3. **A brand without a public page:** a Team without a public page shows its name in the engenty
   look before sign-in. An organization brand of its own would need a setting.
4. **The rest of `<team>.wizards.page` in this app:** the public page, public chat and more could
   move here from the Manage-App. To decide when public chat comes.
