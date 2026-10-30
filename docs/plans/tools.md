# Plan: Werkzeuge, one place for skills, connectors and plugins

Status: plan, nothing built. Written on 2026-10-30 against `feat/work-mode` (v0.13.x). Behind a
new switch `tools`, off by default. Mockups: the artifact “Werkzeuge in the Studio”
(claude.ai/artifact/SLU1E9iwxQ8SjNAeHVg5qT).

Scope: one place in the app bar for everything the AI may use in a space: skills (instructions),
connectors (services, built in, from an OpenAPI description or an MCP server) and plugins (code
that extends engenty wizards). What this plan covers: the name, what the place holds, mine and
discover, where each kind lives, the place in each mode, what leaves Settings, what wizard steps,
Work chats and Goose see, scripts and the sandbox, approvals, the phone, the order of PRs.

Not in scope: models (they stay in Settings › Models), Einbinden (engenty wizards as a tool for
other apps, `docs/plans/api-clients.md`), how a held call becomes a run's waiting page
(`docs/plans/durable-agents.md`).

## Today

| Kind | Lives | Where people manage it | Who uses it |
|---|---|---|---|
| Skills | per space, `space_skill` | `/skills` (since #334) | wizard steps (scripts in the run's sandbox), Work chats (scripts in the chat's sandbox), Goose (reads only) |
| Connectors, built in | code (`connectors/builtin.ts`, `engenty/connections-*`) | Settings › Connectors | wizard steps that list them in `step.connections` |
| Connectors, imported (OpenAPI, MCP) | per space, `space_connector` | Settings › Connectors, directory search (integrations.sh) | same; the architect imports them while it builds |
| Accounts for connectors | per wizard and person, `store_secret` (`connection:<id>`) | nowhere: a person connects during a run | that wizard only |
| Plugins | per install (a computer) or per organization (`pluginIdsOf`) | Settings › Plugins | wizard steps, Work chats (assistant tools), Goose, the studio (parts, pages) |

What stands out:

- A connector belongs to a space, but it sits in Settings, behind a space switcher.
- An account connected for one wizard is asked for again by the next wizard.
- Work chats and Goose reach no connector at all.
- Policy exists per action group (`read` allowed, `write` and `destructive` ask), but nobody can
  see or change it. Work holds calls by a plugin tool's risk mark, a separate rule.
- The glossary still lists “connected systems” for a space's MCP servers. That feature was
  removed in 0.11.5 (#206). An MCP server is now a kind of connector.

## The name

**Werkzeuge / Tools.** One word in each language, each its own word.

- It says what the AI does with these things: it uses them. Skills tell it how, connectors let it
  reach a service, plugins add both.
- Not „Anpassungen“: that is about changing the app's look, and Claude's use of it is no reason.
- Not „Fähigkeiten“: the glossary rules it out for skills.
- Not „Integrationen“: it covers connectors only.
- „Skills“, „Connectors“ and „Plugins“ stay the names of the three kinds inside.
- Icon: lucide `Toolbox` (in the installed version). Skills keep `ScrollText`, connectors `Plug`,
  plugins `Blocks`.

Copy: the glossary gets a row „Werkzeuge / tools: the place for a space's skills, connectors and
plugins“. The row „connected systems“ goes. The hint under the title: „Was deine Wizards, deine
Chats und Goose in diesem Space nutzen dürfen.“

## What the place holds

Three kinds, each a part of the place with its own list, like Quellen's parts:

- **Skills.** As today: mode (immer an, bei Bedarf, aus), files, „Skripte ausführen“.
- **Connectors.** Built-in ones, imported ones and MCP servers in one list. The kind shows as a
  small mark (`MCP`, `OpenAPI`, eingebaut). A connector's page shows its accounts, its actions
  with what each may do without asking, and who uses it.
- **Plugins.** What the organization or this computer has installed. A plugin's page shows what
  it adds (a part in Quellen, actions, skills, a page) and its own settings, which move here
  from Settings › Plugins.

On top: an **Übersicht** with the three as sections, and **Freigaben**: the calls that wait for
the person (Work's held calls, later a run's).

### Meine and Entdecken

Two tabs at the top of the overview and of each part, as in the mockups.

- **Meine:** what this space has.
- **Entdecken:** one search over skills.sh, integrations.sh and engenty's plugins. Filter chips
  for the kind and „Nur offizielle Quellen“ (the skills search has it already). First a row
  „Passt zu diesem Space“, chosen from the space's Quellen and its wizards' steps; then the most
  used in other spaces, then new ones. A check marks what the space has, a plus adds it. The
  source sits under every card.

### Hinzufügen

One button with a menu, one dialog of fixed height (the dialog rule). Skill: from skills.sh,
write, upload. Connector: from the directory, MCP server by address, OpenAPI description. Plugin:
install (admins). An MCP server asks three things: the address, whose account (each person their
own, or one for the space), what it may do without asking. It lists the server's tools before it
saves anything.

## Where each kind lives

| Kind | Today | Proposed |
|---|---|---|
| Skills | space | space (no change) |
| Connector definitions | space; built-ins everywhere | space (no change); a built-in shows in every space, off until switched on |
| Accounts | per wizard and person | **per space and person**, reused by every wizard, chat and Goose in the space; or **one account for the space**, set by an admin, used by all |
| Action policy | code defaults per group | **per space and action**, set on the connector's page |
| Plugins | install or organization | install or organization (no change), shown in every space, installed by admins |

The account change is the one real change to the data. One wizard's account for a person becomes
the space's account for that person. Following the rule for unreleased work, existing rows move
once by command; there is no second path.

## The place in the app bar

- **Studio:** Start · Quellen · Werkzeuge · Ergebnisse. Werkzeuge takes Skills' place from
  #334; `/skills` moves to `/tools/skills`.
- **Work:** Chats · Engenties · Dateien · Daten · Werkzeuge · Ergebnisse · the bell. A Work user
  sees the same place: what their chats may use, and their own accounts to connect.
- **Client:** none.
- The mode switch above stays as it is.

Addresses: `/tools` (overview), `/tools/skills`, `/tools/connectors`, `/tools/plugins`, an item
with `?show=<kind>:<id>` as Skills does today, `/tools/discover`. Redirects: `/skills`,
`/settings/connectors`, `/settings/plugins`.

## What leaves Settings

- Settings › Connectors goes. Its directory search becomes part of Entdecken.
- Settings › Plugins goes. The Pro modules section and each plugin's own settings move to the
  plugin's page in Werkzeuge.
- Settings keeps: Konto, Modelle, Einbinden, Setup, Über, and the organization's sections.

## Who sees what

| | Wizard step | Work chat | Goose |
|---|---|---|---|
| Skills | by mode; scripts in the run's sandbox | by mode; scripts in the chat's sandbox | reads, runs no scripts |
| Connectors | the ones the step lists (`step.connections`), with the running person's account or the space's | **new:** every connector switched on in the space, with the person's account | **new:** read actions only, with the person's account |
| Plugin tools | as today | as today, minus plugins the person turned off | as today |

A Work chat's connectors come as one tool per connector above 24 actions, as steps get them
today (`DIRECT_TOOLS`).

## Scripts and the sandbox

- „Skripte ausführen“ stays per skill and off by default. The skill's page says where scripts
  run: one sandbox per run for wizards, one per chat in Work. Goose runs none.
- The sandbox reaches the internet (`docs/plans/skills.md`). The switch's hint says so for a
  skill from an unchecked source.
- Connectors are not reachable from inside the sandbox. A script that needs a service asks the
  AI, which calls the connector under the policy below.

## Approvals

One policy per space and action, on the connector's page:

- **Erlaubt:** runs without asking.
- **Erst fragen:** the call waits for a person.
- **Aus:** the AI does not see the action.

Defaults follow today's groups: `read` erlaubt, `write` erst fragen, `destructive` always asks
and cannot be set to erlaubt. A plugin tool's risk mark maps to the same three: `read` and
`space` erlaubt, `outside` and unmarked erst fragen.

Where a held call shows: in Work under the bell and in Werkzeuge › Freigaben; in a wizard as the
page it shows today („Allow for the rest of this run“). Who decides: as today, the person who
asked or an owner or admin. Changing a policy takes an admin.

## On a phone

- Werkzeuge sits under „⋯“ beside Ergebnisse, as Skills does now.
- The place opens on its list with Meine and Entdecken as a full-width switch. A row opens the
  item as a page of its own with a back row. The round button adds.
- Hinzufügen opens as a sheet from the bottom.

## Order of PRs

All behind `tools`, off by default. Each one small, each one usable.

1. `feat(studio): Werkzeuge in the app bar` — `/tools` with Skills as its first part; `/skills`
   redirects; Übersicht with the Skills section.
2. `feat(studio): connectors move to Werkzeuge` — list and page, read-only policy;
   `/settings/connectors` redirects.
3. `feat(runtime): accounts per space and person` — `store_secret` slot per space, a one-time
   move of existing rows by command, „Konten“ on the connector's page.
4. `feat(studio): what a connector may do without asking` — policy per space and action, admins
   change it.
5. `feat(work): Work chats use the space's connectors` — with the policy; held calls as today.
6. `feat(studio): Entdecken` — one search over skills.sh, integrations.sh, plugins; „Passt zu
   diesem Space“.
7. `feat(studio): plugins move to Werkzeuge` — plugin pages with their settings;
   `/settings/plugins` redirects.
8. `feat(studio): Freigaben in Werkzeuge` — held calls listed in the place.
9. `feat(studio): Goose reads with the space's connectors`.
10. `feat: Werkzeuge on by default` — flips `tools`, docs, glossary, the copy check.

## Open questions

- The name: Werkzeuge / Tools, or another word?
- Accounts: is „one account for the space“ wanted from the start, or later?
- Should built-in connectors show in every space, or only once someone adds them?
- Plugins: install from Werkzeuge for admins, or keep installing a separate step (cloud: the
  Manage-App's modules)?
- Goose with connectors: read actions only, or the same policy as Work chats?
- Should a Work user (not an admin) see a connector's policy, or only their own accounts?
- On a phone: Werkzeuge under „⋯“, or a fourth tab in place of Quellen in Work?
- Freigaben: a part of Werkzeuge, or only the bell?
