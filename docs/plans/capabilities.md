# Plan: Fähigkeiten, one place for skills and connectors

Status: plan, nothing built. Written on 2026-10-30 against `feat/work-mode` (v0.13.x), revised the
same day after review. Behind a new switch `capabilities`, off by default. Mockups: the artifact
“Fähigkeiten in the Studio” (claude.ai/artifact/SLU1E9iwxQ8SjNAeHVg5qT). The connection model,
the three allowances, fixed steps and the broker come from the connections plan (artifact
“Verbindungen in Quellen”, claude.ai/artifact/GUtiTfPMVvoe1EcgRes3fh); this plan gives them
their place.

## In short

- **Fähigkeiten / Capabilities**, a place in the Studio's app bar after Quellen. Renamed from
  „Werkzeuge“ on review. The glossary gets a row for the place; „Fähigkeit“ stays ruled out as
  a word for one skill.
- Only the Studio shows it; Client shows none. A space can open the Studio to all its members,
  with less: they build, write skills and add knowledge, but set up no connection.
- It holds **Skills** and **Connectors**, each with „Im Space“ and „Entdecken“. An MCP server is
  a kind of connector.
- Built-in connectors (Gmail, Drive, Slack, GitHub …) show as a quiet list of names until
  someone connects one.
- Connectors hold the space's **connections**. Admins set them up and choose how each signs in:
  as the space, or each person for themselves. A person's own sign-ins sit in their menu.
- Settings › Connectors moves here. Plugins move later (roadmap).
- Held calls stay where they wait today: the bell in Work, the run's page in a wizard.
- On a phone Fähigkeiten sits in the „⋯“ menu, as Skills does now.
- A skill's page keeps today's two columns (instructions left, settings right). Dateien moves
  to the top of the right column, above „Wann gilt er“ and „Skripte“.

## Connections

A connection belongs to the **space**. Admins set it up in Fähigkeiten, and the page records who
did („eingerichtet von Matthias, 12. Okt.“). Nobody owns it: admins change its rules, sign it in
again or remove it, and it survives the person who set it up leaving. Members with the Studio use
connections but set none up.

When an admin sets one up, they choose how it signs in:

| | As the space | Each person signs in | Through the company sign-in (later) |
|---|---|---|---|
| Identity | an API key, an app token, or a team login (bestellung@) | each member's own account | each member, through the organization's SSO |
| Sign-in | once, by the admin | each person once, in their menu under „Verbindungen“ | none: the company grants access |
| Acts as | the space | the person | the person |
| Runs with nobody watching | yes | no | no |
| Used by | wizard steps, Work chats | that person's chats, runs and Goose | the same |
| Writes | fixed steps or confirmed actions, „Mit Freigabe“ asks the admins | asks that person | asks that person |
| Plans | every plan | Team | Enterprise, with SSO |

The third way is MCP's Enterprise-Managed Authorization: the company's identity provider grants an
MCP server to a person (an ID-JAG), with no sign-in per server, and the company revokes it there.
It needs SSO and servers that support the extension, so it stays on the roadmap.

Several connections per service in one space are fine (Gmail · Bestellungen, Gmail · Support).

**A person's own page.** Their menu › „Verbindungen“ lists their sign-ins: on top the ones only
for their Goose, in no space; then each of their spaces, where they sign in or out of connections
in which each person signs in, and see the ones that sign in as the space.

**Per space, not per organization.** Spaces keep data apart, e.g. one space per client of an
agency. A later admin action may offer one connection to several spaces („Auch in: …“). With one
space on your computer the question doesn't come up.

Today a sign-in belongs to one wizard and one person (`store_secret`, slot `connection:<id>`);
plugins keep N per space (`plugin_connection`). Connections take `plugin_connection`'s table; a
person's sign-in becomes one per person and connection. Existing rows move once by command.

How others do it: Claude Team/Enterprise and ChatGPT Enterprise let an owner or admin add a
connector for everyone, and each member signs in; Copilot Studio asks per tool for the end user's
or the maker's credentials and warns that the maker's overshare; Zapier Enterprise has managed
connections the company owns; Slack and GitHub install an app that acts as itself.

## The rules (from the connections plan)

A call goes through only when three allowances say yes:

- **The wizard**, frozen at publishing: what its AI steps may read, what its fixed steps do.
- **The connection**, set by the space's admins: per action *Erlaubt / Mit Freigabe / Nie*, and
  who may use it (*Admins / Mitglieder / alle*).
