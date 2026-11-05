# Report: Fähigkeiten and the broker, as built

Written on 2026-10-31 after Part A and Part B of `docs/plans/capabilities.md` landed on
`feat/work-mode`. It says what the code does now, what the tests cover, what an end-to-end run
on a local install showed, and what is still open. Everything here was read from the merged code
or seen in the run; nothing is taken from the plan.

## What landed

All PRs into `feat/work-mode`, squash-merged, each behind a switch where it changes behaviour.

| Step | PR | What the code does |
|---|---|---|
| A0 RWX | #356 | `rwx_rule` per space (`subject × resource × R W X`), deny by default, *verboten* wins; readers of documents, tables, pages and search filter by R. Switch `broker`, off. |
| A1 | #354 | A guest's run never gets the Docker sandbox; `SANDBOX_GUESTS=off\|agentos`, default off. |
| A2 | #355 | `brokerCall` in `apps/runtime/src/broker/call.ts`; the five connector call sites go through it; `broker_log`; a walk test fails on a tool without a broker action. |
| A3 | #358 | `run.grant` fixed at `createRun` from the published definition; `not_in_grant` refused before any rule. |
| A4 | #360 | `step.call` for fixed steps; an AI step on a space connection gets read actions only (`ai_step_writes`); validator and guide. |
| A5 | #359 | `space_connection` (sign-in `space\|person`, audience, rules per kind) and `space_connection_sign_in`; migration 0034 moves plugin connections over with audience *alle*. |
| A6 | #362 | Hosts in the grant (`broker/host.ts`); a guest's send only to a collected address or the space's `mailDomains`, 3 per run, `dailyMailLimit`; results of members-only connections kept in the space (`broker/kept.ts`). |
| A7 | #361 | Work chats' tools are the space's connections; writes are confirmed actions; *Mit Freigabe* holds for admins (`held_for`); Goose uses only its person's sign-ins. |
| A7a | #366 | Critical kinds (`CRITICAL_KINDS`), the bell, hourly mail, report to Manage, `GET …/broker/log` and `…/broker/ask`; migration 0038. |
| — | #363 | A stale test stub (a plugin step without a holder). |
| B0 | #364 | The `capabilities` switch. |
| B1 | #365 | Fähigkeiten in the app bar, `/capabilities/<section>`, `/skills` and `/space/skills` redirect; `apps/web/src/studio/capabilities/sections.ts`. |
| B3 | #367 | Konto › Verbindungen (`GET /api/studio/person/sign-ins`), one sign-in flow for both pages. |
| B4 | #368 | `space.membersStudio` (migration 0039), members reach the studio API only for spaces with the rule, reduced set, 403 elsewhere. |
| B6 | #369 | `GET …/discover?q=`: skills.sh and integrations.sh in parallel, 10 s each, `added` / `setUp` marks. |
| B2 | #370 | Connectors section: list, setup, one connection with sign-in, audience, rules, `?setup=` and `?show=`; `/settings/connectors` redirects. |
| B5 | #371 | Protokoll: log with filters and cursor, line detail with the run's grant, „Was darf …?", notification switches; `BROKER_REFUSALS` in `packages/shared` so every refusal has words. |
| B7 | #372 | `capabilities` on by default; user guide `user-guide/capabilities.md`, glossary rows in `docs/copy-style.md`, developer page `dev/broker.md`; two runtime tests now set the switch off explicitly. `broker` stays off. |
| fix | #375 | Members reach a closed space through no side door: MCP, `/api/v1`, the live stream and Goose use B4's gate, each with a test. |
| B8 | #376 | `broker` on by default; a plugin's document read runs as whoever it serves plus the plugin; a plugin's scheduled job reads as the runtime's own `SYSTEM` subject (allowed, not nameable in a rule, not derivable from a request; "no subject" is still a no). |
| fix | #373 | `send` is a connector action group: SMTP, Gmail and Outlook `send_message` and Slack `post_message` are sends; imported definitions are classified by name (`importer/classify.ts`); a guest's send over a connection now meets the recipient rule and the caps. |

Tenant migrations 0032–0039 apply in order on a fresh data folder (seen in the run).

### Where the code is

- Broker: `apps/runtime/src/broker/` — `call.ts` (`brokerCall`, pure `decide`, `Who`, `Where`, `ActionKind`), `rwx.ts`, `grant.ts`, `log.ts`, `send.ts`, `host.ts`, `kept.ts`, `account.ts` (the one secret reader), `caller.ts`, `registry.ts`.
- Connections: `apps/runtime/src/connectors/space-connections.ts`; routes `routes/connections.ts`, `routes/rules.ts`, `routes/broker.ts`, `routes/discover.ts`, `routes/person.ts` (sign-ins).
- Studio: `apps/web/src/studio/capabilities/` (`CapabilitiesPage`, `SkillsSection`, `ConnectorsSection`, `ProtocolSection`, `DiscoverSection`, `protocol-words.ts`), `connection-sign-in.tsx`, `members-studio.tsx`, `space/SpaceSettings.tsx` (the members rule).
- Switches: `packages/shared/src/feature-flags.ts` — `capabilities`, `broker` (RWX enforcement, off), `skills`.

