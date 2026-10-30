# Plan: Fähigkeiten, one place for skills and connectors

Status: plan, nothing built. Written on 2026-10-30 against `feat/work-mode` (v0.13.x), revised the
same day after review. Behind a new switch `capabilities`, off by default. Mockups: the artifact
“Fähigkeiten in the Studio” (claude.ai/artifact/SLU1E9iwxQ8SjNAeHVg5qT). The account model,
the three allowances, fixed steps and the broker come from the connections plan (artifact
“Verbindungen in Quellen”, claude.ai/artifact/GUtiTfPMVvoe1EcgRes3fh); this plan gives them
their place.

## In short

- **Fähigkeiten / Capabilities**, a place in the Studio's app bar after Quellen. Renamed from
  „Werkzeuge“ on review. The glossary gets a row for the place; „Fähigkeit“ stays ruled out as
  a word for one skill.
- Only the Studio shows it; Client shows none. A space can open the Studio to all its members,
  with less: they build, write skills and add knowledge, but connect no account for others.
- It holds **Skills** and **Connectors**, each with „Im Space“ and „Entdecken“. An MCP server is
  a kind of connector.
- Built-in connectors (Gmail, Drive, Slack, GitHub …) show as a quiet list of names until
  someone connects one.
- Connectors hold the **space's accounts**. A person's own accounts are not here; they sit in
  the person's menu under „Verbindungen“.
- Settings › Connectors moves here. Plugins move later (roadmap).
- Held calls stay where they wait today: the bell in Work, the run's page in a wizard.
- On a phone Fähigkeiten sits in the „⋯“ menu, as Skills does now.
- A skill's page keeps today's two columns (instructions left, settings right). Dateien moves
  to the top of the right column, above „Wann gilt er“ and „Skripte“.

## Two kinds of account

| | Space account | Personal account |
|---|---|---|
| Belongs to | the space, under a name („HubSpot · Vertrieb“, „Gmail · Bestellungen“) | one person |
| Connected | once per space, in Fähigkeiten | once per person, in their menu, for every space |
| Owner | whoever connected it; an owner of the organization can take it over | the person |
| Used by | wizard steps, Work chats (the space's AI), unattended runs | only that person's Goose, live, never unattended |
| Rules | set by its owner: per action, and who may use it | the person is asked before a write |

Several accounts per service in one space are fine (Gmail · Bestellungen, Gmail · Anna).

**The owner** of a space account is the person who connected it: it is their login and their
token. They set its rules and its audience (*nur ich / Mitglieder / alle*), „Mit Freigabe“ asks
them, and they hear when the sign-in runs out. An owner of the organization can change the rules
or take the account over, e.g. when the person leaves.

**Per space, not per organization.** Spaces keep data apart, e.g. one space per client of an
agency. A later admin action may offer one connection to several spaces („Auch in: …“), each
space switching it on. With one space on your computer the question doesn't come up.

Today an account belongs to one wizard and one person (`store_secret`, slot `connection:<id>`);
plugins keep N per space (`plugin_connection`). Space accounts take `plugin_connection`'s table,
personal accounts become one per person. Existing rows move once by command.

## The rules (from the connections plan)

A call goes through only when three allowances say yes:

- **The wizard**, frozen at publishing: what its AI steps may read, what its fixed steps do.
- **The account**, set by its owner: per action *Erlaubt / Mit Freigabe / Nie*, and who may use
  it.
- **The person's role** in the organization.

On a space account the AI only reads. Writing (sending, creating, saving) is a fixed step, or in
a Work chat an action the AI fills in and the person confirms; with „Mit Freigabe“ it then waits
for the account's owner. Every call goes through the broker, which logs it.

## Who sees what

| | Wizard step | Work chat | Goose |
|---|---|---|---|
| Skills | by mode; scripts in the run's sandbox | by mode; scripts in the chat's sandbox | reads, runs no scripts |
| Space accounts | read in AI steps, write in fixed steps | **new:** read; write as a confirmed action | no |
| Personal accounts | only „Wer den Wizard nutzt“ | no | **new:** its person's own, asks before a write |

Goose is a personal copilot: it works with its person's own accounts and the space's skills,
never with the space's accounts.

## Who sees the place

One rule **per space**, set by an admin: „Mitglieder dürfen ins Studio“. It counts for all
members of the space; there is no switch per person.

| | Owner, admin | Member with Studio | Member without |
|---|---|---|---|
| Studio | yes | yes, in spaces that open it to members | no, Work only |
| Wizards | build, publish | build, test | run |
| Skills, Wissen, Daten | add, change | add, change | none |
| Space accounts | connect for others, set rules and audience | use the ones open to members; rules locked | their chats use them |
| Own accounts | in their menu | in their menu, and „nur ich“ accounts in the space | in their menu |

A member with Studio can't connect an account for others or change the rules of an account they
don't own. Freigaben for a space account go to its owner.

## Addresses

`/capabilities`, `/capabilities/skills`, `/capabilities/connectors`, an item with `?show=`.
`/skills` and `/settings/connectors` redirect.

## Order of PRs

All behind `capabilities`, off by default. The connections plan's phases deliver the account
model; these PRs give it the place.

1. `feat(studio): Fähigkeiten in the app bar` — Skills move in, `/skills` redirects.
2. `feat(studio): connectors move to Fähigkeiten` — list, page, built-ins as names;
   `/settings/connectors` redirects.
3. `feat(runtime): space accounts with an owner` — named, several per service, audience and
   rules per action (connections plan, phase 1).
4. `feat(studio): personal accounts in the person's menu` — once per person, for Goose.
5. `feat(work): Work chats read the space's accounts` — writes as confirmed actions.
6. `feat(studio): members in the Studio per space` — one rule per space, the reduced set.
7. `feat(studio): Entdecken` — one search over skills.sh and integrations.sh.
8. `feat: Fähigkeiten on by default` — switch, docs, glossary.

## Roadmap

- Plugins move to Fähigkeiten, with their settings; `/settings/plugins` redirects.
- One connection offered to several spaces.

## Open

- Does a member in Work ever need to see the space's accounts and rules, or is the menu enough?
- May a member with Studio publish a wizard to people outside the space, or only an admin?