- **The person's role** in the organization.

On a connection that signs in as the space, the AI only reads. Writing (sending, creating, saving) is a fixed step, or in
a Work chat an action the AI fills in and the person confirms; with „Mit Freigabe“ it then waits
for an admin of the space. Every call goes through the broker, which logs it.

## The gatekeeper

Every tool call and every read or write of a connected service goes through one path in the
runtime: the broker (connections plan). Nothing else holds a token, a key or a folder path.

- **Who calls:** an AI step of a wizard (reads only on a space connection), a fixed step (the
  writes), a Work chat (reads; writes as a confirmed action), Goose (its person's own sign-ins),
  a plugin (`server.connections.call`), a script in the sandbox (reaches the broker, holds no
  secrets), an AI app over `/api/mcp` (as the signed-in person).
- **What it checks:** `call(who, run, connection, action, input)` against the run's grant (what
  the wizard, chat or Goose may reach), the connection's rules (*Erlaubt / Mit Freigabe / Nie*
  per action, audience) and the person (role, their own sign-in). It answers *allow / ask /
  deny* with a reason; on any failure it denies.
- **What it does:** takes the secret from the vault, signs in the way the connection says (as
  the space, as the person, later through the company sign-in, or a folder path), runs the
  action, returns the result and logs the call („Letzte Nutzung“). *Ask* goes to Freigaben: the
  bell in Work or the run's page, for the space's admins or the person.

Model calls take a separate path, the model gateway (model tiers, masking). In phase 1 the broker
is a function in the runtime with plain rules; later it can read Cedar policies or run as its own
process with agentgateway in front.

## Who sees what

| | Wizard step | Work chat | Goose |
|---|---|---|---|
| Skills | by mode; scripts in the run's sandbox | by mode; scripts in the chat's sandbox | reads, runs no scripts |
| As the space | read in AI steps, write in fixed steps | **new:** read; write as a confirmed action | no |
| Each person signs in | as the person running it | **new:** as the person; asks before a write | **new:** as its person; asks before a write |

Goose is a personal copilot: it works with its person's own sign-ins and the space's skills,
never with a connection that signs in as the space.

## Who sees the place

One rule **per space**, set by an admin: „Mitglieder dürfen ins Studio“. It counts for all
members of the space; there is no switch per person.

| | Owner, admin | Member with Studio | Member without |
|---|---|---|---|
| Studio | yes | yes, in spaces that open it to members | no, Work only |
| Wizards | build, publish | build, test | run |
| Skills, Wissen, Daten | add, change | add, change | none |
| Connections | set up, choose how they sign in, set rules and audience | use the ones open to members; rules locked | their chats use them |
| Own sign-ins | in their menu | in their menu | in their menu |

A member with Studio can't set up a connection or change its rules. Freigaben go to the space's
admins.

## Addresses

`/capabilities`, `/capabilities/skills`, `/capabilities/connectors`, an item with `?show=`.
`/skills` and `/settings/connectors` redirect.

## Order of PRs

All behind `capabilities`, off by default. The connections plan's phases deliver the connection
model; these PRs give it the place.

1. `feat(studio): Fähigkeiten in the app bar` — Skills move in, `/skills` redirects.
2. `feat(studio): connectors move to Fähigkeiten` — list, page, built-ins as names;
   `/settings/connectors` redirects.
3. `feat(runtime): connections owned by the space` — named, several per service, signing in as
   the space, audience and rules per action (connections plan, phase 1).
4. `feat(studio): each person signs in` — the second way, sign-ins in the person's menu.
5. `feat(work): Work chats and Goose use connections` — writes as confirmed actions.
6. `feat(studio): members in the Studio per space` — one rule per space, the reduced set.
7. `feat(studio): Entdecken` — one search over skills.sh and integrations.sh.
8. `feat: Fähigkeiten on by default` — switch, docs, glossary.

## Roadmap

- Plugins move to Fähigkeiten, with their settings; `/settings/plugins` redirects.
- One connection offered to several spaces.
- Through the company sign-in: MCP Enterprise-Managed Authorization, for Enterprise with SSO.

## Open

- Does a member in Work ever need to see the space's connections and rules, or is the menu enough?
- Later: may a member with Studio publish a wizard to people outside the space, or only an admin?