## Tests

Runtime: 130 files. On the final branch (`98a88b30`) 1124 tests pass, 10 skipped, 4 todo; the
five failures predate this work and fail the same way on the commit before Part A
(`knowledge.test.ts` assets re-description, `output-schema.test.ts` ×3, `plugin-hooks.test.ts`
search index). The suites
this work added or extended — `broker`, `broker-walk`, `broker-heard`, `broker-protocol`, `rwx`,
`space-connections`, `work-connections`, `members-studio`, `discover`, `plugin-connections` —
pass: 110 tests, 4 todo. Typecheck is clean in every package; biome, `copy:check` and
`docs:check` pass on each PR.

## Functional (e2e) test plan and results

Run on 2026-10-31 against the merged branch (`dbc2c0c4`, before B7 and the fix) on a local
runtime, one tenant, owner via dev login, `FEATURES=workMode=on,capabilities=on,broker=on`, in
the app's browser pane at 1280×860, 375×812 and in dark mode. A local install has one person
and no team, so member cases ran as runtime tests, not in the browser.

| # | Area | Step | Expected | Result |
|---|---|---|---|---|
| E1 | App bar | open the studio as owner | Fähigkeiten glyph after Quellen, before Ergebnisse | pass |
| E2 | App bar | open `/skills` | redirect to `/capabilities/skills`, trail „Mein Computer / Fähigkeiten / Skills" | pass |
| E3 | App bar | open `/space/skills` | redirect to `/capabilities/skills` | pass |
| E4 | Skills | `/capabilities/skills` | menu column + page, „Im Space", add and mode switch work | pass (Dateien order not judged: no files) |
| E5 | Connectors | `/capabilities/connectors` | „Im Space" empty state, built-ins (HubSpot, S3, SMTP) as names, „Verbindung hinzufügen", „Weitere Connectors" with the registry search | pass |
| E6 | Connectors | create a connection by API (SMTP, als Space, Mitglieder) | listed with sign-in kind and audience; default rules read allow / write ask / destructive deny / send ask | pass |
| E7 | Connectors | open it with `?show=` | name, sign-in, account („Anmelden"), audience control, four rule rows, set up by, usage, remove | pass; **finding F1** (see below), fixed in #373 and re-checked |
| E8 | Connectors | `/settings/connectors` | redirects to `/capabilities/connectors`; no Connectors row in Settings | pass |
| E9 | Verbindungen | person menu › Verbindungen | the space, the connection „Der Space ist noch nicht angemeldet · eingerichtet von …", no button | pass |
| E10 | Entdecken | `/capabilities/discover?q=hubspot` | both directories answer; „Einrichten" opens `/capabilities/connectors?setup=hubspot.com` with the setup form | pass (37 skills, 3 connectors) |
| E11 | Entdecken | add the first skill | row shows „Im Space"; the skill appears under Skills › Bei Bedarf | pass |
| E12 | Protokoll | `/capabilities/protocol` | log, four outcome filters, who / connection / time filters, search; menu „Was darf …?", „Benachrichtigungen" | pass |
| E13 | Protokoll | „Was darf …?" ein Gast · SMTP · send · in a run (API and UI) | refused by audience, rule named, link to the connection | pass; before #373 the wording said „löschen" (F1), after it `send_message` is a send |
| E14 | Protokoll | „Was darf …?" admin · same · in a chat (API) | `ask` by the write rule, admins | pass |
| E15 | Protokoll | three seeded `broker_log` lines (ok / deny critical / ask) | plain words, refused in rose, critical marked; detail shows when, sizes, rule, links | pass |
| E16 | Members | `PATCH /spaces/:id {membersStudio:true}` and read back | persists | pass by API; the toggle in Space › Info shows only on a managed install (`me.mode === "managed"`), so not seen locally |
| E17 | Members | `members-studio.test.ts` | refused without the rule, allowed with it for that space, 403 on connections, rules, publish | pass |
| E18 | API | member on `broker/log`, `rules`, `POST connections` | 403 (`broker-protocol`, `space-connections` tests) | pass |
| E19 | Switch off | restart with `capabilities=off` | `/skills` stays, no glyph, Settings › Connectors back, `/capabilities` and `/account/connections` fall back, `discover` 404 | pass; note: Part A's `connections` and `broker/log` APIs answer with the switch off (they are runtime APIs, not gated by `capabilities`) |
| E20 | Broker | the ten runtime suites above | pass | pass (110) |
| E21 | Phone | `/capabilities` and a connection at 375 px | menu first; `?show=` opens the section | pass |
| E22 | Dark | Protokoll and a connection with `engenty_theme=dark` | readable | pass |

Screenshots of the pane show the enter animation's first frame while the pane is hidden; the
computed opacity is 1. Not a product defect.

### Findings

- **F1 — sending was decided by the delete rule.** A connector's actions are grouped
  `read | write | destructive` (`engenty/connections-sdk/types.ts`); the broker's fourth kind,
  `send`, was reached only by hosts and the e-mail share target. SMTP's `send_message` is grouped
  `destructive`, so a space connection's mail send was „Nie" by default, „Was darf …?" answered
  „darf nicht löschen", and the connection page listed it under „Löschen". Fix: `send` becomes a
  connector action group; see „Status".
- Part A's APIs (`/connections`, `/rules`, `/broker/*`) are not gated by `capabilities`; the
  studio hides their pages with the switch off. Fine for an integration branch; worth a line in
  the docs.
- Skills from skills.sh carry a „nicht geprüft" badge in Entdecken and under Skills: the
  registry's review state. Left as is.

## Not verified

- Signing a space connection in through a real provider (OAuth popup, SMTP credentials) and a
  person's own sign-in as a member: no provider and no second person on the local install.
- A guest's run end to end through the broker (grant, recipient rules, caps, kept results):
  covered by runtime tests only.
- The hourly mail to admins and the report to Manage: Manage has no `POST /v1/broker/:tenant`
  yet (A7a).
- The shop plugin (the only plugin reading the space's pages and documents): its reads were run
  on 2026-11-05 inside a runtime from source, see „Since: the reads that asked nobody" below.
  Not run: reading products out of a page or a price list (needs a text model), and its own
  `test:runtime`, which fails 8 of 11 on main as it is (its step stub has no holder).
- `space_search` answers `filtered`, how many items pass its `where`, without asking who reads;
  the hits and `candidates` are filtered.
- What a plugin makes of pages it read in a job is its own data: by reading the code, the
  shop's products from a Wissen source over a folder closed to guests reach a guest's run
  through the shop's tools. Not run, as making a product needs a model.
- A page made of a document and its document can lie in different folders, and each is decided
  by its own (seen in a run): the page moved into a closed folder leaves the document readable;
  the page moved out of one is readable though its document is closed.
- Per-person sign-in is not gated to the Team plan (B2); the Work bell's run link
  `/wizards/:id?run=` is not a route, the Protokoll uses `/edit/:id?run=` (B5).

## Since: the reads that asked nobody

2026-11-05, on main after v0.16.2. Read from the code, then changed:

| Read | Before | Now |
|---|---|---|
| A plugin's `spaceData.readPages` | every page of the space, with its Markdown, to any caller | the pages its reader may read: whom the plugin serves, and the plugin (as `readFile` since #376) |
| A plugin's `spaceData.files` | every document's name and size | documents its reader may read; logos, patterns and assets ask nobody, as before |
| The steps' Knowledge block (`knowledgeBlock`) | pages, tables and files counted over the whole space; every category with all its values and its range | counted over what the run's holder and wizard may read; a value only closed items have is left out |
| `space_list` without a filter | a category's items and each value's count over the whole space | the same counts as the block |
| `space_document` on a miss | named up to 40 files of the space | names the files the caller may read |
| `page_read` | listed every sub-page | lists the sub-pages the caller may read |
| The space's details in `/api/v1` and Goose's view of the space | counts over the whole space | counts for the person, for Goose for the person |

Which Knowledge tools a step is offered still follows what the space holds, not what the
caller may read: each read is decided when it is made, and a refusal names the item.

Found on the way: two first reads of a space at once (the shop's route lists files and pages
together) seeded its rules twice, and the guests' rows, which have no subject id, came out
double; the rules' `PUT` then refused the list. A space is seeded once now (`rulesOf`).

Tests: `rwx.test.ts`, „a folder closed to guests": a guest's run and a member's run against one
folder with a page, a table with a row, a document and two categories.

The shop plugin (`plugins/shop` of the Manage repo, unchanged), its reads against the rules:

| Read | Where | Reads as | Seen in the run |
|---|---|---|---|
| `readFile` | a document source's file (`dataOfSource`) | the admin of the route or the chat; the runtime in the job | 403 with the document's id for a person the folder is closed to |
| `readPages` | a Wissen source's pages (`readWissenSource`) | the same | 1 page listed by the route for a person the folder is closed to, 3 in the job, 1 in the job with a deny for the plugin |
| `readPages` | the assistant's `propose_source` | the person in the chat | by reading only |
| `files`, `readPages` | the assistant's `list_wissen` | the person in the chat | the folder and its file missing |
| `files`, `readPages` | `GET /wissen` | the person the route answers | the folder and its file missing |

Its tools for a step (`shop.search` and the others) read the plugin's own tables, never the
space's Knowledge. A Wissen source an admin starts by hand reads as that admin: where a rule
closes a folder to them, the products made of its pages are marked gone until the job reads again.

## Status

Everything in Part A and Part B of the plan is merged on `feat/work-mode` (`ff6b08ac`);
`capabilities` and `broker` (RWX enforcement) are on by default (B8). F1 is fixed by #373 and
re-checked on the final branch: the connection page lists `send_message` under „Senden", and
`broker/ask` answers an admin's send in a chat with `ask` by `rules.send` and a guest's send in a
run with `deny` by the audience. Decide before `feat/work-mode` goes to main: narrow the plugin connections A5 converted with audience „alle"; whether a guest's Slack
post should be refused like a send without an address (#373 made it so).
